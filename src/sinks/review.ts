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
import { appendLines, voiceItems, VOICE_KINDS } from "../core/voice.ts";
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
      appendReview(ctx.dataDir, queuedRow(item));
      return { ref: "queued for review" };
    },
  };
}

/** What he is shown for an item, and the text (its content hash) an approval of it names. */
function queuedRow(item: GradedItem): ReviewRow {
  const risk = item.risk && item.risk.level !== "none" ? { risk: item.risk.flags } : {};
  return { id: item.id, decision: "queued", at: new Date().toISOString(), title: item.title, source: item.source, ...(item.url ? { url: item.url } : {}), score: item.grade.score, ...risk, content_hash: item.content_hash };
}

/** A held item he approved whose text changed since, with nothing newer waiting: it goes back to the queue. */
export function revisedSinceApproval(dataDir: string, id: string, hash: string): boolean {
  const last = reviewRows(dataDir).filter((r) => r.id === id && !r.voice && r.decision !== "approving").pop();
  return last?.decision === "approved" && last.content_hash !== hash;
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

const DECISIONS = new Set(["queued", "approved", "rejected", "superseded", "approving", "parked", "deferred"]);

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
  // Approved and rejected are final. A withdrawn (superseded), parked or deferred candidate waits again
  // only when it is queued again: by a later reading, by his `review restore`, or as a sitting frees up.
  const final = new Set<string>();
  const queued = new Map<string, ReviewRow>();
  for (const r of reviewRows(dataDir)) {
    // A row queued after a final word (a held item revised after his approval) waits again.
    if (r.decision === "queued") {
      queued.set(r.id, r);
      final.delete(r.id);
    }
    else if (r.decision === "superseded" || r.decision === "parked" || r.decision === "deferred") queued.delete(r.id);
    else if (r.decision !== "approving") final.add(r.id);
  }
  const waiting = [...queued.values()].filter((r) => !final.has(r.id));
  if (!waiting.some((r) => r.voice)) return waiting;
  // What he sees is what a decision settles: every waiting lead names its repeats by the one rule.
  const ctx = repeatContext(dataDir);
  return waiting.map((r) => (r.voice ? { ...r, voice: withMembers(r.voice, repeatsOf(ctx, r.id, r.voice.members)) } : r));
}

type RepeatContext = { seen: Set<string>; all: VoiceItem[] };
const repeatContext = (dataDir: string): RepeatContext => ({ seen: new Set(reviewRows(dataDir).map((r) => r.id)), all: voiceItems(dataDir) });
const withMembers = (v: VoiceItem, members: NonNullable<VoiceItem["members"]>): VoiceItem => {
  const { members: _, ...rest } = v;
  return members.length ? { ...rest, members } : rest;
};

/**
 * The repeats a lead carries, by the one rule voiceOfferable's leadOf also follows (pipeline.ts): the
 * list saved when it was queued, plus his repeats of it that never had a review row of their own. The
 * review list, `review show`, the written entry and the settling at decision time all read this, so a
 * decision never settles a repeat he was not shown.
 */
export function repeatsOf(ctx: RepeatContext, leadId: string, saved: VoiceItem["members"] = []): NonNullable<VoiceItem["members"]> {
  const out = new Map((saved ?? []).map((m) => [m.id, m]));
  for (const v of ctx.all) if (v.same_as === leadId && v.id !== leadId && !ctx.seen.has(v.id) && v.speaker_verified && !out.has(v.id)) out.set(v.id, { id: v.id, ...(v.at ? { at: v.at } : {}) });
  return [...out.values()];
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
  // An approval delivers exactly the text he was shown. A revision since (or a row queued before rows
  // named their text) is withdrawn and the present text is queued, guarded anew; nothing is delivered.
  if (candidate.content_hash !== item.content_hash) {
    appendReview(cfg.dataDir, { id: item.id, decision: "superseded", at: new Date().toISOString(), title: `withdrawn: the item changed after it was queued (was: ${candidate.title ?? item.id})`, ...(candidate.content_hash ? { content_hash: candidate.content_hash } : {}) });
    appendReview(cfg.dataDir, queuedRow(item));
    throw new Error(`item ${item.id} changed after it was queued: nothing was delivered; its present text waits in the queue, review it again`);
  }
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
  settleMembers(cfg.dataDir, candidate, row);
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

export interface TriagePlan {
  /** Waiting candidates that are not his voice: parked. */
  park: ReviewRow[];
  /** His own candidates past one sitting: deferred, most useful kept. */
  defer: ReviewRow[];
  /** What waits for him afterwards. */
  keep: ReviewRow[];
}

/**
 * One sitting out of what waits now: a candidate that is not his voice is parked (one he restored stays),
 * and of his own only the `maxWaiting` most useful stay; the rest go back among those not yet offered.
 * An approval that was started and interrupted is never touched. Nothing is written unless applied.
 */
export function triageVoice(dataDir: string, maxWaiting: number, order: (a: VoiceItem, b: VoiceItem) => number, apply: boolean): TriagePlan {
  const open = openIntents(dataDir);
  const waiting = pendingReviews(dataDir).filter((r) => r.voice && !open.has(r.id));
  // Restored once is restored for good: a deferred and re-offered candidate keeps it.
  const restoredIds = new Set(reviewRows(dataDir).filter((r) => r.restored).map((r) => r.id));
  const park = waiting.filter((r) => !r.voice!.speaker_verified && !r.restored && !restoredIds.has(r.id));
  const his = waiting.filter((r) => !park.includes(r)).sort((a, b) => order(a.voice!, b.voice!));
  const held = pendingReviews(dataDir).filter((r) => r.voice && open.has(r.id)).length;
  const room = Math.max(0, maxWaiting - held);
  const plan = { park, defer: his.slice(room), keep: his.slice(0, room) };
  if (apply) {
    for (const r of plan.park) parkVoice(dataDir, r, r.voice!.quote_found ? "not his by the recorder's labels" : "the quote is not in the transcript");
    for (const r of plan.defer) deferVoice(dataDir, r);
  }
  return plan;
}

/** A waiting candidate that is not his voice leaves his queue; nothing is deleted and `review restore` brings it back. */
export function parkVoice(dataDir: string, r: ReviewRow, reason: string): void {
  appendReview(dataDir, { id: r.id, decision: "parked", at: new Date().toISOString(), title: `parked: ${reason} (was: ${r.title ?? r.id})`, ...(r.voice ? { voice: r.voice } : {}) });
}

/** A waiting candidate past one sitting goes back among those not yet offered; a run offers it again as the queue empties. */
export function deferVoice(dataDir: string, r: ReviewRow): void {
  appendReview(dataDir, { id: r.id, decision: "deferred", at: new Date().toISOString(), title: `deferred to a later sitting (was: ${r.title ?? r.id})`, ...(r.voice ? { voice: r.voice } : {}), ...(r.restored ? { restored: true } : {}) });
}

/** His `review restore`: a parked candidate waits for him again, and no triage parks it a second time. */
export function restoreVoice(dataDir: string, v: VoiceItem): void {
  appendReview(dataDir, { id: v.id, decision: "queued", at: new Date().toISOString(), title: voiceTitle(v), source: v.source, voice: v, restored: true });
}

/**
 * The repeats a lead carries are settled with it: each gets its own receipt, naming the lead. A repeat
 * already decided on its own is left as it is.
 */
function settleMembers(dataDir: string, lead: ReviewRow, row: ReviewRow): void {
  // The repeats are worked out when he decides, from the recorded candidates, not only from the list saved
  // when the lead was queued: a lead queued from a parked copy (restored) carries no list, and his repeats
  // of it must be settled all the same. A repeat that is not his is never settled here.
  // The lead row comes from pendingReviews, so its members are already what he was shown (repeatsOf).
  const rows = reviewRows(dataDir);
  const all = voiceItems(dataDir);
  const ids = (lead.voice?.members ?? []).map((m) => m.id);
  if (!ids.length) return;
  const decided = new Set(rows.filter((r) => r.decision === "approved" || r.decision === "rejected").map((r) => r.id));
  const items = new Map(all.map((v) => [v.id, v]));
  for (const id of ids) {
    if (decided.has(id)) continue;
    const v = items.get(id);
    appendReview(dataDir, {
      id,
      decision: row.decision,
      at: row.at,
      title: `${row.decision} with ${lead.id}${v ? `: ${v.text}` : ""}`,
      with: lead.id,
      ...(row.ref ? { ref: row.ref } : {}),
      ...(v ? { voice: v } : {}),
      ...(row.landed_kind ? { landed_kind: row.landed_kind } : {}),
    });
  }
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
  settleMembers(cfg.dataDir, candidate, row);
  return row;
}
