# Architecture

How swb-feed is built, what each part owns, and where the design came from. The why is in [CONCEPT.md](../CONCEPT.md); the rules an agent must keep are in [AGENTS.md](../AGENTS.md).

## The run, end to end

```
                        ┌────────────── one run (swb-feed run [job…]) ──────────────┐
                        │                                                            │
 SOURCES                │  GUARD          JOURNAL          GRADE             ROUTE   │   SINKS
 ───────                │  ─────          ───────          ─────             ─────   │   ─────
 feed (RSS/Atom)  ─┐    │  secret shapes  ledger.jsonl     1 deterministic   rules:  │   views (rebuilt whole)
 youtube (+caps)  ─┼──► │  → [REDACTED]   append-only,     vs intent.md,     AND     ├─► wiki · page
 inbox (folder)   ─┤    │  <private> cut  URL identity,    every point       per     │
 stdin (ingest)   ─┘    │  known fields   revisions as     explained         rule,   │   deliveries (receipted)
                        │  only           new rows         2 model, opt.,    every   ├─► jsonl · hindsight ·
   pull | ingest        │                                  budgeted,         match   │   webhook
   = the same journal   │                                  ModelPort         fires   │
                        │                                  3 own voice:              ├─► reviewQueue ─ person ─► delivery
                        │                                  extract, never            │                approves
                        │                                  rate as content           ├─► voiceInbox (approved candidates)
                        └────────────────────────────────────────────────────────────┘
        health.json: per-source failures (circuit), 7-day reputation (demotion)
```

## Components and what each owns

| Component | Owns | Never does |
|---|---|---|
| **Source** (`src/sources/`) | fetching and parsing; may skip items the ledger already holds (`ctx.known`) | guard, grade, store |
| **Guard** (`src/core/guard.ts`) | redacting secret shapes, cutting `<private>` spans, dropping unknown fields | deciding where an item goes |
| **Ledger** (`src/core/ledger.ts`) | the append-only record of captures, grades, deliveries; dedupe by normalized URL; revisions | edit or delete a row |
| **Grader** (`grade.ts`, `model.ts`) | a score against the owner's intent; optional model dimensions within a run budget | send `personal` items to a port that has not opted in |
| **Own-voice stage** (`voice.ts`) | reading the owner's own words for decisions, ideas, asks, open questions; verifying quotes | land anything without approval |
| **Router** (`route.ts`) | pure rules over grade, source, kind, trust | call a model |
| **Views** (`sinks/wiki.ts`, `page.ts`) | a projection rebuilt from the whole ledger | hold state |
| **Deliveries** (`sinks/deliveries.ts`) | handing an item over once, with a receipt | deliver twice |
| **Review queue** (`sinks/review.ts`) | holding a delivery until a person approves or rejects it | write without an approval receipt |

## The seams

Two versioned contracts are the only things a second implementation needs to match:

- **`swb-feed-item/v1`** (`src/contracts/feed-item.ts`): what a source hands over. `swb-feed pull <job> <source>` prints it as JSONL; `swb-feed ingest <job> <source>` reads it and journals exactly what `run` would. A source can therefore live in another process, language or machine.
- **`swb-ledger/v1`** (`src/contracts/ledger.ts`): the ledger's rows (stamped with `v`) and the ports (`Sink`, `ModelPort`). The ledger files can be read by anything that speaks JSONL.

## Lineage: what came from Daniel Miessler's feed design, and what changed

The pipeline follows the shape of Daniel Miessler's published Feed design for his personal AI infrastructure: **ingest → summarize → rate → route**, multi-dimensional ratings plus labels from a fixed set, pure-logic routing rules with AND conditions and priorities, and self-cleaning sources (reputation, auto-demotion, a circuit breaker). This engine is a re-implementation from that design, not a copy of any code.

| Kept from the design | Changed here, and why |
|---|---|
| Summarize + Rate: short and medium summaries, quality, tier, importance, novelty, urgency, labels from a fixed taxonomy | **Deterministic grading first, on every item**, explained point by point; the model is optional and budgeted, so the feed runs with no key and no cloud |
| Rules route on rating dimensions; every match fires | **Relevance to your own intent profile** is the score, not quality alone; rules can also route on projects and keyword score |
| Self-cleaning sources: reputation from proven quality, auto-demotion of chronic low quality, a circuit breaker for failing pollers | Same idea, with thresholds you can read and set (demotion needs 30+ rated items, a mean under 35 and nothing at 70+; the circuit opens after 5 failures and retries every 6 hours), shown in `status` and lifted with `source reset` |
| Route to destinations (alerts, digest, archive) | **Views vs deliveries**: a view is rebuilt from the ledger, a delivery is receipted; a **review queue** puts a person between the feed and any memory |
| Ingest normalizes content | **Write-ahead ledger** with a guard in front: nothing is lost when a grader or sink fails, and no secret is ever written |
| (not in the design) | **The own-voice stage**: your own conversations and notes are read for decisions, never rated as content |

## Running it

One process per run; it exits when done. A lock file (`run.lock`) keeps two runs from writing at once and is taken over if its process died. Schedule it with cron, a systemd timer or a Kubernetes CronJob. Everything it writes stays in the config's `dataDir` and the sinks you configured.
