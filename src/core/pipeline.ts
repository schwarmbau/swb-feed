// One run: pull → guard → journal → grade → extract (own voice) → route → deliver → render.
// The order is the design. The guard runs before the journal, so the ledger never holds a secret;
// the journal runs before the grade, so nothing is lost when a grader or a sink fails.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, FeedConfig, GradedItem, Grade, IntentProfile, Job, PiiConfig, PiiLabel, RawItem, RunContext, Rule, Source, SourceHealth, VoiceItem } from "./types.ts";
import { isModelGrade, modelGrade, pool, UnreadableAnswer } from "./model.ts";
import { Ledger } from "./ledger.ts";
import { GUARD_FLAG, guard, itemText, riskOf } from "./guard.ts";
import { loadIntent } from "./intent.ts";
import { gradeDeterministic } from "./grade.ts";
import { route } from "./route.ts";
import { normalizeUrl, sha256 } from "./text.ts";
import { alreadyDecided as alreadyDecided_, completedVoiceItems, extractionConfidence, extractions, extractVoice, failures, markKey, markStart, mineConversations, offerOrder, recordExtraction, recordFailure, relatedPoint, samePoint, voiceChunks, voiceWindow, type ExtractionRow } from "./voice.ts";
import { approvedTexts, blockedIds, isReviewSink, openIntents, pendingReviews, queueVoice, reviewRows, supersedeVoice } from "../sinks/review.ts";

export interface SourceReport {
  source: string;
  pulled: number;
  fresh: number;
  error?: string;
}

export interface RunReport {
  sources: SourceReport[];
  fresh: GradedItem[];
  delivered: { sink: string; id: string; ok: boolean; error?: string }[];
  /** Items the guard called suspect, kept from a delivery sink that does not accept them (retried every run, never receipted). */
  held: { sink: string; id: string; flags: string[] }[];
  views: string[];
  ledgerSize: number;
  model?: { port: string; graded: number; failed: number; waiting: number; error?: string };
  /** The own-voice stage: items read, candidates queued for review, model calls, items still waiting. */
  voice?: { port: string; extracted: number; queued: number; unoffered: number; already_decided: number; withdrawn: number; calls: number; failed: number; waiting: number; parked: number; warnings: number; error?: string };
}

const RAW_FIELDS = ["external_id", "url", "title", "author", "content", "abstract", "content_kind", "published_at"] as const;

/** Only known fields survive, and every string among them passes the guard before anything is written. */
export function envelopeFrom(raw: RawItem, src: Pick<Source, "name" | "trust" | "privacy_class">): Envelope {
  const clean: Record<string, string | undefined> = {};
  const redactions: string[] = [];
  for (const k of RAW_FIELDS) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    const g = guard(v);
    clean[k] = g.text;
    redactions.push(...g.redactions);
  }
  const flags = Array.isArray(raw.flags) ? raw.flags.filter((f): f is string => typeof f === "string").map((f) => guard(f).text) : [];
  // An item may make itself stricter than its source, never looser.
  const privacy = src.privacy_class === "personal" || raw.privacy_class === "personal" ? "personal" : "public";
  return {
    external_id: clean.external_id ?? "",
    url: clean.url,
    title: clean.title ?? "(untitled)",
    author: clean.author,
    content: clean.content ?? "",
    ...(clean.abstract ? { abstract: clean.abstract } : {}),
    content_kind: clean.content_kind ?? "note",
    published_at: clean.published_at,
    id: identityOf(clean.url, clean.external_id ?? "", src.name),
    source: src.name,
    trust: src.trust,
    privacy_class: privacy,
    captured_at: new Date().toISOString(),
    content_hash: sha256(clean.content ?? ""),
    redactions,
    ...(flags.length ? { flags } : {}),
    ...(raw.own_voice === true ? { own_voice: true } : {}),
  };
}

const TIGHTEN: PiiLabel[] = ["email", "phone", "iban", "bank_account", "address", "id_number", "date_of_birth"];
/** Per call to the detector; a check that does not finish counts as unchecked. */
const PII_DEADLINE_MS = 60_000;

/**
 * Runs the configured detector over every field of an item's guarded text (the fields a prompt or a view can carry). Hits become `guard:pii:<label>` flags; a
 * tightening label makes the item personal through the one-way rule in `envelopeFrom`. A detector
 * that fails or times out leaves `guard:pii:unchecked`, and the item is kept as personal: fail closed.
 */
export async function checkPii(pii: PiiConfig, raw: RawItem, e: Envelope, src: Pick<Source, "name" | "trust" | "privacy_class">): Promise<Envelope> {
  let labels: string[];
  let tighten = false;
  try {
    const hits = await withDeadline(pii.port.detect(itemText(e)), PII_DEADLINE_MS, `pii ${pii.port.name}`);
    // An IBAN the secret shapes already redacted is still an IBAN: the value is gone, the item is still personal.
    const kept = [...hits.filter((h) => h.score >= (pii.minScore ?? 0.5)), ...(e.redactions.includes("iban") ? [{ label: "iban" as const, score: 1 }] : [])];
    labels = [...new Set(kept.map((h) => h.label))].sort();
    tighten = kept.some((h) => (pii.tighten ?? TIGHTEN).includes(h.label));
  } catch {
    labels = ["unchecked"];
    tighten = true;
  }
  if (!labels.length) return e;
  const flags = [...(raw.flags ?? []), ...labels.map((l) => `${GUARD_FLAG}pii:${l}`)];
  const checked = envelopeFrom({ ...raw, flags, ...(tighten ? { privacy_class: "personal" as const } : {}) }, src);
  return { ...checked, captured_at: e.captured_at };
}

export function identityOf(url: string | undefined, externalId: string, source: string): string {
  return sha256(url ? normalizeUrl(url) : `${source}\u0000${externalId}`).slice(0, 16);
}

const HEALTH_FILE = "health.json";

export function readHealth(dataDir: string): Record<string, SourceHealth> {
  try {
    return JSON.parse(readFileSync(join(dataDir, HEALTH_FILE), "utf8"));
  } catch {
    return {};
  }
}

function writeHealth(dataDir: string, h: Record<string, SourceHealth>): void {
  const tmp = join(dataDir, `${HEALTH_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(h, null, 2)}\n`);
  renameSync(tmp, join(dataDir, HEALTH_FILE));
}

/**
 * Which rules apply to an item: those of every job that lists its source. One function for
 * run, regrade and rebuild, so they cannot route differently. A source no job lists (an ad-hoc
 * stdin source) gets `fallback`; declare stdin sources in their job to route them stably.
 */
function rulesFor(cfg: FeedConfig, source: string, fallback?: Rule[]): Rule[] {
  const own = Object.values(cfg.jobs).filter((j) => j.sources.some((s) => s.name === source));
  if (own.length) return own.flatMap((j) => j.rules);
  return fallback ?? Object.values(cfg.jobs).flatMap((j) => j.rules);
}

/** Is this item the owner's own voice (a configured voice source)? Those are never graded as content. */
export const isOwnVoice = (cfg: FeedConfig, e: Pick<Envelope, "source" | "own_voice">) =>
  Boolean(cfg.voice?.sources.includes(e.source) || (e.own_voice === true && cfg.voice?.marked?.includes(e.source)));

/**
 * The owner's own voice never carries the third-party quality scale: grades made before the
 * own-voice stage existed still hold it in grades.jsonl, and it is dropped here, before any rule,
 * view or digest sees it.
 */
export function ownVoiceGrade(g: Grade): Grade {
  const { quality: _q, tier: _t, importance: _i, novelty: _n, urgency: _u, ...rest } = g;
  return rest;
}

/** `approved`: the `<id> <content hash>` pairs he approved in review (views only; a delivery still holds a suspect item). */
function toGraded(cfg: FeedConfig, e: Envelope, g: Grade, rules: Rule[], approved?: Set<string>): GradedItem & { sinks: string[] } {
  const own = isOwnVoice(cfg, e);
  const grade = own ? ownVoiceGrade(g) : g;
  const assessed = riskOf(e);
  const risk = assessed.level === "suspect" && approved?.has(`${e.id} ${e.content_hash}`) ? { ...assessed, approved: true } : assessed;
  const r = route(rules, e, grade, risk);
  // `own_voice` tells every view this is his voice: a memory view then carries only the recorder's abstract.
  return { ...e, ...(own ? { own_voice: true } : {}), grade, risk, rules: r.rules, priority: r.priority, sinks: r.sinks };
}

const accepts = (sink: FeedConfig["sinks"][string], e: Envelope) =>
  (sink.accepts ?? (sink.kind === "view" ? ["public", "personal"] : ["public"])).includes(e.privacy_class);

async function deliver(cfg: FeedConfig, ledger: Ledger, items: (GradedItem & { sinks: string[] })[], ctx: RunContext, report: RunReport) {
  for (const item of items) {
    for (const name of item.sinks) {
      const sink = cfg.sinks[name];
      if (!sink) throw new Error(`rule routes to unknown sink "${name}"`);
      if (sink.kind !== "delivery" || !accepts(sink, item) || ledger.wasDelivered(item.id, name)) continue;
      // A suspect item reaches a delivery only through a person: a review queue, or a sink that says it takes them.
      if (item.risk?.level === "suspect" && !isReviewSink(sink) && !sink.acceptsRisk) {
        report.held.push({ sink: name, id: item.id, flags: item.risk.flags });
        continue;
      }
      try {
        const { ref, skipped } = await sink.deliver(item, ctx);
        if (!ctx.dryRun && !skipped) ledger.recordDelivery({ id: item.id, sink: name, at: new Date().toISOString(), ok: true, ref });
        report.delivered.push({ sink: name, id: item.id, ok: true, ...(skipped ? { error: `rehearsed: ${ref}` } : {}) });
      } catch (err) {
        const error = (err as Error).message;
        if (!ctx.dryRun) ledger.recordDelivery({ id: item.id, sink: name, at: new Date().toISOString(), ok: false, error });
        report.delivered.push({ sink: name, id: item.id, ok: false, error });
      }
    }
  }
}

/** Every item in the ledger with its newest grade, routed by today's rules. */
export function allGraded(cfg: FeedConfig, ledger: Ledger): (GradedItem & { sinks: string[] })[] {
  const grades = ledger.latestGrades();
  const approved = approvedTexts(cfg.dataDir);
  const out: (GradedItem & { sinks: string[] })[] = [];
  for (const e of ledger.envelopes()) {
    const g = grades.get(e.id);
    if (g) out.push(toGraded(cfg, e, g, rulesFor(cfg, e.source), approved));
  }
  return out;
}

/**
 * Views are compiled from the whole ledger, so deleting one and re-rendering loses nothing.
 * One failing view never stops the others or the run: its error is reported and kept in health
 * (as "view · <name>"), and the next run tries again.
 */
export async function renderViews(cfg: FeedConfig, ledger: Ledger, ctx: RunContext): Promise<string[]> {
  const all = allGraded(cfg, ledger);
  const refs: string[] = [];
  const health = readHealth(cfg.dataDir);
  for (const [name, sink] of Object.entries(cfg.sinks)) {
    if (sink.kind !== "view") continue;
    const items = all.filter((i) => i.sinks.includes(name) && accepts(sink, i));
    const key = `view · ${name}`;
    const h: SourceHealth = health[key] ?? { consecutive_failures: 0, last_pulled: 0, last_fresh: 0 };
    try {
      const { ref } = await sink.render(items, ctx);
      refs.push(`${name} (${items.length}) → ${ref ?? ""}`);
      Object.assign(h, { last_ok: new Date().toISOString(), consecutive_failures: 0, last_pulled: items.length, last_fresh: 0 });
    } catch (err) {
      const msg = (err as Error).message;
      refs.push(`${name} FAILED: ${msg}`);
      Object.assign(h, { last_error: msg, last_error_at: new Date().toISOString(), consecutive_failures: h.consecutive_failures + 1 });
    }
    health[key] = h;
  }
  if (!ctx.dryRun) writeHealth(cfg.dataDir, health);
  return refs;
}

/** A source that hangs must not hold the whole run: every pull has a deadline. */
export const PULL_DEADLINE_MS = Number(process.env.FEED_PULL_DEADLINE_MS ?? 10 * 60_000);

export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

/**
 * One writer at a time: every command that writes the ledger, receipts or views takes this lock.
 * A second process (a manual run during the hourly job) gets `null` and should stand down.
 * A lock left by a dead process is taken over.
 */
export function acquireLock(dataDir: string): (() => void) | null {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "run.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch {
      const holder = Number(readFileSync(path, "utf8").trim());
      let alive = false;
      try {
        if (holder > 0) process.kill(holder, 0);
        alive = holder > 0;
      } catch {
        alive = false;
      }
      if (alive && holder !== process.pid) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

export async function ingest(cfg: FeedConfig, job: Job, pulls: { source: Source; items?: RawItem[] }[], ctx: RunContext): Promise<RunReport> {
  const ledger = new Ledger(cfg.dataDir);
  const { profile, hash } = loadIntent(cfg.intent);
  const report: RunReport = { sources: [], fresh: [], delivered: [], held: [], views: [], ledgerSize: 0 };
  const fresh: Envelope[] = [];
  const revised = new Set<string>();

  const health = readHealth(cfg.dataDir);
  for (const { source, items } of pulls) {
    const sr: SourceReport = { source: source.name, pulled: 0, fresh: 0 };
    report.sources.push(sr);
    const h: SourceHealth = health[source.name] ?? { consecutive_failures: 0, last_pulled: 0, last_fresh: 0 };
    health[source.name] = h;
    const sourceCtx: RunContext = { ...ctx, known: (i) => ledger.has({ id: identityOf(i.url, i.external_id, source.name), content_hash: "", content: "" }) };
    // Daniel's self-cleaning: a demoted source is skipped until reset; after 5 straight failures the
    // circuit opens and the source is tried once every 6 hours instead of every run.
    if (!items && h.demoted_at) {
      sr.error = `demoted ${h.demoted_at.slice(0, 10)}: ${h.demoted_reason ?? ""} (reset: source reset "${source.name}")`;
      continue;
    }
    if (!items && h.consecutive_failures >= CIRCUIT_FAILURES && h.last_error_at && Date.now() - Date.parse(h.last_error_at) < CIRCUIT_COOLDOWN_MS) {
      sr.error = `circuit open after ${h.consecutive_failures} failures, next try after ${new Date(Date.parse(h.last_error_at) + CIRCUIT_COOLDOWN_MS).toISOString().slice(11, 16)} UTC`;
      continue;
    }
    let raws: RawItem[];
    try {
      raws = items ?? (await withDeadline(source.pull(sourceCtx), PULL_DEADLINE_MS, source.name));
    } catch (err) {
      sr.error = (err as Error).message;
      h.last_error = sr.error;
      h.last_error_at = new Date().toISOString();
      h.consecutive_failures++;
      continue;
    }
    sr.pulled = raws.length;
    const piiHere = cfg.pii?.sources.includes(source.name) ? cfg.pii : undefined;
    for (const raw of raws) {
      let e = envelopeFrom(raw, source);
      const revision = ledger.isRevision(e);
      if ((ledger.has(e) && !revision) || fresh.some((f) => f.id === e.id)) continue;
      // Only what is about to be journaled is checked: a known item never reaches the detector again.
      if (piiHere) e = await checkPii(piiHere, raw, e, source);
      if (revision) revised.add(e.id);
      if (!ctx.dryRun) ledger.append(e);
      fresh.push(e);
      sr.fresh++;
    }
    h.last_ok = new Date().toISOString();
    h.consecutive_failures = 0;
    h.last_pulled = sr.pulled;
    h.last_fresh = sr.fresh;
  }
  if (!ctx.dryRun && pulls.length) writeHealth(cfg.dataDir, health);

  // Settle the whole ledger, not just this run's catch: an item stranded by a crash between
  // journal and grade gets graded now, and every (item, sink) pair without a receipt (a failed
  // or rehearsed delivery) is tried again. Receipts keep this idempotent.
  const grades = ledger.latestGrades();
  const freshIds = new Set(fresh.map((e) => e.id));
  const envelopes = (ctx.dryRun ? [...new Map([...ledger.envelopes(), ...fresh].map((e) => [e.id, e])).values()] : ledger.envelopes()).filter(
    (e) => e.content.length >= (cfg.minContentChars ?? 0),
  );
  // A revision is graded again from scratch: its old grade, model grade included, judged other text.
  for (const e of envelopes) {
    if (grades.has(e.id) && !revised.has(e.id)) continue;
    const g = gradeDeterministic(e, profile, hash);
    grades.set(e.id, g);
    if (!ctx.dryRun) ledger.appendGrade(g);
  }

  // Daniel's Summarize + Rate, within a budget: fresh items first, then the backlog, newest first.
  report.model = await modelPhase(cfg, ledger, envelopes, grades, freshIds, profile, hash, ctx);
  // His own conversations and notes, reduced to typed candidates in the review queue.
  report.voice = await voicePhase(cfg, ledger, envelopes, grades, freshIds, profile, ctx);

  const all = envelopes.map((e) => toGraded(cfg, e, grades.get(e.id)!, rulesFor(cfg, e.source, freshIds.has(e.id) ? job.rules : undefined)));
  report.fresh = all.filter((i) => freshIds.has(i.id));
  if (!ctx.dryRun && pulls.length) updateReputation(cfg, all);

  await deliver(cfg, ledger, all, ctx, report);
  report.views = await renderViews(cfg, ledger, ctx);
  report.ledgerSize = ledger.size();
  return report;
}

const CIRCUIT_FAILURES = 5;
const CIRCUIT_COOLDOWN_MS = 6 * 3600_000;

/**
 * Upgrades deterministic grades to model grades, at most `maxCallsPerRun` per run
 * (FEED_MODEL_MAX overrides, e.g. for a backfill). FEED_MODEL_REGRADE=1 also re-asks the model
 * for items whose model grade was made against an older intent profile.
 */
async function modelPhase(
  cfg: FeedConfig,
  ledger: Ledger,
  envelopes: Envelope[],
  grades: Map<string, Grade>,
  freshIds: Set<string>,
  profile: IntentProfile,
  hash: string,
  ctx: RunContext,
): Promise<RunReport["model"]> {
  const m = cfg.model;
  if (!m) return undefined;
  const regradeStale = process.env.FEED_MODEL_REGRADE === "1";
  const wanted = envelopes
    .filter((e) => m.port.acceptsPersonal || e.privacy_class === "public")
    .filter((e) => {
      const g = grades.get(e.id);
      // An own-voice grade made on the quality scale is not re-asked: toGraded drops the scale, and the relevance stands.
      return !isModelGrade(g) || (regradeStale && g!.profile_hash !== hash);
    })
    .sort((a, b) => Number(freshIds.has(b.id)) - Number(freshIds.has(a.id)) || b.captured_at.localeCompare(a.captured_at));
  // One budget per run, shared by every job that runs on this context, not one per job.
  const asked = Number(process.env.FEED_MODEL_MAX ?? m.maxCallsPerRun ?? 60);
  ctx.modelBudget ??= { left: Number.isFinite(asked) ? Math.max(0, Math.floor(asked)) : 60 };
  const batch = wanted.slice(0, ctx.modelBudget.left);
  ctx.modelBudget.left -= batch.length;
  const stats = { port: m.port.name, graded: 0, failed: 0, waiting: wanted.length - batch.length, error: undefined as string | undefined };
  if (ctx.dryRun) return { ...stats, waiting: wanted.length };
  await pool(batch, m.concurrency ?? 3, async (e) => {
    try {
      // A fresh deterministic base: re-grading on a stale model grade would make its relevance the new keyword floor.
      const g = await modelGrade(e, profile, gradeDeterministic(e, profile, hash), m, ctx.modelBudget, isOwnVoice(cfg, e));
      const prior = grades.get(e.id)?.extraction_confidence;
      if (prior !== undefined) g.extraction_confidence = prior;
      grades.set(e.id, g);
      ledger.appendGrade(g);
      stats.graded++;
    } catch (err) {
      stats.failed++;
      stats.error = (err as Error).message;
    }
  });
  return { ...stats, port: m.port.name };
}

/** Read from the item's present text, under its present mark: a reading of an older text is never current. */
function isCurrentReading(c: VoiceItem, r: ExtractionRow, textOf: Map<string, string>): boolean {
  return c.content_hash === r.content_hash && c.marked === r.marked && (textOf.get(c.item) ?? c.content_hash) === c.content_hash;
}

/**
 * What may still be offered to him, most useful first: candidates of current readings, not waiting,
 * not decided, not the same words as one already offered, and not the identical sentence of a point he
 * decided (those are counted as `alreadyDecided`). A candidate that overlaps a decided point otherwise
 * is offered and carries `related`, so a reversal reaches him. The queue, the digest and `swb-feed
 * voice` all count from this one list. `textOf`: each own-voice item's present content hash.
 */
export function voiceOfferable(cfg: FeedConfig, textOf?: Map<string, string>): { fresh: VoiceItem[]; alreadyDecided: number } {
  const texts = textOf ?? new Map(new Ledger(cfg.dataDir).envelopes().filter((e) => isOwnVoice(cfg, e)).map((e) => [e.id, e.content_hash]));
  const current = extractions(cfg.dataDir);
  const rows = reviewRows(cfg.dataDir);
  const known = blockedIds(cfg.dataDir);
  const offered = rows.flatMap((r) => (r.voice && r.decision === "queued" && known.has(r.id) ? [r.voice] : []));
  // Decided: approved or rejected, and also an approval that was started and interrupted (it may have
  // written already), so a re-read never offers that point unlinked and a second entry cannot follow.
  const finals = new Map(rows.filter((r) => r.decision === "approved" || r.decision === "rejected").map((r) => [r.id, r]));
  const interrupted = openIntents(cfg.dataDir);
  const decided = rows.flatMap((r) => {
    const f = finals.get(r.id) ?? interrupted.get(r.id);
    if (!r.voice || r.decision !== "queued" || !f) return [];
    const decision = f.decision === "approving" ? ("interrupted" as const) : (f.decision as "approved" | "rejected");
    return [{ v: r.voice, decision, at: f.at, kind: f.landed_kind ?? r.voice.kind }];
  });
  let alreadyDecided = 0;
  const fresh: VoiceItem[] = [];
  for (const c of completedVoiceItems(cfg.dataDir)) {
    const cur = current.get(c.item);
    if (known.has(c.id) || !cur || !isCurrentReading(c, cur, texts) || fresh.some((x) => x.id === c.id)) continue;
    if (decided.some((d) => alreadyDecided_(c, d.v))) {
      alreadyDecided++;
      continue;
    }
    if (offered.some((o) => samePoint(o, c))) continue;
    const rel = decided.find((d) => relatedPoint(c, d.v));
    fresh.push(rel ? { ...c, related: { id: rel.v.id, kind: rel.kind, decision: rel.decision, at: rel.at, quote: rel.v.quote, ...(rel.v.sentence ? { sentence: rel.v.sentence } : {}) } } : c);
  }
  return { fresh: fresh.sort(offerOrder), alreadyDecided };
}

/**
 * Reads the owner's own items into typed candidates, within the run's shared model budget.
 * - Window: items captured since the stage first ran (its start row), plus whatever he ordered with
 *   `voice backfill --since <date>`. Nothing older is read by default.
 * - An item starts only when all its chunks fit the budget; fresh items first, then the newest.
 * - Each fully read item gets one extraction row (per content hash, so a revision is read again) and
 *   its grade gains the extraction's confidence. A failed read is a failure row; after
 *   `failuresBeforePark` of them the item is parked until `voice reset <id>`, so a poison item stops
 *   burning the budget.
 * - Offering: at most `maxNewPerRun` new candidates per run reach his queue, most useful first; the
 *   rest wait in voice.jsonl and are offered on later runs. A candidate that says again what a known
 *   one of the same conversation said is never offered.
 */
async function voicePhase(
  cfg: FeedConfig,
  ledger: Ledger,
  envelopes: Envelope[],
  grades: Map<string, Grade>,
  freshIds: Set<string>,
  profile: IntentProfile,
  ctx: RunContext,
): Promise<RunReport["voice"]> {
  const v = cfg.voice;
  if (!v) return undefined;
  const port = v.port ?? cfg.model?.port;
  const stats = { port: port?.name ?? "none", extracted: 0, queued: 0, unoffered: 0, already_decided: 0, withdrawn: 0, calls: 0, failed: 0, waiting: 0, parked: 0, warnings: 0, error: undefined as string | undefined };
  const window = voiceWindow(cfg.dataDir);
  const firstFresh = envelopes.filter((e) => freshIds.has(e.id)).map((e) => e.captured_at).sort()[0];
  const start = window.start ?? firstFresh ?? new Date().toISOString();
  if (!window.start && !ctx.dryRun) markStart(cfg.dataDir, start);
  const inWindow = (e: Envelope) => e.captured_at >= start || (window.backfill !== undefined && (e.published_at ?? e.captured_at) >= window.backfill);
  const read = extractions(cfg.dataDir);
  const failed = failures(cfg.dataDir);
  const mine = mineConversations(cfg.dataDir);
  const markOf = (e: Envelope) => mine.get(markKey(e.source, e.external_id));
  // A reading is current for one text under one conversation mark: a revision or a changed mark makes
  // it stale, and an item read before is read again even when its capture predates the window.
  const stale = (e: Envelope) => {
    const r = read.get(e.id);
    return !r || r.content_hash !== e.content_hash || r.marked !== markOf(e);
  };
  const park = v.failuresBeforePark ?? 3;
  const own = envelopes.filter((e) => isOwnVoice(cfg, e) && (inWindow(e) || read.has(e.id)) && stale(e));
  const parked = own.filter((e) => (failed.get(e.id)?.filter((f) => f.content_hash === e.content_hash).length ?? 0) >= park);
  stats.parked = parked.length;
  const wanted = own
    .filter((e) => !parked.includes(e))
    .sort((a, b) => Number(freshIds.has(b.id)) - Number(freshIds.has(a.id)) || (b.published_at ?? b.captured_at).localeCompare(a.published_at ?? a.captured_at));
  // A revision is withdrawn from his queue the moment it is seen, before anything is read (and even
  // with no personal port): a candidate from an older text is never approvable.
  const textOf = new Map(envelopes.filter((e) => isOwnVoice(cfg, e)).map((e) => [e.id, e.content_hash]));
  // A candidate whose approval was interrupted is never withdrawn: repeating that approval completes it.
  const interrupted = openIntents(cfg.dataDir);
  if (!ctx.dryRun) {
    for (const r of pendingReviews(cfg.dataDir)) {
      const hash = r.voice ? textOf.get(r.voice.item) : undefined;
      if (r.voice && hash && r.voice.content_hash !== hash && !interrupted.has(r.id)) {
        supersedeVoice(cfg.dataDir, r, "the conversation was revised");
        stats.withdrawn++;
      }
    }
  }
  if (!port || !port.acceptsPersonal) {
    // Personal items reach only a port cleared for them: without one, nothing is read and nothing is sent.
    return { ...stats, waiting: wanted.length, error: port ? `port ${port.name} does not accept personal items` : "no model port" };
  }
  if (ctx.dryRun) return { ...stats, waiting: wanted.length };
  const asked = Number(process.env.FEED_MODEL_MAX ?? cfg.model?.maxCallsPerRun ?? 60);
  ctx.modelBudget ??= { left: Number.isFinite(asked) ? Math.max(0, Math.floor(asked)) : 60 };
  for (const e of wanted) {
    const chunks = voiceChunks(e, v.chunkChars).chunks.length;
    if (chunks === 0) continue;
    if (chunks > ctx.modelBudget.left) {
      stats.waiting++;
      continue;
    }
    const before = ctx.modelBudget.left;
    try {
      const r = await extractVoice(e, profile, port, { budget: ctx.modelBudget, chunkChars: v.chunkChars, owner: cfg.model?.context, ownerLabels: v.ownerLabels, allHis: e.own_voice === true, ...(markOf(e) ? { mine: { at: markOf(e)! } } : {}) });
      recordExtraction(cfg.dataDir, e, r);
      stats.warnings += r.warnings.length;
      const g = grades.get(e.id);
      if (g) {
        const withConfidence: Grade = { ...ownVoiceGrade(g), extraction_confidence: extractionConfidence(r.items) };
        grades.set(e.id, withConfidence);
        ledger.appendGrade(withConfidence);
      }
      stats.extracted++;
    } catch (err) {
      stats.failed++;
      stats.error = (err as Error).message;
      // Only an answer that cannot be read (prose, or JSON without items) counts toward parking;
      // a spent budget or a port outage never does.
      if (err instanceof UnreadableAnswer) recordFailure(cfg.dataDir, e, stats.error);
    }
    stats.calls += before - ctx.modelBudget.left;
  }
  // Every recorded candidate reaches his queue in time, a few per run (the count is shared by every
  // job of this run). This also queues what a run recorded but did not queue before a crash.
  // A newer reading supersedes: a pending candidate from an older text, or from before his mark changed, is withdrawn.
  const current = extractions(cfg.dataDir);
  for (const r of pendingReviews(cfg.dataDir)) {
    const cur = r.voice ? current.get(r.voice.item) : undefined;
    if (!r.voice || !cur || isCurrentReading(r.voice, cur, textOf) || interrupted.has(r.id)) continue;
    supersedeVoice(cfg.dataDir, r, r.voice.content_hash !== cur.content_hash ? "the conversation was revised" : "his conversation mark changed");
    stats.withdrawn++;
  }
  const { fresh, alreadyDecided: skipped } = voiceOfferable(cfg, textOf);
  stats.already_decided = skipped;
  ctx.voiceOffers ??= { left: Math.max(0, v.maxNewPerRun ?? 10) };
  const known = blockedIds(cfg.dataDir);
  const queuedNow: VoiceItem[] = [];
  for (const c of fresh) {
    if (ctx.voiceOffers.left <= 0) break;
    if (queuedNow.some((o) => samePoint(o, c))) continue;
    if (queueVoice(cfg.dataDir, c, known)) {
      stats.queued++;
      ctx.voiceOffers.left--;
      queuedNow.push(c);
    }
  }
  stats.unoffered = fresh.filter((c) => !known.has(c.id) && !queuedNow.some((o) => samePoint(o, c))).length;
  return stats;
}

/** Rolling reputation per source over the window, and Daniel's auto-demotion of chronic low quality. */
function updateReputation(cfg: FeedConfig, all: GradedItem[]): void {
  if (cfg.reputation === false) return;
  const r = cfg.reputation ?? {};
  const since = new Date(Date.now() - (r.windowDays ?? 7) * 86400_000).toISOString();
  const health = readHealth(cfg.dataDir);
  const bySource = new Map<string, GradedItem[]>();
  // His own voice is never rated as content, so it never earns or loses a place by quality.
  for (const i of all) if (i.captured_at >= since && !isOwnVoice(cfg, i)) bySource.set(i.source, [...(bySource.get(i.source) ?? []), i]);
  for (const [name, items] of bySource) {
    const h: SourceHealth = health[name] ?? { consecutive_failures: 0, last_pulled: 0, last_fresh: 0 };
    const rated = items.map((i) => i.grade.quality).filter((q): q is number => typeof q === "number");
    h.rolling_items = items.length;
    h.rolling_avg_quality = rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : undefined;
    h.rolling_a_rate = rated.length ? Math.round((rated.filter((q) => q >= 70).length / rated.length) * 1000) / 1000 : undefined;
    if (!h.demoted_at && rated.length >= (r.minItems ?? 30) && (h.rolling_avg_quality ?? 100) < (r.maxAvgQuality ?? 35) && h.rolling_a_rate === 0) {
      h.demoted_at = new Date().toISOString();
      h.demoted_reason = `chronic low quality: ${rated.length} rated items, mean ${h.rolling_avg_quality}, none at 70+`;
    }
    health[name] = h;
  }
  writeHealth(cfg.dataDir, health);
}

/** Lifts a demotion and closes the circuit for one source. */
export function resetSource(dataDir: string, name: string): boolean {
  const health = readHealth(dataDir);
  const h = health[name];
  if (!h) return false;
  delete h.demoted_at;
  delete h.demoted_reason;
  h.consecutive_failures = 0;
  writeHealth(dataDir, health);
  return true;
}

export function runJob(cfg: FeedConfig, name: string, ctx: RunContext): Promise<RunReport> {
  const job = cfg.jobs[name];
  if (!job) throw new Error(`no job "${name}" (have: ${Object.keys(cfg.jobs).join(", ")})`);
  return ingest(cfg, job, job.sources.map((source) => ({ source })), ctx);
}

/** Re-grade the whole ledger against the current profile: no network, then deliver and re-render. */
export async function regrade(cfg: FeedConfig, ctx: RunContext): Promise<{ changed: number; total: number; views: string[]; report: RunReport }> {
  const ledger = new Ledger(cfg.dataDir);
  const { profile, hash } = loadIntent(cfg.intent);
  const before = ledger.latestGrades();
  const report: RunReport = { sources: [], fresh: [], delivered: [], held: [], views: [], ledgerSize: ledger.size() };
  const items: (GradedItem & { sinks: string[] })[] = [];
  let changed = 0;
  for (const e of ledger.envelopes()) {
    if (e.content.length < (cfg.minContentChars ?? 0)) continue;
    const prior = before.get(e.id);
    // A model grade is kept: re-asking the model is a network call (`FEED_MODEL_REGRADE=1 … run`).
    if (prior && isModelGrade(prior)) {
      items.push(toGraded(cfg, e, prior, rulesFor(cfg, e.source)));
      continue;
    }
    const g = gradeDeterministic(e, profile, hash);
    if (prior?.extraction_confidence !== undefined) g.extraction_confidence = prior.extraction_confidence;
    if (prior?.score !== g.score) changed++;
    if (!ctx.dryRun) ledger.appendGrade(g);
    items.push(toGraded(cfg, e, g, rulesFor(cfg, e.source)));
  }
  await deliver(cfg, ledger, items, ctx, report);
  const views = await renderViews(cfg, ledger, ctx);
  return { changed, total: items.length, views, report };
}
