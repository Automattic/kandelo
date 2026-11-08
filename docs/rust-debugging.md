# Debugging Rust programs

Compile with Cargo's development profile and `debug = 2`. Kandelo's Rust
compiler entry point preserves function names and prepares an instruction
map alongside executable code. Release optimization and inlining can remove
source locations; an absent location is reported as unmapped.

## Node source debugger

From a development checkout with the normal SDK, kernel and rootfs built:

```sh
scripts/dev-shell.sh npx tsx scripts/debug-rust.ts \
  path/to/program.wasm --break src/main.rs:12 -- argument
```

The debugger starts an ephemeral Kandelo machine with the normal rootfs.
`--image IMAGE.vfs` and `--kernel KERNEL.wasm` select explicit artifacts.
Explicit raw VFS images use positioned file reads.
The program executes in an ordinary process worker, with a dedicated kernel
worker. The debugger uses a local Node inspector session and opens no
listening port. Its stdin belongs to the debugger; the guest receives EOF.
Guest stdout remains stdout, while debugger messages and guest stderr use
stderr. `RUST_BACKTRACE` defaults to `1`; set it in the command environment
to choose another value.

At a source breakpoint, these commands are available:

| Command | Behavior |
| --- | --- |
| `next` / `n` | Step over calls until the source location changes. |
| `where` / `bt` | Print the current stack with available names and locations. |
| `continue` / `c` | Resume until another breakpoint or program exit. |
| `quit` / `q` | Close the debugger, retire the machine, and exit with status 130. |

`--commands next,where,continue` supplies commands without a terminal. When
that list ends, execution continues at subsequent stops. The command returns
the guest exit status, or fails if the requested breakpoint was never hit.

A relative filename must uniquely match the end of a recorded source path.
For example, `src/main.rs` is ambiguous when several crates contain that
path; use a longer suffix or the exact path printed in diagnostics. Files
are identified from the prepared module's map. The debugger does not read
source files based on those names, and it verifies the complete executing
module's SHA-256 before interpreting its instruction offsets. Files without
matching executable mappings cannot receive source breakpoints.

Stepping is bounded to 4096 instructions per command. An exhausted budget
fails visibly and tears down the debugging machine. A breakpoint query is limited to 4096 mapped locations,
and input modules to 256 MiB. This command provides
source locations and a call stack; inspecting Rust locals and evaluating
Rust expressions are not implemented.

## Browser debugging

Start the local development server with `./run.sh browser`, then pass the
URL it prints to the Chromium command:

```sh
scripts/dev-shell.sh npx tsx scripts/debug-rust-browser.ts \
  path/to/program.wasm --url http://127.0.0.1:5173/ \
  --break src/main.rs:12 -- argument
```

The command launches its own headless Chromium machine. It uses the same
`next`, `where`, `continue`, `quit` and scripted commands as the Node debugger.
It accepts `--image` and `--kernel`; an explicit raw image streams to a
private OPFS file and boots through positioned reads. That temporary file
and the debugging machine are removed when the session closes.
Guest stdout and debugger stdin behave as in the Node command. Browser audio
output is quiet by default; `KANDELO_PLAYWRIGHT_AUDIBLE_AUDIO=1` opts in.

This is a local development command using Chromium's debugging protocol.
It does not attach to existing browser tabs. Firefox and WebKit interactive
source stepping are not implemented. Ordinary backtrace support and its
engine limits are described in [the Rust target guide](rust-target.md).

## Coverage inside Kandelo

The guest Rust SDK includes the compiler's matching profiler runtime,
`llvm-profdata` and `llvm-cov`. In a guest project, build with coverage
instrumentation, then run the executable and merge its real profile files:

```sh
mkdir coverage-run-1
RUSTFLAGS="-C instrument-coverage" cargo build --offline -j1
LLVM_PROFILE_FILE="coverage-run-1/%p.profraw" target/debug/my_program.wasm
llvm-profdata merge -sparse coverage-run-1/*.profraw -o coverage-run-1/merged.profdata
llvm-cov show target/debug/my_program.wasm --instr-profile=coverage-run-1/merged.profdata
llvm-cov export target/debug/my_program.wasm --instr-profile=coverage-run-1/merged.profdata
llvm-cov show target/debug/my_program.wasm --instr-profile=coverage-run-1/merged.profdata \
  --format=html --output-dir=coverage-run-1/html
```

Replace `my_program` with the Cargo binary's name. Keep the source files
available at their recorded guest paths for text and HTML source display.
Use a fresh output directory for each run; `%p` separates parent and child
processes within that run, while process IDs can be reused after a reboot.
These commands use the installed guest SDK.

To collect unit-test profiles, set both variables on the test command:

```sh
RUSTFLAGS="-C instrument-coverage" LLVM_PROFILE_FILE="coverage-run-1/%p.profraw" \
  cargo test --offline -j1 -- --test-threads=1
```

Report against the test executable returned by
`cargo test --no-run --message-format=json`, rather than the ordinary
application executable. Keep its coverage build flags the same. Profile
updates are not atomic by default; the acceptance fixture synchronizes the
function whose exact threaded call count it checks. Automatic atomic
updates remain unvalidated. Aborting panics and forced termination may
leave no profile; crash-profile recovery is not implemented.

The checked-in acceptance builds an ordinary offline Cargo project and
checks branch counts, separate parent/child profiles, 400 synchronized
calls, both unit tests, source text and HTML. It also requires malformed
profiles and incompatible raw-profile versions to fail. The same workflow
passes on Node, Chromium, Firefox and WebKit using LLVM 22.1.2 reporters
matched to the SDK compiler.

## Clean-build acceptance

The on-demand [Rust development workflow](../.github/workflows/rust-development.yml)
starts with empty Kandelo source and binary caches, builds a partial Rust
shell through the normal resolver, and runs the Node and three-browser
development checks. Select a Linux runner with enough disk for building
LLVM, Clang and Rust; a preinstalled Kandelo cache is not an input. The
pinned Nix toolchain still uses its normal binary cache.

For a prepared local checkout, the same strict checks accept explicit
standalone SDK and native-fixture archives:

```sh
scripts/dev-shell.sh bash scripts/check-rust-development.sh node SDK.zip NATIVE-FIXTURES.zip
scripts/dev-shell.sh bash scripts/check-rust-development.sh browser SDK.zip NATIVE-FIXTURES.zip
```

Build the partial shell with Cargo, rustc, kandelo-rustc,
kandelo-sdk-browser-bundle, wasm-fork-instrument,
rust-profiler-runtime-bundle, rust-coverage-tools, rust-docs and
mandoc-browser-bundle first. Resolve `kandelo-rust-sdk` and
`rust-native-fixtures` through the normal package resolver for the two
archive arguments. The check refuses missing tools, libtest or the profiler
runtime and records the archive hashes with its test reports. Interactive
browser-debugger checks select Chromium, whose debugging protocol the
command uses.
