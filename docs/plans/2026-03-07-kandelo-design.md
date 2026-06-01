# Kandelo — Design Document

## Goal

A POSIX-compliant kernel for WebAssembly that provides syscall interfaces to guest Wasm programs, runs in both Node.js and browser environments, and offers clear tradeoff choices where full POSIX compliance requires environmental support (e.g., SharedArrayBuffer for blocking syscalls).

## Architecture

Three layers:

- **Kernel-space** (Rust→Wasm): Runs in a coordinator worker (or main thread). Owns shared state — process table, fd tables, lock state. Receives syscall requests over SharedArrayBuffer channels.
- **User-space** (Rust→Wasm): Linked into each guest worker. Provides the POSIX C API surface. Handles local operations without kernel round-trips. Proxies coordinated operations to kernel-space.
- **Host glue** (TypeScript): Instantiates workers, sets up SharedArrayBuffer channels, provides platform I/O backends (Node.js `fs`, browser OPFS, etc.).

## Communication

Two paths, selectable per environment:

1. **Primary: SharedArrayBuffer + Atomics.wait/notify** — synchronous blocking from guest perspective. Requires cross-origin isolation in browsers.
2. **Fallback: postMessage + Asyncify** — guest yields via Asyncify while awaiting response. No SharedArrayBuffer needed.

### Syscall Channel Layout (per worker, in SharedArrayBuffer)

| Offset | Size | Field |
|--------|------|-------|
| 0..3 | 4B | Status (IDLE=0 / PENDING=1 / COMPLETE=2 / ERROR=3) |
| 4..7 | 4B | Syscall number |
| 8..31 | 24B | Arguments (6 x i32) |
| 32..35 | 4B | Return value |
| 36..39 | 4B | errno |
| 40..N | variable | Data transfer buffer |

## Tech Stack

- **Rust** targeting `wasm32-unknown-unknown` (no wasm-bindgen), raw `extern "C"` + `#[no_mangle]` exports
- **Cargo workspace** with crates: `kernel`, `userspace`, `shared` (types/constants)
- **TypeScript** host glue with `tsup` for dual ESM/CJS output
- **Vitest** for TypeScript integration tests
- **Rust unit tests** for kernel/userspace logic

## Initial Scope

File descriptor subsystem: `open`, `close`, `read`, `write`, `lseek`, `dup`, `dup2`, `pipe`, `fstat`, `fcntl` (F_DUPFD, F_DUPFD_CLOEXEC, F_GETFD, F_SETFD, F_GETFL, F_SETFL).
