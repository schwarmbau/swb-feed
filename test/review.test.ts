import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/core/pipeline.ts";
import { allGraded } from "../src/core/pipeline.ts";
import { Ledger } from "../src/core/ledger.ts";
import { writeDigest } from "../src/core/digest.ts";
import { runCli } from "../src/core/cli.ts";
import { approveReview, pendingReviews, rejectReview, reviewQueue, reviewRows } from "../src/sinks/review.ts";
import type { DeliverySink, FeedConfig, RawItem, RunContext, Source } from "../src/core/types.ts";

// The review step: promotion waits for a person's approval. Only an approval writes,
// every approval and rejection is a receipt in review.jsonl, and a rejected item is never offered again.

const PROFILE = `# Intent — tester
## Interests
- **Agent memory** (3): agent memory, second brain, llm wiki
## Projects
- **brain**: second brain, llm wiki
`;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
const ctx = (dataDir = "", dryRun = false): RunContext => ({ dataDir, dryRun, log: () => {}, fetch });

const ITEMS: RawItem[] = [
  { external_id: "a", url: "https://e.org/a", title: "Second brain patterns", content: "agent memory and the llm wiki, a long article", content_kind: "article" },
  { external_id: "b", url: "https://e.org/b", title: "LLM wiki in practice", content: "second brain with an llm wiki, notes from the field", content_kind: "article" },
];

/** A target that records what it would have written, so writes can be counted against receipts. */
function fakeTarget(dir: string, opts: { skip?: boolean } = {}) {
  const writes: string[] = [];
  const sink: DeliverySink = {
    kind: "delivery",
    accepts: ["public"],
    async deliver(item) {
      if (opts.skip) return { ref: "would write", skipped: true };
      const path = join(dir, `${item.id}.md`);
      writeFileSync(path, item.title);
      writes.push(path);
      return { ref: path };
    },
  };
  return { sink, writes };
}

function setup(research: DeliverySink, items: RawItem[] = ITEMS, privacy: "public" | "personal" = "public") {
  const dir = scratch("feed-review-");
  writeFileSync(join(dir, "intent.md"), PROFILE);
  const source: Source = { name: "Blog", trust: "normal", privacy_class: privacy, pull: async () => items };
  const job = { sources: [source], rules: [{ name: "promote", to: ["research"] }] };
  const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: { research }, jobs: { j: job } };
  return { dir, cfg, job, source, c: ctx(join(dir, "data")) };
}

const items = (cfg: FeedConfig) => allGraded(cfg, new Ledger(cfg.dataDir));

describe("review queue", () => {
  test("a promote candidate is queued, not written, and queued only once", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    const r = await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    expect(r.delivered.map((d) => d.ok)).toEqual([true, true]);
    expect(t.writes).toEqual([]);
    expect(pendingReviews(s.cfg.dataDir).map((p) => p.title).sort()).toEqual(["LLM wiki in practice", "Second brain patterns"]);
    await ingest(s.cfg, s.job, [], s.c);
    expect(reviewRows(s.cfg.dataDir).filter((x) => x.decision === "queued")).toHaveLength(2);
  });

  test("approve writes through the wrapped sink and records the receipt with its ref", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    const id = pendingReviews(s.cfg.dataDir)[0]!.id;
    const row = await approveReview(s.cfg, items(s.cfg), id.slice(0, 6), s.c);
    expect(row.decision).toBe("approved");
    expect(t.writes).toEqual([row.ref!]);
    expect(pendingReviews(s.cfg.dataDir).map((p) => p.id)).not.toContain(id);
    await expect(approveReview(s.cfg, items(s.cfg), id.slice(0, 6), s.c)).rejects.toThrow("already approved");
  });

  test("falsifier: no write without an approve receipt; every write has one", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    const [first, second] = pendingReviews(s.cfg.dataDir);
    await approveReview(s.cfg, items(s.cfg), first!.id, s.c);
    rejectReview(s.cfg, second!.id);
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    const approvedRefs = reviewRows(s.cfg.dataDir).filter((r) => r.decision === "approved").map((r) => r.ref);
    expect(t.writes).toEqual(approvedRefs as string[]);
  });

  test("reject is final: no write, and the item is never offered again", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    const id = pendingReviews(s.cfg.dataDir)[0]!.id;
    expect(rejectReview(s.cfg, id).decision).toBe("rejected");
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    expect(pendingReviews(s.cfg.dataDir).map((p) => p.id)).not.toContain(id);
    expect(reviewRows(s.cfg.dataDir).filter((r) => r.id === id).map((r) => r.decision)).toEqual(["queued", "rejected"]);
    await expect(approveReview(s.cfg, items(s.cfg), id, s.c)).rejects.toThrow("already rejected");
    expect(t.writes).toEqual([]);
  });

  test("a target that only rehearses leaves the item waiting, with no receipt", async () => {
    const t = fakeTarget(scratch("feed-target-"), { skip: true });
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    const id = pendingReviews(s.cfg.dataDir)[0]!.id;
    await expect(approveReview(s.cfg, items(s.cfg), id, s.c)).rejects.toThrow("only rehearsed");
    expect(pendingReviews(s.cfg.dataDir).map((p) => p.id)).toContain(id);
    expect(reviewRows(s.cfg.dataDir).some((r) => r.decision === "approved")).toBe(false);
  });

  test("a personal item is never queued for a public-only target", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }), ITEMS, "personal");
    const r = await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    expect(r.delivered).toEqual([]);
    expect(pendingReviews(s.cfg.dataDir)).toEqual([]);
  });

  test("an id prefix must be 4+ characters and unambiguous", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    expect(() => rejectReview(s.cfg, "ab")).toThrow("4+ characters");
    expect(() => rejectReview(s.cfg, "zzzz")).toThrow("no item waiting");
  });

  test("the digest shows what waits, and queueing is not counted as handed to memory", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    let d = writeDigest(s.cfg, { dir: join(s.dir, "digests") });
    let md = readFileSync(d.path, "utf8");
    expect(d.waiting).toBe(2);
    expect(d.delivered).toBe(0);
    expect(md).toContain("## Waiting for your review: 2");
    expect(md).toContain("2 waiting for your review");
    expect(md).not.toContain("## Handed to memory");
    const id = pendingReviews(s.cfg.dataDir)[0]!.id;
    await approveReview(s.cfg, items(s.cfg), id, s.c);
    d = writeDigest(s.cfg, { dir: join(s.dir, "digests") });
    md = readFileSync(d.path, "utf8");
    expect(d.waiting).toBe(1);
    expect(d.delivered).toBe(1);
    expect(md).toContain("## Waiting for your review: 1");
    expect(md).toContain("→ review → approved");
  });

  test("swb-feed review: list, approve and reject through the CLI", async () => {
    const t = fakeTarget(scratch("feed-target-"));
    const s = setup(reviewQueue({ approve: t.sink }));
    await ingest(s.cfg, s.job, [{ source: s.source }], s.c);
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      await runCli(["review"], async () => s.cfg);
      const [a, b] = pendingReviews(s.cfg.dataDir);
      await runCli(["review", "approve", a!.id.slice(0, 8)], async () => s.cfg);
      await runCli(["review", "reject", b!.id.slice(0, 8)], async () => s.cfg);
      await runCli(["review", "list"], async () => s.cfg);
    } finally {
      console.log = log;
    }
    expect(out[0]).toBe("2 waiting for your review (approve <id> writes it, reject <id> closes it for good):");
    expect(out.some((l) => l.startsWith("approved "))).toBe(true);
    expect(out.some((l) => l.startsWith("rejected ") && l.endsWith("it will not be offered again"))).toBe(true);
    expect(out.at(-1)).toBe("nothing is waiting for review");
    expect(t.writes).toHaveLength(1);
    expect(existsSync(join(s.cfg.dataDir, "run.lock"))).toBe(false);
  });
});
