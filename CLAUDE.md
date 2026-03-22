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

## Architecture

Centralized kernel mode only. One kernel Wasm instance serves all process workers via channel IPC (SharedArrayBuffer + Atomics). Programs are compiled with `channel_syscall.c`.

## Build

```bash
bash build.sh          # Build kernel wasm + musl sysroot
scripts/build-programs.sh  # Build test/example C programs
```

## Key Directories

- `crates/kernel/` — Rust kernel (no_std on wasm32)
- `host/src/` — TypeScript host runtime
- `host/test/` — Vitest integration tests
- `glue/channel_syscall.c` — Syscall glue compiled into every user program
- `scripts/` — Build and test scripts
