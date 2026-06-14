# SQLite Project Unit Tests on Kandelo

Results root: `test-runs/gastown-sqlite-browser-full-pr5-snapshot`

## Invocation

- Permutation: `full`
- Jobs per host: `2`
- Timeout per host: `21600000` ms
- Patterns/tests: full permutation default

## Host summary

| Host | Runner exit | Total jobs | Done | Failed | Omitted | Running | Ready | SQLite cases | Case errors | Current challenges |
|------|-------------|------------|------|--------|---------|---------|-------|--------------|-------------|--------------------|
| `browser` | 1 | 1393 | 58 | 4 | 0 | 2 | 1329 | 20066 | 1004 | failed:test/sysfault.test (1360 cases/2 errors); failed:test/writecrash.test (20 cases/1 errors); failed:test/like.test (159 cases/1 errors); failed:test/savepoint6.test (3325 cases/1000 errors); running:test/walfault.test (0 cases/0 errors) |

## Artifacts

- `browser`: `test-runs/gastown-sqlite-browser-full-pr5-snapshot/browser`
