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
| Workspace Rust tests | `cargo test --workspace --exclude xtask --target <host-target>` | Any change under `crates/`: kernel, fork-instrument, shared, wasm-local-root-spill, and future workspace crates. `--target` is required because the default wasm32 target has no host runner; xtask has its own always-run suite. |
| Package-system automation tests | `cargo test -p xtask --target <host-target>` | `tools/xtask/**` changes: package resolver, binaries-dir placement, cache/output artifact validation, archive staging + canonical filename |
| Host integration tests | `cd host && npx vitest run` | Host/runtime behavior |
| Browser app/runtime tests | `cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium` | Browser host, UI, demo, service worker, VFS image behavior |
| Browser package-tree contract | `cd apps/browser-demos && npx playwright test test/package-deferred-tree-browser.spec.ts --project=chromium --project=firefox --project=webkit` | Browser lazy/eager package-tree parity, including Safari/WebKit |
| Browser asset check | `bash scripts/ci-check-browser-assets.sh` | Browser asset/import changes |
| musl libc-test | `scripts/run-libc-tests.sh` | libc, syscall, and kernel semantic changes |
| Open POSIX Test Suite | `scripts/run-posix-tests.sh` | POSIX API behavior |
| Sortix os-test | `scripts/run-sortix-tests.sh --all` | Broad POSIX/kernel regression coverage |
| ABI snapshot | `bash scripts/check-abi-version.sh` | ABI-adjacent changes |

For CI-shaped local runs, prefer:

```bash
bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh <cargo-workspace|cargo-xtask|vitest|browser|libc|posix|sortix> [group]
```

The optional group reproduces CI's deterministic suite partitions. Vitest
accepts `1/2`, `2/2`, or `resource-isolated`; libc accepts
`functional-regression` or `math`; and Sortix accepts `include`, `basic`, or
`runtime`. Omitting the group runs the complete suite, including Vitest's full
test inventory and `--all` for Sortix. Vitest's complete run excludes each
file declared in `scripts/ci-vitest-resource-isolated-cases.tsv` from its main
worker and then runs every declared case in a fresh worker process. Each row
names a regex-safe identifier that occurs in exactly one test. Before excluding
a file, the runner requires those identifiers to map one-to-one onto its full
machine-readable `vitest list --json` inventory.

For direct Cargo commands, compute `<host-target>` with:

```bash
rustc -vV | awk '/^host/ {print $2}'
```

`scripts/ci-run-test-suite.sh` does not currently expose an `abi` suite; run
`bash scripts/check-abi-version.sh` separately for ABI-adjacent changes.

## Preparing a fresh checkout or worktree to run the suites

The Vitest, browser, libc, posix, and sortix suites need built artifacts and
submodules that a fresh checkout — and every new `git worktree` — does **not**
inherit. This project builds everything locally; no CI status check
pre-materializes these artifacts for you. Missing artifacts surface as `Binary
not found: …/kernel.wasm` (or a program `.wasm`), `sysroot not found`, or
`libc/musl/src: No such file`. These are not "cannot validate" conditions, and
they are not a reason to stop short of a goal (running a suite, reproducing a
failure, or validating a branch before a merge). Building what a task needs is
part of the task. Build or fetch what is missing:

1. **Submodules** (musl, libc-test, os-test) — worktrees do not check them out:
   ```bash
   git submodule update --init --recursive
   ```
   If `libc/musl` exists but is not a valid checkout (a stray dir from a partial
   build blocks the clone), reset it: `rm -rf libc/musl && git submodule update
   --init libc/musl`.

   **On macOS, `os-test` does not check out correctly by default.** The suite
   tracks 17 pairs of paths that differ only in letter case, such as
   `include/inttypes/PRIx16.c` and `include/inttypes/PRIX16.c`. A
   case-insensitive filesystem — the macOS default — can hold only one file
   per pair, so `git submodule update --init` leaves 17 files modified that
   nobody edited.

   Only one spelling per pair keeps a directory entry, and the suite discovers
   its tests by listing directories. The other 17 are therefore **never found
   and never run**: measured on this branch, the `include` suite reports
   **3,741 tests on a collapsed checkout against 3,758 on a case-sensitive
   one**, and nothing in the output says 17 are missing. The `include` suite
   is compile-only and supplies most of this project's conformance passes, so
   a collapsed checkout silently under-reports it. (The surviving file also
   answers to the missing spelling, so anything that opens one of those paths
   directly compiles its sibling's source.)

   `scripts/run-sortix-tests.sh` and `scripts/run-browser-sortix-tests.sh`
   refuse to start on such a checkout and name every affected path. Provision
   a real one, then point the runner at it:

   ```bash
   export KANDELO_OS_TEST_DIR="$(scripts/ensure-case-sensitive-os-test.sh --print-dir)"
   ```

   That creates and mounts a case-sensitive APFS sparse image
   (`~/.cache/kandelo/KandeloCaseBuild.sparseimage`) via
   `scripts/ensure-case-sensitive-volume.sh`, clones `os-test` onto it at the
   exact commit the submodule pins, and prints the directory. Both scripts are
   idempotent and are no-ops on Linux and on any checkout already sitting on a
   case-sensitive filesystem, so provisioning can run them unconditionally.
   Neither touches the repository's own submodule checkout.

   `./run.sh setup` runs the same provisioning automatically when — and only
   when — it finds a collapsed checkout, so a fresh macOS worktree is
   prepared without a separate step.

   **Cost: none measurable.** Three interleaved runs of the `include` suite,
   alternating between the two checkouts on the same machine, gave 230 / 203 /
   188 s on the collapsed checkout and 211 / 200 / 231 s on the case-sensitive
   one — a 7 s difference in the means, smaller than the 42 s spread within
   either arm, and the case-sensitive arm compiles 17 more tests. Measured
   under a 1-minute load average of 30–50 from concurrent builds, which is why
   the runs were interleaved rather than batched.

   Read sources from the image, but keep build output off it. Both runners pin
   `BUILD_DIR` to the repository's own filesystem for exactly this reason: an
   earlier revision put build output on the sparse image and the same suite
   took 3,200 s instead of 290 s.
2. **Kernel wasm + host + rootfs + musl sysroot** — ~1.5min; `./run.sh setup`
   builds the musl sysroot from scratch on a fresh checkout (or just
   re-syncs overlay headers when a sysroot already exists), then the
   kernel, every package, and the rootfs, producing
   `local-binaries/kernel.wasm` (the binary resolver prefers it over
   `binaries/`) and `host/wasm/rootfs.vfs`:
   ```bash
   scripts/dev-shell.sh ./run.sh setup
   ```
   If a sysroot already exists and you just edited
   `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, `setup` will
   not rebuild musl for you — rebuild it explicitly first:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh
   ```
3. **Node dependencies** — `node_modules` are per-checkout, and both the repo
   root (the conformance runners load `tsx` from root) and `host/` are needed:
   ```bash
   npm ci            # root — provides tsx used by run-sortix/posix/libc-tests.sh
   (cd host && npm ci)
   ```
4. **Prebuilt test binaries** the source build does not produce, e.g. the
   MariaDB/Perl VFS images a few Vitest cases load:
   ```bash
   scripts/dev-shell.sh bash scripts/fetch-binaries.sh
   ```
5. **Program and test-fixture binaries** under `local-binaries/programs/` and
   `local-binaries/test-fixtures/` — `scripts/build-programs.sh` emits these,
   and several Vitest cases load them directly. The `exact-abi-source` suite,
   for one, reads these program fixtures:
   `local-binaries/programs/wasm32/{exec-child,vfork-lifecycle}.wasm` and
   `local-binaries/test-fixtures/wasm32/login.wasm`. Without them
   `exec-state-tracking`, `spawn-*`, `vfork-production-mechanism`, and
   `demo-login-image` fail with `ENOENT`/`existsSync === false` that has nothing
   to do with your change. The same script builds `hello64.wasm`, the LP64
   program the `wasm64` cases need and that `fetch-binaries.sh` does not carry:
   ```bash
   scripts/dev-shell.sh bash scripts/build-programs.sh
   ```
   `./run.sh setup` already builds the wasm64 sysroot (its bootstrap step plan
   runs `sysroot64` unconditionally, alongside the wasm32 `sysroot`). If the
   wasm64 sysroot is missing (e.g. a partial checkout) or you just edited
   `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, rebuild it explicitly
   first:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix
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
rebuild just the kernel wasm at `origin/main` and re-run the one test. Report a
pre-existing failure as pre-existing, not as your regression.

### Rebuilding just the kernel — and what each way costs you

Two ways, and they are not interchangeable. Pick with the trade-off in view:

```bash
# The engine path. Produces a VERIFIABLE artifact in the tier the resolver
# reads first, and `cargo xtask verify-fresh` can judge it.
scripts/dev-shell.sh cargo run -p xtask -- bootstrap kernel

# The cheap path. Works in a bare worktree with no submodules, and produces an
# artifact nothing can freshness-check.
scripts/dev-shell.sh cargo build --release -p kandelo -Z build-std=core,alloc
scripts/dev-shell.sh bash -c 'source scripts/install-local-binary.sh;
  install_local_binary kernel \
    target/wasm32-unknown-unknown/release/kandelo_kernel.wasm \
    kandelo-kernel.wasm'
```

**The cheap path stages an artifact `verify-fresh` cannot verify, and the
command says so as it installs.** Only the local-build engine stamps
`kandelo.build.key`; it appends the key at cache-store time, and `verify-fresh`
compares that stamp against the key the source tree currently resolves to. An
artifact staged by `install_local_binary` carries no stamp, so the gate refuses
it rather than judging it:

```
local-binaries/kernel.wasm carries no build key stamp; rebuild with
`./run.sh setup` so freshness can be verified.
```

`./run.sh test` runs that gate before its suites, so a cheaply-provisioned
worktree fails it. That is correct — an unverifiable artifact must not be scored
as fresh — but it is a real cost of the cheap path, and the reason the engine
path is the default recommendation here. The installer does not invent a stamp
to make the gate pass: it is handed a caller-supplied file and cannot know the
bytes came from this source tree, and a stamp it invented would claim a
provenance it never checked.

Use the cheap path when the engine path cannot run — a bare worktree with no
`libc/musl` submodule cannot generate the VFS product catalog, so `bootstrap`
stops before it builds anything. Initialising that one submodule is usually
cheaper than losing the freshness gate:

```bash
git submodule update --init libc/musl
```

Whichever you use, stage through `install_local_binary` rather than `cp`: the
resolver searches `local-binaries/source-only-v1/` **before** ambient
`local-binaries/`, so a plain copy into the ambient tier can be shadowed by an
older kernel and leave you testing the artifact you did not just build.

After editing kernel Rust, rebuild the kernel wasm (`./run.sh setup`) before the
Vitest/conformance suites — they load `local-binaries/kernel.wasm`, so a stale
wasm silently runs your OLD kernel code. `./run.sh setup` does not rebuild musl;
after editing `libc/musl-overlay/` or `libc/glue/channel_syscall.c`, run
`scripts/build-musl.sh` first. (`bash build.sh` still works as a deprecated
delegator to `./run.sh setup`.)

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
