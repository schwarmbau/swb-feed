// YouTube channels: the channel's Atom feed (through the RSS source) plus each new video's
// captions through yt-dlp, so a talk is graded on what was said, not on its description.
//   yt-dlp --skip-download --write-auto-subs --write-subs --sub-langs "en.*,de.*" --sub-format vtt
// yt-dlp is slow and rate-limited, so only videos the ledger does not know yet are fetched, a
// few per run. An unknown video beyond the cap, or one whose fetch failed, is left out of this
// run entirely: the ledger dedups by URL, so emitting it without a transcript would be final.

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RawItem, PullContext, Source, Trust } from "../contracts/feed-item.ts";
import { decodeEntities } from "../core/text.ts";
import { feed } from "./feed.ts";

export type YtDlpRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface YouTubeOptions {
  name: string;
  channelId: string;
  trust?: Trust;
  /** Newest N feed entries considered per run. */
  limit?: number;
  /** yt-dlp calls per run (default 3). */
  maxTranscriptsPerRun?: number;
  langs?: string;
  /** Path to yt-dlp. a scheduler's bare PATH often lacks Homebrew, hence the fallback in `resolveYtDlp`. */
  ytDlp?: string;
  /** Test seam: runs the yt-dlp argument vector (binary first). */
  run?: YtDlpRunner;
}

const TIMEOUT_MS = 60_000;

/** WebVTT to plain text, dropping cue timings, inline tags and the rolling repeats of auto-captions. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const block of vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue; // header, NOTE, STYLE, REGION
    for (const l of lines.slice(at + 1)) {
      const text = decodeEntities(l.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      // Auto-captions repeat the previous cue's line above the new one, and hold it in a 10 ms cue.
      if (text && !out.slice(-2).includes(text)) out.push(text);
    }
  }
  return out.join(" ");
}

/** Picks one caption file: the spoken language when a "-orig" track names it, else the first by preference. */
export function pickCaptions(files: string[], langs: string): string | undefined {
  const lang = (f: string) => f.replace(/\.vtt$/, "").split(".").pop() ?? "";
  const vtts = files.filter((f) => f.endsWith(".vtt"));
  const orig = vtts.find((f) => lang(f).endsWith("-orig"));
  if (orig) {
    const spoken = lang(orig).replace(/-orig$/, "");
    return vtts.find((f) => lang(f) === spoken) ?? orig;
  }
  for (const pattern of langs.split(",")) {
    const re = new RegExp(`^(?:${pattern.trim()})$`); // yt-dlp reads --sub-langs entries as regexes too
    const hit = vtts.find((f) => re.test(lang(f)));
    if (hit) return hit;
  }
  return vtts[0];
}

export function resolveYtDlp(explicit?: string): string | undefined {
  if (explicit) return explicit;
  return Bun.which("yt-dlp") ?? (existsSync("/opt/homebrew/bin/yt-dlp") ? "/opt/homebrew/bin/yt-dlp" : undefined);
}

async function spawnYtDlp(args: string[]) {
  // yt-dlp looks up helpers (a JS runtime, ffmpeg) on PATH; its own directory is where Homebrew put them.
  const env = { ...process.env, PATH: `${dirname(args[0])}:${process.env.PATH ?? ""}` };
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr: proc.signalCode ? `timed out after ${TIMEOUT_MS / 1000}s` : stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** `final`: the video will never have captions (private, removed, members-only, disabled). */
type Captions = { text: string } | { none: true; final: boolean } | { error: string };

/** A new video often has no auto-captions yet: wait this long before recording it as having none. */
const CAPTION_GRACE_MS = 48 * 3600_000;
/** A video whose caption fetch keeps failing is given up on after this long, so it stops holding a slot. */
const GIVE_UP_MS = 7 * 86400_000;
const ageMs = (published?: string) => (published && !Number.isNaN(Date.parse(published)) ? Date.now() - Date.parse(published) : Infinity);

async function captions(url: string, bin: string, langs: string, run: YtDlpRunner): Promise<Captions> {
  const dir = await mkdtemp(join(tmpdir(), "swb-feed-yt-"));
  try {
    const args = [bin, "--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", langs, "--sub-format", "vtt", "--sleep-subtitles", "2", "-o", join(dir, "%(id)s.%(ext)s"), "--", url];
    const r = await run(args);
    const file = pickCaptions(await readdir(dir), langs);
    if (file) {
      const text = vttToText(await readFile(join(dir, file), "utf8"));
      if (text) return { text };
    }
    const said = `${r.stderr}\n${r.stdout}`;
    // A private, removed or members-only video never gets captions; retrying it would hold a slot every run.
    if (/subtitles are disabled|private video|video unavailable|members[- ]only|has been removed/i.test(said)) return { none: true, final: true };
    if (r.code === 0 || /no (automatic )?(captions|subtitles)/i.test(said)) return { none: true, final: false };
    const reason = said.split("\n").map((l) => l.trim()).find((l) => /^ERROR\b/.test(l)) ?? said.trim().split("\n").pop() ?? `exit ${r.code}`;
    return { error: reason.replace(/^ERROR:\s*/, "").slice(0, 120) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function youtube(o: YouTubeOptions): Source {
  const channel = feed({
    name: o.name,
    url: `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(o.channelId)}`,
    trust: o.trust,
    kind: "video",
    limit: o.limit ?? 15,
  });
  const cap = o.maxTranscriptsPerRun ?? 3;
  const langs = o.langs ?? "en.*,de.*";
  return {
    name: o.name,
    trust: channel.trust,
    privacy_class: "public",
    async pull(ctx: PullContext): Promise<RawItem[]> {
      const entries = await channel.pull(ctx);
      const bin = resolveYtDlp(o.ytDlp);
      if (!bin) throw new Error("yt-dlp not found (set ytDlp, or install it to /opt/homebrew/bin)");
      const run = o.run ?? spawnYtDlp;
      const items: RawItem[] = [];
      let fetched = 0;
      for (const e of entries) {
        if (ctx.known?.({ url: e.url, external_id: e.external_id })) continue;
        // yt-dlp gets only YouTube watch links: anything else in the feed is not ours to hand it.
        if (fetched >= cap || !e.url || !/^https:\/\/(www\.)?youtube\.com\//.test(e.url)) continue;
        fetched++;
        const description = e.content.trim();
        const c = await captions(e.url, bin, langs, run);
        if ("error" in c) {
          ctx.log(`${o.name}: ${e.title}: captions failed: ${c.error}; retried next run`);
          // Throttled: every further call this run would fail the same way and prolong the block.
          if (/\b429\b|too many requests/i.test(c.error)) {
            ctx.log(`${o.name}: YouTube is rate-limiting (429); no more caption fetches this run`);
            break;
          }
          if (ageMs(e.published_at) > GIVE_UP_MS) items.push({ ...e, content: description, abstract: description || undefined, flags: [`captions failed: ${c.error}`] });
          continue;
        }
        if ("none" in c) {
          // Too new to be sure: leave it out so a later run fetches the captions once YouTube made them.
          if (!c.final && ageMs(e.published_at) < CAPTION_GRACE_MS) continue;
          items.push({ ...e, content: description, abstract: description || undefined, flags: ["no captions"] });
          continue;
        }
        // The marker is always written: it is how a memory view knows to keep raw captions out.
        const content = `${description ? `${description}\n\n` : ""}Transcript:\n${c.text}`;
        items.push({ ...e, content, abstract: description || undefined });
      }
      return items;
    },
  };
}
