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

5. **Browser demo verification**: When fixing browser demo bugs, run `./run.sh browser` and manually verify the fix in a browser before claiming it works. Code reasoning alone is not sufficient — browser timing, service workers, and Wasm behavior must be observed.

## Performance Benchmarks

Run benchmarks to measure kernel performance across Node.js and browser hosts:

```bash
# Run all Node.js benchmarks (3 rounds each)
npx tsx benchmarks/run.ts

# Run specific suite
npx tsx benchmarks/run.ts --suite syscall-io

# Run browser benchmarks via Playwright
npx tsx benchmarks/run.ts --host browser

# Compare two results
npx tsx benchmarks/compare.ts benchmarks/results/before.json benchmarks/results/after.json
```

Results are saved as JSON in `benchmarks/results/`. Available suites: `syscall-io`, `process-lifecycle`, `erlang-ring`, `wordpress`, `mariadb`.

Some suites require pre-built binaries (Erlang, PHP/WordPress, MariaDB) and will skip gracefully if not found. The `syscall-io` and `process-lifecycle` suites only need the base sysroot and benchmark programs (`scripts/build-programs.sh`).

## Architecture

Centralized kernel mode only. One kernel Wasm instance serves all process workers via channel IPC (SharedArrayBuffer + Atomics). Programs are compiled with `channel_syscall.c`.

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
