// Routing is pure logic, no model: every rule whose conditions all hold fires,
// and an item reaches each sink at most once however many rules point there.

import type { Envelope, Grade, NumberCondition, Priority, Risk, Rule } from "./types.ts";
import { riskOf } from "./guard.ts";

const RANK: Record<Priority, number> = { immediate: 0, daily: 1, weekly: 2, archive: 3 };

/** A missing value never satisfies a condition: a rule that asks for a model dimension skips deterministic grades. */
function within(c: NumberCondition | undefined, v: number | undefined): boolean {
  if (!c || (c.gte === undefined && c.lte === undefined)) return true;
  if (v === undefined) return false;
  return (c.gte === undefined || v >= c.gte) && (c.lte === undefined || v <= c.lte);
}

/** A deterministic grade is its own keyword score; model grades made before `keyword_score` existed carry it in `why`. */
export function keywordScore(g: Grade): number | undefined {
  if (g.keyword_score !== undefined) return typeof g.keyword_score === "number" && g.keyword_score >= 0 && g.keyword_score <= 100 ? g.keyword_score : undefined;
  if (!g.grader.startsWith("model/")) return g.score;
  const m = g.why.map((w) => /^deterministic score (\d+)$/.exec(w)).find(Boolean);
  return m ? Number(m[1]) : undefined;
}

/** `risk`: the item's risk when the caller has it; computed from the item when a rule asks and it is missing. */
export function matches(rule: Rule, e: Envelope, g: Grade, risk?: Risk): boolean {
  const w = rule.when;
  if (!w) return true;
  if (!within(w.score, g.score)) return false;
  if (!within(w.quality, g.quality) || !within(w.importance, g.importance) || !within(w.novelty, g.novelty) || !within(w.urgency, g.urgency))
    return false;
  if (w.tiers && !(g.tier && w.tiers.includes(g.tier))) return false;
  if (!within(w.keywords, keywordScore(g))) return false;
  if (w.labels && !w.labels.some((l) => g.labels.includes(l))) return false;
  if (w.projects && !(w.projects.includes("*") ? g.projects.length > 0 : w.projects.some((p) => g.projects.includes(p))))
    return false;
  if (w.sources && !w.sources.includes(e.source)) return false;
  if (w.kinds && !w.kinds.includes(e.content_kind)) return false;
  if (w.trust && !w.trust.includes(e.trust)) return false;
  if (w.risk && !w.risk.includes((risk ?? riskOf(e)).level)) return false;
  return true;
}

export function route(rules: Rule[], e: Envelope, g: Grade, risk?: Risk): { sinks: string[]; rules: string[]; priority: Priority } {
  const sinks = new Set<string>();
  const fired: string[] = [];
  let priority: Priority = "archive";
  for (const r of rules) {
    if (!matches(r, e, g, risk)) continue;
    fired.push(r.name);
    for (const s of r.to) sinks.add(s);
    const p = r.priority ?? "archive";
    if (RANK[p] < RANK[priority]) priority = p;
  }
  return { sinks: [...sinks], rules: fired, priority };
}
