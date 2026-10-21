import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard } from "../src/core/guard.ts";
import { parseFeed } from "../src/sources/feed.ts";
import { parseIntent } from "../src/core/intent.ts";
import { gradeDeterministic } from "../src/core/grade.ts";
import { route } from "../src/core/route.ts";
import { envelopeFrom, ingest, renderViews, regrade } from "../src/core/pipeline.ts";
import { Ledger } from "../src/core/ledger.ts";
import { wiki } from "../src/sinks/wiki.ts";
import { hindsight } from "../src/sinks/deliveries.ts";
import type { DeliverySink, FeedConfig, GradedItem, RawItem, RunContext, Source } from "../src/core/types.ts";

const FAKE_KEY = "sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-0000000000";
const ctx = (dryRun = false): RunContext => ({ dataDir: "", dryRun, log: () => {}, fetch });

const PROFILE = `# Intent — tester
## Interests
- **Agent memory** (3): agent memory, second brain, llm wiki
- **Security** (1): prompt injection
## Projects
- **brain**: second brain, llm wiki
## Avoid
- giveaway
`;

function raw(over: Partial<RawItem> = {}): RawItem {
  return { external_id: "x1", url: "https://example.org/a?utm_source=rss", title: "An LLM wiki as a second brain", content: "Agent memory works best as an llm wiki. It compounds.", content_kind: "article", ...over };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "swb-feed-"));
  writeFileSync(join(dir, "intent.md"), PROFILE);
  return dir;
}

const staticSource = (name: string, items: RawItem[], privacy: "public" | "personal" = "public"): Source => ({
  name,
  trust: "normal",
  privacy_class: privacy,
  pull: async () => items,
});

function recorder(): DeliverySink & { got: GradedItem[] } {
  const got: GradedItem[] = [];
  return { kind: "delivery", got, deliver: async (i) => (got.push(i), { ref: "mem" }) };
}

describe("guard", () => {
  test("replaces secret shapes with typed markers and strips private spans", () => {
    const r = guard(`key ${FAKE_KEY} and ghp_${"a".repeat(36)} <private>hidden</private> visible`);
    expect(r.text).not.toContain("sk-ant-");
    expect(r.text).toContain("[REDACTED:anthropic_key]");
    expect(r.text).toContain("[REDACTED:github_token]");
    expect(r.text).not.toContain("hidden");
    expect(r.text).toContain("visible");
  });
  test("an unclosed private tag suppresses the rest (fail closed)", () => {
    expect(guard("keep <private>drop everything after").text).toBe("keep ");
  });
});

describe("parseFeed", () => {
  test("RSS 2.0 with content:encoded and CDATA", () => {
    const xml = `<rss><channel><item><title>Hello &amp; welcome</title><link>https://e.org/1</link><guid>g1</guid>
      <pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate><dc:creator>Ann</dc:creator>
      <description>short</description><content:encoded><![CDATA[<p>Full <b>body</b> text.</p>]]></content:encoded></item></channel></rss>`;
    const [e] = parseFeed(xml);
    expect(e.title).toBe("Hello & welcome");
    expect(e.url).toBe("https://e.org/1");
    expect(e.content).toBe("Full body text.");
    expect(e.author).toBe("Ann");
    expect(e.published_at).toBe("2026-10-13T10:00:00.000Z");
  });
  test("Atom with alternate link, author name and escaped HTML content", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title>Release v1.2</title>
      <link rel="alternate" href="https://e.org/r/1"/><updated>2026-10-15T16:13:07Z</updated>
      <author><name>nico</name></author><content type="html">&lt;p&gt;Fixed &lt;code&gt;retain&lt;/code&gt;&lt;/p&gt;</content></entry></feed>`;
    const [e] = parseFeed(xml);
    expect(e.external_id).toBe("tag:1");
    expect(e.url).toBe("https://e.org/r/1");
    expect(e.author).toBe("nico");
    expect(e.content).toBe("Fixed retain");
  });
});

describe("grade and route", () => {
  const profile = parseIntent(PROFILE);
  test("profile parses interests with weights, projects and avoid terms", () => {
    expect(profile.interests.map((i) => [i.label, i.weight])).toEqual([["Agent memory", 3], ["Security", 1]]);
    expect(profile.projects[0]).toEqual({ name: "brain", terms: ["second brain", "llm wiki"] });
    expect(profile.avoid).toEqual(["giveaway"]);
  });
  test("deterministic: same item and profile give the same score, explained", () => {
    const e = envelopeFrom(raw(), staticSource("s", []));
    const a = gradeDeterministic(e, profile, "h");
    const b = gradeDeterministic(e, profile, "h");
    expect(a.score).toBe(b.score);
    expect(a.score).toBeGreaterThan(50);
    expect(a.projects).toEqual(["brain"]);
    expect(a.why.join(" ")).toContain("Agent memory");
  });
  test("an item with no overlap still gets a score", () => {
    const e = envelopeFrom(raw({ title: "Cooking pasta", content: "Boil water." }), staticSource("s", []));
    expect(gradeDeterministic(e, profile, "h").score).toBe(0);
  });
  test("every matching rule fires, each sink appears once", () => {
    const e = envelopeFrom(raw(), staticSource("s", []));
    const g = gradeDeterministic(e, profile, "h");
    const r = route(
      [
        { name: "all", to: ["wiki"], priority: "archive" },
        { name: "proj", when: { projects: ["*"] }, to: ["wiki", "mem"], priority: "daily" },
        { name: "sec", when: { labels: ["Security"] }, to: ["alert"], priority: "immediate" },
      ],
      e,
      g,
    );
    expect(r.rules).toEqual(["all", "proj"]);
    expect(r.sinks).toEqual(["wiki", "mem"]);
    expect(r.priority).toBe("daily");
  });
});

describe("pipeline", () => {
  test("write-ahead, idempotent: a second run adds no rows and delivers nothing twice", async () => {
    const dir = setup();
    const mem = recorder();
    const job = { sources: [staticSource("s", [raw(), raw({ external_id: "x2", url: "https://example.org/b", title: "Other", content: "second brain notes" })])], rules: [{ name: "r", to: ["mem"] }] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: { mem }, jobs: { j: job } };
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    expect(new Ledger(cfg.dataDir).envelopes().length).toBe(2);
    expect(mem.got.length).toBe(2);
    rmSync(dir, { recursive: true });
  });
  test("the same URL with tracking parameters is the same item", () => {
    const s = staticSource("s", []);
    expect(envelopeFrom(raw({ url: "https://Example.org/a?utm_source=x#top" }), s).id).toBe(envelopeFrom(raw({ url: "https://example.org/a" }), s).id);
  });
  test("secrets never reach the ledger file", async () => {
    const dir = setup();
    const job = { sources: [staticSource("s", [raw({ content: `token ${FAKE_KEY} here` })])], rules: [] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: {}, jobs: { j: job } };
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    const text = readFileSync(join(cfg.dataDir, "ledger.jsonl"), "utf8");
    expect(text).not.toContain("sk-ant-");
    expect(text).toContain("anthropic_key");
    rmSync(dir, { recursive: true });
  });
  test("personal items never reach a delivery sink by default", async () => {
    const dir = setup();
    const mem = recorder();
    const job = { sources: [staticSource("diary", [raw()], "personal")], rules: [{ name: "r", to: ["mem"] }] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: { mem }, jobs: { j: job } };
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    expect(mem.got.length).toBe(0);
    rmSync(dir, { recursive: true });
  });
  test("a view is rebuilt from the ledger alone: delete it, rebuild, same notes", async () => {
    const dir = setup();
    const brain = join(dir, "brain");
    const items = Array.from({ length: 5 }, (_, n) => raw({ external_id: `i${n}`, url: `https://example.org/${n}`, title: `Second brain note ${n}`, content: `llm wiki ${n}` }));
    const job = { sources: [staticSource("s", items)], rules: [{ name: "all", to: ["wiki"] }] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: { wiki: wiki({ dir: brain }) }, jobs: { j: job } };
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    const before = readdirSync(join(brain, "notes")).sort();
    rmSync(brain, { recursive: true });
    await renderViews(cfg, new Ledger(cfg.dataDir), ctx());
    expect(readdirSync(join(brain, "notes")).sort()).toEqual(before);
    expect(before.length).toBe(5);
    rmSync(dir, { recursive: true });
  });
  test("a view refuses to wipe a folder it did not create", async () => {
    const dir = setup();
    const brain = join(dir, "mine");
    mkdirSync(brain);
    writeFileSync(join(brain, "precious.md"), "keep me");
    await expect(wiki({ dir: brain }).render([], ctx())).rejects.toThrow("refusing");
    expect(readFileSync(join(brain, "precious.md"), "utf8")).toBe("keep me");
    rmSync(dir, { recursive: true });
  });
  test("regrade after a profile change rescores without fetching", async () => {
    const dir = setup();
    const job = { sources: [staticSource("s", [raw({ title: "Prompt injection in agents", content: "prompt injection everywhere" })])], rules: [] };
    const cfg: FeedConfig = { dataDir: join(dir, "data"), intent: join(dir, "intent.md"), sinks: {}, jobs: { j: job } };
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    writeFileSync(cfg.intent, PROFILE.replace("**Security** (1)", "**Security** (6)"));
    const r = await regrade(cfg, ctx());
    expect(r.changed).toBe(1);
    rmSync(dir, { recursive: true });
  });
});

describe("hindsight sink", () => {
  test("posts a RetainRequest to /v1/default/banks/{bank}/memories with the item id as document_id", async () => {
    let seen: { path: string; auth: string | null; body: any } | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() };
        return Response.json({ success: true, bank_id: "b", items_count: 1, async: true });
      },
    });
    const e = envelopeFrom(raw(), staticSource("s", []));
    const item: GradedItem = { ...e, grade: gradeDeterministic(e, parseIntent(PROFILE), "h"), rules: ["r"], priority: "daily" };
    await hindsight({ baseUrl: `http://localhost:${server.port}`, bank: "second brain", apiKey: "k" }).deliver(item, ctx());
    server.stop();
    expect(seen!.path).toBe("/v1/default/banks/second%20brain/memories");
    expect(seen!.auth).toBe("Bearer k");
    expect(seen!.body.items).toHaveLength(1);
    expect(seen!.body.items[0].document_id).toBe(item.id);
    expect(typeof seen!.body.items[0].content).toBe("string");
    expect(seen!.body.items[0].timestamp).toBeTruthy();
  });
});

describe("audit regressions (2026-10-15)", () => {
  const cfgFor = (dir: string, job: { sources: Source[]; rules: any[] }, sinks: FeedConfig["sinks"]): FeedConfig => ({
    dataDir: join(dir, "data"),
    intent: join(dir, "intent.md"),
    sinks,
    jobs: { j: job },
  });

  test("#1 distinct stories with the same short body are not merged", async () => {
    const dir = setup();
    const items = [1, 2, 3].map((n) => raw({ external_id: `s${n}`, url: `https://news.example/${n}`, title: `Story ${n}`, content: "Comments" }));
    const job = { sources: [staticSource("hn", items)], rules: [] };
    await ingest(cfgFor(dir, job, {}), job, [{ source: job.sources[0] }], ctx());
    expect(new Ledger(join(dir, "data")).envelopes().length).toBe(3);
    rmSync(dir, { recursive: true });
  });

  test("#2 a rehearsed or failed delivery is retried by the next run", async () => {
    const dir = setup();
    let live = false;
    const got: string[] = [];
    const flaky: DeliverySink = { kind: "delivery", deliver: async (i) => (live ? (got.push(i.id), { ref: "ok" }) : { ref: "rehearsal", skipped: true }) };
    const failing: DeliverySink = { kind: "delivery", deliver: async (i) => { if (!live) throw new Error("503"); got.push(`f:${i.id}`); return { ref: "ok" }; } };
    const job = { sources: [staticSource("s", [raw()])], rules: [{ name: "r", to: ["mem", "hook"] }] };
    const cfg = cfgFor(dir, job, { mem: flaky, hook: failing });
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    expect(got).toEqual([]);
    live = true;
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    expect(got.length).toBe(2);
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    expect(got.length).toBe(2);
    rmSync(dir, { recursive: true });
  });

  test("#2 an item journaled but never graded is graded by the next run", async () => {
    const dir = setup();
    const job = { sources: [staticSource("s", [raw()])], rules: [] };
    const cfg = cfgFor(dir, job, {});
    new Ledger(cfg.dataDir).append(envelopeFrom(raw(), job.sources[0]));
    expect(new Ledger(cfg.dataDir).latestGrades().size).toBe(0);
    await ingest(cfg, job, [{ source: job.sources[0] }], ctx());
    expect(new Ledger(cfg.dataDir).latestGrades().size).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("#4 #5 private spans in an HTML or Markdown inbox file never reach the ledger, title included", async () => {
    const { inbox } = await import("../src/sources/inbox.ts");
    const dir = setup();
    const box = join(dir, "inbox");
    mkdirSync(box);
    writeFileSync(join(box, "a.html"), "<p>public</p><private>SECRET-HTML</private>");
    writeFileSync(join(box, "b.md"), "<private>\n# SECRET-TITLE\nhidden\n</private>\nvisible text");
    const src = inbox({ name: "Inbox", dir: box });
    const job = { sources: [src], rules: [] };
    await ingest(cfgFor(dir, job, {}), job, [{ source: src }], ctx());
    const text = readFileSync(join(dir, "data", "ledger.jsonl"), "utf8");
    expect(text).not.toContain("SECRET");
    expect(text).toContain("visible text");
    rmSync(dir, { recursive: true });
  });

  test("#6 nested private spans do not leak the outer tail", () => {
    expect(guard("a <private>outer <private>inner</private> LEAK</private> b").text).toBe("a  b");
  });

  test("#7 every field is guarded, unknown fields are dropped", () => {
    const e = envelopeFrom({ ...raw({ url: `https://e.org/x?token=ghp_${"a".repeat(36)}`, author: FAKE_KEY }), extra: FAKE_KEY } as RawItem, staticSource("s", []));
    const text = JSON.stringify(e);
    expect(text).not.toContain("ghp_aaaa");
    expect(text).not.toContain("sk-ant-");
    expect("extra" in e).toBe(false);
  });

  test("#8 the page never renders a non-web link", async () => {
    const { page } = await import("../src/sinks/page.ts");
    const dir = setup();
    const e = envelopeFrom(raw({ url: "javascript:alert(document.domain)" }), staticSource("s", []));
    const item: GradedItem = { ...e, grade: gradeDeterministic(e, parseIntent(PROFILE), "h"), rules: [], priority: "daily" };
    await page({ path: join(dir, "p.html") }).render([item], ctx());
    expect(readFileSync(join(dir, "p.html"), "utf8")).not.toContain('href="javascript:');
    rmSync(dir, { recursive: true });
  });

  test("#9 a rebuild keeps editor config and your own files in the wiki folder", async () => {
    const dir = setup();
    const brain = join(dir, "brain");
    await wiki({ dir: brain }).render([], ctx());
    mkdirSync(join(brain, ".obsidian"));
    writeFileSync(join(brain, ".obsidian", "app.json"), "{}");
    writeFileSync(join(brain, "my-own-note.md"), "mine");
    await wiki({ dir: brain }).render([], ctx());
    expect(readFileSync(join(brain, ".obsidian", "app.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(brain, "my-own-note.md"), "utf8")).toBe("mine");
    rmSync(dir, { recursive: true });
  });

  test("#10 an item cannot make itself public on a personal source", () => {
    expect(envelopeFrom(raw({ privacy_class: "public" }), staticSource("diary", [], "personal")).privacy_class).toBe("personal");
  });

  test("#15 prefixed Atom and CDATA holding </item> parse", () => {
    expect(parseFeed(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:id>1</atom:id><atom:title>T</atom:title><atom:content>body</atom:content></atom:entry></atom:feed>`)).toHaveLength(1);
    const [e] = parseFeed(`<rss><channel><item><title>A</title><description><![CDATA[x </item> y]]></description></item></channel></rss>`);
    expect(e.content).toContain("y");
  });
});
