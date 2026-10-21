// Delivery sinks hand items to other systems, once each, with a receipt in deliveries.jsonl.
// The feed never becomes the memory: it hands over and lets the brain consolidate.

import type { DeliverySink, GradedItem } from "../core/types.ts";
import { clip } from "../core/text.ts";

/** One JSON object per line on stdout: the Unix end of the pipe. Logs go to stderr. */
export function jsonl(): DeliverySink {
  return {
    kind: "delivery",
    accepts: ["public", "personal"],
    async deliver(item) {
      process.stdout.write(`${JSON.stringify(item)}\n`);
      return { ref: "stdout" };
    },
  };
}

/** The text a memory engine should read: what it is, why it matters to you, what it says. */
export function memoryText(i: GradedItem): string {
  return [
    `${i.title} (${i.source}${i.author ? `, ${i.author}` : ""}${i.published_at ? `, ${i.published_at.slice(0, 10)}` : ""})`,
    i.url ? `URL: ${i.url}` : "",
    i.grade.projects.length ? `Relevant to: ${i.grade.projects.join(", ")}` : "",
    `Summary: ${i.grade.summary_medium}`,
    "",
    clip(i.content, 4000),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Hindsight (vectorize-io/hindsight, MIT): POST /v1/default/banks/{bank}/memories with a RetainRequest.
 * document_id = the feed item id, so a re-delivery upserts instead of duplicating.
 */
export function hindsight(o: { baseUrl: string; bank: string; apiKey?: string }): DeliverySink {
  return {
    kind: "delivery",
    async deliver(item, ctx) {
      const body = {
        async: true,
        items: [
          {
            content: memoryText(item),
            timestamp: item.published_at ?? item.captured_at,
            context: `feed item from ${item.source}`,
            document_id: item.id,
            tags: [...item.grade.labels, ...item.grade.projects].map((t) => t.toLowerCase().replace(/\s+/g, "-")),
            metadata: { source: item.source, url: item.url ?? "", score: String(item.grade.score), kind: item.content_kind },
          },
        ],
      };
      if (ctx.dryRun) return { ref: `dry-run ${o.bank}`, skipped: true };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
      const res = await ctx.fetch(`${o.baseUrl.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(o.bank)}/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Hindsight HTTP ${res.status}: ${clip(await res.text(), 200)}`);
      return { ref: `${o.bank}/${item.id}` };
    },
  };
}

/** Any HTTP endpoint that takes the graded item as JSON (n8n, Inngest, Open Brain capture, your own). */
export function webhook(o: { url: string; headers?: Record<string, string> }): DeliverySink {
  return {
    kind: "delivery",
    async deliver(item, ctx) {
      if (ctx.dryRun) return { ref: `dry-run ${o.url}`, skipped: true };
      const res = await ctx.fetch(o.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...o.headers },
        body: JSON.stringify(item),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      return { ref: o.url };
    },
  };
}
