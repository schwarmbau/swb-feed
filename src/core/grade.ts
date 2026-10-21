// Grade = "good for what the owner is doing", not "good". Deterministic by default:
// same item + same profile = same score, and every point is explained in `why`.
// A model grade (model.ts) is layered on top later, within a budget, and keeps these reasons.

import type { Envelope, Grade, IntentProfile } from "./types.ts";
import { clip, sentences } from "./text.ts";

const W = "a-z0-9äöüß";
const reCache = new Map<string, RegExp>();
function termRe(term: string): RegExp {
  let re = reCache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
    re = new RegExp(`(?<![${W}])${esc}(?![${W}])`, "gi");
    reCache.set(term, re);
  }
  re.lastIndex = 0;
  return re;
}

function count(text: string, term: string): number {
  return text.match(termRe(term))?.length ?? 0;
}

export function summarize(e: Pick<Envelope, "title" | "content">): { short: string; medium: string } {
  const ss = sentences(e.content).filter((s) => s.length > 25);
  const short = clip(ss[0] ?? e.title, 220);
  let medium = "";
  for (const s of ss) {
    if (medium.length + s.length > 600) break;
    medium += (medium ? " " : "") + s;
  }
  return { short, medium: clip(medium || short, 640) };
}

export function gradeDeterministic(e: Envelope, profile: IntentProfile, profileHash: string): Grade {
  const title = e.title.toLowerCase();
  const body = e.content.slice(0, 12000).toLowerCase();
  const why: string[] = [];
  const labels: string[] = [];
  let raw = 0;

  for (const interest of profile.interests) {
    const hits: string[] = [];
    let strength = 0;
    for (const t of interest.terms) {
      const n = Math.min(count(body, t), 3) + 2 * Math.min(count(title, t), 1);
      if (n > 0) {
        strength += n;
        hits.push(`${t}×${n}`);
      }
    }
    if (strength > 0) {
      labels.push(interest.label);
      const pts = interest.weight * Math.log2(1 + strength);
      raw += pts;
      why.push(`${interest.label}: ${hits.join(", ")}`);
    }
  }

  const projects: string[] = [];
  for (const p of profile.projects) {
    const hit = p.terms.find((t) => count(title, t) + count(body, t) > 0);
    if (hit) {
      projects.push(p.name);
      raw += 1;
      why.push(`project ${p.name}: "${hit}"`);
    }
  }

  let score = 100 * (1 - Math.exp(-raw / 5));
  if (e.trust === "high") {
    score += 8;
    why.push("trusted source +8");
  } else if (e.trust === "low") {
    score -= 8;
    why.push("low-trust source −8");
  }
  for (const t of profile.avoid) {
    if (count(title, t) + count(body, t) > 0) {
      score -= 25;
      why.push(`avoid "${t}" −25`);
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  if (why.length === 0) why.push("no overlap with the intent profile");

  const s = summarize(e);
  return {
    id: e.id,
    score,
    labels,
    projects,
    why,
    summary_short: s.short,
    summary_medium: s.medium,
    grader: "deterministic/v1",
    profile_hash: profileHash,
    graded_at: new Date().toISOString(),
  };
}
