// Where an approved voice candidate lands: Markdown files in the project record, one per kind as
// configured (for example: decisions and questions to INBOX-FROM-VOICE.md,
// ideas to IDEAS.md, asks to ASKS-FROM-VOICE.md as issue drafts). One with no project yet lands in the
// records root. A person moves rulings into the record of authority and files asks by hand.
//
// Only `review approve` calls this. An entry lands as an idea unless he typed it (`--kind`). It holds
// the extractor's English sentence and his short quote, never the transcript sentence around it (that
// is shown at approval only). Every field passes one plain-text encoder, so nothing a model or a
// transcript wrote can become Markdown or HTML structure. Landing is idempotent per candidate.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { VoiceItem, VoiceKind, VoiceTarget } from "../core/types.ts";
import { appendLines } from "../core/voice.ts";

export interface VoiceInboxOptions {
  /** The directory holding the project records (e.g. a notes folder with one directory per project). */
  root: string;
  /** Intent-profile project name → record directory, where they differ (e.g. garden → garden-notes). */
  records?: Record<string, string>;
  /** The file each landed kind goes to (default INBOX-FROM-VOICE.md for all); a plain name, never a path. */
  files?: Partial<Record<VoiceKind, string>>;
}

/** What an approval decides: the kind it lands as (idea unless he typed one) and whether he typed it. */
export interface Landing {
  kind: VoiceKind;
  typed: boolean;
}

const HEADER = (project: string) => `# From his voice: ${plain(project)}

Candidates the feed's own-voice stage took out of his conversations and notes, each one approved by him in the review queue (\`swb-feed review\`). The sentence is the extractor's, the quote is from the transcript, and each entry says how the quote was attributed to him (the recorder's label, his mark on the whole conversation, his own note, or not his). An entry is a decision only where he typed it so at approval; otherwise it is an idea. Entries are appended, never edited here: a ruling moves into the record of authority when someone harvests this file.
`;

/**
 * Plain text on one line: control characters gone, HTML and Markdown structure escaped
 * (& < > become entities; \ ` * _ [ ] ! # | ~ are backslash-escaped; a leading - + or "1." too).
 */
export function plain(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]!#|~])/g, "\\$1")
    .replace(/^([-+])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

const safe = (v: string | undefined, re: RegExp, fallback: string) => (v && re.test(v) ? v : fallback);

/** The earlier decided point a candidate overlaps, named so he can see a revision or a reversal. */
export function relatedLine(r: NonNullable<VoiceItem["related"]>): string {
  const how = r.decision === "approved" ? "approved" : r.decision === "rejected" ? "rejected" : "approval interrupted";
  return `Related to your earlier ${plain(r.kind)} \`${safe(r.id, /^[0-9a-f]{16}$/, "unknown")}\` (${how} ${safe(r.at.slice(0, 10), /^\d{4}-\d{2}-\d{2}$/, "unknown date")}): „${plain(r.quote)}".`;
}

/** How the quote was attributed to him, said as it happened. */
function attribution(v: VoiceItem): string {
  const label = v.speaker ? ` (label "${plain(v.speaker)}")` : "";
  if (!v.speaker_verified) return `not his by the recorder's labels${label}`;
  if (v.speaker_basis === "mark") return `his by conversation mark (set ${safe(v.marked?.slice(0, 10), /^\d{4}-\d{2}-\d{2}$/, "unknown date")})${label}`;
  if (v.speaker_basis === "note") return "his own note";
  return `his by the recorder${label}`;
}

/** The exact text an approval appends below its heading. The review list shows this same text. */
export function voiceBody(v: VoiceItem, l: Landing): string[] {
  const where = [
    `${plain(v.source)} \`${safe(v.conversation, /^[\w.-]{1,80}$/, "unknown").slice(0, 8)}\``,
    v.at && /^\d{1,3}:\d{2}$/.test(v.at) ? `at ${v.at}` : "",
    attribution(v),
    `feed item \`${safe(v.item, /^[0-9a-f]{16}$/, "unknown")}\``,
    `candidate \`${safe(v.id, /^[0-9a-f]{16}$/, "unknown")}\``,
  ].filter(Boolean);
  return [
    plain(v.text),
    "",
    `> „${plain(v.quote)}"${v.quote_found ? "" : " (not found verbatim in the transcript)"}`,
    "",
    `${l.typed ? `Typed ${plain(l.kind)} by him at approval` : `Landed as ${plain(l.kind)}`}; the extractor suggested ${plain(v.kind)} (confidence ${Math.round(Number(v.confidence) || 0)}).`,
    ...(v.related ? [relatedLine(v.related)] : []),
    where.join(" · "),
  ];
}

export function voiceEntry(v: VoiceItem, approvedAt: string, l: Landing): string {
  const date = safe(v.date, /^\d{4}-\d{2}-\d{2}$/, "unknown date");
  const at = safe(approvedAt.slice(0, 16), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "unknown").replace("T", " ");
  // An ask is filed as a work issue by a person, by hand: it lands shaped as a draft, never as an issue.
  const draft = l.kind === "ask" ? [`Issue draft · title: ${plain(v.text)}`, ""] : [];
  return ["", `## ${date} · ${plain(l.kind)} · approved ${at} UTC`, "", ...draft, ...voiceBody(v, l), ""].join("\n");
}

/** The landing an earlier approval of this candidate wrote into the file (its heading and its "Typed" line), if any. */
export function landedIn(text: string, id: string): Landing | undefined {
  const marker = text.indexOf(`candidate \`${id}\``);
  if (marker < 0) return undefined;
  const head = text.lastIndexOf("\n## ", marker);
  const block = text.slice(head + 1, marker);
  const kind = block.match(/^## [^·\n]+ · (decision|idea|ask|question) · approved/)?.[1] as VoiceKind | undefined;
  return kind ? { kind, typed: block.includes(`Typed ${kind} by him at approval`) } : { kind: "idea", typed: false };
}

/** Never follows a link at the landing path, a dangling one included. */
function refuseLink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to write through it`);
}

export function voiceInbox(o: VoiceInboxOptions): VoiceTarget & { pathFor(v: VoiceItem, l: Landing): string; preflight(v: VoiceItem, l: Landing): string } {
  for (const f of Object.values(o.files ?? {})) if (!/^[\w.-]+\.md$/.test(f ?? "")) throw new Error(`voice file "${f}" must be a plain .md file name`);
  const dirFor = (v: VoiceItem) => (v.project ? join(o.root, o.records?.[v.project] ?? v.project) : o.root);
  const pathFor = (v: VoiceItem, l: Landing) => join(dirFor(v), o.files?.[l.kind] ?? "INBOX-FROM-VOICE.md");
  // A record is never created by a model's link: the project's directory must already exist, it must
  // really sit under the records root (links followed), and the file itself is never a link.
  const preflight = (v: VoiceItem, l: Landing): string => {
    const dir = dirFor(v);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no project record at ${dir}; approve with --project <name> to re-link it`);
    const rel = relative(realpathSync(o.root), realpathSync(dir));
    if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) throw new Error(`project "${v.project}" resolves outside ${o.root}`);
    const path = pathFor(v, l);
    refuseLink(path);
    return path;
  };
  return {
    pathFor,
    preflight,
    async land(v, receipt) {
      const l: Landing = { kind: receipt.kind, typed: receipt.typed };
      const path = preflight(v, l);
      // Idempotent: an approval interrupted before its receipt lands nothing twice when it is repeated,
      // and reports what the record holds, so the receipt says what really landed whatever the new flags.
      // With one file per kind, a repeat typed as another kind looks in every landing file of the record.
      const kinds: VoiceKind[] = ["decision", "idea", "ask", "question"];
      for (const other of new Set(kinds.map((k) => pathFor(v, { kind: k, typed: false })))) {
        if (!existsSync(other)) continue;
        refuseLink(other);
        const existing = landedIn(readFileSync(other, "utf8"), v.id);
        if (existing) return { ref: other, landed: existing };
      }
      if (!existsSync(path)) appendLines(path, HEADER(v.project ?? "no project yet"));
      appendLines(path, voiceEntry(v, receipt.approved_at, l));
      return { ref: path };
    },
  };
}
