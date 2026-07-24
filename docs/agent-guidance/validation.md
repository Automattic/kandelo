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

## Preparing a fresh checkout or worktree to run the suites

The Vitest, browser, libc, posix, and sortix suites need built artifacts and
submodules that a fresh checkout — and every new `git worktree` — does **not**
inherit. Missing artifacts surface as `Binary not found: …/kernel.wasm` (or a
program `.wasm`), `sysroot not found`, or `libc/musl/src: No such file`. These
are not "cannot validate" conditions. Build or fetch what is missing:

1. **Submodules** (musl, libc-test, os-test) — worktrees do not check them out:
   ```bash
   git submodule update --init --recursive
   ```
   If `libc/musl` exists but is not a valid checkout (a stray dir from a partial
   build blocks the clone), reset it: `rm -rf libc/musl && git submodule update
   --init libc/musl`.
2. **musl sysroot** — one-time, ~20s; required before `build.sh` can compile the
   user programs and rootfs:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh
   ```
3. **Kernel wasm + host + rootfs** — ~1.5min; produces `local-binaries/kernel.wasm`
   (the binary resolver prefers it over `binaries/`) and `host/wasm/rootfs.vfs`:
   ```bash
   scripts/dev-shell.sh bash build.sh
   ```
4. **Node dependencies** — `node_modules` are per-checkout, and both the repo
   root (the conformance runners load `tsx` from root) and `host/` are needed:
   ```bash
   npm ci            # root — provides tsx used by run-sortix/posix/libc-tests.sh
   (cd host && npm ci)
   ```
5. **Prebuilt test binaries** the source build does not produce, e.g. the
   MariaDB/Perl VFS images a few Vitest cases load:
   ```bash
   scripts/dev-shell.sh bash scripts/fetch-binaries.sh
   ```
6. **wasm64 sysroot** (only for the `wasm64` Vitest cases, which need an LP64
   `hello64.wasm` that `fetch-binaries.sh` does not carry):
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix
   scripts/dev-shell.sh bash scripts/build-programs.sh
   ```

After that the full suites run. Do **not** report "I can't run Vitest / the
conformance suites / the browser" because a fresh worktree lacks artifacts —
build or fetch them with the steps above, then run the suite and report the real
result. If a suite genuinely cannot run (no network for `fetch-binaries.sh`, no
display for browser tests, etc.), name the exact step that failed and why; that
is different from validation being impossible.

Before blaming a suite failure on your change, confirm it actually is your
change: a few package/demo tests (e.g. the Erlang `ring` benchmark) can fail for
environment or artifact reasons unrelated to a given diff. Reproduce the failure
on a pristine `origin/main` build of the same artifact before attributing it —
rebuild just the kernel wasm (`cargo build --release -p kandelo -Z
build-std=core,alloc && cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm
local-binaries/kernel.wasm`) at `origin/main` and re-run the one test. Report a
pre-existing failure as pre-existing, not as your regression.

After editing kernel Rust, rebuild the kernel wasm (`bash build.sh`) before the
Vitest/conformance suites — they load `local-binaries/kernel.wasm`, so a stale
wasm silently runs your OLD kernel code. `bash build.sh` does not rebuild musl;
after editing `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, run
`scripts/build-musl.sh` first.

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
