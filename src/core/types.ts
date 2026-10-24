// The contracts every module speaks. A source emits RawItems, the engine turns them into Envelopes and
// GradedItems, a sink receives GradedItems. The two seam contracts live in src/contracts/ and are
// re-exported here, so every import keeps working; what stays below is the engine's own configuration.

export * from "../contracts/feed-item.ts";
export * from "../contracts/ledger.ts";
import type { ModelPort, PiiLabel, PiiPort, Rule, Sink, VoiceItem, VoiceKind } from "../contracts/ledger.ts";
import type { Source } from "../contracts/feed-item.ts";

/** Where an approved voice item lands. Only `review approve` calls it. */
export interface VoiceTarget {
  /** `kind` is what it lands as (idea unless he typed one); `typed` says he typed it at approval. */
  /** `landed`: what the record already held for this candidate (a repeated approval writes nothing and reports it). */
  land(item: VoiceItem, receipt: { approved_at: string; kind: VoiceKind; typed: boolean }): Promise<{ ref: string; landed?: { kind: VoiceKind; typed: boolean } }>;
  /** Where it would land, for the preview at approval. */
  pathFor?(item: VoiceItem, landing: { kind: VoiceKind; typed: boolean }): string;
  /** Every check `land` makes before writing (record exists, under the root, no link): the path, or a throw. */
  preflight?(item: VoiceItem, landing: { kind: VoiceKind; typed: boolean }): string;
}

export interface VoiceConfig {
  /** Sources whose every item is the owner's own voice (e.g. "Omi"). */
  sources: string[];
  /** Sources where only items he marks as his own count (the inbox: frontmatter `voice: own`). */
  marked?: string[];
  /** Labels the recorder gives his own turns (Omi renders is_user segments with this label). */
  ownerLabels?: string[];
  /** New candidates offered to him per run (default 10); the rest wait, most useful first. */
  maxNewPerRun?: number;
  /** One sitting: at most this many candidates wait in his queue at once (default 25); a run tops it up. */
  maxWaiting?: number;
  /** Failed runs after which an item is parked until `voice reset <id>` (default 3). */
  failuresBeforePark?: number;
  /** The port for extraction; defaults to the grading port. Must accept personal items. */
  port?: ModelPort;
  /** Characters of text per extraction call (default 6000: past that, the model reads the first half of a chunk and skims the rest). */
  chunkChars?: number;
  target: VoiceTarget;
}

export interface ModelConfig {
  port: ModelPort;
  /** Upper bound on model calls in one run (default 60). The rest wait for later runs. */
  maxCallsPerRun?: number;
  /** Calls in flight at once (default 3). */
  concurrency?: number;
  /** The fixed label set the model chooses from (Daniel: small and fixed, so labels stay comparable). */
  taxonomy: string[];
  /** What the owner is trying to do, beyond the intent profile (e.g. a short statement of goals). */
  context?: string;
}


export interface PiiConfig {
  port: PiiPort;
  /** Sources whose new items are checked (an inbox, a mail drop). Public feeds are not: their names are public context. */
  sources: string[];
  /** Labels that make an item personal. Default: contact, bank, address, ID and birth date; names and firms only flag. */
  tighten?: PiiLabel[];
  /** Hits below this confidence are ignored (default 0.5). */
  minScore?: number;
}

export interface Job {
  sources: Source[];
  rules: Rule[];
}

export interface IntentProfile {
  owner: string;
  interests: { label: string; terms: string[]; weight: number }[];
  projects: { name: string; terms: string[] }[];
  avoid: string[];
}

export interface FeedConfig {
  dataDir: string;
  intent: string;
  sinks: Record<string, Sink>;
  jobs: Record<string, Job>;
  /** Items shorter than this are journaled but never graded or routed. */
  minContentChars?: number;
  /** Optional model grading (Daniel's Summarize + Rate). Without it every grade is deterministic. */
  model?: ModelConfig;
  /** Personal-data checks on the new items of some sources: hits are flags, and contact data makes an item personal. */
  pii?: PiiConfig;
  /** The own-voice stage: decisions, ideas, asks and open questions out of personal items, into the review queue. */
  voice?: VoiceConfig;
  /** Source reputation and auto-demotion (Daniel). Defaults below; `false` turns demotion off. */
  reputation?: false | { minItems?: number; maxAvgQuality?: number; windowDays?: number };
}


/** Per-source health, persisted in the data directory and updated on every pull. */
export interface SourceHealth {
  last_ok?: string;
  last_error?: string;
  last_error_at?: string;
  consecutive_failures: number;
  last_pulled: number;
  last_fresh: number;
  /** Rolling reputation over the last window (Daniel): items, mean quality, share with quality ≥ 70. */
  rolling_items?: number;
  rolling_avg_quality?: number;
  rolling_a_rate?: number;
  /** Set when reputation demotes the source; it is skipped until `source reset`. */
  demoted_at?: string;
  demoted_reason?: string;
}
