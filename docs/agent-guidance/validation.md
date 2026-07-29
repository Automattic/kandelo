# Validation Contract

Validation is evidence for a specific claim. Do not say "tests pass", "the
branch is complete", "the browser works", "ABI is fine", or "performance
improved" unless the evidence for that exact claim has been run and reported.

Use precise language:

- "I ran `X`; it passed."
- "I did not run `Y`."
- "This change is docs-only; I did not run runtime tests."
- "This is not fully merge-validated because `Z` remains unrun."

Do not use a narrow check to support a broad claim. A passing unit test does
not prove POSIX behavior. A passing Node/Vitest path does not prove browser
behavior. A passing browser demo does not prove ABI compatibility. A
micro-benchmark does not prove application performance.

Core validation surface:

| Suite | Command | Primary evidence for |
|---|---|---|
| Kernel unit tests | `cargo test -p kandelo --target <host-target> --lib` | Kernel logic changes |
| Fork instrument tests | `cargo test -p fork-instrument --target <host-target>` | Fork instrumentation/tooling changes |
| Host integration tests | `cd host && npx vitest run` | Host/runtime behavior |
| Browser app/runtime tests | `cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium` | Browser host, UI, demo, service worker, VFS image behavior |
| Browser package-tree contract | `cd apps/browser-demos && npx playwright test test/package-deferred-tree-browser.spec.ts --project=chromium --project=firefox --project=webkit` | Browser lazy/eager package-tree parity, including Safari/WebKit |
| Browser process-memory ownership | `cd apps/browser-demos && npx playwright test test/process-memory-retirement.spec.ts --project=chromium --project=firefox --project=webkit` | Exact-generation retirement under a strict live-memory budget on every browser engine |
| Browser asset check | `bash scripts/ci-check-browser-assets.sh` | Browser asset/import changes |
| musl libc-test | `scripts/run-libc-tests.sh` | libc, syscall, and kernel semantic changes |
| Open POSIX Test Suite | `scripts/run-posix-tests.sh` | POSIX API behavior |
| Sortix os-test | `scripts/run-sortix-tests.sh --all` | Broad POSIX/kernel regression coverage |
| ABI snapshot | `bash scripts/check-abi-version.sh` | ABI-adjacent changes |

For CI-shaped local runs, prefer:

```bash
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh <cargo-kernel|fork-instrument|vitest|browser|libc|posix|sortix> [group]
```

The optional group reproduces the natural CI shards for the longest
conformance suites. libc accepts `functional-regression` or `math`; Sortix
accepts `include`, `basic`, or `runtime`. Omitting the group runs the complete
suite, including `--all` for Sortix.

For direct Cargo commands, compute `<host-target>` with:

```bash
rustc -vV | awk '/^host/ {print $2}'
```

`scripts/ci-run-test-suite.sh` does not currently expose an `abi` suite; run
`bash scripts/check-abi-version.sh` separately for ABI-adjacent changes.

The table names primary evidence, not a universal checklist. Choose the suites
that support the claim you will make, broaden coverage when a change crosses
contract boundaries, and report anything relevant that was not run.

Runtime/kernel changes are not fully validated until the relevant conformance
suites have been considered. If a change touches syscall behavior, process
lifecycle, memory layout, fd semantics, VFS semantics, signals, libc glue, or
ABI-adjacent code, do not stop at unit tests and Vitest.

Browser-facing fixes are not complete from code reasoning alone. Use browser
tests where possible and manually verify user-visible browser demo fixes with:

```bash
./run.sh browser
```

Physical resident set size (RSS) is not an absolute cross-engine contract.
For process-memory retirement work, pair the deterministic cross-browser
ownership test above with the scheduled
`process-memory-retirement-telemetry.yml` matched-control trace. The scheduled
and applicable pull-request workflow compares counterbalanced 1 MiB and
32 MiB retirement trials with deliberately live Kandelo processes at both
sizes on the same engine and runner. After one unmeasured live-process realm,
it preserves two independent ABBA size contrasts. Each live contrast must
expose at least 8 MiB per child. Every live replicate must meet that
sensitivity floor at warm-up and sustained churn. Every retirement contrast
must remain below 4 MiB per child and 15% of its paired live signal during
256-child churn. Churn uses the median of all wave samples and the median
represented child count, rather than whichever collection peak or descent
happens to be last. Every individual retirement trial must also keep the
median shift from the first half of its waves to the second half below the
late slope and growth bounds.

The workflow samples before a browser context, after kernel initialization,
after warm-up and workload waves, after kernel destruction, and around 200 ms,
1 s, and 3 s after context closure. It uses the stabilized final close sample.
Context-close size contrasts are absolute byte residuals, not values divided
by all retired children. A paired live-control residual establishes the
engine-local noise floor. A positive retired terminal signal becomes a
regression only when later pre-context baselines also accumulate; a bounded
engine cache is an advisory. A signal at the earlier kernel-destroy sample is
preserved as engine-timed collection data when it clears at context close.
Across contexts, median and upper-quartile close residuals plus Theil-Sen and
first/last baseline trends prevent a fixed per-realm leak from canceling out
of the size contrast. An inconclusive trace is evidence to repeat or
investigate, not evidence that reclamation passed.

The workflow starts a cheap scope job on every pull request. Its reviewed path
matcher covers process-memory owners, retirement fences, browser worker and
graphics aliases, the telemetry harness, and Playwright dependency manifests.
Applicable changes run the three-engine matrix; unrelated changes skip it.
Scheduled and manually dispatched runs always measure.
The scope job first runs the checked-in matcher and aggregate-gate control
tests. Empty matches are allowed, but matcher errors fail the scope job and
therefore the aggregate gate instead of skipping telemetry.

Every job explicitly checks out the pull request's exact head rather than
GitHub's synthetic merge ref. All three applicable engine jobs must report
`pass`, their 90-day artifacts must record that head, and a moved branch starts
a new run. An always-present aggregate gate succeeds as "not applicable" for
an unrelated change and otherwise requires preparation plus the complete
matrix. That stable aggregate job is the check suitable for branch protection.
Manually dispatch the workflow when a relevant ownership change falls outside
the matcher, and add every new long-lived browser process-memory owner to it.
The physical sentinel is differential evidence, not an absolute RSS ceiling.
