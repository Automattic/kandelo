//! Feasibility probe for lane Y's builder bridge: how many host imports does a
//! module linking `runtime-core`'s image path actually need?
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
extern crate alloc;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
#[global_allocator]
static ALLOC: wasm::ModuleAllocator = wasm::ModuleAllocator(core::cell::UnsafeCell::new(
    dlmalloc::Dlmalloc::new(),
));

/// Mirrors `crates/wasm-artifact-module`: a RECLAIMING allocator growing from
/// the end of this module's own linear memory, so it adds no import.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use dlmalloc::Dlmalloc;

    pub struct ModuleAllocator(pub UnsafeCell<Dlmalloc>);

    // SAFETY: one builder drives this module on one thread.
    unsafe impl Sync for ModuleAllocator {}

    unsafe impl GlobalAlloc for ModuleAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).malloc(layout.size(), layout.align()) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { (*self.0.get()).free(ptr, layout.size(), layout.align()) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).calloc(layout.size(), layout.align()) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            unsafe { (*self.0.get()).realloc(ptr, layout.size(), layout.align(), new_size) }
        }
    }
}

use runtime_core::sffs_container::{wrap, ContainerSections};
use runtime_core::sffs_write::{NoContent, SffsConfig, SffsWriter};

/// Pull in the SUBSTRATE as well as the serializer.
///
/// The first probe linked only `SffsWriter` and the container and came out at
/// 29,565 bytes with zero function imports -- but it did not link `rootfs.rs`,
/// which is where the builder's mutable filesystem actually lives. A
/// feasibility number that omits the substrate is not a feasibility number.
#[unsafe(no_mangle)]
pub extern "C" fn sm_probe_substrate() -> u64 {
    runtime_core::rootfs::reset();
    match runtime_core::rootfs::insert_base_dir(b"/", 0o755, 0, 0, 1) {
        Ok(()) => {}
        Err(_) => return 0,
    }
    if runtime_core::rootfs::mkdir(b"/usr", 0o755, 0, 0).is_err() {
        return 0;
    }
    match runtime_core::rootfs::lstat(b"/usr") {
        Ok(st) => st.st_mode as u64,
        Err(_) => 0,
    }
}

/// Build a trivial image and report its length. Enough to pull the writer, the
/// container and their transitive dependencies into the link.
#[unsafe(no_mangle)]
pub extern "C" fn sm_probe_build(size_bytes: u64) -> u64 {
    let w = match SffsWriter::mkfs(SffsConfig {
        size_bytes,
        max_size_bytes: None,
        growable_to_bytes: size_bytes,
        now_ms: 0,
    }) {
        Ok(w) => w,
        Err(_) => return 0,
    };
    let image = match w.finish() {
        Ok(image) => image,
        Err(_) => return 0,
    };
    let body = match image.to_vec(&NoContent) {
        Ok(body) => body,
        Err(_) => return 0,
    };
    match wrap(
        &body,
        &ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: b"",
        },
    ) {
        Ok(container) => container.len() as u64,
        Err(_) => 0,
    }
}
