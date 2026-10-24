#!/usr/bin/env bun
// swb-feed: run jobs, ingest from a pipe, re-grade, rebuild views, explain one item.
// Reports go to stderr so stdout stays clean for the jsonl sink.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FeedConfig, RawItem, RunContext, Source } from "./types.ts";
import { acquireLock, identityOf, ingest, withDeadline, PULL_DEADLINE_MS, regrade, renderViews, resetSource, runJob, allGraded, readHealth, voiceOfferable, type RunReport } from "./pipeline.ts";
import { isModelGrade } from "./model.ts";
import { Ledger, skippedRows, unversioned } from "./ledger.ts";
import { clip } from "./text.ts";
import { displayItem, isHeld, riskOf, shownTitle } from "./guard.ts";
import { approveReview, pendingReviews, previewVoice, rejectReview, restoreVoice, reviewRows, triageVoice, withdrawPending, type ReviewRow } from "../sinks/review.ts";
import { extractedAt, extractions, failures, markBackfill, markKey, markMine, MAX_WAITING, mineConversations, OFFER_ORDER, offerOrder, proposeProject, resetVoice, voiceItems, voiceWindow } from "./voice.ts";
import type { IntentProfile, VoiceItem } from "./types.ts";
import { plain, voiceBody } from "../sinks/voice.ts";
import { loadIntent } from "./intent.ts";

const USAGE = `swb-feed — feed any second brain

  swb-feed run [job…]            harvest the sources of each job (all jobs if none)
  swb-feed pull <job> <source>   run one source alone: its items as JSONL on stdout, then one swb_pull_end line, raw (before the
                                 guard), nothing written; pipe it into ingest, never paste it
  swb-feed ingest <job> <source> read JSONL items from stdin, as if <source> had pulled them
  swb-feed regrade               re-grade the whole ledger against the current intent profile
  swb-feed rebuild               regenerate every view (wiki, page) from the ledger alone
  swb-feed explain <id>          one item's trail: capture, guard, grade, rules, deliveries
  swb-feed status                ledger size, sources, sinks, jobs, reputation
  swb-feed source reset <name>   lift a demotion and close the failure circuit for one source
  swb-feed review [list]         what waits for a person: one sitting of his own voice, grouped by project
  swb-feed review approve <id>   hand one to the sink it was queued for (writes it, with a receipt)
                                 a voice candidate lands in its project's record; --project <name> re-links it,
                                 --kind <kind> re-types it (his call: the one way a held item becomes a decision)
  swb-feed review show <id>      the exact text an approval would write
  swb-feed review reject <id>    close one for good: it is never offered again
                                 approving or rejecting a voice candidate settles the repeats it stands for
  swb-feed review triage         one sitting: park what is not his voice, defer his own past maxWaiting (--dry-run)
  swb-feed review parked         the candidates that are not his voice, recorded, never offered
  swb-feed review restore <id>|--all   queue parked candidates again; a triage never parks them twice
  swb-feed voice                 the own-voice stage: window, items read, candidates waiting, parked items
  swb-feed voice backfill --since <date>   also read his conversations from that date on
  swb-feed voice reset <id>      try a parked item again
  swb-feed voice mine <conversation-id>    every turn of that conversation is his (unmine: undo)

  --config <file>   default ./feed.config.ts      --dry-run   change nothing on disk or remote`;

const err = (s: string) => process.stderr.write(`${s}\n`);

// Strict parsing: a mistyped flag must stop the run, because `--dryrun` silently ignored
// would mean a live run with real deliveries.
const BOOL_FLAGS = new Set(["--dry-run", "--help", "--all"]);
const VALUE_FLAGS = new Set(["--config", "--project", "--kind", "--since", "--source"]);
let flags = new Set<string>();
let values = new Map<string, string>();
let positional: string[] = [];
let cmd: string | undefined;
let rest: string[] = [];
let loaderOverride: (() => Promise<FeedConfig>) | undefined;

function parseArgs(argv: string[]) {
  flags = new Set();
  values = new Map();
  positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (BOOL_FLAGS.has(name) && inline === undefined) flags.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith("--")) {
        err(`swb-feed: ${name} needs a value`);
        process.exit(2);
      }
      values.set(name, v);
    } else {
      err(`swb-feed: unknown option ${a} (known: ${[...BOOL_FLAGS, ...VALUE_FLAGS].join(", ")})`);
      process.exit(2);
    }
  }
  [cmd, ...rest] = positional;
}
const flag = (n: string) => flags.has(n);
const opt = (n: string) => values.get(n);

async function loadConfig(): Promise<FeedConfig> {
  if (loaderOverride) return loaderOverride();
  const path = resolve(opt("--config") ?? "feed.config.ts");
  const mod = await import(path);
  process.chdir(dirname(path)); // relative paths in the config resolve next to it
  return mod.default as FeedConfig;
}

function ctx(): RunContext {
  return { dataDir: "", dryRun: flag("--dry-run"), log: err, fetch };
}

function printReport(name: string, r: RunReport) {
  err(`\n▸ job ${name}${flag("--dry-run") ? " (dry run)" : ""}`);
  for (const s of r.sources) err(`  ${s.error ? "✗" : "✓"} ${s.source.padEnd(28)} ${s.error ? s.error : `${s.pulled} pulled, ${s.fresh} new`}`);
  if (r.fresh.length) {
    err(`\n  ${r.fresh.length} new items, best first:`);
    for (const i of [...r.fresh].sort((a, b) => b.grade.score - a.grade.score).slice(0, 8)) {
      err(`  ${String(i.grade.score).padStart(3)} ${gradeTag(i.grade)}  ${shownTitle(i.title, i.risk, 60).padEnd(62)} ${i.grade.projects.join(", ")}`); // G3
    }
  }
  if (r.model) {
    const m = r.model;
    err(`\n  model ${m.port}: ${m.graded} graded, ${m.failed} failed, ${m.waiting} waiting${m.error ? ` (last error: ${clip(m.error, 100)})` : ""}`);
  }
  if (r.voice) {
    const v = r.voice;
    err(`  own voice ${v.port}: ${v.extracted} read, ${v.queued} candidates offered for review${v.unoffered ? ` (${v.unoffered} more wait for later runs)` : ""}${v.already_decided ? `, ${v.already_decided} already decided by him (not offered again)` : ""}${v.withdrawn ? `, ${v.withdrawn} withdrawn` : ""}, ${v.calls} calls, ${v.failed} failed, ${v.waiting} waiting${v.parked ? `, ${v.parked} parked (voice reset <id>)` : ""}${v.warnings ? `, ${v.warnings} injection warning(s): see explain` : ""}${v.error ? ` (last error: ${clip(v.error, 100)})` : ""}`);
  }
  const rehearsed = r.delivered.filter((d) => d.ok && d.error?.startsWith("rehearsed"));
  const ok = r.delivered.filter((d) => d.ok).length - rehearsed.length;
  const bad = r.delivered.filter((d) => !d.ok);
  if (r.delivered.length) err(`\n  delivered ${ok}${bad.length ? `, failed ${bad.length} (${bad[0].sink}: ${bad[0].error})` : ""}`);
  if (rehearsed.length) err(`  rehearsed ${rehearsed.length} (no receipt): ${rehearsed[0].sink} ${rehearsed[0].error!.replace(/^rehearsed: /, "")}`);
  if (r.held.length) err(`  held ${r.held.length} suspect (guard): ${r.held[0].sink} ← ${r.held[0].id} (${r.held[0].flags.join(", ")}); explain <id> shows why`);
  for (const v of r.views) err(`  view ${v}`);
  err(`  ledger: ${r.ledgerSize} items`);
}

/**
 * A voice candidate in the review list: id, the suggested kind, project, then the exact text a plain
 * approval writes (it lands as an idea), unclipped, and below it the full transcript sentence, which
 * is shown here and never written. `review show <id> --kind … --project …` previews other flags.
 */
export function voiceLines(r: ReviewRow, proposal?: { project: string; term: string }): string[] {
  const v = r.voice!;
  return [
    `  ${r.id.slice(0, 12)}  suggested ${v.kind} · ${v.project ?? (proposal ? `no project yet, proposed ${proposal.project}` : "no project yet")} · ${v.date}`,
    ...voiceBody(v, { kind: "idea", typed: false }).map((l) => (l ? `      ${l}` : "")),
    ...(proposal ? [`      proposed from "${plain(proposal.term)}": review approve ${r.id.slice(0, 12)} --project ${proposal.project}`] : []),
    ...(v.sentence ? [`      (shown, never written) in its sentence: „${plain(v.sentence)}"`] : []),
    ...(v.related?.sentence ? [`      (shown, never written) the earlier one's sentence: „${plain(v.related.sentence)}"`] : []),
    "",
  ];
}

/**
 * One sitting, as he reads it: his candidates under their project (or the one proposed for them), the
 * projects with most waiting first and "no project yet" last; inside each, decisions and questions first.
 */
/** `held`: own-voice items the guard holds (item id → flags); a candidate read from one is marked. */
export function voiceSitting(waiting: ReviewRow[], profile: Pick<IntentProfile, "projects">, held: Map<string, string[]> = new Map()): string[] {
  const groups = new Map<string, { r: ReviewRow; proposal?: { project: string; term: string } }[]>();
  for (const r of waiting) {
    if (!r.voice) continue;
    const proposal = proposeProject(r.voice, profile);
    const key = r.voice.project ?? proposal?.project ?? "";
    groups.set(key, [...(groups.get(key) ?? []), { r, ...(proposal ? { proposal } : {}) }]);
  }
  const keys = [...groups.keys()].sort((a, b) => Number(a === "") - Number(b === "") || groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
  return keys.flatMap((k) => {
    const rows = groups.get(k)!.sort((a, b) => offerOrder(a.r.voice!, b.r.voice!));
    const counts = OFFER_ORDER.map((kind) => [kind, rows.filter((x) => x.r.voice!.kind === kind).length] as const).filter(([, n]) => n);
    return [`── ${k || "no project yet"} · ${counts.map(([kind, n]) => `${n} ${kind}${n > 1 ? "s" : ""}`).join(", ")}`, "", ...rows.flatMap((x) => [...(held.has(x.r.voice!.item) ? [`  ⚠ read from an item the guard holds (${held.get(x.r.voice!.item)!.join(", ")}): check the quote against your own words`] : []), ...voiceLines(x.r, x.proposal)])];
  });
}

function voiceStatus(cfg: FeedConfig): string[] {
  const v = cfg.voice!;
  const w = voiceWindow(cfg.dataDir);
  const waiting = pendingReviews(cfg.dataDir).filter((r) => r.voice).length;
  const { fresh, notHis } = voiceOfferable(cfg);
  const unoffered = fresh.length;
  const parked = [...failures(cfg.dataDir)].filter(([, f]) => f.length >= (v.failuresBeforePark ?? 3));
  return [
    `own voice: ${[...v.sources, ...(v.marked ?? []).map((m) => `${m} (marked voice: own)`)].join(", ")} · reads from ${w.start?.slice(0, 16) ?? "the next run"}${w.backfill ? `, backfilled from ${w.backfill}` : ""}`,
    `  ${extractedAt(cfg.dataDir).size} items read · ${voiceItems(cfg.dataDir).length} candidates · ${waiting} waiting for review (one sitting: ${v.maxWaiting ?? MAX_WAITING}) · ${unoffered} not yet offered (${v.maxNewPerRun ?? 10} per run) · ${notHis.length} parked as not his (review parked)`,
    ...[...mineConversations(cfg.dataDir)].map(([k, at]) => `  ✓ all his (marked ${at.slice(0, 10)}): ${k.replace("\u0000", " ")}`),
    ...parked.map(([item, f]) => `  ⊘ parked ${item}: ${f.length} failed reads, last: ${clip(f[f.length - 1]!.error, 100)} (voice reset ${item})`),
  ];
}

/** "A·82" for a model grade (tier, quality), blank padding for a deterministic one. */
export const gradeTag = (g: { tier?: string; quality?: number }) => (g.tier ? `${g.tier}·${String(g.quality ?? "?").padStart(2)}` : "    ");

/** The last line `pull` prints after a pull that succeeded. Without it, an empty stdin means the pull failed. */
const PULL_END = "swb_pull_end";

let stdinRead: { items: RawItem[]; ended: boolean } | null = null;

async function readStdinItems(): Promise<{ items: RawItem[]; ended: boolean }> {
  const text = await Bun.stdin.text();
  let ended = false;
  const items = text
    .split("\n")
    .filter((l) => l.trim())
    .filter((l) => {
      const j = JSON.parse(l);
      if (j && typeof j === "object" && PULL_END in j) return !(ended = true);
      return true;
    })
    .map((l) => {
      const j = JSON.parse(l);
      // A string title, empty included: the pipe takes every item a source may hand the in-process door.
      if (typeof j.title !== "string" || typeof j.content !== "string") throw new Error("each line needs at least title and content");
      // Unknown fields are dropped later by envelopeFrom; nothing a pipe sends bypasses the guard.
      return { ...j, external_id: j.external_id ?? j.url ?? j.title, content_kind: j.content_kind ?? "note" } as RawItem;
    });
  return { items, ended };
}

async function main() {
  if (!cmd || flag("--help")) return err(USAGE);
  const cfg = await loadConfig();
  const c = ctx();
  c.dataDir = cfg.dataDir;

  // Commands that write take the run lock; a second writer stands down instead of racing.
  // ingest reads its whole pipe BEFORE it takes the lock, so a slow `pull` upstream never holds the hourly run.
  if (cmd === "ingest") stdinRead = await readStdinItems();
  let release: (() => void) | null = null;
  const writes = ["run", "ingest", "regrade", "rebuild", "source"].includes(cmd) || (cmd === "review" && ["approve", "reject", "triage", "restore"].includes(rest[0] ?? "")) || (cmd === "voice" && Boolean(rest[0]));
  if (writes && !flag("--dry-run")) {
    release = acquireLock(cfg.dataDir);
    if (!release) {
      err(`swb-feed: another feed run holds ${cfg.dataDir}/run.lock; standing down`);
      process.exitCode = 3;
      return;
    }
  }
  try {
    await dispatch(cfg, c);
  } finally {
    release?.();
  }
}

async function dispatch(cfg: FeedConfig, c: RunContext) {
  switch (cmd) {
    case "run": {
      // One job failing (a view that throws, a bug in a source) never stops the jobs after it.
      let failed = 0;
      for (const name of rest.length ? rest : Object.keys(cfg.jobs)) {
        try {
          printReport(name, await runJob(cfg, name, c));
        } catch (e) {
          failed++;
          err(`\n▸ job ${name} FAILED: ${(e as Error).message}`);
        }
      }
      if (failed) process.exitCode = 1;
      break;
    }
    case "pull": {
      // Feed's door of seam S1: the source alone, no guard, no grade, nothing written. It gets the
      // same read-only `known` the hourly run gives it, so a source that skips journaled items (YouTube)
      // skips the same ones; a data dir that does not exist yet is never created. `pull | ingest`
      // journals exactly what `run` would (test/seam.test.ts).
      const [jobName, sourceName] = rest;
      const source = cfg.jobs[jobName]?.sources.find((s) => s.name === sourceName);
      if (!source) throw new Error("usage: swb-feed pull <job> <source-name> | swb-feed ingest <job> <source-name>");
      const ledger = existsSync(cfg.dataDir) ? new Ledger(cfg.dataDir) : undefined;
      const known = ledger && ((i: { url?: string; external_id: string }) => ledger.has({ id: identityOf(i.url, i.external_id, source.name), content_hash: "", content: "" }));
      err(`pull ${source.name}: raw items, before the guard; pipe them into ingest, never into a file`);
      const items = await withDeadline(source.pull({ log: err, fetch, ...(known ? { known } : {}) }), PULL_DEADLINE_MS, `pull ${source.name}`);
      for (const item of items) console.log(JSON.stringify(item));
      console.log(JSON.stringify({ [PULL_END]: { source: source.name, items: items.length } }));
      break;
    }
    case "ingest": {
      const [jobName, sourceName] = rest;
      const job = cfg.jobs[jobName];
      if (!job || !sourceName) throw new Error("usage: swb-feed ingest <job> <source-name> < items.jsonl");
      const source: Source = job.sources.find((s) => s.name === sourceName) ?? {
        name: sourceName,
        trust: "normal",
        privacy_class: "personal",
        pull: async () => [],
      };
      const { items, ended } = stdinRead ?? { items: [], ended: false };
      // A failed pull prints nothing and its exit code dies in the pipe: an empty stdin with no end
      // marker is that failure, so the source health is left alone instead of being marked ok.
      if (!ended && !items.length) {
        err(`ingest ${sourceName}: nothing on stdin and no end-of-pull line (did pull fail?); source health left as it was`);
        process.exitCode = 1;
        break;
      }
      printReport(`${jobName} ← stdin`, await ingest(cfg, job, [{ source, items }], c));
      break;
    }
    case "regrade": {
      const r = await regrade(cfg, c);
      err(`re-graded ${r.total} items against the current profile, ${r.changed} scores changed`);
      const handed = r.report.delivered.filter((d) => d.ok && !d.error?.startsWith("rehearsed")).length;
      const rehearsed = r.report.delivered.length - handed;
      if (r.report.delivered.length) err(`delivered ${handed} newly qualifying items${rehearsed ? `, rehearsed ${rehearsed}` : ""}`);
      for (const v of r.views) err(`view ${v}`);
      break;
    }
    case "rebuild": {
      for (const v of await renderViews(cfg, new Ledger(cfg.dataDir), c)) err(`view ${v}`);
      break;
    }
    case "explain": {
      const ledger = new Ledger(cfg.dataDir);
      const id = rest[0] ?? "";
      const item = allGraded(cfg, ledger).find((i) => i.id.startsWith(id) && id.length >= 4);
      if (!item) throw new Error(`no item with id starting "${id}" (need 4+ chars)`);
      const grades = Bun.file(ledger.gradesPath);
      const history = (await grades.text()).split("\n").filter((l) => l.includes(`"id":"${item.id}"`)).map((l) => unversioned(JSON.parse(l))).filter((g) => g !== undefined);
      const deliveries = ledger.deliveries().filter((d) => d.id === item.id);
      const reviews = reviewRows(cfg.dataDir).filter((r) => r.id === item.id);
      const voice = voiceItems(cfg.dataDir).filter((v) => v.item === item.id);
      const extraction = extractions(cfg.dataDir).get(item.id);
      const decided = new Map(reviewRows(cfg.dataDir).filter((r) => r.decision !== "queued").map((r) => [r.id, r.decision]));
      console.log(
        [
          shownTitle(item.title, item.risk, 200), // G3: explain fences a held item too
          `  id ${item.id} · ${item.source} · ${isHeld(item.risk) ? "held" : item.content_kind} · ${item.privacy_class} · trust ${item.trust}`,
          item.url && !isHeld(item.risk) ? `  ${item.url}` : "",
          `\ncaptured  ${item.captured_at} · content ${item.content.length} chars · sha256 ${item.content_hash.slice(0, 12)}`,
          `guard     ${item.redactions.length ? `redacted ${item.redactions.join(", ")}` : "nothing redacted"} · risk ${item.risk?.level ?? "none"}${item.risk?.flags.length ? ` (${item.risk.flags.join(", ")})` : ""}${item.risk?.level === "suspect" ? ", held from delivery sinks except review" : ""}`,
          `grade     ${item.grade.score} by ${item.grade.grader}, profile ${item.grade.profile_hash}${history.length > 1 ? ` (history: ${history.map((g) => (g as { score: number }).score).join(" → ")})` : ""}`,
          ...displayItem(item).grade.why.map((w) => `          · ${w}`), // a held item's model reasons are the guard's words (pass 3, H3)
          `route     rules ${item.rules.join(", ") || "none"} → sinks ${item.sinks.join(", ") || "none"} · priority ${item.priority}`,
          `deliver   ${deliveries.length ? deliveries.map((d) => `${d.sink} ${d.ok ? "ok" : `failed: ${d.error}`} ${d.at}`).join("; ") : "no deliveries"}`,
          reviews.length ? `review    ${reviews.map((r) => `${r.decision} ${r.at}${r.ref ? ` → ${r.ref}` : ""}`).join("; ")}` : "",
          voice.length ? `voice     ${voice.length} candidates (${extractedAt(cfg.dataDir).has(item.id) ? "read" : "partly read"}), extraction confidence ${item.grade.extraction_confidence ?? "?"}` : "",
          ...voice.map((v) => `          · ${v.id.slice(0, 12)} ${v.kind} ${v.at ?? "?"} ${v.project ?? "no project yet"} · ${decided.get(v.id) ?? "waiting"} · ${isHeld(item.risk) ? "(from a held item: text withheld)" : clip(v.text, 90)}`),
          ...(extraction?.warnings ?? []).map((w) => `          ⚠ ${isHeld(item.risk) ? "(held item: warning text withheld)" : w}`),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      break;
    }
    case "status": {
      const ledger = new Ledger(cfg.dataDir);
      const graded = ledger.latestGrades();
      const byModel = [...graded.values()].filter(isModelGrade).length;
      err(`ledger ${ledger.size()} items, ${graded.size} graded (${byModel} by model), ${ledger.deliveries().filter((d) => d.ok).length} deliveries`);
      if (cfg.model) err(`model: ${cfg.model.port.name}, ${cfg.model.maxCallsPerRun ?? 60} calls per run`);
      if (cfg.voice) err(voiceStatus(cfg).join("\n"));
      for (const [file, n] of skippedRows) err(`⚠ skipped ${n} row(s) in ${file}: unreadable, or written by another ledger version (this code reads swb-ledger/v1)`);
      for (const [n, j] of Object.entries(cfg.jobs)) err(`job ${n}: ${j.sources.map((s) => s.name).join(", ")} · ${j.rules.length} rules`);
      err(`sinks: ${Object.entries(cfg.sinks).map(([n, s]) => `${n} (${s.kind})`).join(", ")}`);
      const health = readHealth(cfg.dataDir);
      for (const [n, h] of Object.entries(health)) {
        const rep = h.rolling_avg_quality !== undefined ? ` · quality ${h.rolling_avg_quality} over ${h.rolling_items} (${Math.round((h.rolling_a_rate ?? 0) * 100)}% 70+)` : "";
        const mark = h.demoted_at ? "⊘" : h.consecutive_failures ? "✗" : "✓";
        err(`  ${mark} ${n.padEnd(30)} last ok ${h.last_ok?.slice(0, 16).replace("T", " ") ?? "never"} · ${h.last_pulled} pulled, ${h.last_fresh} new${rep}${h.consecutive_failures ? ` · failing ${h.consecutive_failures}×: ${h.last_error}` : ""}${h.demoted_at ? ` · DEMOTED ${h.demoted_at.slice(0, 10)}: ${h.demoted_reason}` : ""}`);
      }
      break;
    }
    case "review": {
      const [sub = "list", id] = rest;
      if (sub === "list") {
        const pending = pendingReviews(cfg.dataDir);
        if (!pending.length) {
          console.log("nothing is waiting for review");
          break;
        }
        const byId = new Map(allGraded(cfg, new Ledger(cfg.dataDir)).map((i) => [i.id, i]));
        console.log(`${pending.length} waiting for your review (approve <id> writes it, reject <id> closes it for good):`);
        for (const r of pending) {
          if (r.voice) continue;
          const i = byId.get(r.id);
          const g = i?.grade;
          // A held item's own words only fenced and marked; its link is the source's too, so it is left out.
          console.log(`  ${r.id.slice(0, 12)}  ${String(g?.score ?? r.score ?? "?").padStart(3)} ${g ? gradeTag(g) : "    "}  ${shownTitle(i?.title ?? r.title ?? r.id, i?.risk, 70)} · ${i?.source ?? r.source ?? "?"} · queued ${r.at.slice(0, 10)}`);
          if ((i?.url ?? r.url) && !isHeld(i?.risk)) console.log(`                ${i?.url ?? r.url}`);
        }
        if (pending.some((r) => r.voice)) {
          console.log("");
          const held = new Map([...byId.values()].filter((x) => isHeld(x.risk)).map((x) => [x.id, x.risk!.flags]));
          for (const l of voiceSitting(pending, loadIntent(cfg.intent).profile, held)) console.log(l);
        }
        if (cfg.voice) {
          const { fresh, notHis } = voiceOfferable(cfg);
          if (fresh.length) console.log(`${fresh.length} more of your own wait for a later sitting; a run offers them as this one empties.`);
          if (notHis.length) console.log(`${notHis.length} not your voice, parked: review parked (review restore <id> brings one back)`);
        }
        break;
      }
      if (sub === "triage") {
        if (!cfg.voice) throw new Error("no voice stage in this config");
        const max = cfg.voice.maxWaiting ?? MAX_WAITING;
        const before = pendingReviews(cfg.dataDir).filter((r) => r.voice).length;
        const plan = triageVoice(cfg.dataDir, max, offerOrder, !c.dryRun);
        console.log(`${c.dryRun ? "would triage" : "triaged"} ${before} waiting: ${plan.park.length} parked as not his voice, ${plan.defer.length} deferred to a later sitting, ${plan.keep.length} stay (one sitting: ${max})`);
        break;
      }
      if (sub === "parked") {
        if (!cfg.voice) throw new Error("no voice stage in this config");
        const { notHis } = voiceOfferable(cfg);
        if (!notHis.length) {
          console.log("nothing is parked");
          break;
        }
        console.log(`${notHis.length} parked as not your voice (review restore <id> or --all queues them again):`);
        for (const v of notHis) for (const l of voiceLines({ id: v.id, decision: "parked", at: v.extracted_at, voice: v })) console.log(l);
        break;
      }
      if (sub === "restore") {
        if (!cfg.voice) throw new Error("no voice stage in this config");
        const { notHis } = voiceOfferable(cfg);
        const picked: VoiceItem[] = flag("--all") ? notHis : notHis.filter((v) => id && id.length >= 4 && v.id.startsWith(id));
        if (!flag("--all") && picked.length !== 1) throw new Error(picked.length ? `"${id}" matches ${picked.length} parked candidates` : `no parked candidate starts with "${id ?? ""}" (need 4+ characters, or --all)`);
        if (c.dryRun) return err(`would restore ${picked.length}`);
        for (const v of picked) restoreVoice(cfg.dataDir, v);
        console.log(`restored ${picked.length}: they wait for you again, and no triage parks them twice`);
        break;
      }
      if (sub === "show" && id) {
        const r = pendingReviews(cfg.dataDir).find((x) => x.id.startsWith(id) && id.length >= 4);
        if (!r) throw new Error(`no waiting item starts with "${id}"`);
        if (!r.voice) {
          // The same fence as review list: a held item's words only marked, its link left out (audit pass 2, G1).
          const i = allGraded(cfg, new Ledger(cfg.dataDir)).find((x) => x.id === r.id);
          console.log(shownTitle(i?.title ?? r.title ?? r.id, i?.risk, 200));
          if ((i?.url ?? r.url) && !isHeld(i?.risk)) console.log(i?.url ?? r.url);
          break;
        }
        // Exactly what `review approve` with the same flags appends, and where.
        const projects = loadIntent(cfg.intent).profile.projects.map((p) => p.name);
        const p = previewVoice(cfg, r.voice, { project: opt("--project"), kind: opt("--kind"), projects });
        console.log(`would append to ${p.path ?? "its record"}:${p.entry}`);
        if (r.voice.sentence) console.log(`(shown, never written) in its sentence: „${plain(r.voice.sentence)}"`);
        if (r.voice.related?.sentence) console.log(`(shown, never written) the earlier one's sentence: „${plain(r.voice.related.sentence)}"`);
        break;
      }
      if (!["approve", "reject"].includes(sub) || !id) throw new Error("usage: swb-feed review [list] | show <id> | approve <id-prefix> | reject <id-prefix> | triage | parked | restore <id>|--all");
      if (c.dryRun) return err(`would ${sub} ${id}`);
      if (sub === "approve") {
        const projects = loadIntent(cfg.intent).profile.projects.map((p) => p.name);
        const row = await approveReview(cfg, allGraded(cfg, new Ledger(cfg.dataDir)), id, c, { project: opt("--project"), kind: opt("--kind"), projects });
        console.log(`approved ${row.id}${row.ref ? ` → ${row.ref}` : ""}`);
      } else {
        const row = rejectReview(cfg, id);
        console.log(`rejected ${row.id}: it will not be offered again`);
      }
      break;
    }
    case "voice": {
      if (!cfg.voice) throw new Error("no voice stage in this config");
      const [sub, id] = rest;
      if (!sub) {
        console.log(voiceStatus(cfg).join("\n"));
        break;
      }
      if (c.dryRun) return err(`would ${sub} ${id ?? opt("--since") ?? ""}`);
      if (sub === "backfill") {
        const since = opt("--since");
        if (!since) throw new Error("usage: swb-feed voice backfill --since <YYYY-MM-DD>");
        markBackfill(cfg.dataDir, since);
        console.log(`the next run also reads his own items from ${since} on (within the run's model budget, ${cfg.voice.maxNewPerRun ?? 10} new candidates per run)`);
      } else if ((sub === "mine" || sub === "unmine") && id) {
        // Only a conversation the ledger holds, from a voice source; --source when two sources share the id.
        const hits = new Ledger(cfg.dataDir)
          .envelopes()
          .filter((e) => e.external_id === id && cfg.voice!.sources.includes(e.source) && (!opt("--source") || e.source === opt("--source")));
        if (!hits.length) throw new Error(`no conversation "${id}" from ${cfg.voice.sources.join(", ")} in the ledger`);
        if (new Set(hits.map((e) => e.source)).size > 1) throw new Error(`"${id}" exists in ${[...new Set(hits.map((e) => e.source))].join(" and ")}: name one with --source`);
        const e = hits[0]!;
        const marked = mineConversations(cfg.dataDir).has(markKey(e.source, id));
        if (marked === (sub === "mine")) {
          console.log(`${e.source} "${shownTitle(e.title, riskOf(e), 120)}": ${marked ? "already marked as all his" : "not marked"}; nothing changed`);
          break;
        }
        markMine(cfg.dataDir, e.source, id, sub === "mine");
        const reason = sub === "mine" ? "his conversation mark was set" : "his conversation mark was removed";
        const withdrawn = withdrawPending(cfg.dataDir, e.id, reason);
        console.log(`${e.source} "${shownTitle(e.title, riskOf(e), 120)}" (${e.published_at?.slice(0, 10) ?? "?"}): ${sub === "mine" ? "every turn counts as his" : "speaker labels count again"}; read again on the next run${withdrawn ? `, ${withdrawn} waiting candidates withdrawn` : ""}`);
      } else if (sub === "reset" && id) {
        resetVoice(cfg.dataDir, id);
        console.log(`${id} is tried again on the next run`);
      } else throw new Error("usage: swb-feed voice | voice backfill --since <date> | voice reset <item-id> | voice mine|unmine <conversation-id>");
      break;
    }
    case "source": {
      const [sub, name] = rest;
      if (sub !== "reset" || !name) throw new Error('usage: swb-feed source reset "<source name>"');
      if (c.dryRun) return err(`would reset ${name}`);
      err(resetSource(cfg.dataDir, name) ? `reset ${name}: demotion lifted, circuit closed` : `no health record for "${name}"`);
      break;
    }
    default:
      err(USAGE);
      process.exitCode = 2;
  }
}

/** Run the CLI with an argument list; a host may supply the config itself. */
export async function runCli(argv: string[], loader?: () => Promise<FeedConfig>): Promise<void> {
  parseArgs(argv);
  loaderOverride = loader;
  try {
    await main();
  } catch (e) {
    err(`swb-feed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export const usage = USAGE;

if (import.meta.main) await runCli(process.argv.slice(2));
