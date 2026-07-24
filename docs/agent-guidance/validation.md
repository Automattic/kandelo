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
| Browser lazy VFS contract | `cd apps/browser-demos && npx playwright test test/browser-kernel-lazy-registration.spec.ts --project=chromium --project=firefox --project=webkit` | Browser-host lazy VFS registration ordering, including Safari/WebKit |
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

## Preparing host vitest fixtures

The host vitest gate (`cd host && npx vitest run`) needs two build artifacts
that its own `globalSetup` does not produce:

- `host/wasm/rootfs.vfs` — mounted by the getpwent and node-host-mounts tests.
- `local-binaries/programs/wasm64/hello64.wasm` — loaded by the wasm64 tests.

Tests that cannot find these fixtures `skipIf(...)` themselves, so a run can
report green while silently skipping rootfs and wasm64 coverage. In a fresh
(e.g. Homebrew package) worktree, prepare them deterministically inside the
dev shell with:

```bash
bash scripts/dev-shell.sh bash scripts/prepare-vitest-fixtures.sh
```

This bootstrap:

- preflights the required tools and fails with an explicit MISSING-TOOL
  message — kept distinct from a release-cache miss — when the SDK
  cross-toolchain is absent. The usual cause is running outside
  `scripts/dev-shell.sh`, where `wasm32posix-cc`/`wasm-opt` are not on PATH
  and even the Rust host linker is unavailable (the old failure surfaced as a
  wall of `tool 'clang' not found` linker errors);
- classifies each rootfs input package as a release-cache HIT (a published
  archive was fetched and validated) or MISS (a source build is required
  because the archive is absent or its `cache_key_sha` drifted from the
  current recipe), so forced source builds are named and expected rather than
  an ambiguous silent fallback;
- builds the wasm32/wasm64 sysroots, the kernel, the wasm64 `hello64`
  fixture, and `host/wasm/rootfs.vfs`, skipping any that already exist;
- writes passed/failed/skipped outcome lists under
  `test-runs/vitest-fixtures/outcome-lists/` (override with `--result-dir`).

Use `--classify-only` for a fast "is my environment ready, and what will
source-build?" pre-check that runs the preflight and release-cache
classification without building any fixtures.

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
