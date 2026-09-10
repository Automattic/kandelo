//! The co-resident WASI Preview 1 side module.
//!
//! ## Note on the `wasi-shim.ts` references throughout this crate
//!
//! Doc comments here cite `host/src/wasi-shim.ts` with line numbers. That file
//! was the TypeScript WASI implementation this crate replaced, and it was
//! DELETED when the cutover landed (K10 I6). The citations are historical
//! provenance for a ported decision, not live pointers: read the file at
//! commit `c45e73d3d`. They are kept rather than stripped because "this
//! mirrors what the old code did here, and here is exactly where" is the only
//! record of why several of these choices are shaped the way they are.
//!
//! `WasiShim` is **guest-side**: it runs in the process worker, on the guest's
//! own linear memory, and is wired as the guest's `wasi_snapshot_preview1`
//! import namespace (`host/src/worker-main.ts:3291-3341`). So its Rust home is
//! neither the kernel nor a host-side module but a co-resident wasm side
//! module in the same worker -- the `crates/fork-module` pattern.
//!
//! ## What this needs from the host, and what it does not
//!
//! It needs **no new host capability**. There is no `env.host_*` import, no
//! `HostIO` method, no new channel opcode, and no `ABI_VERSION` motion:
//! `wasi_snapshot_preview1` is a guest ABI fixed by the WASI specification and
//! appears nowhere in `abi/snapshot.json`. The module speaks the *existing*
//! syscall channel, the same one `libc/glue/channel_syscall.c` speaks for SDK
//! guests. The host's job shrinks from "implement 46 WASI functions" to
//! "instantiate one more module and pass its exports through".
//!
//! ## Placement
//!
//! The module is a PIC side module: it imports `env.memory` plus
//! `__memory_base` / `__stack_pointer` / `__table_base` and relocates itself
//! into a **host-chosen** region.
//!
//! It deliberately does NOT inherit `fork-module`'s placement recipe, which
//! reserves via a kernel `SYS_MMAP`. That works for SDK guests because they
//! route all address-space growth through the kernel; a WASI guest does not --
//! `wasi-libc` calls `memory.grow` directly and the kernel is never told. K10
//! probe 3 (`docs/plans/probes/2026-09-09-k10/`) established on Node,
//! Chromium, and WebKit that the host can place the region itself, and that
//! this is sound because `memory.grow` returns the PREVIOUS page count, so a
//! self-growing guest always lands above whatever the host already placed.
//!
//! ## Testability
//!
//! [`shim::WasiShim`] is generic over [`mem::GuestMemory`] and
//! [`channel::Channel`], so every entry point runs on the host against a byte
//! buffer and a recording fake channel. That is what `cargo test -p
//! wasi-module --features testing` exercises, and it reaches inputs a real
//! guest fixture cannot easily reach.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
// The channel handshake blocks on `memory_atomic_wait32` and wakes the kernel
// worker with `memory_atomic_notify`. Both intrinsics are still behind this
// gate (rust-lang/rust#77839); the host build compiles them out entirely.
#![cfg_attr(
    any(target_arch = "wasm32", target_arch = "wasm64"),
    feature(stdarch_wasm_atomic_wait)
)]

pub mod channel;
pub mod mem;
pub mod preopen;
pub mod shim;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod exports;

pub use shim::{StringBlob, WasiShim};

/// `panic = "immediate-abort"` is set by the build, so this is never reached
/// through an unwind; it exists to satisfy the `no_std` link.
#[cfg(all(any(target_arch = "wasm32", target_arch = "wasm64"), not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
