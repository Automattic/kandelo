# dash + GNU coreutils — Design

## Goal

A working POSIX shell (dash) with GNU coreutils running on wasm-posix-kernel,
providing an interactive terminal experience where the shell forks and execs
real separate .wasm binaries for each command.

## Prerequisites

### exec implementation

Currently stubbed (ENOSYS). Needs:

1. **Kernel argv/envp passing**: `sys_execve` currently only reads the path
   pointer (args[0]). Must also read argv (args[1]) and envp (args[2]) from
   process memory and store them in the process state for the new program.

2. **Host onExec callback**: Must actually load a new .wasm binary:
   - Resolve path (with PATH search for bare commands)
   - Terminate the old worker
   - Create fresh WebAssembly.Memory
   - Create new worker with the new binary + preserved argv/envp
   - Re-register the channel with the kernel
   - `kernel_exec_setup` already handles CLOEXEC fd filtering and signal reset

3. **Program registry**: serve.ts provides a mapping from filesystem paths
   to .wasm binary bytes (e.g., `/bin/ls` → `coreutils-ls.wasm`).

### Exec flow in centralized mode

```
Shell (fork child)                   Kernel Worker                Host (onExec)
    │                                    │                            │
    ├─ execve("/bin/ls", argv, envp) ──►│                            │
    │                                    ├─ kernel_exec_setup(pid) ──►│
    │                                    │   (CLOEXEC, signal reset)  │
    │                                    │                            │
    │                                    ├─ onExec(pid, path) ──────►│
    │                                    │                            ├─ resolve path
    │                                    │                            ├─ load .wasm bytes
    │                                    │                            ├─ terminate old worker
    │                                    │                            ├─ create fresh Memory
    │                                    │                            ├─ create new worker
    │                                    │                            ├─ re-register channel
    │                                    │                            │
    │  (new program starts from _start)  │                            │
```

## Build targets

### dash 0.5.12

- Source: https://git.kernel.org/pub/scm/utils/dash/dash.git
- ~15K lines of C, autoconf build
- Minimal dependencies (libc only)
- Key POSIX features: fork, exec, pipe, dup2, signal, wait, setpgid
- Build: `wasm32posix-configure && make`
- Output: `examples/libs/dash/dash.wasm`

### GNU coreutils 9.5

- Source: https://ftp.gnu.org/gnu/coreutils/
- autoconf + gnulib build system
- Start with essential utilities (~25):
  cat, ls, echo, mkdir, rm, cp, mv, head, tail, wc, sort, uniq,
  grep, sed, tr, test, printf, env, basename, dirname, true, false,
  chmod, touch, date
- Each utility → separate .wasm binary in `examples/libs/coreutils/bin/`

### grep and sed

GNU coreutils doesn't include grep or sed (they're separate GNU packages).
Options:
- Build GNU grep and GNU sed separately
- Or rely on dash builtins + BusyBox-style minimal implementations
- Recommendation: build GNU grep 3.11 and GNU sed 4.9 as separate targets

## Filesystem layout (inside kernel)

```
/bin/sh          → dash.wasm
/bin/cat         → coreutils/cat.wasm
/bin/ls          → coreutils/ls.wasm
/bin/grep        → grep.wasm
/bin/sed         → sed.wasm
/usr/bin/env     → coreutils/env.wasm
...
```

The serve.ts pre-loads all .wasm binaries and provides them to `onExec`
via a path→bytes map.

## Interactive shell (serve.ts)

`examples/shell/serve.ts`:
- Boots kernel with dash as pid 1
- Bridges host stdin/stdout for interactive terminal
- Pre-loads all utility .wasm binaries
- Implements onExec with PATH search and binary lookup
- Implements onFork for child process creation

## Implementation order

1. **PR: exec support** — kernel argv/envp + host onExec implementation
2. **PR: dash** — build script + basic shell test
3. **PR: coreutils** — build script + interactive shell serve.ts
4. **PR: grep + sed** — separate builds for these key utilities

## run.sh integration

```
./run.sh build dash          # Build dash shell
./run.sh build coreutils     # Build GNU coreutils
./run.sh run shell           # Interactive shell with all utilities
```
