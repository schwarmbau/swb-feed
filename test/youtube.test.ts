import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pickCaptions, vttToText, youtube, type YtDlpRunner } from "../src/sources/youtube.ts";
import type { RunContext } from "../src/core/types.ts";

const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.310 align:start position:0%

hello<00:00:00.320><c> everyone</c><00:00:00.640><c> welcome</c>

00:00:02.310 --> 00:00:02.320 align:start position:0%
hello everyone welcome


00:00:02.320 --> 00:00:05.150 align:start position:0%
hello everyone welcome
to<00:00:02.560><c> the</c><00:00:02.800><c> talk</c><00:00:03.100><c> on</c><00:00:03.300><c> agents</c>

00:00:05.150 --> 00:00:05.160 align:start position:0%
to the talk on agents


00:00:05.160 --> 00:00:08.000 align:start position:0%
to the talk on agents
Q&amp;A<00:00:05.500><c> comes</c><00:00:05.900><c> later</c>
`;

describe("vttToText", () => {
  test("drops header, timings, settings, inline tags and rolling duplicates", () => {
    expect(vttToText(AUTO_VTT)).toBe("hello everyone welcome to the talk on agents Q&A comes later");
  });

  test("keeps manual captions with cue ids and CRLF", () => {
    const vtt = "WEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\n<v Speaker>First line.</v>\r\n\r\nNOTE skip me\r\n\r\n2\r\n00:00:02.000 --> 00:00:03.000\r\nSecond line.\r\n";
    expect(vttToText(vtt)).toBe("First line. Second line.");
  });
});

describe("pickCaptions", () => {
  test("prefers the spoken language over a machine translation", () => {
    expect(pickCaptions(["a.en.vtt", "a.de.vtt", "a.de-orig.vtt"], "en.*,de.*")).toBe("a.de.vtt");
    expect(pickCaptions(["a.en-orig.vtt", "a.de.vtt"], "en.*,de.*")).toBe("a.en-orig.vtt");
    expect(pickCaptions(["a.de.vtt", "a.en-US.vtt"], "en.*,de.*")).toBe("a.en-US.vtt");
    expect(pickCaptions([], "en.*")).toBeUndefined();
  });
});

// Dates are relative to now: the caption grace (48 h) and give-up (7 d) rules read the video's age.
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
const entry = (id: string, age: number, desc = `About ${id}.`) => `
  <entry>
    <id>yt:video:${id}</id>
    <yt:videoId>${id}</yt:videoId>
    <title>Video ${id}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
    <author><name>Tester</name></author>
    <published>${daysAgo(age)}</published>
    <media:group><media:title>Video ${id}</media:title><media:description>${desc}</media:description></media:group>
  </entry>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Tester</title>${entry("v5", 3)}${entry("v4", 4)}${entry("v3", 5)}${entry("v2", 6, "")}${entry("v1", 9)}
</feed>`;

const fakeFetch = (async () => new Response(FEED, { status: 200 })) as unknown as typeof fetch;
const feedOf = (xml: string) => (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;

function ctx(known: string[] = [], logs: string[] = []): RunContext {
  return { dataDir: "", dryRun: false, log: (m) => logs.push(m), fetch: fakeFetch, known: (i) => known.some((id) => i.url?.endsWith(id)) };
}

// Writes a caption file where yt-dlp would, keyed by video id; per-id behaviour comes from `script`.
function fakeYtDlp(script: Record<string, "captions" | "none" | "fail" | "throttled" | "private">, calls: string[]): YtDlpRunner {
  return async (args) => {
    const url = args[args.length - 1];
    const id = url.split("v=")[1];
    calls.push(id);
    const out = args[args.indexOf("-o") + 1];
    switch (script[id] ?? "captions") {
      case "captions":
        writeFileSync(join(dirname(out), `${id}.en.vtt`), AUTO_VTT);
        return { code: 0, stdout: "", stderr: "" };
      case "none":
        return { code: 0, stdout: "[info] There are no subtitles for the requested languages", stderr: "" };
      case "private":
        return { code: 1, stdout: "", stderr: "ERROR: [youtube] x: Private video. Sign in if you've been granted access" };
      case "fail":
        return { code: 1, stdout: "", stderr: "ERROR: [youtube] x: Unable to download video subtitles: HTTP Error 503: Service Unavailable" };
      case "throttled":
        return { code: 1, stdout: "", stderr: "ERROR: [youtube] x: HTTP Error 429: Too Many Requests" };
    }
  };
}

describe("youtube source", () => {
  test("fetches transcripts for unknown videos, newest first, up to the cap; skips known and the rest", async () => {
    const calls: string[] = [];
    const src = youtube({ name: "YT", channelId: "UCx", maxTranscriptsPerRun: 2, ytDlp: "yt-dlp", run: fakeYtDlp({}, calls) });
    const items = await src.pull(ctx(["v5"]));
    expect(src.privacy_class).toBe("public");
    expect(calls).toEqual(["v4", "v3"]);
    expect(items.map((i) => i.external_id)).toEqual(["yt:video:v4", "yt:video:v3"]);
    expect(items[0].content_kind).toBe("video");
    expect(items[0].content).toBe("About v4.\n\nTranscript:\nhello everyone welcome to the talk on agents Q&A comes later");
    expect(items[0].abstract).toBe("About v4.");
    expect(items[0].flags).toBeUndefined();
  });

  test("no captions and permanently unavailable videos are emitted with a flag; other failures wait for a later run", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const run = fakeYtDlp({ v5: "fail", v4: "none", v3: "private", v2: "captions" }, calls);
    const items = await youtube({ name: "YT", channelId: "UCx", maxTranscriptsPerRun: 4, ytDlp: "yt-dlp", run }).pull(ctx([], logs));
    expect(calls).toEqual(["v5", "v4", "v3", "v2"]);
    expect(items.map((i) => [i.external_id, i.flags?.[0]])).toEqual([
      ["yt:video:v4", "no captions"],
      ["yt:video:v3", "no captions"],
      ["yt:video:v2", undefined],
    ]);
    expect(items[0].content).toBe("About v4.");
    expect(items[2].content).toBe("Transcript:\nhello everyone welcome to the talk on agents Q&A comes later");
    expect(logs.join("\n")).toContain("captions failed: [youtube] x: Unable to download video subtitles: HTTP Error 503");
  });

  test("a 429 stops further yt-dlp calls for the rest of the pull", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const run = fakeYtDlp({ v5: "captions", v4: "throttled" }, calls);
    const items = await youtube({ name: "YT", channelId: "UCx", maxTranscriptsPerRun: 5, ytDlp: "yt-dlp", run }).pull(ctx([], logs));
    expect(calls).toEqual(["v5", "v4"]);
    expect(items.map((i) => i.external_id)).toEqual(["yt:video:v5"]);
    expect(logs.filter((l) => l.includes("no more caption fetches this run"))).toHaveLength(1);
  });

  test("passes the subtitle sleep to yt-dlp", async () => {
    let seen: string[] = [];
    const run: YtDlpRunner = async (args) => ((seen = args), { code: 0, stdout: "", stderr: "" });
    await youtube({ name: "YT", channelId: "UCx", maxTranscriptsPerRun: 1, ytDlp: "yt-dlp", run }).pull(ctx());
    const at = seen.indexOf("--sleep-subtitles");
    expect(seen.slice(at, at + 2)).toEqual(["--sleep-subtitles", "2"]);
  });

  test("a feed failure surfaces before anything else", async () => {
    const bad = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const src = youtube({ name: "YT", channelId: "UCx", ytDlp: "yt-dlp", run: fakeYtDlp({}, []) });
    await expect(src.pull({ ...ctx(), fetch: bad })).rejects.toThrow("HTTP 404");
  });

  test("a video too new to have captions waits; one that fails for a week is given up with a flag", async () => {
    const xml = FEED.replace(/<entry>[\s\S]*<\/entry>/, `${entry("n1", 1)}${entry("old", 9)}`);
    const calls: string[] = [];
    const c = { ...ctx(), fetch: feedOf(xml) };
    const items = await youtube({ name: "YT", channelId: "UCx", maxTranscriptsPerRun: 5, ytDlp: "yt-dlp", run: fakeYtDlp({ n1: "none", old: "fail" }, calls) }).pull(c);
    expect(calls).toEqual(["n1", "old"]);
    expect(items.map((i) => [i.external_id, i.flags?.[0]?.slice(0, 15)])).toEqual([["yt:video:old", "captions failed"]]);
  });

  test("only YouTube links reach yt-dlp, after an end-of-options marker", async () => {
    let seen: string[] = [];
    const xml = FEED.replace(/<entry>[\s\S]*<\/entry>/, entry("v9", 3).replace("https://www.youtube.com/watch?v=v9", "--exec=evil"));
    const run: YtDlpRunner = async (args) => ((seen = args), { code: 0, stdout: "", stderr: "" });
    await youtube({ name: "YT", channelId: "UCx", ytDlp: "yt-dlp", run }).pull({ ...ctx(), fetch: feedOf(xml) });
    expect(seen).toEqual([]);
    await youtube({ name: "YT", channelId: "UCx", maxTranscriptsPerRun: 1, ytDlp: "yt-dlp", run }).pull(ctx());
    expect(seen.at(-2)).toBe("--");
    expect(seen.at(-1)).toBe("https://www.youtube.com/watch?v=v5");
  });
});
