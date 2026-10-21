# Contributing

Thank you for looking. Issues, ideas and pull requests are welcome, in English or German.

## How changes flow

`src/` and `test/` are exported from the maintainer's upstream engine at the commit named in `UPSTREAM.json`, which also lists each file's checksum. That keeps one engine instead of two drifting copies.

- **A pull request that touches `src/` or `test/`** is reviewed here as usual. When it is accepted, the maintainer applies it upstream and the next export brings it back, with you credited as co-author in the commit.
- **Everything else** (`README.md`, `CONCEPT.md`, `examples/`, `package.json`, this file) lives here and is merged directly.

## Before you open a pull request

```bash
bun install
bun test
bun run typecheck
```

- **No runtime dependencies.** The engine runs on Bun alone; a new dependency needs a very good reason.
- **A new source or sink is one file plus a test.** It implements `Source`, `ViewSink` or `DeliverySink` from `src/contracts/`, and nothing in the pipeline should need to change for it.
- **The two contracts are versioned** (`swb-feed-item/v1`, `swb-ledger/v1`). A change that would break a second implementation needs a new version, not an edit.
- **Privacy by default.** A sink or model port that may receive `personal` items says so explicitly; secrets are guarded before the first write. Tests use synthetic data only.

## Security

Please report a vulnerability privately through GitHub's security advisory form for this repository, not in a public issue.

## Licence

By contributing you agree that your contribution is licensed under the licence in `LICENSE`.
