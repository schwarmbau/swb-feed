// The review step: an item that clears a promote rule waits for a person before it is handed over.
// (promotion into memory goes through a review step a person approves.)
//
// reviewQueue(...) wraps the delivery sink that would have written the item. Delivering to it only
// records a candidate; `review approve <id>` hands that item to the wrapped sink, and `review reject
// <id>` closes it for good. Every row lives in review.jsonl in the data directory, append-only:
// queued, approved (with the wrapped sink's ref), rejected. An approved row is the receipt a write
// needs; the pipeline's own receipt for the queueing keeps a candidate from being queued twice, and
// a rejected item is never offered again.
//
// The own-voice stage queues typed candidates here too (decision / idea / ask / question, from his
// own conversations): a queued row then carries the candidate (`voice`), and approving it hands the
// candidate to the configured voice target, which writes it into the project's record.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_ROW_VERSION, type DeliverySink, type FeedConfig, type GradedItem, type ReviewDecision, type ReviewRow, type RunContext, type VoiceItem, type VoiceKind } from "../core/types.ts";
import { unversioned } from "../core/ledger.ts";
import { appendLines, VOICE_KINDS } from "../core/voice.ts";
import { landedIn, voiceEntry, type Landing } from "./voice.ts";

export type { ReviewDecision, ReviewRow };

export interface ReviewSink extends DeliverySink {
  /** The sink an approval hands the item to. */
  review: { target: DeliverySink };
}

export const REVIEW_FILE = "review.jsonl";

export const isReviewSink = (s: FeedConfig["sinks"][string] | undefined): s is ReviewSink =>
  Boolean(s && s.kind === "delivery" && "review" in s && (s as ReviewSink).review?.target);

/** A review sink accepts what its target accepts, so a personal item can never be queued for a public-only write. */
export function reviewQueue(o: { approve: DeliverySink }): ReviewSink {
  return {
    kind: "delivery",
    accepts: o.approve.accepts ?? ["public"],
    review: { target: o.approve },
    async deliver(item, ctx) {
      if (ctx.dryRun) return { ref: "would queue for review", skipped: true };
      const risk = item.risk && item.risk.level !== "none" ? { risk: item.risk.flags } : {};
      appendReview(ctx.dataDir, { id: item.id, decision: "queued", at: new Date().toISOString(), title: item.title, source: item.source, ...(item.url ? { url: item.url } : {}), score: item.grade.score, ...risk, content_hash: item.content_hash });
      return { ref: "queued for review" };
    },
  };
}

/** A typed candidate from his own voice waits for him. Queued once: a known id (waiting, approved or rejected) is skipped. */
export function queueVoice(dataDir: string, v: VoiceItem, known = blockedIds(dataDir)): boolean {
  if (known.has(v.id)) return false;
  appendReview(dataDir, { id: v.id, decision: "queued", at: new Date().toISOString(), title: voiceTitle(v), source: v.source, voice: v });
  known.add(v.id);
  return true;
}

export const voiceTitle = (v: VoiceItem) => `suggested ${v.kind}: ${v.text}`;

function appendReview(dataDir: string, row: ReviewRow): void {
  mkdirSync(dataDir, { recursive: true });
  appendLines(join(dataDir, REVIEW_FILE), `${JSON.stringify({ v: LEDGER_ROW_VERSION, ...row })}\n`);
}

const DECISIONS = new Set(["queued", "approved", "rejected", "superseded", "approving"]);

/** Every row, in order. A torn or foreign line is skipped, never fatal (the same law as the ledger). */
export function reviewRows(dataDir: string): ReviewRow[] {
  const path = join(dataDir, REVIEW_FILE);
  if (!existsSync(path)) return [];
  const rows: ReviewRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      // The version stamp is stripped like the ledger's; a row of another version is skipped.
      const r = unversioned(JSON.parse(line)) as ReviewRow | undefined;
      if (r && typeof r.id === "string" && DECISIONS.has(r.decision) && typeof r.at === "string") rows.push(r);
    } catch {
      // torn line
    }
  }
  return rows;
}

/**
 * Items he approved, as `<id> <content hash>`: the hash he was queued and the hash he approved must be the
 * same text. An approval row without a hash (written before hashes existed) approves nothing here.
 */
export function approvedTexts(dataDir: string): Set<string> {
  const rows = reviewRows(dataDir).filter((r) => !r.voice && r.content_hash);
  const queued = new Set(rows.filter((r) => r.decision === "queued").map((r) => `${r.id} ${r.content_hash}`));
  return new Set(rows.filter((r) => r.decision === "approved").map((r) => `${r.id} ${r.content_hash}`).filter((k) => queued.has(k)));
}

/** Candidates still waiting: queued and neither approved nor rejected, oldest first. */
export function pendingReviews(dataDir: string): ReviewRow[] {
  // Approved and rejected are final. A withdrawn (superseded) candidate waits again only when a later
  // reading queues it again, e.g. after his conversation mark is removed.
  const final = new Set<string>();
  const queued = new Map<string, ReviewRow>();
  for (const r of reviewRows(dataDir)) {
    if (r.decision === "queued") queued.set(r.id, r);
    else if (r.decision === "superseded") queued.delete(r.id);
    else if (r.decision !== "approving") final.add(r.id);
  }
  return [...queued.values()].filter((r) => !final.has(r.id));
}

/** Ids that must not be queued again: waiting now, or decided by him. A withdrawn id may be queued again. */
export function blockedIds(dataDir: string): Set<string> {
  return new Set([...pendingReviews(dataDir).map((r) => r.id), ...reviewRows(dataDir).filter((r) => r.decision === "approved" || r.decision === "rejected").map((r) => r.id)]);
}

/** The one pending candidate an id prefix names (4+ characters, unambiguous). */
function pick(dataDir: string, prefix: string): ReviewRow {
  if (prefix.length < 4) throw new Error(`need 4+ characters of an item id (got "${prefix}")`);
  const hits = pendingReviews(dataDir).filter((r) => r.id.startsWith(prefix));
  if (hits.length === 0) {
    // The final word on it (approved, rejected, withdrawn), never an intent row.
    const closed = reviewRows(dataDir).filter((r) => r.id.startsWith(prefix) && r.decision !== "queued" && r.decision !== "approving").pop();
    throw new Error(closed ? `item ${closed.id} was already ${closed.decision} (${closed.at.slice(0, 16)})` : `no item waiting for review starts with "${prefix}"`);
  }
  if (hits.length > 1) throw new Error(`"${prefix}" matches ${hits.length} waiting items: ${hits.map((r) => r.id).join(", ")}`);
  return hits[0]!;
}

/** The review sink an item was routed to, or the only one there is. */
function sinkFor(cfg: FeedConfig, item: GradedItem & { sinks?: string[] }): ReviewSink {
  const routed = (item.sinks ?? []).map((n) => cfg.sinks[n]).find(isReviewSink);
  if (routed) return routed;
  const all = Object.values(cfg.sinks).filter(isReviewSink);
  if (all.length === 1) return all[0]!;
  throw new Error(`cannot tell which review sink item ${item.id} belongs to (${all.length} configured)`);
}

/**
 * Approve: hand the item to the wrapped sink for real, then record the receipt with the sink's ref.
 * A target that only rehearses (returns skipped) leaves the item waiting, with no receipt.
 */
export async function approveReview(
  cfg: FeedConfig,
  items: (GradedItem & { sinks?: string[] })[],
  prefix: string,
  ctx: RunContext,
  o: VoiceApproval = {},
): Promise<ReviewRow> {
  const candidate = pick(cfg.dataDir, prefix);
  if (candidate.voice) return approveVoice(cfg, candidate, candidate.voice, o);
  if (o.project || o.kind) throw new Error("--project and --kind apply to a voice candidate only");
  const item = items.find((i) => i.id === candidate.id);
  if (!item) throw new Error(`item ${candidate.id} is queued but no longer in the ledger`);
  const sink = sinkFor(cfg, item);
  const accepts = sink.review.target.accepts ?? ["public"];
  if (!accepts.includes(item.privacy_class)) throw new Error(`item ${item.id} is ${item.privacy_class}; the target accepts ${accepts.join(", ")}`);
  const { ref, skipped } = await sink.review.target.deliver(item, { ...ctx, dryRun: false });
  if (skipped) throw new Error(`the target only rehearsed (${ref ?? "no ref"}); item ${item.id} stays waiting`);
  const row: ReviewRow = { id: item.id, decision: "approved", at: new Date().toISOString(), title: item.title, ...(ref ? { ref } : {}), content_hash: item.content_hash };
  appendReview(cfg.dataDir, row);
  return row;
}

export interface VoiceApproval {
  project?: string;
  projects?: string[];
  /** His own re-typing at approval: the one way a held-back item becomes a decision. */
  kind?: string;
}

/**
 * A voice candidate lands through the voice target, never anywhere else. `project` re-links it at
 * approval (a "no project yet" item, a wrong link); it must name a project the intent profile has.
 * `kind` is his re-typing; the entry then records that he typed it, beside why it was held.
 */
export interface VoicePreview {
  item: VoiceItem;
  landing: Landing;
  /** Where it would land, when the target can say. */
  path?: string;
  /** The exact entry an approval with these flags appends (the time is the preview's). */
  entry: string;
}

/**
 * What an approval with these flags would write, and where: `review show` prints it and
 * `review approve` lands exactly this item and landing. Without --kind an item lands as an idea.
 */
export function previewVoice(cfg: FeedConfig, v: VoiceItem, o: VoiceApproval, at = new Date().toISOString()): VoicePreview {
  let item = v;
  if (o.project) {
    const name = (o.projects ?? []).find((p) => p.toLowerCase() === o.project!.toLowerCase());
    if (!name) throw new Error(`no project "${o.project}" in the intent profile (have: ${(o.projects ?? []).join(", ")})`);
    item = { ...item, project: name };
  }
  let landing: Landing = { kind: "idea", typed: false };
  if (o.kind) {
    const kind = o.kind.toLowerCase() as VoiceKind;
    if (!VOICE_KINDS.includes(kind)) throw new Error(`--kind must be one of ${VOICE_KINDS.join(", ")}`);
    landing = { kind, typed: true };
  }
  const path = cfg.voice?.target.pathFor?.(item, landing);
  return { item, landing, ...(path ? { path } : {}), entry: voiceEntry(item, at, landing) };
}

async function approveVoice(cfg: FeedConfig, candidate: ReviewRow, v: VoiceItem, o: VoiceApproval): Promise<ReviewRow> {
  const target = cfg.voice?.target;
  if (!target) throw new Error(`item ${candidate.id} is a voice candidate, and no voice target is configured`);
  const approvedAt = new Date().toISOString();
  const { item, landing } = previewVoice(cfg, v, o, approvedAt);
  // Every check land makes runs first, so a refusal (no record, outside the root, a link) leaves no intent behind.
  const path = target.preflight ? target.preflight(item, landing) : target.pathFor?.(item, landing);
  // An approval states its target before it lands. A repeat after a crash must name the same target,
  // or one candidate would land in two records. Re-targeting is allowed only when the earlier target
  // holds nothing of this candidate (the earlier attempt never wrote).
  const intent = openIntents(cfg.dataDir).get(candidate.id);
  const same = intent && intent.ref === path && intent.landed_kind === landing.kind && Boolean(intent.typed) === landing.typed;
  if (intent && !same) {
    const wrote = intent.ref && existsSync(intent.ref) && landedIn(readFileSync(intent.ref, "utf8"), candidate.id);
    if (wrote) throw new Error(`an interrupted approval of ${candidate.id} already wrote to ${intent.ref} as ${intent.landed_kind}${intent.typed ? " (typed)" : ""}; repeat it with the same --kind and --project`);
  }
  if (!same) appendReview(cfg.dataDir, { id: candidate.id, decision: "approving", at: approvedAt, ...(path ? { ref: path } : {}), landed_kind: landing.kind, typed: landing.typed });
  const { ref, landed } = await target.land(item, { approved_at: approvedAt, kind: landing.kind, typed: landing.typed });
  // A repeated approval after a crash: the receipt records what the record holds, not the new flags.
  const kind = landed?.kind ?? landing.kind;
  const row: ReviewRow = { id: candidate.id, decision: "approved", at: approvedAt, title: `${kind}: ${item.text}`, ref, voice: item, landed_kind: kind };
  appendReview(cfg.dataDir, row);
  return row;
}

/**
 * A pending voice candidate of an older reading of its conversation: closed with the reason, so he
 * sees it was withdrawn (a revised text, or his conversation mark changed), and the new reading's
 * candidates stand alone.
 */
export function supersedeVoice(dataDir: string, r: ReviewRow, reason: string): void {
  appendReview(dataDir, { id: r.id, decision: "superseded", at: new Date().toISOString(), title: `withdrawn: ${reason} (was: ${r.title ?? r.id})`, ...(r.voice ? { voice: r.voice } : {}) });
}

/** Candidates whose approval was started and never received its receipt (a crash inside approve), by id: the newest intent. */
export function openIntents(dataDir: string): Map<string, ReviewRow> {
  const open = new Map<string, ReviewRow>();
  for (const r of reviewRows(dataDir)) {
    if (r.decision === "approving") open.set(r.id, r);
    else if (r.decision === "approved" || r.decision === "rejected") open.delete(r.id);
  }
  return open;
}

/**
 * Withdraws every pending candidate of one feed item; returns how many. A candidate whose approval was
 * interrupted is never withdrawn: repeating that approval completes it (landing is idempotent).
 */
export function withdrawPending(dataDir: string, item: string, reason: string): number {
  const open = openIntents(dataDir);
  const pending = pendingReviews(dataDir).filter((r) => r.voice?.item === item && !open.has(r.id));
  for (const r of pending) supersedeVoice(dataDir, r, reason);
  return pending.length;
}

/** Reject: final. The item keeps its queueing receipt, so no later run offers it again. */
export function rejectReview(cfg: FeedConfig, prefix: string): ReviewRow {
  const candidate = pick(cfg.dataDir, prefix);
  const row: ReviewRow = { id: candidate.id, decision: "rejected", at: new Date().toISOString(), ...(candidate.title ? { title: candidate.title } : {}) };
  appendReview(cfg.dataDir, row);
  return row;
}
