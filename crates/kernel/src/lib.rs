#![cfg_attr(target_arch = "wasm32", no_std)]
#![cfg_attr(target_arch = "wasm32", no_main)]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod fd;
pub mod lock;
pub mod memory;
pub mod ofd;
pub mod path;
pub mod pipe;
pub mod process;
pub mod signal;
pub mod socket;
pub mod syscalls;

#[cfg(target_arch = "wasm32")]
pub mod wasm_api;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};

    struct WasmAlloc;

    unsafe impl GlobalAlloc for WasmAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            // Grow linear memory in pages (64 KiB each).
            let pages = (layout.size() + layout.align() + 65535) / 65536;
            let prev = core::arch::wasm32::memory_grow(0, pages);
            if prev == usize::MAX {
                return core::ptr::null_mut();
            }
            let base = prev * 65536;
            let aligned = (base + layout.align() - 1) & !(layout.align() - 1);
            aligned as *mut u8
        }

        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
            // No-op: Wasm linear memory cannot be freed.
        }
    }

    #[global_allocator]
    static ALLOC: WasmAlloc = WasmAlloc;

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}
