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
