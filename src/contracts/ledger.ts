// The engine's contracts: the amber ledger's rows (ledger, grades, deliveries, review), the rules that
// route them, the sinks they reach and the one door to a model. Built on Feed's contract, never the reverse.

import type { PrivacyClass, PullContext, RawItem, Trust } from "./feed-item.ts";

/** The name and version a second implementation of the engine pins against. */
export const LEDGER_CONTRACT = "swb-ledger/v1";
/**
 * Stamped as `v` on every new row of ledger.jsonl, grades.jsonl and review.jsonl. A row without it
 * was written before the stamp and is read as version 1; old rows are never rewritten.
 */
export const LEDGER_ROW_VERSION = 1;

/** One captured thing, exactly as it arrived. Immutable once journaled. */
export interface Envelope extends Omit<RawItem, "privacy_class"> {
  /** Stable identity: derived from the normalized URL, else source + external_id. */
  id: string;
  /** Which source produced it (the source's `name`). */
  source: string;
  captured_at: string;
  privacy_class: PrivacyClass;
  trust: Trust;
  /** sha256 of the content after the guard ran. */
  content_hash: string;
  /** Labels of secrets the guard replaced before this record was written (never the values). */
  redactions: string[];
}

export type Tier = "S" | "A" | "B" | "C" | "D";

/**
 * The grade is derived and versioned: re-grading after the intent profile changes is cheap.
 * `score` is relevance to the owner (0–100) and is what rules route on by default. A model grade
 * adds Daniel Miessler's dimensions: quality, tier, importance, novelty, urgency.
 */
export interface Grade {
  id: string;
  score: number;
  labels: string[];
  projects: string[];
  why: string[];
  summary_short: string;
  summary_medium: string;
  grader: string;
  profile_hash: string;
  graded_at: string;
  /** How good the item is in itself, 1–100 (model only). */
  quality?: number;
  tier?: Tier;
  importance?: number;
  novelty?: number;
  urgency?: number;
  /** The deterministic (keyword) score a model grade was layered on: a floor no prompt can talk up. */
  keyword_score?: number;
  /**
   * Own-voice items only: how sure the extraction stage is of what it took out, 0–100 (the mean of
   * its items' confidence, 0 when it found nothing). An own-voice item never carries the quality scale.
   * (Voice ownership decides how an item is graded; `privacy_class` only where it may go.)
   */
  extraction_confidence?: number;
}

/** item × sink receipt in deliveries.jsonl. */
export interface Delivery {
  id: string;
  sink: string;
  at: string;
  ok: boolean;
  ref?: string;
  error?: string;
}

/** What the extraction stage takes out of the owner's own conversations and notes. */
export type VoiceKind = "decision" | "idea" | "ask" | "question";

/**
 * One candidate from the owner's own voice. A model made it, so it is a proposal: it lands in a
 * record only after he approves it, and it lands as an idea unless he types it himself.
 */
export interface VoiceItem {
  /** Candidate id: stable for (feed item, kind, quote). */
  id: string;
  /** The feed item it came from, and the content hash of the text it was read from. */
  item: string;
  content_hash: string;
  source: string;
  /** The source's own id (the Omi conversation id, the inbox file name). */
  conversation: string;
  /** The extractor's suggestion, shown to him; never what an item lands as by itself. */
  kind: VoiceKind;
  /** One sentence in English: what he decided, proposed, asked for or left open. */
  text: string;
  /** His own words, short, as found in the text. */
  quote: string;
  /** Were the quote's words found, whole, inside one turn of the text? An unfound quote is shown as such. */
  quote_found: boolean;
  /** Was that turn his? Shown to him, never a gate. */
  speaker_verified: boolean;
  /** Why it counts as his: the recorder's label, his conversation mark, or a note he marked. */
  speaker_basis?: "recorder" | "mark" | "note";
  /** Read under his mark on the whole conversation, set at this time. */
  marked?: string;
  /** An earlier candidate of the same conversation he already decided, which this one overlaps (a revision, a reversal). */
  related?: { id: string; kind: VoiceKind; decision: "approved" | "rejected" | "interrupted"; at: string; quote: string; sentence?: string };
  /** The extractor saw the same point earlier in this reading: the id of that candidate, which carries this one. */
  same_as?: string;
  /** Offered as one entry: the repeats of this point in the same reading, settled with it. */
  members?: { id: string; at?: string }[];
  /** The label of the turn the quote was found in. */
  speaker?: string;
  /** The sentence the quote sits in (cut around the quote past 600 characters, marked "…"), so he sees a negation or a question around it. Shown at approval, never landed. */
  sentence?: string;
  /** Position in the conversation (m:ss), taken from where the quote was found. */
  at?: string;
  /** The conversation's date (YYYY-MM-DD). */
  date: string;
  /** A project from the intent profile; absent = no project yet. */
  project?: string;
  /** 0–100: how sure the extractor is that he said this and meant it this way. */
  confidence: number;
  extractor: string;
  extracted_at: string;
}

/**
 * `superseded`: a voice candidate whose conversation was revised before he decided; the revision's candidates replace it.
 * `parked`: taken out of his queue as not his voice; `review restore` queues it again.
 * `deferred`: taken out of a full queue, back among the candidates not yet offered; it returns as he decides.
 */
export type ReviewDecision = "queued" | "approved" | "rejected" | "superseded" | "approving" | "parked" | "deferred";

/** One row of review.jsonl. */
export interface ReviewRow {
  id: string;
  decision: ReviewDecision;
  at: string;
  /** Snapshot for the list and the digest; the ledger stays the record of the item itself. */
  title?: string;
  source?: string;
  url?: string;
  score?: number;
  /** approved: what the wrapped sink returned (a note path). */
  ref?: string;
  /** queued by the own-voice stage: the candidate; approved: the candidate as it landed. */
  voice?: VoiceItem;
  /** approved voice candidate: the kind it landed as (idea unless he typed one). */
  landed_kind?: VoiceKind;
  /** approving: whether he typed the kind. */
  typed?: boolean;
  /** queued by his `review restore`: a triage never parks it again. */
  restored?: boolean;
  /** approved or rejected as a repeat: the candidate whose decision settled it. */
  with?: string;
  /** queued: the guard's flags on the item, shown to him at approval. */
  risk?: string[];
  /** queued and approved: the item's content hash, so an approval binds to the text he saw, never to a later revision. */
  content_hash?: string;
}

/**
 * The one door to a language model. The engine asks for JSON and validates what comes back;
 * which vendor answers is an adapter's business (a subscription CLI, any OpenAI-compatible API).
 */
export interface ModelPort {
  name: string;
  /** May personal items (transcripts, private notes) be sent through this port? Default no. */
  acceptsPersonal: boolean;
  json(system: string, user: string): Promise<unknown>;
}

/** `suspect`: something in the item is shaped to steer a model that reads it. `note`: a benign guard finding (personal data, a skip link, one zero-width space). */
export type RiskLevel = "none" | "note" | "suspect";

/**
 * What the guard flagged on an item. Derived from the stored item whenever it is routed, like a
 * grade, and never written to the ledger. A flag can only hold an item back, never let it through.
 */
export interface Risk {
  level: RiskLevel;
  /** Rule names from a fixed vocabulary (`injection:override`, `hidden:tag_chars` …), never item text. */
  flags: string[];
  /** A suspect item he approved in review, for this exact text (the approval names its content hash). Views only. */
  approved?: boolean;
}

/** One kind of personal data a detector found: a label from the fixed set below and its confidence (0–1). Never the value. */
export interface PiiHit {
  label: PiiLabel;
  score: number;
}

export type PiiLabel = "person" | "org" | "email" | "phone" | "iban" | "bank_account" | "address" | "id_number" | "date_of_birth" | "username" | "ip";

/**
 * The one door to a personal-data detector (a local model, a service). Labels only, no spans: the
 * guard flags and tightens an item, it never cuts text out of it.
 */
export interface PiiPort {
  name: string;
  detect(text: string): Promise<PiiHit[]>;
}

export interface GradedItem extends Envelope {
  grade: Grade;
  /** Set by the pipeline on every routed item. */
  risk?: Risk;
  /** Rules that matched, in order. */
  rules: string[];
  priority: Priority;
}

export type Priority = "immediate" | "daily" | "weekly" | "archive";

/**
 * Two kinds of sink, because they obey different truth-change laws.
 * A view is a compiled projection (a wiki, a page): rebuilt whole from the ledger, never the store.
 * A delivery hands items to another system (a memory engine, a webhook): once per item, with a receipt.
 */
export type Sink = ViewSink | DeliverySink;

interface SinkBase {
  /** Privacy classes that may reach this sink. Defaults: views both, deliveries ["public"]. */
  accepts?: PrivacyClass[];
}

export interface ViewSink extends SinkBase {
  kind: "view";
  render(items: GradedItem[], ctx: RunContext): Promise<{ ref?: string }>;
}

export interface DeliverySink extends SinkBase {
  kind: "delivery";
  /**
   * May an item the guard calls `suspect` be handed to this sink? Default no: it is held back (a
   * review queue takes it, so a person decides). Views always receive it, with its risk attached.
   */
  acceptsRisk?: boolean;
  /** `skipped: true` = rehearsed, not handed over: no receipt, so a later live run still delivers. */
  deliver(item: GradedItem, ctx: RunContext): Promise<{ ref?: string; skipped?: boolean }>;
}

export interface NumberCondition { gte?: number; lte?: number }

export interface Rule {
  name: string;
  /** All conditions must hold (AND). An empty `when` always matches. Every matching rule fires (fan-out). */
  when?: {
    score?: NumberCondition;
    labels?: string[]; // item has at least one
    projects?: string[]; // item matches at least one; "*" = any project
    sources?: string[];
    kinds?: string[];
    trust?: Trust[];
    /** Model dimensions. An item without a model grade does not match a rule that asks for one. */
    quality?: NumberCondition;
    importance?: NumberCondition;
    novelty?: NumberCondition;
    urgency?: NumberCondition;
    /** The deterministic keyword score, whichever grader produced the grade. */
    keywords?: NumberCondition;
    tiers?: Tier[];
    /** The guard's risk level is one of these (`none` when nothing was flagged). */
    risk?: RiskLevel[];
  };
  to: string[];
  priority?: Priority;
}

export interface RunContext extends PullContext {
  dataDir: string;
  dryRun: boolean;
  /** Model calls this run may still make; set on first use and shared by every job run on this context. */
  modelBudget?: { left: number };
  /** New own-voice candidates this run may still offer him; shared by every job run on this context. */
  voiceOffers?: { left: number };
}
