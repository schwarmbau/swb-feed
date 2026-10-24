# AGENTS.md

Guidance for an AI coding agent (Codex, Claude Code, any harness) working in or reading this repository. Humans: start with [README.md](README.md) and [CONCEPT.md](CONCEPT.md).

## What this is

swb-feed is the intake layer for a second brain: it pulls sources, guards and journals every item, grades it against the owner's intent profile, and routes it to sinks (views and deliveries). TypeScript on Bun, zero runtime dependencies. The full component map is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

```bash
bun install          # dev dependencies only (typescript, @types/bun)
bun test             # the whole suite; must stay green
bun run typecheck    # tsc --noEmit over src, test, examples
bun run demo         # live run of examples/second-brain (network, no key)
```

Tests create their own temp dirs. Set `TMPDIR` to a scratch dir if you run them somewhere you care about.

## Where things are

| Path | What it holds |
|---|---|
| `src/contracts/feed-item.ts` | `swb-feed-item/v1`: `RawItem`, `Source`, `PullContext`. What a source hands over. Imports nothing. |
| `src/contracts/ledger.ts` | `swb-ledger/v1`: `Envelope`, `Grade`, `Delivery`, `ReviewRow`, `Rule`, `Sink`, `ModelPort`, `RunContext`, the row version stamp `v`. |
| `src/core/types.ts` | re-exports both contracts plus engine config: `FeedConfig`, `Job`, `ModelConfig`, `VoiceConfig`, `IntentProfile`, `SourceHealth`. |
| `src/core/pipeline.ts` | `ingest()`: pull → guard → journal → grade (deterministic, then model within budget) → own-voice stage → route → deliver → render views; health, reputation, circuit, run lock. |
| `src/core/guard.ts` | secret-shape redaction and `<private>` stripping, before anything is written; `assess`/`riskOf`: risk flags (`none`/`note`/`suspect`) derived from every stored field on every run; levels only go up. |
| `src/core/pii.ts` | `contactPii()` (zero-dependency personal-data port) and `combinePii()`. |
| `adapters/pii-openmed/` | optional `PiiPort` on local ONNX models; its own `package.json`, models downloaded, never committed. The engine never imports it. |
| `src/core/ledger.ts` | the append-only journal and its readers; skips and counts malformed rows. |
| `src/core/grade.ts`, `intent.ts` | deterministic grading against the Markdown intent profile; every point is explained in `why`. |
| `src/core/model.ts` | optional model grading behind `ModelPort`; `openAICompatible()` adapter; answer validation. |
| `src/core/route.ts` | pure rules: AND conditions, every matching rule fires, each sink once. |
| `src/core/voice.ts` | the own-voice stage: extraction, quote verification, dedupe, parking. |
| `src/core/cli.ts`, `digest.ts`, `index.ts` | the CLI (`runCli`), the daily digest, the public API. |
| `src/sources/` | `feed` (RSS/Atom), `youtube` (captions via yt-dlp), `inbox` (folder). |
| `src/sinks/` | views `wiki`, `page`; deliveries `jsonl`, `hindsight`, `webhook`; `reviewQueue`; `voiceInbox`. |
| `examples/second-brain/` | a runnable config and intent profile. Its `data/`, `brain/`, `brain.html` are output, git-ignored. |

Data a run writes, all in the config's `dataDir`: `ledger.jsonl` (captures), `grades.jsonl` (versioned by profile hash), `deliveries.jsonl` (receipts), `review.jsonl`, `voice.jsonl`, `health.json`, `run.lock`.

## Invariants: do not break these

1. **Guard before journal.** Nothing reaches the ledger, a view, a delivery or a model without passing `guard()`. Unknown `RawItem` fields are dropped.
2. **The ledger only grows.** Never rewrite or delete ledger rows. A changed item is a revision row, not an edit.
3. **Views are rebuilt, deliveries are receipted.** A view is regenerated from the whole ledger (`rebuild`) and never holds state. A delivery runs once per item and sink and leaves a receipt; `skipped: true` means rehearsed, no receipt, retried next run.
4. **Two privacy axes, never merged.** `privacy_class` decides where an item may go (sinks and model ports must opt in to `personal`); an item can only make itself stricter than its source. Own-voice decides how it is graded (never rated as content).
5. **Deterministic first.** Every item gets an explained deterministic grade; a model grade is optional, budgeted, and a failed model call keeps the deterministic grade.
6. **Model output is untrusted.** Item text is fenced and defanged in prompts (invisible characters dropped, guard flags never shown); model answers are validated and pass the guard before they are stored.
7. **No runtime dependencies.** New capability arrives as a port the config fills (like `ModelPort`), not as a package import in the engine.
8. **Contracts are versioned.** A breaking change to `src/contracts/` needs a new version string, not an edit.
9. **Risk only tightens.** A guard flag can hold an item back from a delivery sink or make it `personal`; it can never make an item looser, delete its text, or drop it from the ledger. Nothing an item says lowers its level: quoting, framing or an "example" around an attack leaves it `suspect`. Every field a prompt or a view can carry is assessed (`itemText`), and flags come from a closed vocabulary. Views receive every item with its risk; a view that feeds a model's memory leaves out a `suspect` item until a person approved that exact text (`risk.approved`, bound to the content hash). Stored text is never normalized; matching runs on a copy.
10. **Optional adapters live in `adapters/`**, each with its own `package.json`. Invariant 7 holds for `src/`: an adapter fills a port in the config, never the other way round.

## Adding a source or a sink

One file plus one config line; nothing in `pipeline.ts` changes. A source implements `Source` (`name`, `trust`, `privacy_class`, `pull(ctx)` returning `RawItem[]`; use `ctx.fetch`, honour `ctx.known` to skip expensive detail fetches). A sink implements `ViewSink` or `DeliverySink`; set `accepts: ["public", "personal"]` only if it may receive personal items. Add a test beside the others in `test/`, with synthetic data only.

## How the code arrives here

`src/` and `test/` are exported from the maintainer's upstream engine at the sha in `UPSTREAM.json` (every file's sha256 listed). Propose changes to them as pull requests; the maintainer applies them upstream and the next export brings them back (see CONTRIBUTING.md). Everything else in the repo is edited here directly.
