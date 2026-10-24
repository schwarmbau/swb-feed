> **Licence: Apache-2.0.** The product name is still being decided; `swb-feed` is the working name.

# swb-feed

**Feed any second brain.** Harvest the sources you choose, journal everything, grade it against what you are actually working on, and route it to whichever brain you use: a Markdown wiki, a memory engine like Hindsight, your own system.

A [Schwarmbau](https://schwarmbau.de) open-core project. TypeScript on [Bun](https://bun.sh), zero runtime dependencies, runs on your own machine. Read [CONCEPT.md](CONCEPT.md) for the why and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the parts. Working with an AI coding agent? Point it at [AGENTS.md](AGENTS.md).

```
SOURCES → GUARD → JOURNAL → GRADE → ROUTE → SINKS
```

**Kurz auf Deutsch.** swb-feed füttert dein Second Brain: Es holt die Quellen, die du auswählst (Blogs, Substack, YouTube, GitHub, arXiv, ein Eingangsordner), schreibt alles in ein Journal, das nur wächst, bewertet jeden Eintrag an dem, woran du gerade arbeitest, und reicht das Beste an dein Gedächtnis weiter: ein Markdown-Wiki, Hindsight oder dein eigenes System. Geheimnisse werden vor dem ersten Schreiben entfernt, und ohne API-Schlüssel läuft alles deterministisch und nachvollziehbar. Selbst gehostet und quelloffen, für alle, die ihre Daten behalten wollen.

## Try it

```bash
git clone https://github.com/schwarmbau/swb-feed.git
cd swb-feed
bun install
bun run demo
```

No key, no account. The demo pulls Andrej Karpathy, Daniel Miessler, Nate B. Jones, Open Brain, Hindsight and an arXiv query on agent memory, grades every item against `examples/second-brain/intent.md`, and writes into `examples/second-brain/`:

- `brain/`: a Markdown wiki (open it in Obsidian or any editor): `index.md`, one note per item, a page per project, a source table;
- `brain.html`: one page with the items that touch your projects;
- `data/`: the ledger, the grades, the receipts and each source's health.

Run it again: nothing is duplicated. Edit `intent.md`, then `bun ../../src/core/cli.ts regrade` from that folder: the brain changes, with no network.

## Commands

`swb-feed` is the engine's CLI, `src/core/cli.ts`. From the repo root, `alias swb-feed="bun $PWD/src/core/cli.ts"` gives you the command; `bun <path-to-repo>/src/core/cli.ts` works anywhere without it.

Run it from the folder that holds your `feed.config.ts` (or pass `--config <file>`). `--dry-run` changes nothing on disk or remote. Run reports go to stderr, so `run` and `pull` keep stdout clean for a pipe.

| | |
|---|---|
| `swb-feed run [job…]` | harvest each job's sources (all jobs if none) |
| `swb-feed pull <job> <source>` | one source alone: its raw items as JSONL on stdout, nothing written |
| `swb-feed ingest <job> <source>` | read JSONL items from stdin, as if that source had pulled them |
| `swb-feed regrade` | re-grade the whole ledger against the current intent profile |
| `swb-feed rebuild` | regenerate every view from the ledger alone |
| `swb-feed explain <id>` | one item's trail: capture, guard, grade, rules, deliveries |
| `swb-feed status` | ledger size, sources, sinks, jobs, reputation |
| `swb-feed source reset <name>` | lift a demotion and close a failure circuit |
| `swb-feed review [list]` · `review show <id>` · `review approve <id>` · `review reject <id>` | the review queue: nothing queued reaches its sink until a person approves it |
| `swb-feed voice` · `voice backfill --since <date>` · `voice reset <id>` · `voice mine <conversation-id>` | the own-voice stage (below) |

`pull | ingest` journals exactly what `run` journals, so a source can live in another process, another language or another machine:

```bash
swb-feed pull research "My blog" | swb-feed ingest research "My blog"
```

## Configure

`feed.config.ts` is plain TypeScript. The package is not on npm: inside this clone, import from `./src/core/index.ts` (as the demo does); in your own project, add it from git with `bun add github:schwarmbau/swb-feed`, which makes the import below resolve.

```ts
import { defineFeed, feed, inbox, wiki, hindsight } from "@schwarmbau/swb-feed";

export default defineFeed({
  dataDir: "./data",
  intent: "./intent.md",
  sinks: {
    wiki: wiki({ dir: "./brain" }),
    memory: hindsight({ baseUrl: "http://localhost:8888", bank: "research" }),
  },
  jobs: {
    research: {
      sources: [
        feed({ name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", trust: "high" }),
        inbox({ name: "Inbox", dir: "./inbox" }),
      ],
      rules: [
        { name: "archive", to: ["wiki"] },
        { name: "memory", when: { labels: ["Agent memory"], score: { gte: 60 } }, to: ["memory"] },
      ],
    },
  },
});
```

The intent profile is Markdown, and it is the only yardstick:

```md
## Interests
- **Agent memory** (3): agent memory, second brain, llm wiki, recall
## Projects
- **my-wiki**: obsidian, knowledge base
## Avoid
- giveaway
```

Rules: all conditions in `when` must hold, every matching rule fires, and an item reaches each sink once. Conditions: `score`, `keywords`, `labels`, `projects` (`"*"` = any), `sources`, `kinds`, `trust`, and with a model grade also `quality`, `importance`, `novelty`, `urgency`, `tiers`.

Sources shipped: `feed` (RSS and Atom: blogs, Substack, YouTube channels, GitHub releases and commits, arXiv), `youtube` (channels with each new video's captions, needs `yt-dlp`), `inbox` (a folder of `.md`, `.txt`, `.html`; `personal` by default). Sinks shipped: `wiki` and `page` (views), `hindsight`, `webhook`, `jsonl` (deliveries), `reviewQueue` (wraps a delivery behind a person's approval), `voiceInbox` (where an approved own-voice candidate lands).

## Optional model grading

Without a model, every item gets a deterministic score and every point of it is explained. With one, the engine adds two summaries, a quality score, a tier, importance, novelty and urgency, labels from a fixed set you choose, and relevance to you. Any OpenAI-compatible endpoint works (a self-hosted LiteLLM, Ollama, an EU router):

```ts
import { openAICompatible } from "@schwarmbau/swb-feed";

model: {
  port: openAICompatible({ baseUrl: "http://localhost:4000/v1", model: "my-model", apiKey: () => process.env.LLM_KEY }),
  taxonomy: ["Agent memory", "Security", "Other"],
  maxCallsPerRun: 60,
},
```

The demo turns this on when `FEED_LLM_BASE_URL` and `FEED_LLM_MODEL` are set. Items marked `personal` never reach a port unless it says `acceptsPersonal: true`. Calls per run are capped; the rest wait for the next run. A source whose items stay poor is demoted until `source reset`; one that keeps failing is tried less often.

## Your own voice

Recordings of your own conversations, and notes you mark `voice: own`, are your thinking, so they are never rated as content. The own-voice stage reads them for what you decided, proposed, asked for and left open, checks every quote against the transcript, and puts each candidate in the review queue. Nothing lands until you approve it, and it lands as an idea unless you type it as a decision.

## Write your own source or sink

One file, then one line in your config.

```ts
import type { DeliverySink } from "@schwarmbau/swb-feed";

export const slack = (webhookUrl: string): DeliverySink => ({
  kind: "delivery",
  async deliver(item) {
    await fetch(webhookUrl, { method: "POST", body: JSON.stringify({ text: `${item.grade.score} · ${item.title} ${item.url ?? ""}` }) });
    return { ref: "slack" };
  },
});
```

A **view** (`kind: "view"`, `render(items)`) is rebuilt from the whole ledger each run. A **delivery** (`kind: "delivery"`, `deliver(item)`) runs once per item and leaves a receipt. A **source** is `{ name, trust, privacy_class, pull(ctx) }` returning items. The two seam contracts are versioned: `swb-feed-item/v1` (`src/contracts/feed-item.ts`, what a source hands over) and `swb-ledger/v1` (`src/contracts/ledger.ts`, the ledger's rows and the ports).

## Schedule it

It runs once and exits. Use what you already have: `cron`, a systemd timer, a Kubernetes CronJob.

## Develop

```bash
bun test
bun run typecheck
```

The engine in `src/` and `test/` is exported from the maintainer's upstream at the commit named in `UPSTREAM.json`, with every file's checksum. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes flow.

## Licence

Apache-2.0, see `LICENSE`.
