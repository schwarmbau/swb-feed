// The daily digest: what came in, what reached memory, what needs a look. One Markdown file per
// day, written from the ledger, the grades, the receipts and the source health alone.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedConfig, GradedItem, VoiceKind } from "./types.ts";
import { Ledger } from "./ledger.ts";
import { allGraded, readHealth, voiceOfferable } from "./pipeline.ts";
import { clip } from "./text.ts";
import { isReviewSink, pendingReviews, reviewRows, type ReviewRow } from "../sinks/review.ts";
import { offerOrder } from "./voice.ts";
import { extractions, failures } from "./voice.ts";
import { plain, voiceBody } from "../sinks/voice.ts";

export interface DigestResult {
  path: string;
  fresh: number;
  delivered: number;
  /** Promote candidates waiting for a person (all of them, not only today's). */
  waiting: number;
  flagged: number;
  sick: string[];
}

const line = (i: GradedItem) =>
  `- **${i.grade.score}**${i.grade.tier ? ` ${i.grade.tier}·${i.grade.quality ?? "?"}` : ""} ${i.url ? `[${clip(i.title, 90)}](${i.url})` : clip(i.title, 90)} · ${i.source}`;

const KIND_ORDER: VoiceKind[] = ["decision", "ask", "question", "idea"];
const VOICE_SHOWN = 8;

/**
 * Voice candidates, one group per conversation: what is waiting by kind, then the most confident
 * decisions and asks first. A long walk yields a hundred candidates, so the digest names the few
 * and points to `swb-feed review` for the rest.
 */
function voiceGroups(waiting: ReviewRow[], byId: Map<string, GradedItem>): string[] {
  const groups = new Map<string, ReviewRow[]>();
  for (const r of waiting) if (r.voice) groups.set(r.voice.item, [...(groups.get(r.voice.item) ?? []), r]);
  return [...groups].flatMap(([item, rows]) => {
    const v0 = rows[0]!.voice!;
    const counts = KIND_ORDER.map((k) => [k, rows.filter((r) => r.voice!.kind === k).length] as const).filter(([, n]) => n);
    const best = [...rows].sort((a, b) => offerOrder(a.voice!, b.voice!)).slice(0, VOICE_SHOWN);
    return [
      "",
      `### From your voice: ${plain(clip(byId.get(item)?.title ?? v0.conversation, 80))} (${plain(v0.source)} ${plain(v0.date)}) · suggested ${counts.map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ")}`,
      "",
      // Unclipped: the text under each line is exactly what a plain approval writes (it lands as an
      // idea; `--kind decision` is his call). The transcript sentence is shown and never written.
      ...best.flatMap((r) => {
        const v = r.voice!;
        return [
          `- \`${r.id.slice(0, 12)}\` suggested **${v.kind}** · ${plain(v.project ?? "no project yet")}`,
          "",
          ...voiceBody(v, { kind: "idea", typed: false }).map((l) => (l ? `  ${l}` : "")),
          ...(v.sentence ? [`  (shown, never written) in its sentence: „${plain(v.sentence)}"`] : []),
          ...(v.related?.sentence ? [`  (shown, never written) the earlier one's sentence: „${plain(v.related.sentence)}"`] : []),
          "",
        ];
      }),
      ...(rows.length > best.length ? [`- … and ${rows.length - best.length} more: \`swb-feed review\``] : []),
    ];
  });
}

export function writeDigest(cfg: FeedConfig, opts: { dir: string; now?: Date; hours?: number; title?: string }): DigestResult {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.hours ?? 24) * 3600_000).toISOString();
  const ledger = new Ledger(cfg.dataDir);
  const all = allGraded(cfg, ledger);
  const fresh = all.filter((i) => i.captured_at >= since).sort((a, b) => b.grade.score - a.grade.score);
  const byId = new Map(all.map((i) => [i.id, i]));
  // Queueing for review is not handing over: those receipts are left out, and approvals count instead.
  const delivered = [
    ...ledger.deliveries().filter((d) => d.ok && d.at >= since && !isReviewSink(cfg.sinks[d.sink])),
    ...reviewRows(cfg.dataDir).filter((r) => r.decision === "approved" && r.at >= since).map((r) => ({ id: r.id, sink: "review → approved", ref: r.ref, title: r.title })),
  ];
  const waiting = pendingReviews(cfg.dataDir);
  const failedDeliveries = ledger.deliveries().filter((d) => !d.ok && d.at >= since);
  const flagged = all.filter((i) => (i.flags?.length || i.risk?.level === "suspect") && i.captured_at >= since);
  const health = readHealth(cfg.dataDir);
  const sick = Object.entries(health).filter(([, h]) => h.consecutive_failures > 0);
  const demoted = Object.entries(health).filter(([, h]) => h.demoted_at);
  // Text in his own items that tried to instruct the extractor: nothing was taken from it, and he should know.
  const warned = [...extractions(cfg.dataDir).values()].filter((x) => x.warnings?.length && x.at >= since);
  // Items whose reading keeps failing are parked, not retried: he decides whether to try again.
  const parked = cfg.voice ? [...failures(cfg.dataDir)].filter(([, f]) => f.length >= (cfg.voice!.failuresBeforePark ?? 3)) : [];
  const unoffered = cfg.voice ? voiceOfferable(cfg).fresh.length : 0;
  // Candidates taken back out of his queue are reported, never dropped silently.
  const withdrawn = reviewRows(cfg.dataDir).filter((r) => r.decision === "superseded" && r.at >= since);
  const withdrawnBy = new Map<string, number>();
  for (const r of withdrawn) {
    const reason = (r.title ?? "").match(/^withdrawn: ([^(]+?) \(/)?.[1] ?? "withdrawn";
    withdrawnBy.set(reason, (withdrawnBy.get(reason) ?? 0) + 1);
  }

  const byProject = new Map<string, GradedItem[]>();
  for (const i of fresh) for (const p of i.grade.projects) byProject.set(p, [...(byProject.get(p) ?? []), i]);

  const day = now.toISOString().slice(0, 10);
  const md = [
    `# ${opts.title ?? "Feed digest"} · ${day}`,
    "",
    `${fresh.length} new items in the last ${opts.hours ?? 24} h · ${delivered.length} handed to memory · ${waiting.length} waiting for your review · ${flagged.length} flagged · ${sick.length ? `${sick.length} source(s) failing` : "all sources healthy"}`,
    "",
    ...(sick.length || demoted.length || flagged.length || failedDeliveries.length || warned.length || parked.length
      ? [
          "## Needs a look",
          "",
          ...sick.map(([n, h]) => `- **${n}** failing ${h.consecutive_failures}×${h.consecutive_failures >= 5 ? " (circuit open, retried every 6 h)" : ""} since ${h.last_ok?.slice(0, 16) ?? "never"}: ${h.last_error ?? ""}`),
          ...demoted.map(([n, h]) => `- **${n}** demoted ${h.demoted_at!.slice(0, 10)}: ${h.demoted_reason ?? ""} (lift: \`source reset "${n}"\`)`),
          ...flagged.map((i) => `- ${i.title} (${i.source}): ${[...(i.flags ?? []), ...(i.risk?.level === "suspect" ? [`guard suspect: ${i.risk.flags.join(", ")}`] : [])].join("; ")}`),
          ...parked.map(([item, f]) => `- ${byId.get(item)?.title ?? item}: own-voice reading failed ${f.length}×, parked (last: ${clip(f[f.length - 1]!.error, 120)}); try again: \`swb-feed voice reset ${item}\``),
          ...warned.map((x) => `- ${byId.get(x.item)?.title ?? x.item}: text that tried to instruct the extractor (${clip(x.warnings!.join("; "), 160)})`),
          ...failedDeliveries.slice(0, 10).map((d) => `- delivery to ${d.sink} failed for ${byId.get(d.id)?.title ?? d.id}: ${clip(d.error ?? "", 120)}`),
          "",
        ]
      : []),
    ...(waiting.length
      ? [
          `## Waiting for your review: ${waiting.length}`,
          "",
          "Approve writes it into its record, reject closes it for good: `swb-feed review approve <id>` · `swb-feed review reject <id>`. A voice candidate with no project yet takes `--project <name>`.",
          "",
          ...waiting.filter((r) => !r.voice).map((r) => {
            const i = byId.get(r.id);
            return `- \`${r.id.slice(0, 12)}\` ${i ? line(i).slice(2) : `**${r.score ?? "?"}** ${clip(r.title ?? r.id, 90)} · ${r.source ?? "?"}`}`;
          }),
          ...voiceGroups(waiting, byId),
          ...(unoffered ? ["", `${unoffered} more candidates from your voice are recorded and will be offered ${cfg.voice?.maxNewPerRun ?? 10} per run, most useful first.`] : []),
          "",
        ]
      : []),
    ...(withdrawn.length
      ? [`## Withdrawn from your queue: ${withdrawn.length}`, "", ...[...withdrawnBy].map(([why, n]) => `- ${n} because ${why}; a new reading's candidates take their place once it is read`), ""]
      : []),
    ...(delivered.length
      ? ["## Handed to memory", "", ...delivered.map((d) => `- ${byId.get(d.id)?.title ?? ("title" in d ? d.title : undefined) ?? d.id} → ${d.sink}${d.ref ? ` (${d.ref})` : ""}`), ""]
      : []),
    "## By project",
    "",
    ...(byProject.size
      ? [...byProject].sort((a, b) => b[1].length - a[1].length).flatMap(([p, l]) => [`### ${p} (${l.length})`, "", ...l.slice(0, 5).map(line), ""])
      : ["Nothing new touched a project.", ""]),
    "## Best of the rest",
    "",
    ...fresh.filter((i) => i.grade.projects.length === 0).slice(0, 5).map(line),
    "",
    "## Sources",
    "",
    "| Source | Last ok | Pulled | New | Failures | Quality (7 d) |",
    "|---|---|---|---|---|---|",
    ...Object.entries(health).map(
      ([n, h]) =>
        `| ${n} | ${h.last_ok?.slice(0, 16).replace("T", " ") ?? "never"} | ${h.last_pulled} | ${h.last_fresh} | ${h.consecutive_failures} | ${h.rolling_avg_quality !== undefined ? `${h.rolling_avg_quality} (${Math.round((h.rolling_a_rate ?? 0) * 100)}% 70+)` : "–"}${h.demoted_at ? " · demoted" : ""} |`,
    ),
    "",
  ].join("\n");

  mkdirSync(opts.dir, { recursive: true });
  const path = join(opts.dir, `${day}.md`);
  writeFileSync(path, md);
  return { path, fresh: fresh.length, delivered: delivered.length, waiting: waiting.length, flagged: flagged.length, sick: sick.map(([n]) => n) };
}
