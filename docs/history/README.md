# Historical reference material

Selected design decisions and failure analyses live here after their original
plans or raw output trees have been retired. These records preserve historical
context; their proposals, commands, results and follow-ups do not establish
current behavior or current test expectations.

| Reference | Preserves |
|---|---|
| [Process memory allocation, May 2026](2026-05-30-process-memory-allocation.md) | Layout tradeoffs, compatibility choices and deferred linker/compaction proposals from the original allocator plan |
| [SQLite full-run failures](sqlite-full-run-failures.md) | Browser failure identifiers and timings, interrupted jobs, and the separate Node executable-format failure |
| [xtask stale-fixture repair](xtask-stale-fixture-repair.md) | Seven fixture failures, their repair, the negative validation guard and before/after evidence |

Each record identifies its original source. Raw databases and full logs remain
available in that source tree's Git history. New runner output stays in ignored
`test-runs/` or scratch storage. Current main failure observations follow the
separate [baseline workflow](../../tests/baselines/README.md).
