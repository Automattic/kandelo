//! The syscall channel, as the WASI guest's personality speaks it.
//!
//! `libc/glue/channel_syscall.c` is the SDK guest's channel implementation.
//! `WasiShim.doSyscall` (`host/src/wasi-shim.ts:490-544`) is a second one,
//! written in TypeScript, for WASI guests. This is that second one in Rust,
//! and it drives the SAME protocol on the SAME channel -- no new opcode, no
//! new marshalling, no ABI motion.
//!
//! Behind a trait so every entry point can be exercised on the host against a
//! fake channel that records the syscall number and the six i64 argument
//! slots, which is exactly the shape `host/test/wasi-shim.test.ts:60-84`
//! already asserts against a mocked `Atomics.wait`.

use wasm_posix_shared::channel;

/// One channel request/response.
pub trait Channel {
    /// Publish a syscall and block until the kernel worker completes it.
    /// Returns `(return_value, errno)`.
    fn syscall(&self, nr: u32, args: [i64; 6]) -> (i64, u32);

    /// Byte offset of this process's channel within the guest's memory.
    fn base(&self) -> u64;

    /// Byte offset of the channel's scratch data area.
    fn data_area(&self) -> u64 {
        self.base() + channel::DATA_OFFSET as u64
    }

    /// Usable bytes in the scratch data area.
    fn data_capacity(&self) -> u64 {
        channel::DATA_SIZE as u64
    }
}

/// The wasm implementation: the real in-realm handshake.
///
/// Byte-for-byte the protocol `WasiShim.doSyscall` performs:
///
/// ```text
/// write CH_SYSCALL, CH_ARGS[0..6]
/// atomic store CH_STATUS = PENDING; notify
/// while (wait32(CH_STATUS, PENDING) == woken) { }   // re-sleep on a spurious wake
/// read CH_RETURN, CH_ERRNO
/// atomic store CH_STATUS = IDLE
/// ```
///
/// The re-wait loop is preserved deliberately: the TypeScript's
/// `while (Atomics.wait(...) === "ok")` goes back to sleep when a wake leaves
/// the word still PENDING, and dropping that would turn a spurious wake into a
/// bogus result. K10 probe 2 (`docs/plans/probes/2026-09-09-k10/`) confirms
/// `memory.atomic.wait32` and the kernel worker's `Atomics.notify` interoperate
/// on this word on Node, Chromium, and WebKit.
///
/// Unlike `fork-module`'s channel syscall, this does NOT set
/// `REQUEST_FLAG_DEFER_SIGNAL_DELIVERY`: that flag exists because the fork
/// module runs mid-continuation and caught signals must stay pending across
/// the transition. A WASI call is an ordinary syscall, and the TypeScript sets
/// no request flags either.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub struct WasmChannel {
    base: u64,
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
impl WasmChannel {
    pub const fn new(base: u64) -> Self {
        Self { base }
    }
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
impl Channel for WasmChannel {
    fn base(&self) -> u64 {
        self.base
    }

    fn syscall(&self, nr: u32, args: [i64; 6]) -> (i64, u32) {
        use core::arch::wasm32 as wasm_intr;
        use core::sync::atomic::{AtomicI32, Ordering};

        const CH_IDLE: i32 = wasm_posix_shared::ChannelStatus::Idle as i32;
        const CH_PENDING: i32 = wasm_posix_shared::ChannelStatus::Pending as i32;

        // SAFETY: `base` is the process's syscall-channel region, supplied by
        // the host from `computeProcessMemoryLayout` and page-aligned. Every
        // access below is within `[base, base + HEADER_SIZE)`.
        unsafe {
            let write_u32 = |off: usize, v: u32| {
                core::ptr::write_unaligned((self.base as usize + off) as *mut u32, v)
            };
            let write_i64 = |off: usize, v: i64| {
                core::ptr::write_unaligned((self.base as usize + off) as *mut i64, v)
            };
            write_u32(channel::SYSCALL_OFFSET, nr);
            for (index, value) in args.iter().enumerate() {
                write_i64(channel::ARGS_OFFSET + index * channel::ARG_SIZE, *value);
            }

            let status_ptr = (self.base as usize + channel::STATUS_OFFSET) as *mut i32;
            let status = &*(status_ptr as *const AtomicI32);
            // SeqCst so the request writes above are visible to the kernel
            // worker before it observes PENDING.
            status.store(CH_PENDING, Ordering::SeqCst);
            wasm_intr::memory_atomic_notify(status_ptr, 1);
            // 0 == "woken". A status that already left PENDING returns
            // "not-equal" and exits the loop.
            while wasm_intr::memory_atomic_wait32(status_ptr, CH_PENDING, -1) == 0 {}

            let ret = core::ptr::read_unaligned(
                (self.base as usize + channel::RETURN_OFFSET) as *const i64,
            );
            let err = core::ptr::read_unaligned(
                (self.base as usize + channel::ERRNO_OFFSET) as *const u32,
            );
            status.store(CH_IDLE, Ordering::SeqCst);
            (ret, err)
        }
    }
}

/// A host-side channel for tests: records every call and replays scripted
/// responses. The same shape as the `vi.spyOn(Atomics, "wait")` harness in
/// `host/test/wasi-shim.test.ts`.
#[cfg(feature = "testing")]
pub struct FakeChannel<'m> {
    base: u64,
    memory: &'m crate::mem::FakeMemory,
    pub calls: core::cell::RefCell<std::vec::Vec<RecordedCall>>,
    #[allow(clippy::type_complexity)]
    responder: std::boxed::Box<
        dyn Fn(&RecordedCall, &crate::mem::FakeMemory) -> ChannelResponse + 'm,
    >,
}

/// A syscall as it appeared on the channel.
#[cfg(feature = "testing")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCall {
    pub nr: u32,
    pub args: [i64; 6],
}

#[cfg(feature = "testing")]
#[derive(Debug, Clone, Default)]
pub struct ChannelResponse {
    pub result: i64,
    pub errno: u32,
}

#[cfg(feature = "testing")]
impl ChannelResponse {
    pub fn ok(result: i64) -> Self {
        Self { result, errno: 0 }
    }
    pub fn err(errno: u32) -> Self {
        Self { result: -1, errno }
    }
}

#[cfg(feature = "testing")]
impl<'m> FakeChannel<'m> {
    pub fn new(
        base: u64,
        memory: &'m crate::mem::FakeMemory,
        responder: impl Fn(&RecordedCall, &crate::mem::FakeMemory) -> ChannelResponse + 'm,
    ) -> Self {
        Self {
            base,
            memory,
            calls: core::cell::RefCell::new(std::vec::Vec::new()),
            responder: std::boxed::Box::new(responder),
        }
    }

    /// Every call recorded so far.
    pub fn calls(&self) -> std::vec::Vec<RecordedCall> {
        self.calls.borrow().clone()
    }

    /// The single call recorded, panicking if there was not exactly one.
    pub fn only_call(&self) -> RecordedCall {
        let calls = self.calls.borrow();
        assert_eq!(calls.len(), 1, "expected exactly one syscall, got {calls:?}");
        calls[0].clone()
    }
}

#[cfg(feature = "testing")]
impl Channel for FakeChannel<'_> {
    fn base(&self) -> u64 {
        self.base
    }

    fn syscall(&self, nr: u32, args: [i64; 6]) -> (i64, u32) {
        let call = RecordedCall { nr, args };
        self.calls.borrow_mut().push(call.clone());
        let response = (self.responder)(&call, self.memory);
        (response.result, response.errno)
    }
}
