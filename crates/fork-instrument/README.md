# fork-instrument

Compile-time instrumentation for POSIX `fork()` support in wasm
binaries.

Reads a wasm binary. Identifies every function on the transitive call
path to a named async import (by default `kernel.kernel_fork`). Rewrites
those functions with save/restore machinery so the kernel's host code
can unwind the wasm call stack to linear memory, create a child wasm
instance, copy memory, and rewind the child back to the `fork()` call
site.

Replaces our prior use of Binaryen's `--asyncify` pass. Designed to
handle new-EH (`try_table`) output, `call_indirect` on fork paths, and
`fork()` from inside C++ catch handlers — all cases where Asyncify
falls short in our setup.

See [`docs/fork-instrumentation.md`](../../docs/fork-instrumentation.md)
for the current design, ABI, save-buffer layout, and operating limits.

## CLI

```sh
wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
```

## Status

PR #307 (`fierce-wire`) replaces the old Binaryen Asyncify fork path in the
build scripts. The tool instruments direct + indirect fork-path callers,
spills scalar and supported ref-typed locals, survives modern `try_table`
catch-handler rewind, and preserves module validity. Remaining unsupported
patterns are documented in `docs/fork-instrumentation.md`.

## Build

The repo default Cargo target is `wasm32-unknown-unknown`, which is correct
for the kernel but wrong for this host-side CLI. Build it for the host
triple:

```sh
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo build -p fork-instrument --release --target "$HOST_TARGET"
```

Binary: `target/$HOST_TARGET/release/wasm-fork-instrument`.

From the repo root, `scripts/build-fork-instrument-tool.sh` does this and
installs the result to `tools/bin/wasm-fork-instrument`.

## Tests

```sh
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo test -p fork-instrument --target "$HOST_TARGET"
```

## Fuzzing (Phase 6 gate)

Phase 6 catch-handler resume is validated against a random-WAT fuzzer with a dual walrus + wasmparser oracle. Per design §5.4, ≥10 000 iterations must complete with zero validator failures before Phase 6 is declared shippable.

Prerequisites: `cargo install cargo-fuzz` (one-time; requires nightly, which `rust-toolchain.toml` already pins).

Short invocation (from the repo root):

```sh
scripts/run-fork-instrument-fuzz.sh
```

Override iteration count or input size:

```sh
FUZZ_RUNS=50000 FUZZ_MAX_LEN=256 scripts/run-fork-instrument-fuzz.sh
```

Direct invocation from this crate:

```sh
cargo fuzz run --sanitizer=none fuzz_try_table -- -runs=10000 -max_len=128
```

`--sanitizer=none` is required: on macOS arm64, cargo-fuzz's default AddressSanitizer deadlocks during init. libFuzzer's coverage instrumentation is orthogonal, so mutation is still coverage-guided. Semantic/validator divergence is what we're fuzzing for here, not memory-safety bugs — ASAN is not load-bearing.

Findings land in `fuzz/artifacts/fuzz_try_table/`. Decode with `cargo fuzz fmt fuzz_try_table <artifact>` to see the `WatProgram` struct that triggered the finding. Any finding MUST be converted into a unit-level fixture in `tests/instrument.rs` before being closed.
