// One self-contained HTML page over the same items as the wiki: something to put on a screen.
// Also a compiled view, so it is rebuilt from the ledger and never edited.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GradedItem, ViewSink } from "../core/types.ts";
import { clip } from "../core/text.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function card(i: GradedItem): string {
  const g = i.grade;
  const tags = [...g.projects.map((p) => `<span class="p" data-p="${esc(p)}">${esc(p)}</span>`), ...g.labels.map((l) => `<span class="l">${esc(l)}</span>`)].join("");
  // Only web links become links: a feed can carry any scheme, javascript: included.
  const safe = i.url && /^https?:\/\//i.test(i.url);
  const title = safe ? `<a href="${esc(i.url!)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title);
  return `<article data-projects="${esc(g.projects.join("|"))}">
  <div class="score s${Math.floor(g.score / 25)}">${g.score}</div>
  <div class="body">
    <h3>${title}</h3>
    <div class="meta">${esc(i.source)}${i.author ? ` · ${esc(clip(i.author, 40))}` : ""} · ${(i.published_at ?? i.captured_at).slice(0, 10)} · ${esc(i.priority)}${g.tier ? ` · tier ${esc(g.tier)} · quality ${g.quality ?? "?"}` : ""}</div>
    <p>${esc(g.summary_short)}</p>
    <div class="tags">${tags}</div>
    <details><summary>why</summary><ul>${g.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul><div class="meta">rules: ${esc(i.rules.join(", ") || "none")} · grader ${esc(g.grader)} · profile ${esc(g.profile_hash)} · id ${i.id}</div></details>
  </div>
</article>`;
}

export function page(o: { path: string; title?: string }): ViewSink {
  return {
    kind: "view",
    async render(items, ctx) {
      if (ctx.dryRun) return { ref: o.path };
      const sorted = [...items].sort((a, b) => b.grade.score - a.grade.score);
      const projects = [...new Set(sorted.flatMap((i) => i.grade.projects))].sort();
      const sources = new Set(sorted.map((i) => i.source)).size;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title ?? "Brain feed")}</title>
<style>
:root{--bg:#f7f7f4;--fg:#1c1c1a;--mut:#6b6b66;--card:#fff;--line:#e4e4de;--acc:#b8860b}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece6;--mut:#9a9a92;--card:#1d1d1b;--line:#2e2e2b;--acc:#e0b84a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px}h1{margin:0 0 4px;font-size:28px}.sub{color:var(--mut);margin-bottom:18px}
nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}nav button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit;font-size:14px}
nav button.on{background:var(--fg);color:var(--bg)}
article{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
.score{flex:0 0 48px;height:48px;border-radius:10px;display:grid;place-items:center;font-weight:700;font-size:18px;background:var(--line)}
.s3,.s4{background:var(--acc);color:#141413}.s2{border:2px solid var(--acc)}
.body{min-width:0;flex:1}h3{margin:0;font-size:17px;line-height:1.3}h3 a{color:inherit}
.meta{color:var(--mut);font-size:13px;margin:2px 0 6px}p{margin:4px 0 8px}
.tags span{display:inline-block;font-size:12px;border-radius:6px;padding:1px 7px;margin:0 6px 4px 0}.p{background:var(--fg);color:var(--bg)}.l{border:1px solid var(--line);color:var(--mut)}
details{font-size:14px;color:var(--mut)}summary{cursor:pointer}
</style></head><body><main>
<h1>${esc(o.title ?? "Brain feed")}</h1>
<div class="sub">${sorted.length} items from ${sources} sources, graded against one intent profile · rebuilt ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</div>
<nav><button class="on" data-f="">all</button>${projects.map((p) => `<button data-f="${esc(p)}">${esc(p)}</button>`).join("")}</nav>
${sorted.map(card).join("\n")}
</main><script>
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll("nav button").forEach(x=>x.classList.toggle("on",x===b));const f=b.dataset.f;document.querySelectorAll("article").forEach(a=>a.style.display=!f||a.dataset.projects.split("|").includes(f)?"":"none")});
</script></body></html>`;
      mkdirSync(dirname(o.path), { recursive: true });
      writeFileSync(o.path, html);
      return { ref: o.path };
    },
  };
}
