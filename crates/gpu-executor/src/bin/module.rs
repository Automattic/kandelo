//! The GPU executor Wasm module's entry: the allocator and panic handler a
//! `no_std` Wasm binary needs around `kandelo_gpu_executor::wasm`, whose
//! `ge_*` exports `build-wasm.sh` names explicitly.
//!
//! WHY a binary at all: the exports live in the library so they are
//! type-checked with the core, but only a final artifact may own a global
//! allocator and a panic handler.
#![cfg_attr(target_arch = "wasm32", no_std)]
#![cfg_attr(target_arch = "wasm32", no_main)]

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    panic!("the GPU executor module must be built for wasm32");
}

#[cfg(target_arch = "wasm32")]
mod module {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;

    // Link the library, whose `#[no_mangle]` exports are the module surface;
    // naming them here keeps that dependency visible.
    #[allow(unused_imports)]
    pub use kandelo_gpu_executor::wasm::{ge_alloc, ge_free, ge_handle, ge_version};

    struct Allocator(UnsafeCell<dlmalloc::Dlmalloc>);
    // One GPU worker thread calls the module; see `kandelo_gpu_executor::wasm`.
    unsafe impl Sync for Allocator {}

    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator(UnsafeCell::new(dlmalloc::Dlmalloc::new()));

    unsafe impl GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).malloc(layout.size(), layout.align()) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { (*self.0.get()).free(pointer, layout.size(), layout.align()) }
        }
    }

    // `panic=immediate-abort` removes panic formatting; a panic can only
    // come from a defect (hostile input is refused without one), and it
    // traps rather than continuing with broken state.
    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
        core::arch::wasm32::unreachable()
    }
}
