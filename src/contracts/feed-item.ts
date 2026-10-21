// Seam S1, Feed → engine: what a source hands over. Feed senses; it grades, guards and stores nothing.
// The engine's own contract (ledger.ts) builds on this one, never the other way round.

/** The name and version a second implementation of a source (or of the engine) pins against. */
export const FEED_ITEM_CONTRACT = "swb-feed-item/v1";

export type PrivacyClass = "public" | "personal";
export type Trust = "high" | "normal" | "low";

/** One thing a source pulled, before the engine guards it and stamps id, hash and capture time. */
export interface RawItem {
  /** The source's own id for the item (guid, entry id, file path). */
  external_id: string;
  url?: string;
  title: string;
  author?: string;
  content: string;
  /**
   * A source's own short summary, kept apart from `content` (Omi's overview, a call's metadata line).
   * Anything that must not carry the raw text, like a memory view of a transcript, reads this field.
   */
  abstract?: string;
  content_kind: string;
  published_at?: string;
  /** Short machine-readable warnings a source attaches, e.g. "truncated: 39:31 of 57:02". */
  flags?: string[];
  /** His own voice: an inbox note he marked `voice: own`, or (set when routed) any item of a voice source. */
  own_voice?: boolean;
  /** An item may make itself stricter than its source, never looser. */
  privacy_class?: PrivacyClass;
}

/** What a source may use while it pulls. */
export interface PullContext {
  log(msg: string): void;
  fetch: typeof fetch;
  /** Set by the pipeline for each source: has this item already been journaled? Lets a source skip expensive detail fetches. */
  known?(item: { url?: string; external_id: string }): boolean;
}

export interface Source {
  name: string;
  trust: Trust;
  privacy_class: PrivacyClass;
  pull(ctx: PullContext): Promise<RawItem[]>;
}
