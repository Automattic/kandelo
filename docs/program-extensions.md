# Required program extensions

The supported ABI-56 base program snapshot and digest remain unchanged.
New independently versioned interfaces use reserved Wasm import modules
beginning with `kandelo.`. An import is a **required interface declaration**;
it is not advisory metadata that a host may ignore. Old base programs import
none of these interfaces. This mechanism does not relax base ABI admission.

`crates/program-abi/src/program_extensions.rs` owns the declarations.
`cargo xtask program-extensions` generates the extension manifest
`abi/program-extensions.json`, host constants, Rust standard-library wire
constants/import declaration, and combined SDK linker allowance. `--check`
verifies those generated files; `xtask dump-abi --check` includes this check.
Keep the module version's signature, wire fields and meanings immutable.
An incompatible interface requires a new module version; regenerating the
manifest does not make an incompatible change to an existing version valid.

Native artifact admission and the shared host policy reject unknown reserved
modules, unsupported versions, unknown names, wrong import kinds, missing or
multiple process memories, and mismatched function signatures. Dynamic loading
also checks the namespaces the actual process worker supplies before
instantiating the module. Tests include a host with no extension support:
ordinary base programs are admitted, while a program requiring stack capture
is refused. The SDK linker checks the same declarations; a symbol allowance
alone cannot turn an ordinary `env` import into a versioned interface.

## Stack capture version 1

Module `kandelo.stack.v1` supplies `__kandelo_stack_capture_v1`:

```text
(buffer: pointer, capacity: i32, maximum_frames: i32) -> i32
```

The pointer is i32 for memory32 and i64 for memory64. Capacity and maximum
frames are unsigned 32-bit values. Capture is synchronous in the executing
process/thread worker. It writes at most the caller's capacity and returns
the positive packet byte length. Errors are fixed negative values, without
changing guest `errno`: invalid arguments or metadata `-22`, invalid guest
address `-14`, and capacity below the 48-byte header `-105`. Invalid input
does not write the guest buffer. Capacity is at most 65,536 bytes; frame
requests are 1–128. A packet that cannot hold more complete frames reports
truncation. Capturing does not unwind, resume, or alter guest frames.

All integers are little-endian. The packet header is 48 bytes:

| Offset | Type | Meaning |
|---|---|---|
| 0 | u32 | Four bytes `KSTK` |
| 4 | u16 | Version 1 |
| 6 | u16 | Flags: truncated 1, module unresolved 2 |
| 8 | u32 | Frame count |
| 12 | u32 | Complete packet byte length |
| 16 | 32 bytes | SHA-256 of the exact loaded main program, or zero if ambiguous |

Each frame has a 32-byte header followed immediately by name bytes and source
path bytes, with no padding:

| Offset | Type | Meaning |
|---|---|---|
| 0 | u32 | VM function index |
| 4 | u32 | Flags: has PC 1, has name 2, has source 4, module known 8 |
| 8 | u64 | Absolute Wasm module instruction offset, or zero if unavailable |
| 16 | u32 | One-based source line, or zero |
| 20 | u32 | One-based source column, or zero |
| 24 | u32 | UTF-8 name length, at most 4,096 bytes |
| 28 | u32 | UTF-8 source path length, at most 16,384 bytes |

Names come from the exact module's name section when its identity is known,
otherwise from the engine's observed frame text. Source lookup requires an
actual instruction offset within that exact function body and a matching
code-bound `kandelo.debug.lines` map. A code offset is not a linear-memory
address or a function-table index. Missing offsets, names and source locations
remain missing; consumers must not invent substitute addresses or paths.

The worker builds that metadata from the program bytes on the first capture.
A process worker therefore keeps its program bytes for the process's
lifetime when the main module imports `kandelo.stack.v1`; every other
process releases them before it reports ready. Rust's standard library
imports this module, so every Rust process keeps them.

The worker captures actual VM frames, excluding JavaScript frames. Native
stack formats and depth limits differ across engines. If an engine supplies
function indices without offsets, function names remain usable but lines
cannot be resolved. The host marks identity unresolved while a side module is
being instantiated or any guest side library is live; it does not assign the
main program's source map to another module's frame. A per-frame module-known
flag governs whether the header digest applies to that frame.

The Rust backend validates the complete packet and owns each frame's metadata.
Symbol lookup uses that owned frame, not a process-global last-capture cache;
bare-address lookup has no owning module and remains unresolved. Formatting
retains named frames when a native engine omits the PC. Source filenames are
diagnostic strings only: no source file is opened or fetched by capture or
resolution. Worker memory and guest views are neither transferred to a
persistent browser realm nor retained across an asynchronous operation.

## Kernel log version 1

Module `kandelo.klog.v1` supplies `__kandelo_klogctl_v1`:

```text
(buffer: pointer, capacity: i32, action: i32) -> i32
```

It is `klogctl(action, buffer, capacity)` over the kernel message ring, with
the arguments reordered to the `(pointer, i32, i32)` shape every extension
uses. musl's `klogctl()` is replaced in the overlay
(`libc/musl-overlay/src/linux/klogctl.c`) to call it, so a program imports
the interface only if it links `klogctl()`; every other program keeps its
base identity. A non-negative return is `klogctl`'s result. An error is a
negative errno (`-22` invalid action, length or missing buffer, `-1` a
clear by a non-root caller, `-14` an unusable buffer), and the libc wrapper
turns it into `-1` with `errno` set. Actions 2–5, 9 and 10 are served.
Every other action is refused with `-22`, including the console-level
actions 6–8, because Kandelo has no console log level. The read actions render
`<pri>[seconds.microseconds] text` lines.

**Why an extension.** musl issues `SYS_syslog` (304), which the frozen
base program surface does not declare. Declaring it would add a syscall
number, a buffer descriptor and a scalar contract to that surface and so
change the digest every supported program carries. The kernel therefore
answers 304 with `ENOSYS`, and a program that needs the ring says so
through this import. A host that cannot serve it refuses the program
instead of handing it an empty answer.

**How the call reaches the kernel.** The ring is kernel state, so the
process worker serves the import by issuing kernel-host request
`extension_requests::KLOG_V1` (600) on the calling thread's own channel.
The kernel stages the buffer through that request's descriptor in
`host_abi::EXTENSION_REQUEST_DESCRIPTORS`, the same way it stages a
syscall's, so no log bytes pass through host code. The request number
and descriptor are kernel-host surface (`extension_requests` in
`abi/snapshot.json`), versioned by `HOST_ADAPTER_VERSION`, not by the
program digest. They are reachable only through this import: no
program's libc marshals 600.

See [optional source-line maps](fork-instrumentation.md#optional-source-line-maps)
and the [Rust debugging workflow](rust-target.md#source-diagnostics-and-backtraces).
