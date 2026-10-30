# Recorded test results

These records preserve failures for review. They do not change test
expectations, runner verdicts, or exit codes. Generate the TOML files with
`xtask test-baseline`; do not edit them by hand. Conformance expectations
and their checked reasons remain owned by the runners, including
`scripts/sortix-expectations.sh` and `scripts/xfail-reasons.sh`.

Persist only failures and anomalies: expected failures, unexpected passes,
timeouts, errors, skips and intermittent results. Ordinary passing tests,
success counts and overall test counts are omitted. Parsers consume passing
events temporarily to establish retry rates; they do not become stored
success records. Small successful examples in parser fixtures test that
filtering and retry detection work.

## Initial records: historical, not eligible for classification

The seven initial records come from main at `e4bca8639e`, the comparison
run for [PR #1600](https://github.com/Automattic/kandelo/pull/1600).
They were imported from Conductor's archived
`batched-follow-ups-for-main-correctness/main-validation-v1/` logs, not
rerun for this change. Their artifact fingerprints, complete filesystem
read traces, exact runtime/browser versions, exact OS release, and most
load measurements were not retained. Unknown fields remain unknown.
`historical = true` makes every initial record ineligible, even if its
source commit happens to match a checkout. No full suites were run to
establish current baselines or exclusion policies in this change.

| Record | Historical failures and anomalies |
|---|---|
| Vitest / Node | 30 failed, 21 skipped |
| Sortix / Node | 19 failed, 1,357 timeouts, 4 expected failures, 50 skipped |
| Open POSIX / Chromium | 3 expected failures, 1 unresolved, 2 skipped |
| libc-test / Chromium | 18 expected failures |
| Sortix / Chromium | 21 failed, 9 unexpected passes, 13 expected failures, 50 skipped |
| Playwright / Chromium, selected specs | 27 failed |
| Playwright / WebKit, selected specs | 21 failed, 15 skipped |

The Node Sortix log records an infrastructure failure: runtime tests
timed out while rebuilding the program-index checker. Its large number
of exceptions is real; compressing them into a single invented test
would lose evidence. PR #1600 explains the root cause and subsequent
fix. The libc browser clock failure was reported as an XFAIL by that
runner, so its record preserves that outcome.

Some old reporters did not name every skipped or expected-failure case.
The records keep their totals and explicit warnings about missing names;
they never invent test identities. Vitest and Playwright count timeouts
among their failure totals; individual rows retain the timeout outcome.
There are no main-run seeds for Node libc, Node Open POSIX, or Firefox.

`history-seeds.json` contains the curated import provenance and hashes of
the original, complete logs. Regenerate from an archive containing those
exact bytes (the raw logs are not duplicated into Git):

```bash
scripts/dev-shell.sh cargo build -p xtask --target aarch64-apple-darwin
scripts/dev-shell.sh target/aarch64-apple-darwin/debug/xtask test-baseline \
  import-history --manifest tests/baselines/history-seeds.json \
  --logs-root /path/to/batched-follow-ups-for-main-correctness
```

Replace the target with the host triple on other machines. The parser
fixtures under `tools/xtask/tests/fixtures/test-baselines/` retain small
real excerpts with their source ranges and original-log hashes.
Fixtures remove ANSI escapes and trailing whitespace for readable diffs.
The retry fixture is synthetic because the archived Playwright runs used
`--retries=0`.

## Commands and eligibility

Use the host-built `xtask test-baseline --help` for arguments. Run all
verification commands through `scripts/dev-shell.sh`.

| Command | Purpose |
|---|---|
| `capture` | Wrap a main run; save its log and evidence, compare inputs before/after, and sample load every five seconds |
| `record` | Parse a finished log with matching evidence and replace one baseline |
| `record --append` | Add a targeted main rerun with the same input digest and environment |
| `status` | Print current or stale, with changed paths/components when available; return nonzero for stale records |
| `classify` | Label branch failures against a current main record; refuse stale records |
| `summarize` | Show only failures and anomalies from a log without claiming equivalence |
| `check-reads` | Check a trace's hash and binding, and reject any read of an excluded path |
| `import-history` | Verify all seed log hashes, then regenerate historical records |

`capture` and freshness checks require a clean checkout at fetched
`origin/main`; they never switch branches or rebuild artifacts. From a
branch, use `--main-root /path/to/clean-main` for freshness checks or
capture. Build artifacts normally before capturing. Missing artifacts
are a provisioning step, not permission to invent their identities.
Put run outputs under the ignored `.context/` directory.

The key includes source tree/blob identities, artifact identities, the
exclusion policy, relevant run configuration, actual read-file contents,
and the OS/Node environment. Browser records also include the installed
Playwright version and the version reported by a launched browser.
`capture` probes the default headless Playwright engine; custom channels,
executable paths and remote browsers are not supported by this probe.
Do not use it to attest those configurations.

Source coverage starts with **the whole tracked tree**. Only a supplied
per-suite policy can remove paths. There are no guessed default
exclusions. Tree IDs are retained as diagnostic locators; commit IDs
are provenance, not key material. A clean-worktree requirement prevents
uncommitted or untracked source from silently escaping that identity.

The artifact key includes the stamped kernel build key and actual Wasm
bytes; installed sysroot bytes and their existing musl stamps; the
program index and SourceOnly projection's existing closure-derived
package keys and receipts. Projected member bytes must match the
receipts. Additional images/fixtures belong in `extra_artifacts`; reads
of ignored files are hashed as well. This records consumed artifacts;
it is not a replacement for normal build freshness checks.

## Read evidence and future captures

This tool accepts a normalized filesystem trace; it does not collect a
privileged trace itself. On macOS, `fs_usage` requires root. A collector
must cover the suite's complete process tree, including shell scripts,
Node workers, compilers, Vite and browsers. Retain the raw trace. Include
explicit file reads, directory listings, metadata lookups and missing
path probes; an import graph alone misses tests that read documentation
or scripts with filesystem APIs. Do not mark a dropped, truncated or
partial trace complete. Normalize aliases/symlinks to repository paths.
Separate the collector's own evidence-reading/normalization operations
from suite inputs, and document that filtering in the method description.

A reviewed input specification looks like this schematic example;
replace its illustrative read list with the actual complete inventory:

```json
{
  "kernel": "local-binaries/source-only-v1/kernel.wasm",
  "sysroots": ["sysroot", "sysroot64"],
  "projection": "local-binaries/source-only-v1/.kandelo/source-only-program-projection-v1.json",
  "program_index": "local-binaries/source-only-v1/program-packages.json",
  "extra_artifacts": [],
  "policy": {"exclude": []},
  "context": {"resolution-policy": "source-only-v1"},
  "read_paths": ["host/src/node-kernel-host.ts"]
}
```

An exclusion is an exact relative path, or a directory prefix ending in
`/`, never a glob. Exclude a path only after the suite's complete trace
proves it absent. Keep the raw trace and reviewed normalized inventory
with the run evidence. Generated baseline data and parser fixtures are
outside the resolver source-literal audit; other tests must be measured
before excluding those paths from their keys. Vitest reads `README.md`,
`docs/` and skill files: a README change can legitimately stale Vitest.

For each capture, the collector wrapper receives a fresh
`KANDELO_BASELINE_CAPTURE_ID` environment variable. It must write a new
read-set JSON file after tracing, with these fields:

```json
{
  "capture_id": "copy KANDELO_BASELINE_CAPTURE_ID from this run",
  "suite": "sortix",
  "host": "node",
  "command": ["the", "exact", "capture", "argv"],
  "method": "describe the collector and process-tree filtering",
  "complete": true,
  "trace_sha256": "64 lowercase hex characters hashing the raw trace",
  "paths": ["host/src/node-kernel-host.ts"]
}
```

The wrapper must execute the suite, preserve its exit status and finish
the trace even on failure. Its implementation/configuration must be
included among the captured inputs. Read-set completeness is a reviewed
collector assertion; the tool verifies its binding/hash/path constraints,
not the collector's truthfulness. A new read outside the input inventory
or inside an excluded path rejects the capture. Update the inventory,
remove conflicting exclusions and recapture before recording it.
Start `capture` inside the dev shell; re-entering the shell between it
and the collector would strip the capture ID from the environment.

Use `capture --spec ... --reads ... --trace ... --log ... --out ... --`
followed by that collector wrapper and its suite arguments. Pass
`--full-suite` only for an unfiltered inventory. The load threshold
defaults to the number of available CPUs; `--load-threshold N` records
an explicit alternative. Any sample above the threshold makes the run
unreliable for classification. A failed suite still makes `capture`
fail after saving evidence. `record` success means the evidence was
written, never that the tests passed.

After a finished run:

```bash
xtask test-baseline record --log .context/run.log --evidence .context/run.json
xtask test-baseline status --main-root /path/to/clean-main
xtask test-baseline classify --baseline tests/baselines/sortix-node.toml \
  --log .context/branch-sortix.log --main-root /path/to/clean-main
```

These examples assume `xtask` is the host-built binary inside the dev
shell. `status` never runs a suite. A new fingerprint must be captured
from a run; changing metadata in an old record cannot make it current.

Classification distinguishes exact known outcomes/reasons, intermittent
results, changed outcomes/reasons, absent failures, and cases outside
the recorded scope. Missing per-test details also force a targeted main
rerun for an absent case. Absence is evidence to investigate a branch
change or load, not proof of causality. Partial Playwright seeds cannot
establish results for specs main did not run.

For targeted reruns, retain the original full input specification and
configuration, including its complete read inventory. The rerun may
read a subset, but cannot add unknown inputs. Append using `record
--append` and fresh capture evidence. Mixed observations become
`intermittent`, with `adverse / attempts`; a later pass never deletes an
earlier failure. Anomaly counts remain the original run's counts.
For a passing Vitest rerun, use its existing `--reporter=verbose` option
so the parser can name the passing test. Default summary counts cannot
identify it. Skipped/unselected rerun cases do not establish attempts.
Historical records cannot be extended into verified records: replace
them with fully captured evidence.

See the binding [agent workflow](../../docs/agent-guidance/validation.md#committed-test-baselines).
