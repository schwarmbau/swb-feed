// A folder you drop things into: notes, transcripts, exported articles (.md, .txt, .html).
// The simplest possible capture surface, and the one that works without a network.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { PrivacyClass, RawItem, Source, Trust } from "../contracts/feed-item.ts";
import { htmlToText } from "../core/text.ts";
import { hiddenHtmlFlags, stripPrivate } from "../core/guard.ts";

export interface InboxOptions {
  name: string;
  dir: string;
  trust?: Trust;
  privacy?: PrivacyClass;
  kind?: string;
}

function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

export function inbox(o: InboxOptions): Source {
  return {
    name: o.name,
    trust: o.trust ?? "high",
    privacy_class: o.privacy ?? "personal",
    async pull(): Promise<RawItem[]> {
      let files: string[];
      try {
        files = readdirSync(o.dir).filter((f) => /\.(md|txt|html?)$/i.test(f));
      } catch {
        return [];
      }
      return files.map((f) => {
        const path = join(o.dir, f);
        // Private spans go before anything reads the file: HTML conversion would erase the tags,
        // and the title is taken from the text.
        const raw = stripPrivate(readFileSync(path, "utf8"));
        const isHtml = /\.html?$/i.test(f);
        const { meta, body } = isHtml ? { meta: {}, body: raw } : frontmatter(raw);
        const text = isHtml ? htmlToText(body) : body.trim();
        const flags = isHtml ? hiddenHtmlFlags(body) : [];
        const heading = text.match(/^#\s+(.+)$/m)?.[1];
        const content = heading ? text.replace(/^#\s+.+\n*/m, "").trim() : text;
        const title = (meta as Record<string, string>).title ?? heading ?? basename(f, extname(f));
        return {
          external_id: f,
          url: (meta as Record<string, string>).url,
          title,
          author: (meta as Record<string, string>).author,
          content,
          content_kind: (meta as Record<string, string>).kind ?? o.kind ?? "note",
          published_at: new Date(statSync(path).mtimeMs).toISOString(),
          ...(flags.length ? { flags } : {}),
          // His own words only when he says so: exported articles and other people's text stay content.
          ...((meta as Record<string, string>).voice === "own" ? { own_voice: true } : {}),
        };
      });
    },
  };
}
