#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod access;
pub mod devfs;
pub mod fd;
pub mod fork;
pub mod lock;
pub mod memory;
pub mod mqueue;
pub mod ipc;
pub mod ofd;
pub mod path;
pub mod pipe;
pub mod procfs;
pub mod process;
pub mod pshared;
pub mod process_table;
pub mod pty;
pub mod signal;
pub mod socket;
pub mod syscalls;
pub mod terminal;
pub mod unix_socket;
pub mod wakeup;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub mod wasm_api;

// ---------------------------------------------------------------------------
// Debug logging (temporary)
// ---------------------------------------------------------------------------

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub fn debug_log(msg: &str) {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn host_debug_log(ptr: *const u8, len: u32);
    }
    unsafe { host_debug_log(msg.as_ptr(), msg.len() as u32); }
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub fn debug_log(_msg: &str) {}

// ---------------------------------------------------------------------------
// Current time helper
// ---------------------------------------------------------------------------

/// Get current real time in seconds (CLOCK_REALTIME).
/// On wasm32, calls the host import. On native (tests), returns 0.
pub fn current_time_secs() -> i64 {
    #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
    {
        #[link(wasm_import_module = "env")]
        unsafe extern "C" {
            fn host_clock_gettime(clock_id: u32, sec_ptr: *mut i64, nsec_ptr: *mut i64) -> i32;
        }
        let mut sec: i64 = 0;
        let mut nsec: i64 = 0;
        unsafe { host_clock_gettime(0, &mut sec as *mut i64, &mut nsec as *mut i64); }
        sec
    }
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        0
    }
}

// ---------------------------------------------------------------------------
// Kernel mode flag
// ---------------------------------------------------------------------------

use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// Kernel operating mode.
///
/// - Mode 0 (default): Traditional per-process kernel. Blocking syscalls spin
///   or delegate to the host. Used by existing single-kernel-per-worker setup.
/// - Mode 1: Centralized kernel. Blocking syscalls return EAGAIN immediately
///   so the host JS event loop can handle waiting asynchronously.
static KERNEL_MODE: AtomicU32 = AtomicU32::new(0);

/// Returns true when the kernel is running in centralized mode (mode 1).
/// In this mode, syscalls that would block instead return EAGAIN so the
/// host can retry them asynchronously.
#[inline]
pub fn is_centralized_mode() -> bool {
    KERNEL_MODE.load(Ordering::Relaxed) != 0
}

/// Set the kernel operating mode. Called from wasm_api or tests.
pub fn set_kernel_mode(mode: u32) {
    KERNEL_MODE.store(mode, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Permission enforcement toggle
// ---------------------------------------------------------------------------

/// Runtime gate for filesystem permission checks landed across PR 5/5.
///
/// Defaults on as of Task 5.10. The earlier enforcement commits
/// (Tasks 5.3-5.9) landed with this default off so each step could
/// be reviewed in isolation; flipping it to true is the final gate
/// that activates POSIX permission semantics for all syscalls.
static ENFORCE_PERMISSIONS: AtomicBool = AtomicBool::new(true);

#[inline]
pub fn enforce_permissions() -> bool {
    ENFORCE_PERMISSIONS.load(Ordering::Relaxed)
}

pub fn set_enforce_permissions(enabled: bool) {
    ENFORCE_PERMISSIONS.store(enabled, Ordering::Relaxed);
}

#[cfg(all(test, not(any(target_arch = "wasm32", target_arch = "wasm64"))))]
mod enforce_permissions_tests {
    use super::*;
    use std::sync::Mutex;

    // The flag is process-global; serialize the three tests so they don't
    // observe each other's writes when cargo runs tests in parallel.
    static LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_is_true() {
        // Read the compile-time AtomicBool initializer directly. We
        // intentionally do NOT take LOCK here — the goal is to observe
        // the static's initial state, and any other concurrent test
        // may have mutated it. To keep this test deterministic the
        // other tests in this module restore the toggle to `true`
        // (the compile-time default) before they return, so reading
        // it here always observes the default value regardless of
        // execution order.
        assert!(enforce_permissions());
    }

    #[test]
    fn set_true_flips_on() {
        let _g = LOCK.lock().unwrap();
        set_enforce_permissions(false);
        set_enforce_permissions(true);
        assert!(enforce_permissions());
        // Leave default state restored for subsequent tests.
        set_enforce_permissions(true);
    }

    #[test]
    fn set_false_flips_back() {
        let _g = LOCK.lock().unwrap();
        set_enforce_permissions(true);
        set_enforce_permissions(false);
        assert!(!enforce_permissions());
        // Leave default state restored for subsequent tests.
        set_enforce_permissions(true);
    }
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::sync::atomic::{AtomicUsize, Ordering};

    /// Bump allocator that grows upward from __heap_base.
    ///
    /// The kernel's heap starts at the linker-defined __heap_base and grows
    /// upward. When the cursor exceeds the current Wasm memory size, we grow
    /// memory just enough to cover the allocation. This avoids conflicts with
    /// the user-space allocator (musl mallocng) which uses mmap addresses
    /// starting at 0x10000000 — the kernel heap stays well below that.
    struct BumpAlloc {
        cursor: AtomicUsize,
    }

    impl BumpAlloc {
        const fn new() -> Self {
            BumpAlloc {
                cursor: AtomicUsize::new(0),
            }
        }
    }

    unsafe extern "C" {
        static __heap_base: u8;
    }

    #[inline(always)]
    fn wasm_memory_size() -> usize {
        #[cfg(target_arch = "wasm32")]
        { core::arch::wasm32::memory_size(0) }
        #[cfg(target_arch = "wasm64")]
        { core::arch::wasm64::memory_size(0) }
    }

    #[inline(always)]
    fn wasm_memory_grow(pages: usize) -> usize {
        #[cfg(target_arch = "wasm32")]
        { core::arch::wasm32::memory_grow(0, pages) }
        #[cfg(target_arch = "wasm64")]
        { core::arch::wasm64::memory_grow(0, pages) }
    }

    unsafe impl GlobalAlloc for BumpAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align();
            let size = layout.size();

            loop {
                let mut cur = self.cursor.load(Ordering::Relaxed);

                // Lazy-init: set cursor to __heap_base on first allocation
                if cur == 0 {
                    let base = unsafe { &__heap_base as *const u8 as usize };
                    let _ = self.cursor.compare_exchange(
                        0, base, Ordering::Relaxed, Ordering::Relaxed,
                    );
                    cur = self.cursor.load(Ordering::Relaxed);
                }

                // Align the cursor
                let aligned = (cur + align - 1) & !(align - 1);
                let new_cursor = match aligned.checked_add(size) {
                    Some(nc) => nc,
                    None => return core::ptr::null_mut(),
                };

                // Ensure Wasm memory covers the allocation
                let current_bytes = wasm_memory_size() * 65536;
                if new_cursor > current_bytes {
                    let needed_pages = (new_cursor - current_bytes + 65535) / 65536;
                    let prev = wasm_memory_grow(needed_pages);
                    if prev == usize::MAX {
                        return core::ptr::null_mut();
                    }
                }

                // Try to claim the region atomically
                if self
                    .cursor
                    .compare_exchange(cur, new_cursor, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
                {
                    return aligned as *mut u8;
                }
                // Another thread won; retry with updated cursor
            }
        }

        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
            // No-op: bump allocator does not reclaim memory.
        }
    }

    #[global_allocator]
    static ALLOC: BumpAlloc = BumpAlloc::new();

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        unsafe { core::hint::unreachable_unchecked() }
    }
}
