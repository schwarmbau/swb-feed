// The intent profile: what the owner is actually trying to do, in plain Markdown.
// It is the only thing that makes a grade mean "good for me" rather than "good".
//
//   ## Interests
//   - **Agent memory** (3): memory, second brain, knowledge base, recall
//   ## Projects
//   - **reading-list**: newsletter, essays, bookmarks
//   ## Avoid
//   - giveaway, crypto pump

import { readFileSync } from "node:fs";
import type { IntentProfile } from "./types.ts";
import { sha256 } from "./text.ts";

function splitTerms(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function parseIntent(md: string): IntentProfile {
  const profile: IntentProfile = { owner: "", interests: [], projects: [], avoid: [] };
  const title = md.match(/^#\s+(.+)$/m);
  profile.owner = title ? title[1].replace(/^intent\s*[—:-]\s*/i, "").trim() : "owner";
  let section = "";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      section = h[1].toLowerCase();
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    if (section.startsWith("interest")) {
      const m = body.match(/^\*\*(.+?)\*\*\s*(?:\((\d+(?:\.\d+)?)\))?\s*:\s*(.+)$/);
      if (m) profile.interests.push({ label: m[1].trim(), weight: m[2] ? Number(m[2]) : 1, terms: splitTerms(m[3]) });
    } else if (section.startsWith("project")) {
      const m = body.match(/^\*\*(.+?)\*\*\s*:\s*(.+)$/);
      if (m) profile.projects.push({ name: m[1].trim(), terms: splitTerms(m[2]) });
    } else if (section.startsWith("avoid")) {
      profile.avoid.push(...splitTerms(body));
    }
  }
  return profile;
}

export function loadIntent(path: string): { profile: IntentProfile; hash: string } {
  const md = readFileSync(path, "utf8");
  return { profile: parseIntent(md), hash: sha256(md).slice(0, 12) };
}
