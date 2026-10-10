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
| Browser native filesystem contracts | `cd apps/browser-demos && npx playwright test test/native-rootfs-lazy.spec.ts test/rootfs-inspection.spec.ts --project=chromium --project=firefox --project=webkit` | Native lazy fetch/read/exec and live filesystem inspection, including Safari/WebKit |
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

## Waiting on long builds and suites

`./run.sh setup`, `local-build`, full Vitest, and the conformance suites can
run for more than 10 minutes. Full builds include compilation, fork
instrumentation, and artifact verification; their duration depends on
package cache reuse. In August and September 2026, agents spent about 12%
of their input tokens on poll turns and on cache rewrites after long blocking
calls. They also waited on `pgrep -f` patterns that matched the waiting shell
itself and never returned, and started second runs that broke the first.
`scripts/agent-job` removes those choices:

A run that fits in one Bash call, under the tool's 10-minute limit, needs
none of this. Run it in the foreground with output to a log file
(`cmd > .context/x.log 2>&1; echo exit=$?`): that is one call and no waiting
turns. For anything longer:

```bash
scripts/agent-job start -- ./run.sh setup   # prints a job id (run.sh enters the dev shell itself)
scripts/agent-job wait <id>      # blocks on the job's PID for up to 9 min; exit 124 = still running, run it again
scripts/agent-job status [<id>]  # elapsed vs usual duration, local-build progress, live processes
scripts/agent-job result <id>    # exit status, [suite-health] lines, log tail
```

The command after `--` can take either of two forms, and both run exactly
as written:

```bash
# Several words: an argv, re-quoted so each word reaches bash unchanged.
scripts/agent-job start -- scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/foo.test.ts'
# One quoted word: a shell string, run verbatim by bash -c.
scripts/agent-job start -- "scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/foo.test.ts'"
```

Before 2026-10-02, the several-words form joined the words with plain
spaces and lost their quoting. The inner `bash -c` then received only `cd`,
and the rest ran outside the dev shell from the repo root. If a vitest job
log's ` RUN  v… <path>` line names the repo root instead of `.../host`, the
run used the wrong config and toolchain, and its results are invalid.

- **Waiting:** repeat `agent-job wait <id>` in the foreground until it
  returns the job's status. That is one turn per 9 minutes, never a
  `sleep`/`tail` poll. If an agent client yields a running terminal session,
  resume that session to collect the result. An interactive main session may
  instead run `agent-job wait <id> --timeout 0` in the background and use a
  completion notification. A headless session or subagent must not end its
  turn while waiting: it stops there, and the result is lost.
- **Subagents** must not wait on whole-tree builds or full suites. A
  subagent's prompt cache expires after 5 minutes, so every long blocking
  call rewrites its whole context. Build what a subagent needs before
  dispatching it. A subagent that discovers it needs one reports the command
  back instead of running it.
- **Progress:** for `./run.sh setup`, `local-build`, and `build <target>`,
  `agent-job status` shows nodes done out of the total. Start them as
  `./run.sh …`, not under `scripts/dev-shell.sh`, which drops the events
  variable. `./run.sh local-build --plan` previews a build (cache hits,
  nodes to build, estimated time) before you start it.
- **Locked runs:** `agent-job start` refuses a second locked run (vitest,
  `run.sh test`, `ci-run-test-suite.sh`, `npm ci`, setup, local-build) in the
  same worktree while one is running. Those runs race each other.
- **Another workspace's build:** waiting on a build that another worktree
  (another Conductor workspace) is running is supported, and `agent-job` is
  the tool for it. Do not hand-roll a `kill -0 <pid>`, `pgrep`, or `sleep`
  loop on its process. Job records are machine-wide, so every command
  accepts a peer's job id:

  ```bash
  scripts/agent-job list --all               # every worktree's jobs: state, worktree, commit, relation to your HEAD
  scripts/agent-job status <id>              # its progress, worktree, and commit
  scripts/agent-job wait <id>                # same 540 s / exit-124 contract as for your own jobs
  scripts/agent-job wait --peer prepare-browser   # the one running job whose command contains the text
  ```

  - **Check the commit before relying on the build.** `list --all` shows
    each job's `HEAD`, with `*` when its tree had uncommitted tracked
    changes at start, and how that commit relates to yours: `same`,
    `N behind` (it built an ancestor of your `HEAD`), `N ahead` (a
    descendant), `diverged`, or `unrelated`; `-` means the job was
    started before commits were recorded. `status` and `wait` spell the
    same out, and list the uncommitted paths. Untracked files are not
    counted. Worktrees share the build cache, and its entries are keyed
    on build inputs. Once a peer's build finishes, your own run reuses
    whatever it built from the same inputs, so the closer its commit is
    to yours, the more your run can reuse.
  - **`--peer <text>` never guesses.** When no running job's command
    contains `<text>`, or more than one does, it lists the candidates on
    stderr and exits 2; then wait on one by id. A job that itself exits
    2 also makes `wait` exit 2, so read the output.
  - The locked-run check is per worktree: a peer's `local-build` does not
    stop yours from starting. Choosing to wait on it is the agent's call.
- **Before a suite**, `npx tsx scripts/check-artifact-closures.ts` reports
  any program package whose artifact closure would fail to resolve with
  "Package artifact closure is incomplete". It takes about 3 s once warm, and
  saves the minutes a suite would spend reaching the same error.
- **Every Vitest run** ends with a `[suite-health]` line. When many files
  fail to load, it groups them by the missing thing, so one line replaces
  scrolling hundreds of failure blocks. `WARN` means part of the suite did
  not run (a load error or zero tests).
- **Optional guard hook:** `.claude/hooks/wait-guard.py` denies the costly
  patterns as they happen. It blocks `sleep`-then-`tail` poll turns,
  `pgrep -f` waiters, and subagents running whole-tree builds or full
  suites, and every denial says what to do instead. It is opt-in.
  - **Install or update** with
    `python3 .claude/hooks/install-hooks.py --user` (all your sessions) or
    `--project-local` (this checkout only). It edits only its own entry,
    keeps a `.bak` of the settings file, and changes nothing when run again.
  - **Check for a stale copy** with `--check`, which exits 1 when the
    installed hook is out of date. `--uninstall` removes it. The installed
    hook also tells you itself, once per session, when the checkout you
    work in has a newer `HOOK_VERSION`.
  - **Changing the hook:** bump `HOOK_VERSION` in `wait-guard.py` with any
    change to a rule or message, and say in the PR to re-run the
    installer.
  - **Scope:** the hook acts only in checkouts that contain
    `scripts/agent-job`.

Whether each of these helps is measured, with a rule for keeping or removing
it, in `evals/build-waiting/README.md`.

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
2. **Kernel wasm + host + rootfs + musl sysroot** — `./run.sh setup`
   checks both musl sysroots, rebuilding missing, stale, or altered core
   outputs and refreshing the graphics archives, then builds the
   kernel, every package, and the rootfs, producing
   `local-binaries/source-only-v1/kernel.wasm` (the binary resolver prefers
   the published tree over `binaries/`) and `host/wasm/rootfs.vfs.zst`.
   The default rootfs records lazy-file sizes from that same published
   tree, including the programs' ABI-contract stamps:
   ```bash
   scripts/dev-shell.sh ./run.sh setup
   ```
   To check just the wasm32 core SDK after editing libc inputs:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh --ensure --core-only
   ```
3. **Node dependencies** — `node_modules` are per-checkout, and both the repo
   root (the conformance runners load `tsx` from root) and `host/` are needed.
   `./run.sh setup` and `./run.sh local-build` already run the root `npm ci`
   when root `node_modules/` is missing or out of sync with
   `package-lock.json` (sealed package builds such as rootfs and shell run
   `node_modules/tsx` but never install it themselves); `host/` is separate:
   ```bash
   npm ci            # root — provides tsx used by run-sortix/posix/libc-tests.sh
   (cd host && npm ci)
   ```
4. **Package artifacts the suites load** — the MariaDB and Perl VFS images, the
   program `.wasm` files, and the browser VFS products. `./run.sh setup` builds
   all of them from source into `local-binaries/`; there is no separate fetch
   step. (`scripts/fetch-binaries.sh` was deleted when binary resolution became
   local-first; do not look for it. A single package can be resolved on demand
   with `cargo xtask build-deps resolve <name>`, which prefers the per-user
   cache and falls back to a source build.)
5. **Program and test-fixture binaries** under `local-binaries/programs/` and
   `local-binaries/test-fixtures/` — `scripts/build-programs.sh` emits these,
   and several Vitest cases load them directly. The `exact-abi-source` suite,
   for one, reads these program fixtures:
   `local-binaries/programs/wasm32/{exec-child,vfork-lifecycle}.wasm` and
   `local-binaries/test-fixtures/wasm32/login.wasm`. Without them
   `exec-state-tracking`, `spawn-*`, `vfork-production-mechanism`, and
   `demo-login-image` fail with `ENOENT`/`existsSync === false` that has nothing
   to do with your change. The same script builds `hello64.wasm`, the LP64
   program the `wasm64` cases need and that `./run.sh setup` does not build:
   ```bash
   scripts/dev-shell.sh bash scripts/build-programs.sh
   ```
   `./run.sh setup` already builds the wasm64 sysroot (its bootstrap step plan
   runs `sysroot64` unconditionally, alongside the wasm32 `sysroot`). If the
   wasm64 sysroot needs checking separately from setup:
   ```bash
   scripts/dev-shell.sh bash scripts/build-musl.sh --ensure --core-only --arch wasm64posix
   ```

After that the full suites run. Do **not** report "I can't run Vitest / the
conformance suites / the browser" because a fresh worktree lacks artifacts —
build or fetch them with the steps above, then run the suite and report the real
result. If a suite genuinely cannot run (no network for a package source
download, no display for browser tests, etc.), name the exact step that failed
and why; that is different from validation being impossible.

Sortix's upstream suite contains filenames that differ only by case, such
as `PRIX16.c` and `PRIx16.c`. On a case-insensitive filesystem, a checkout
can overwrite one with the other and appear dirty immediately. Use a
pristine checkout at the pinned submodule commit on a case-sensitive
volume, and run the normal suite with that source root:

```bash
scripts/dev-shell.sh env KANDELO_SORTIX_SOURCE_ROOT=/absolute/os-test \
  bash scripts/ci-run-test-suite.sh sortix
```

The runner keeps its build directory below the selected source root;
SDK, kernel, overrides, and runtime still come from the current worktree.

Before blaming a suite failure on your change, confirm it actually is your
change: a few package/demo tests (e.g. the Erlang `ring` benchmark) can fail for
environment or artifact reasons unrelated to a given diff. Reproduce the failure
on a pristine `origin/main` build of the same artifact before attributing it —
rebuild just the kernel wasm (`cargo build --release -p kandelo -Z
build-std=core,alloc && cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm
local-binaries/kernel.wasm`) at `origin/main` and re-run the one test. Report a
pre-existing failure as pre-existing, not as your regression.

After editing kernel Rust, rebuild the kernel wasm (`./run.sh setup`) before the
Vitest/conformance suites — they load `local-binaries/kernel.wasm`, so a stale
wasm silently runs your OLD kernel code. Setup also checks musl freshness;
after editing libc inputs, rebuild linked programs and fixtures through the
normal setup/program paths. (`bash build.sh` still works as a deprecated
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
