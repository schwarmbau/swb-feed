// Three append-only JSONL files, each with one job and one truth-change law:
//   ledger.jsonl      raw captures, written first, never rewritten   (immutable)
//   grades.jsonl      derived grades, carrying the profile hash       (revisable: re-grade appends)
//   deliveries.jsonl  item × sink receipts                            (idempotent delivery)
// Everything a sink shows is rebuildable from these three files.
// New ledger and grade rows carry `v` (swb-ledger/v1); the stamp is stripped on read, so no caller sees it.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_ROW_VERSION, type Delivery, type Envelope, type Grade } from "./types.ts";

export type { Delivery };

/** Rows that failed to parse or had the wrong shape, per file, at its latest read (a torn line that heals clears). */
export const skippedRows = new Map<string, number>();

/**
 * A row without its version stamp. A row with no `v` predates the stamp and reads as version 1;
 * a row of another version is not ours to read (undefined), so it is skipped like a wrong shape.
 */
export function unversioned(row: unknown): unknown {
  if (!isObj(row) || !("v" in row)) return row;
  const { v, ...rest } = row;
  return v === LEDGER_ROW_VERSION ? rest : undefined;
}

/**
 * A torn line from a crash, or a row of the wrong shape (a hand edit, corruption), is skipped and
 * counted, never fatal: one bad row must not stop every job in the run.
 */
function readJsonl<T>(path: string, valid: (x: unknown) => boolean): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = unversioned(JSON.parse(line));
      if (valid(row)) out.push(row as T);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (skipped) skippedRows.set(path, skipped);
  else skippedRows.delete(path);
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (v: unknown) => typeof v === "string";
const validEnvelope = (x: unknown) =>
  isObj(x) && isStr(x.id) && isStr(x.source) && isStr(x.title) && isStr(x.content) && isStr(x.content_hash) && isStr(x.captured_at) && isStr(x.content_kind) && (x.flags === undefined || Array.isArray(x.flags));
const validGrade = (x: unknown) => isObj(x) && isStr(x.id) && typeof x.score === "number" && isStr(x.grader) && Array.isArray(x.why) && Array.isArray(x.labels) && Array.isArray(x.projects) && isStr(x.summary_short) && isStr(x.summary_medium);
const validDelivery = (x: unknown) => isObj(x) && isStr(x.id) && isStr(x.sink) && typeof x.ok === "boolean";

/** A growing item is re-graded at most once a day, so a feed that pads its posts cannot burn the model budget. */
const REVISION_INTERVAL_MS = 24 * 3600_000;

/**
 * Short bodies ("Comments", an empty description, a one-line release note) are shared by
 * unrelated items, so only a body long enough to be a fingerprint dedupes across URLs.
 */
const MIN_FINGERPRINT_CHARS = 280;
const hashable = (e: Pick<Envelope, "content">) => e.content.length >= MIN_FINGERPRINT_CHARS;

interface Version {
  hash: string;
  length: number;
  truncated: boolean;
  at: string;
}

const isTruncated = (e: Pick<Envelope, "flags">) => Boolean(e.flags?.some((f) => f.startsWith("truncated")));

export class Ledger {
  readonly ledgerPath: string;
  readonly gradesPath: string;
  readonly deliveriesPath: string;
  /** The newest version of each item: what a revision is measured against. */
  private latest = new Map<string, Version>();
  private hashes = new Set<string>();
  private delivered = new Set<string>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.ledgerPath = join(dir, "ledger.jsonl");
    this.gradesPath = join(dir, "grades.jsonl");
    this.deliveriesPath = join(dir, "deliveries.jsonl");
    for (const e of readJsonl<Envelope>(this.ledgerPath, validEnvelope)) this.remember(e);
    for (const d of readJsonl<Delivery>(this.deliveriesPath, validDelivery)) if (d.ok) this.delivered.add(`${d.id}\u0000${d.sink}`);
  }

  private remember(e: Envelope): void {
    this.latest.set(e.id, { hash: e.content_hash, length: e.content.length, truncated: isTruncated(e), at: e.captured_at });
    if (hashable(e)) this.hashes.add(e.content_hash);
  }

  /** Same id, or the same substantial body arriving under another URL, is the same capture. */
  has(e: Pick<Envelope, "id" | "content_hash" | "content">): boolean {
    return this.latest.has(e.id) || (hashable(e) && this.hashes.has(e.content_hash));
  }

  /**
   * A known item that came back materially better: its body grew by a tenth or more (at most once
   * a day), or a truncation flag went away (Omi re-sending the full transcript). Small rewrites of a feed's
   * description are not revisions, or every hourly run would re-grade them.
   */
  isRevision(e: Envelope): boolean {
    const prev = this.latest.get(e.id);
    if (!prev || prev.hash === e.content_hash || this.hashes.has(e.content_hash)) return false;
    if (prev.truncated && !isTruncated(e)) return true;
    return e.content.length >= prev.length * 1.1 && Date.parse(e.captured_at) - Date.parse(prev.at) >= REVISION_INTERVAL_MS;
  }

  /** Journals a new item or a revision of a known one; anything else is a duplicate and is dropped. */
  append(e: Envelope): boolean {
    if (this.has(e) && !this.isRevision(e)) return false;
    appendFileSync(this.ledgerPath, `${JSON.stringify({ v: LEDGER_ROW_VERSION, ...e })}\n`);
    this.remember(e);
    return true;
  }

  appendGrade(g: Grade): void {
    appendFileSync(this.gradesPath, `${JSON.stringify({ v: LEDGER_ROW_VERSION, ...g })}\n`);
  }

  wasDelivered(id: string, sink: string): boolean {
    return this.delivered.has(`${id}\u0000${sink}`);
  }

  recordDelivery(d: Delivery): void {
    appendFileSync(this.deliveriesPath, `${JSON.stringify(d)}\n`);
    if (d.ok) this.delivered.add(`${d.id}\u0000${d.sink}`);
  }

  /** Every item once, at its newest version, in the order items first arrived. */
  envelopes(): Envelope[] {
    const byId = new Map<string, Envelope>();
    for (const e of readJsonl<Envelope>(this.ledgerPath, validEnvelope)) byId.set(e.id, e);
    return [...byId.values()];
  }

  /** The newest grade per item. */
  latestGrades(): Map<string, Grade> {
    const m = new Map<string, Grade>();
    for (const g of readJsonl<Grade>(this.gradesPath, validGrade)) m.set(g.id, g);
    return m;
  }

  deliveries(): Delivery[] {
    return readJsonl<Delivery>(this.deliveriesPath, validDelivery);
  }

  size(): number {
    return this.latest.size;
  }
}
