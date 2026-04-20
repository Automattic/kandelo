# wasm-posix-kernel

## Test Verification

**ALL of these must pass before claiming "tests pass" or completing any branch:**

1. **Cargo tests** (kernel unit tests):
   ```bash
   cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
   ```
   Expected: 539+ tests pass, 0 failures.

2. **Vitest** (host integration tests):
   ```bash
   cd host && npx vitest run
   ```
   Expected: all test files pass (PHP tests skip if binary not built).

3. **musl libc-test suite** (C standard library conformance):
   ```bash
   scripts/run-libc-tests.sh
   ```
   Expected: 0 unexpected failures. `XFAIL` (expected failures) and `TIME` (timeouts) are acceptable. Any `FAIL` that is not `XFAIL` is a regression.

4. **Open POSIX Test Suite** (POSIX API conformance):
   ```bash
   scripts/run-posix-tests.sh
   ```
   Expected: 0 `FAIL` results. `UNRES` (unresolved) and `SKIP` are acceptable.

**Do not skip suites 3 and 4.** They catch regressions that unit tests miss — syscall behavior changes, ABI issues, and POSIX compliance problems only surface when running real C programs against the kernel.

5. **ABI snapshot check**:
   ```bash
   bash scripts/check-abi-version.sh
   ```
   Expected: exit 0. Rebuilds the kernel wasm, regenerates the structural snapshot (covering channel layout, syscall numbers, marshalled structs, and kernel-wasm exports), and fails if `abi/snapshot.json` drifts from source, or if the snapshot changed vs `origin/main` without a matching `ABI_VERSION` bump in `crates/shared/src/lib.rs`. See [docs/abi-versioning.md](docs/abi-versioning.md).

6. **Browser demo verification**: When fixing browser demo bugs, run `./run.sh browser` and manually verify the fix in a browser before claiming it works. Code reasoning alone is not sufficient — browser timing, service workers, and Wasm behavior must be observed.

## Kernel ABI stability — DO NOT change without bumping `ABI_VERSION`

The kernel's binary interface to user programs is load-bearing: any silent change can corrupt memory in any binary compiled against an older kernel. **Every change to the following requires bumping `ABI_VERSION` in `crates/shared/src/lib.rs` and regenerating `abi/snapshot.json` in the same commit:**

- Channel header layout (`shared::channel::*`), channel data buffer, signal-delivery area.
- Syscall numbers (additions, removals, renames).
- Marshalled `repr(C)` structs (`WasmStat`, `WasmDirent`, `WasmFlock`, `WasmTimespec`, `WasmPollFd`, `WasmStatfs`).
- Asyncify save slots (`shared::abi::ASYNCIFY_SAVE_SLOTS`).
- `shared::abi::*` constants (custom section name, process-expected globals, export filter lists).
- Kernel-wasm exports (any `kernel_*` function signature change, global type/mutability change, or new/removed export that isn't on the toolchain denylist).

**Workflow when you've changed something that might be ABI-affecting:**

```bash
bash scripts/check-abi-version.sh update   # regenerate abi/snapshot.json
git diff abi/snapshot.json                 # inspect — is this actually an ABI change?
# If yes: bump ABI_VERSION in crates/shared/src/lib.rs and commit both files together.
bash scripts/check-abi-version.sh          # verify
```

The script is also run as step 5 of the test suite above. CI refuses to merge a change where the snapshot drifts without a version bump. See [docs/abi-versioning.md](docs/abi-versioning.md) for full policy, including what the structural check does *not* catch (e.g., semantic changes that don't shift offsets — reviewers must flag those).

## Performance Benchmarks

**When doing performance work, run ALL 5 suites on BOTH hosts (Node.js and browser).** Do not run only `syscall-io` or only one host — application-level suites exercise different syscall patterns, threading models, and I/O workloads that micro-benchmarks miss. If a suite skips because its binary is missing, build it before drawing conclusions.

### The 5 benchmark suites

| Suite | What it measures | Binary prerequisites |
|-------|-----------------|---------------------|
| `syscall-io` | Pipe/file throughput, syscall latency | `scripts/build-programs.sh` |
| `process-lifecycle` | fork, exec, clone, cold start | `scripts/build-programs.sh` |
| `erlang-ring` | BEAM VM message passing (1000 processes) | `bash examples/libs/erlang/build-erlang.sh` |
| `wordpress` | PHP CLI + WordPress HTTP first response | `bash examples/libs/php/build-php.sh` + WordPress checkout |
| `mariadb` | SQL bootstrap + query performance | `bash examples/libs/mariadb/build-mariadb.sh` |

Application suites require the SDK: `cd sdk && npm link`

### Running benchmarks

```bash
# All suites, Node.js host (3 rounds each, reports median)
npx tsx benchmarks/run.ts --rounds=3

# All suites, browser host (via Playwright)
npx tsx benchmarks/run.ts --host=browser --rounds=3

# Single suite (only when specifically asked)
npx tsx benchmarks/run.ts --suite=syscall-io

# Compare before/after
npx tsx benchmarks/compare.ts benchmarks/results/before.json benchmarks/results/after.json
```

Results are saved as JSON in `benchmarks/results/`. See [docs/profiling.md](docs/profiling.md) for detailed suite descriptions, metrics, and build prerequisites.

## Architecture

Centralized kernel mode only. One kernel Wasm instance serves all process workers via channel IPC (SharedArrayBuffer + Atomics). Programs are compiled with `channel_syscall.c`.

**The kernel MUST run in a dedicated worker thread on ALL platforms** — `worker_thread` on Node.js, Web Worker in browsers. Never instantiate `CentralizedKernelWorker` on the main thread. The main thread should only be a thin proxy for setup and I/O routing. Running the kernel on the main thread degrades syscall throughput by 3-4x due to event loop overhead.

See [docs/architecture.md](docs/architecture.md) for full architecture details.

## Performance: Do NOT Micro-Optimize the Syscall Hot Path

**Do not add "optimization" tables or shortcut logic to `kernel-worker.ts`.** Specifically, do not:

- Add syscall argument count tables to skip reading unused args (e.g., `SYSCALL_ARG_COUNTS`)
- Add syscall classification sets to conditionally skip post-syscall work (e.g., `IO_SYSCALLS` to skip `drainAndProcessWakeupEvents`)
- Cache `DataView` or `Int32Array` objects on channel structs to avoid re-creation
- Skip debug ring logging for "trivial" syscalls

These optimizations were benchmarked and **made performance worse across all application workloads** (WordPress, Erlang, MariaDB). The per-syscall overhead of `new DataView()`, reading 6 BigInt args, and unconditionally draining wakeup events is negligible compared to the actual Wasm kernel execution. The "optimizations" add branch misprediction overhead, risk correctness bugs (wrong syscall numbers → zeroed args → broken networking), and make the code harder to maintain.

The real performance lever is the **dedicated worker thread architecture** (`NodeKernelHost` / `BrowserKernel`), which provides 2x pipe throughput and 2.5x clone speed. Keep `kernel-worker.ts` simple and correct.

## Build

```bash
bash build.sh          # Build kernel wasm + musl sysroot
scripts/build-programs.sh  # Build test/example C programs
```

## Cross-Compilation and Configure Scripts

We cross-compile C libraries for wasm32 using `wasm32posix-cc`. Autoconf `configure` scripts often run feature-detection checks (e.g., `AC_CHECK_FUNCS`) that test against the **host** system's libraries rather than the wasm sysroot. This produces incorrect results — functions like `feenableexcept` may exist on macOS/Linux but not in our musl-based wasm sysroot.

When writing build scripts that call `configure`, explicitly override any checks for functions not available in the wasm sysroot using autoconf cache variables:

```bash
ac_cv_func_feenableexcept=no \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-none \
    CC=wasm32posix-cc \
    ...
```

Do not rely on configure's auto-detection when cross-compiling. If a build fails due to missing functions, check whether configure incorrectly detected a host-only feature and add the appropriate `ac_cv_*=no` override.

## Documentation

Every PR that adds or changes user-facing features, APIs, or behavior must include corresponding documentation updates. Check these locations:

- **`docs/architecture.md`** — Update when changing kernel design, host runtime, VFS, networking, or process model
- **`docs/posix-status.md`** — Update when adding, completing, or changing syscall implementations
- **`docs/sdk-guide.md`** — Update when changing SDK tools or compilation workflow
- **`docs/porting-guide.md`** — Update when changing how software is ported or run
- **`docs/browser-support.md`** — Update when changing browser capabilities or limitations
- **`README.md`** — Update when adding major features, new ported software, or changing project structure

Do not skip documentation. If a feature is worth implementing, it is worth documenting.

## Key Directories

- `crates/kernel/` — Rust kernel (no_std on wasm32)
- `host/src/` — TypeScript host runtime
- `host/test/` — Vitest integration tests
- `glue/channel_syscall.c` — Syscall glue compiled into every user program
- `scripts/` — Build and test scripts
