#![cfg_attr(target_family = "wasm", no_std)]
#![cfg_attr(target_family = "wasm", no_main)]
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

extern crate alloc;
extern crate wasm_posix_shared;

#[cfg(target_family = "wasm")]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};

    struct WasmAlloc;

    unsafe impl GlobalAlloc for WasmAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            // Grow linear memory in pages (64 KiB each).
            let pages = (layout.size() + layout.align() + 65535) / 65536;
            let prev = wasm_memory_grow(pages);
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

    #[cfg(target_arch = "wasm64")]
    fn wasm_memory_grow(pages: usize) -> usize {
        core::arch::wasm64::memory_grow(0, pages)
    }

    #[cfg(target_arch = "wasm32")]
    fn wasm_memory_grow(pages: usize) -> usize {
        core::arch::wasm32::memory_grow(0, pages)
    }

    #[global_allocator]
    static ALLOC: WasmAlloc = WasmAlloc;

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        #[cfg(target_arch = "wasm64")]
        { core::arch::wasm64::unreachable() }
        #[cfg(target_arch = "wasm32")]
        { core::arch::wasm32::unreachable() }
    }
}
