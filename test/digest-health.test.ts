import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, envelopeFrom, ingest, readHealth } from "../src/core/pipeline.ts";
import { gradeDeterministic } from "../src/core/grade.ts";
import { parseIntent } from "../src/core/intent.ts";
import { writeDigest } from "../src/core/digest.ts";
import type { FeedConfig, GradedItem, RawItem, RunContext, Source, ViewSink } from "../src/core/types.ts";

const PROFILE = `# Intent — tester
## Interests
- **Agent memory** (3): agent memory, second brain, llm wiki, walk
## Projects
- **brain**: second brain, llm wiki, walk
`;
const profile = parseIntent(PROFILE);
const fakeFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const ctx = (f: typeof fetch = fetch, dryRun = false): RunContext => ({ dataDir: "", dryRun, log: () => {}, fetch: f });

function graded(raw: RawItem, src: Pick<Source, "name" | "trust" | "privacy_class">): GradedItem {
  const e = envelopeFrom(raw, src);
  return { ...e, grade: gradeDeterministic(e, profile, "h"), rules: [], priority: "daily" };
}

describe("digest", () => {
  test("names flagged items and failing sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-dig-"));
    writeFileSync(join(dir, "intent.md"), PROFILE);
    const good: Source = { name: "Omi", trust: "high", privacy_class: "personal", pull: async () => [{ external_id: "c1", title: "Walk", content: "a walk about the second brain", content_kind: "transcript", flags: ["truncated: transcript ends at 39:31 of 57:00"] }] };
    const bad: Source = { name: "Broken", trust: "normal", privacy_class: "public", pull: async () => { throw new Error("HTTP 503"); } };
    const job = { sources: [good, bad], rules: [] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: {}, jobs: { j: job } };
    await ingest(cfg, job, [{ source: good }, { source: bad }], ctx());
    const r = writeDigest(cfg, { dir: join(dir, "digests") });
    const md = readFileSync(r.path, "utf8");
    expect(md).toContain("truncated: transcript ends at 39:31");
    expect(md).toContain("**Broken** failing 1×");
    expect(r.sick).toEqual(["Broken"]);
    rmSync(dir, { recursive: true });
  });
});

describe("audit regressions (2026-10-15)", () => {

  test("H1 a view that throws is reported in health and does not stop the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-run-"));
    writeFileSync(join(dir, "intent.md"), PROFILE);
    const src: Source = { name: "S", trust: "normal", privacy_class: "public", pull: async () => [{ external_id: "1", url: "https://e.org/1", title: "second brain", content: "llm wiki", content_kind: "article" }] };
    const broken: ViewSink = { kind: "view", render: async () => { throw new Error("boom"); } };
    const job = { sources: [src], rules: [{ name: "all", to: ["broken"] }] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: { broken }, jobs: { j: job } };
    const r = await ingest(cfg, job, [{ source: src }], ctx());
    expect(r.views[0]).toContain("FAILED: boom");
    expect(readHealth(cfg.dataDir)["view · broken"].consecutive_failures).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("H2 one writer at a time; a lock left by a dead process is taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-lock-"));
    const release = acquireLock(dir);
    expect(release).not.toBeNull();
    writeFileSync(join(dir, "run.lock"), String(process.ppid)); // a live process that is not us
    expect(acquireLock(dir)).toBeNull();
    writeFileSync(join(dir, "run.lock"), "999999"); // no such process
    const again = acquireLock(dir);
    expect(again).not.toBeNull();
    again!();
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
    rmSync(dir, { recursive: true });
  });

});
