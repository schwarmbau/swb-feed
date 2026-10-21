// Seam S1, Feed → engine: the pipe door must journal exactly what the in-process door journals.
// Real processes and a real pipe, scratch data dirs only. Below: the swb-ledger/v1 row stamp.

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture, { ITEMS } from "./fixtures/seam.config.ts";
import { ingest, renderViews } from "../src/core/pipeline.ts";
import { Ledger, skippedRows } from "../src/core/ledger.ts";
import { reviewQueue, reviewRows } from "../src/sinks/review.ts";
import type { FeedConfig, GradedItem, RunContext, Source } from "../src/core/types.ts";

const CLI = join(import.meta.dir, "../src/core/cli.ts");
const CONFIG = join(import.meta.dir, "fixtures/seam.config.ts");
const BUN = process.execPath;

const scratch = () => mkdtempSync(join(tmpdir(), "swb-seam-"));
const env = (data: string) => ({ ...process.env, SEAM_DATA: data });

function cli(data: string, ...args: string[]) {
  const r = Bun.spawnSync([BUN, CLI, ...args, "--config", CONFIG], { env: env(data), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** `pull | ingest` through sh, arguments passed as positionals, never interpolated. */
function pipe(data: string, source = "fixture") {
  const script = `"$0" "$1" pull j "$3" --config "$2" | "$0" "$1" ingest j "$3" --config "$2"`;
  const r = Bun.spawnSync(["sh", "-c", script, BUN, CLI, CONFIG, source], { env: env(data), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`pull | ingest exited ${r.exitCode}: ${r.stderr.toString()}`);
}

/** Rows of a data file with the fields that name a moment dropped: everything else must match byte for byte. */
const rows = (dir: string, file: string, moment: string) =>
  readFileSync(join(dir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const { [moment]: _, ...rest } = JSON.parse(l);
      return JSON.stringify(rest);
    });

describe("seam S1: pull | ingest = run", () => {
  test("pull prints every item the source pulled, as JSONL, and writes nothing", () => {
    const data = join(scratch(), "data");
    const out = cli(data, "pull", "j", "fixture").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(out.at(-1)).toEqual({ swb_pull_end: { source: "fixture", items: ITEMS.length } });
    expect(out.slice(0, -1)).toEqual(JSON.parse(JSON.stringify(ITEMS)));
    expect(existsSync(data)).toBe(false);
  });

  test("pull gives the source the run's `known`, read-only, and the second pass matches run's too", () => {
    const [twiceRun, runThenPipe] = [scratch(), scratch()];
    cli(twiceRun, "run", "j");
    cli(runThenPipe, "run", "j");
    const before = Object.fromEntries(["ledger.jsonl", "grades.jsonl", "health.json"].map((f) => [f, readFileSync(join(runThenPipe, f), "utf8")]));
    // Only the mirrored long body is unknown by id: run dropped it as a duplicate body, never journaled it.
    const out = cli(runThenPipe, "pull", "j", "fixture").split("\n").filter(Boolean).slice(0, -1).map((l) => JSON.parse(l).external_id);
    expect(out).toEqual(["l2"]);
    for (const [f, text] of Object.entries(before)) expect(readFileSync(join(runThenPipe, f), "utf8")).toBe(text);

    cli(twiceRun, "run", "j");
    pipe(runThenPipe);
    expect(rows(runThenPipe, "ledger.jsonl", "captured_at")).toEqual(rows(twiceRun, "ledger.jsonl", "captured_at"));
    expect(rows(runThenPipe, "grades.jsonl", "graded_at")).toEqual(rows(twiceRun, "grades.jsonl", "graded_at"));
  });

  test("a failed pull piped into ingest leaves the source health alone and fails the pipe", () => {
    const data = scratch();
    const r = Bun.spawnSync(["sh", "-c", `"$0" "$1" pull edge boom --config "$2" | "$0" "$1" ingest edge boom --config "$2"`, BUN, CLI, CONFIG], { env: env(data), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("no end-of-pull line");
    const health = existsSync(join(data, "health.json")) ? JSON.parse(readFileSync(join(data, "health.json"), "utf8")) : {};
    expect(JSON.stringify(health)).not.toContain("boom");
  });

  test("ingest takes the run lock only after its pipe is read, so a slow pull never holds the run", async () => {
    const data = scratch();
    mkdirSync(data, { recursive: true });
    const p = Bun.spawn(["sh", "-c", `"$0" "$1" pull edge slow --config "$2" | "$0" "$1" ingest edge slow --config "$2"`, BUN, CLI, CONFIG], { env: env(data), stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(700);
    expect(existsSync(join(data, "run.lock"))).toBe(false);
    expect(await p.exited).toBe(0);
    expect(rows(data, "ledger.jsonl", "captured_at")).toHaveLength(1);
  });

  test("an unknown job or source is a usage error, not an empty pull", () => {
    const r = Bun.spawnSync([BUN, CLI, "pull", "j", "nope", "--config", CONFIG], { env: env(join(scratch(), "data")), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("usage: swb-feed pull");
  });

  test("the ledger and the grades are identical on both doors, the guard included", () => {
    const viaRun = scratch();
    const viaPipe = scratch();
    cli(viaRun, "run", "j");
    pipe(viaPipe);

    const ledgerRun = rows(viaRun, "ledger.jsonl", "captured_at");
    const ledgerPipe = rows(viaPipe, "ledger.jsonl", "captured_at");
    expect(ledgerPipe).toEqual(ledgerRun);
    expect(rows(viaPipe, "grades.jsonl", "graded_at")).toEqual(rows(viaRun, "grades.jsonl", "graded_at"));

    // Not vacuous: every item but the mirrored long body was journaled, and the guard redacted on both doors.
    expect(ledgerRun.length).toBe(ITEMS.length - 1);
    const envelopes = ledgerRun.map((l) => JSON.parse(l));
    expect(envelopes.flatMap((e) => e.redactions).sort()).toEqual(["anthropic_key", "github_token"]);
    for (const dir of [viaRun, viaPipe]) {
      const text = readFileSync(join(dir, "ledger.jsonl"), "utf8");
      expect(text).not.toContain("sk-ant-");
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("not for the ledger");
    }
    const call = envelopes.find((e) => e.external_id === "c7");
    expect(call).toMatchObject({ privacy_class: "personal", own_voice: true, abstract: "a call, 12 min" });
    expect(envelopes.find((e) => e.external_id === "e0").title).toBe("");
  });
});

describe("swb-ledger/v1: the row stamp", () => {
  const FILES = ["ledger.jsonl", "grades.jsonl", "review.jsonl"];
  const ctx = (dataDir: string): RunContext => ({ dataDir, dryRun: false, log: () => {}, fetch });

  /** A config over the fixture source whose items reach a recording view and the review queue. */
  function config(dataDir: string, seen: string[] = []): FeedConfig {
    const source = fixture.jobs.j.sources[0]!;
    return {
      ...fixture,
      dataDir,
      sinks: {
        seen: { kind: "view", accepts: ["public", "personal"], render: async (items: GradedItem[]) => (seen.push(JSON.stringify(items)), {}) },
        queue: reviewQueue({ approve: { kind: "delivery", deliver: async () => ({ ref: "kept" }) } }),
      },
      jobs: { j: { sources: [source], rules: [{ name: "all", to: ["seen", "queue"] }] } },
    };
  }

  /** The same data dir as it looked before the stamp: every row of the three files without `v`. */
  function unstamped(from: string): string {
    const to = join(scratch(), "data");
    mkdirSync(to);
    for (const f of FILES) {
      const lines = readFileSync(join(from, f), "utf8").split("\n").filter(Boolean);
      writeFileSync(join(to, f), lines.map((l) => JSON.stringify((({ v: _, ...rest }) => rest)(JSON.parse(l)))).join("\n") + "\n");
    }
    return to;
  }

  test("new rows carry v: 1, and readers see rows without it exactly as before", async () => {
    const stamped = join(scratch(), "data");
    await ingest(config(stamped), config(stamped).jobs.j, [{ source: config(stamped).jobs.j.sources[0]! }], ctx(stamped));
    for (const f of FILES) {
      const lines = readFileSync(join(stamped, f), "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l.startsWith('{"v":1,')).toBe(true);
    }

    const old = unstamped(stamped);
    expect(readFileSync(join(old, "ledger.jsonl"), "utf8")).not.toContain('"v":');
    const [a, b] = [new Ledger(stamped), new Ledger(old)];
    expect(a.envelopes()).toEqual(b.envelopes());
    expect([...a.latestGrades()]).toEqual([...b.latestGrades()]);
    expect(reviewRows(stamped)).toEqual(reviewRows(old));
    for (const e of a.envelopes()) expect("v" in e).toBe(false);
    for (const r of reviewRows(stamped)) expect("v" in r).toBe(false);

    // rebuild hands every view the same items from either file.
    const [seenNew, seenOld]: string[][] = [[], []];
    await renderViews(config(stamped, seenNew), a, ctx(stamped));
    await renderViews(config(old, seenOld), b, ctx(old));
    expect(seenNew.length).toBe(1);
    expect(seenNew).toEqual(seenOld);
  });

  test("an old row is never rewritten: new rows are appended after it", async () => {
    const first = join(scratch(), "data");
    await ingest(config(first), config(first).jobs.j, [{ source: config(first).jobs.j.sources[0]! }], ctx(first));
    const old = unstamped(first);
    const before = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(old, f), "utf8")]));
    const late: Source = { name: "fixture", trust: "normal", privacy_class: "public", pull: async () => [{ external_id: "n1", title: "A later second brain item", content: "llm wiki, agent memory, later.", content_kind: "note" }] };
    const cfg = config(old);
    await ingest(cfg, { ...cfg.jobs.j, sources: [late] }, [{ source: late }], ctx(old));
    for (const f of FILES) {
      const after = readFileSync(join(old, f), "utf8");
      expect(after.startsWith(before[f]!)).toBe(true);
      const added = after.slice(before[f]!.length).split("\n").filter(Boolean);
      expect(added.length).toBeGreaterThan(0);
      for (const l of added) expect(l.startsWith('{"v":1,')).toBe(true);
    }
  });

  test("a row of another version is skipped and counted, never read as ours", async () => {
    const dir = join(scratch(), "data");
    await ingest(config(dir), config(dir).jobs.j, [{ source: config(dir).jobs.j.sources[0]! }], ctx(dir));
    const n = new Ledger(dir).envelopes().length;
    const queued = reviewRows(dir).length;
    const row = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n")[0]!);
    appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ ...row, v: 2, id: "from-the-future" })}\n`);
    appendFileSync(join(dir, "review.jsonl"), `${JSON.stringify({ v: 2, id: "from-the-future", decision: "queued", at: "2027-01-01T00:00:00Z" })}\n`);
    skippedRows.clear();
    expect(new Ledger(dir).envelopes().length).toBe(n);
    expect(skippedRows.get(join(dir, "ledger.jsonl"))).toBe(1);
    expect(reviewRows(dir).length).toBe(queued);
  });
});
