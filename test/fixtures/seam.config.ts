// A fixed source for the seam S1 conformance test: `pull | ingest` against `run`.
// Its items cover what the seam has to carry unchanged: secrets for the guard, a stricter privacy
// class, own voice, flags, an empty title, a body that reappears under another URL, a private span.

import { join } from "node:path";
import type { FeedConfig, RawItem, Source } from "../../src/core/types.ts";

const KEY = "sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-0000000000";
const GH = `ghp_${"a".repeat(36)}`;
const LONG = "An llm wiki is a second brain that compounds. ".repeat(8);

export const ITEMS: RawItem[] = [
  { external_id: "a1", url: "https://example.org/a?utm_source=rss", title: `Second brain notes ${GH}`, content: `Agent memory as an llm wiki. key ${KEY}`, content_kind: "article", author: "Ann", published_at: "2026-10-15T10:00:00.000Z" },
  { external_id: "c7", title: "His call", content: `I decided to keep the second brain local. <private>not for the ledger</private> Done.`, abstract: "a call, 12 min", content_kind: "transcript", privacy_class: "personal", own_voice: true, flags: [`truncated: 9:00 of 12:00 ${KEY}`] },
  { external_id: "e0", title: "", content: "An item a source sent with an empty title, about agent memory.", content_kind: "note" },
  { external_id: "u1", title: "Ümlaut \"quotes\" and\nnewlines", content: "Zeile eins\nZeile zwei — llm wiki ✓", content_kind: "note" },
  { external_id: "l1", url: "https://example.org/long", title: "Long body", content: LONG, content_kind: "article" },
  { external_id: "l2", url: "https://mirror.example.net/long", title: "Long body, mirrored", content: LONG, content_kind: "article" },
];

// Like the YouTube source, it skips what the ledger already holds when it is told (`known`).
const fixture: Source = { name: "fixture", trust: "normal", privacy_class: "public", pull: async (ctx) => ITEMS.filter((i) => !ctx.known?.(i)) };

// A source that always fails, and one that takes a while: the pipe edges (audit, 2026-10-16).
const boom: Source = { name: "boom", trust: "normal", privacy_class: "public", pull: async () => { throw new Error("boom"); } };
const slow: Source = { name: "slow", trust: "normal", privacy_class: "public", pull: async () => { await Bun.sleep(1500); return [ITEMS[0]]; } };

export default {
  dataDir: process.env.SEAM_DATA ?? join(import.meta.dir, "unset-data"),
  intent: join(import.meta.dir, "seam-intent.md"),
  sinks: {},
  jobs: { j: { sources: [fixture], rules: [] }, edge: { sources: [boom, slow], rules: [] } },
} satisfies FeedConfig;
