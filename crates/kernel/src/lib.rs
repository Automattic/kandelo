#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod audio;
pub(crate) mod descriptor_backing;
pub mod devfs;
pub mod dri;
pub mod fd;
pub mod fifo;
pub mod fork;
pub mod ipc;
pub mod lock;
pub mod memory;
pub mod mouse;
pub mod mqueue;
pub mod ofd;
pub mod path;
pub mod pipe;
pub mod process;
pub mod process_table;
pub mod procfs;
pub mod pshared;
pub mod pty;
pub mod signal;
pub mod socket;
pub mod spawn;
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
    unsafe {
        host_debug_log(msg.as_ptr(), msg.len() as u32);
    }
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
        unsafe {
            host_clock_gettime(0, &mut sec as *mut i64, &mut nsec as *mut i64);
        }
        sec
    }
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        0
    }
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::hint::spin_loop;
    use core::sync::atomic::{AtomicBool, Ordering};
    use dlmalloc::Dlmalloc;

    /// Reclaiming allocator for the dedicated kernel Wasm instance.
    ///
    /// WebAssembly memory cannot shrink, so "reclaiming" means that freed
    /// chunks remain inside the kernel heap and are reused by later
    /// allocations. That distinction is load-bearing: process serialization,
    /// pipes, directory entries, and syscall scratch structures are transient.
    /// A monotonic allocator turns ordinary long-running fork/pipe churn into
    /// eventual exhaustion of the kernel's fixed one-gibibyte linear memory.
    ///
    /// `dlmalloc` is also the allocator Rust uses for ordinary
    /// wasm32-unknown-unknown programs. Its Wasm system backend grows from the
    /// current end of linear memory, keeping allocator-owned pages disjoint
    /// from linker data and host scratch allocations.
    struct KernelAllocator {
        locked: AtomicBool,
        allocator: UnsafeCell<Dlmalloc>,
    }

    impl KernelAllocator {
        const fn new() -> Self {
            Self {
                locked: AtomicBool::new(false),
                allocator: UnsafeCell::new(Dlmalloc::new()),
            }
        }

        fn lock(&self) -> KernelAllocatorGuard<'_> {
            // The platform contract runs the kernel instance in one dedicated
            // worker and serializes syscall dispatch. The imported memory is
            // nevertheless shared and built with atomics, so keep allocator
            // integrity explicit if host dispatch ever becomes concurrent.
            while self
                .locked
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                while self.locked.load(Ordering::Relaxed) {
                    spin_loop();
                }
            }
            KernelAllocatorGuard { allocator: self }
        }
    }

    // SAFETY: every access to the UnsafeCell is serialized by `locked`.
    unsafe impl Sync for KernelAllocator {}

    struct KernelAllocatorGuard<'a> {
        allocator: &'a KernelAllocator,
    }

    impl Drop for KernelAllocatorGuard<'_> {
        fn drop(&mut self) {
            self.allocator.locked.store(false, Ordering::Release);
        }
    }

    unsafe impl GlobalAlloc for KernelAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _guard = self.lock();
            unsafe { (&mut *self.allocator.get()).malloc(layout.size(), layout.align()) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            let _guard = self.lock();
            unsafe {
                (&mut *self.allocator.get()).free(ptr, layout.size(), layout.align());
            }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let _guard = self.lock();
            unsafe { (&mut *self.allocator.get()).calloc(layout.size(), layout.align()) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let _guard = self.lock();
            unsafe {
                (&mut *self.allocator.get()).realloc(ptr, layout.size(), layout.align(), new_size)
            }
        }
    }

    #[global_allocator]
    static ALLOC: KernelAllocator = KernelAllocator::new();

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        unsafe { core::hint::unreachable_unchecked() }
    }
}
