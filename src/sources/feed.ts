// RSS 2.0 and Atom, which covers far more than blogs: Substack, YouTube channels,
// GitHub releases and commits, arXiv queries, Mastodon, most podcasts.
// Zero dependencies, so a deliberately small parser: items/entries, a dozen known fields.

import type { PrivacyClass, RawItem, PullContext, Source, Trust } from "../contracts/feed-item.ts";
import { decodeEntities, htmlToText, unCdata } from "../core/text.ts";

function field(block: string, names: string[]): string | undefined {
  for (const n of names) {
    const esc = n.replace(":", "\\:");
    const m = block.match(new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}>`, "i"));
    if (m && m[1].trim()) return m[1];
  }
  return undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? decodeEntities(m[1]) : undefined;
}

function plain(raw: string | undefined): string {
  if (!raw) return "";
  let v = unCdata(raw).trim();
  if (/&lt;\/?[a-z]/i.test(v)) v = decodeEntities(v);
  return htmlToText(v);
}

function atomLink(block: string): string | undefined {
  const links = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  const alt = links.find((l) => !/\brel=/i.test(l) || /\brel=["']alternate["']/i.test(l));
  return alt ? attr(alt, "href") : undefined;
}

export interface ParsedEntry {
  external_id: string;
  url?: string;
  title: string;
  author?: string;
  content: string;
  published_at?: string;
}

export function parseFeed(input: string): ParsedEntry[] {
  // CDATA can hold anything, "</item>" included, so it is set aside before blocks are cut
  // and restored per field. A namespace prefix on Atom (<atom:entry>) is dropped.
  const cdata: string[] = [];
  const xml = input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => `\u0000${cdata.push(c) - 1}\u0000`)
    .replace(/<(\/?)atom:/g, "<$1");
  const restore = (s: string | undefined) => s?.replace(/\u0000(\d+)\u0000/g, (_, n: string) => cdata[Number(n)]);
  const f = (b: string, names: string[]) => restore(field(b, names));
  return parseBlocks(xml, f, (b) => restore(atomLink(b)));
}

function parseBlocks(xml: string, field: (b: string, names: string[]) => string | undefined, atomLink: (b: string) => string | undefined): ParsedEntry[] {
  const isAtom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml) || (/<entry\b/i.test(xml) && !/<item\b/i.test(xml));
  const blocks = xml.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) ?? [];
  return blocks.map((b) => {
    const url = isAtom ? atomLink(b) : plain(field(b, ["link"])) || undefined;
    const id = plain(field(b, ["guid", "id"])) || url || plain(field(b, ["title"]));
    const author = plain(field(b, ["dc:creator"])) || plain(field(field(b, ["author"]) ?? "", ["name"])) || plain(field(b, ["author"]));
    const content =
      plain(field(b, ["content:encoded"])) ||
      plain(field(b, ["content"])) ||
      plain(field(b, ["media:description"])) ||
      plain(field(b, ["description", "summary"]));
    const date = plain(field(b, ["pubDate", "published", "dc:date", "updated"]));
    const parsed = date ? new Date(date) : undefined;
    return {
      external_id: id,
      url,
      title: plain(field(b, ["title"])) || "(untitled)",
      author: author || undefined,
      content,
      published_at: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
    };
  });
}

export interface FeedOptions {
  name: string;
  url: string;
  trust?: Trust;
  kind?: string;
  /** Newest N entries per run. */
  limit?: number;
  privacy?: PrivacyClass;
}

export function feed(o: FeedOptions): Source {
  return {
    name: o.name,
    trust: o.trust ?? "normal",
    privacy_class: o.privacy ?? "public",
    async pull(ctx: PullContext): Promise<RawItem[]> {
      const res = await ctx.fetch(o.url, {
        headers: { "user-agent": "swb-feed/0.1 (+https://schwarmbau.de)", accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = parseFeed(await res.text());
      // 200 with nothing parsed is a failure too: a parked domain or broken XML looks healthy otherwise.
      if (entries.length === 0) throw new Error("HTTP 200 but no entries parsed");
      return entries
        .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
        .slice(0, o.limit ?? 10)
        .map((e) => ({ ...e, content_kind: o.kind ?? "article" }));
    },
  };
}
