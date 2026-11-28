//! The executor's Wasm boundary: the `ge_*` exports the GPU worker shell
//! calls, and the `kgpu_backend` imports that carry backend calls out to the
//! worker's platform renderer.
//!
//! Ownership: the shell owns transport and the platform renderer; this file
//! owns only the crossing. It adapts raw pointers into slices and the
//! imported functions into a `Backend`, then hands every decision to
//! `crate::Executor`.
//!
//! WHY the exports police pointers: the module has a private memory the
//! shell writes into, and the executor promises never to trap. Every pointer
//! the shell passes must therefore lie inside a live `ge_alloc` allocation;
//! anything else is refused with `-EFAULT` instead of becoming an
//! out-of-bounds access, an alias of the executor's own heap, or a corrupt
//! `free`. The shell treats a negative `ge_handle` result as a transport
//! fault, not as a completion.
//!
//! Single-threaded by construction: one GPU worker instantiates one module
//! and calls it from its event loop, never re-entrantly.

extern crate alloc;

use alloc::collections::BTreeMap;
use core::alloc::Layout;
use core::cell::UnsafeCell;

use wasm_posix_shared::Errno;
use wasm_posix_shared::kgpu::{
    COMPLETION_SIZE, EXTENT_SIZE, Extent, KGPU_PROTOCOL_VERSION, encode_completion,
};

use crate::Executor;
use crate::backend::Backend;

// The backend's `read_pixels` import reads the extent array in place, in the
// record wire layout.
const _: () = assert!(core::mem::size_of::<Extent>() == EXTENT_SIZE);

#[link(wasm_import_module = "kgpu_backend")]
unsafe extern "C" {
    #[link_name = "create_context"]
    fn import_create_context(context: u32) -> i32;
    #[link_name = "destroy_context"]
    fn import_destroy_context(context: u32);
    #[link_name = "create_surface"]
    fn import_create_surface(context: u32, surface: u32, width: u32, height: u32) -> i32;
    #[link_name = "destroy_surface"]
    fn import_destroy_surface(context: u32, surface: u32);
    #[link_name = "bind_surface"]
    fn import_bind_surface(context: u32, surface: u32);
    #[link_name = "viewport"]
    fn import_viewport(context: u32, x: i32, y: i32, w: i32, h: i32);
    #[link_name = "clear_color"]
    fn import_clear_color(context: u32, r: f32, g: f32, b: f32, a: f32);
    #[link_name = "clear"]
    fn import_clear(context: u32, mask: u32);
    #[link_name = "read_pixels"]
    fn import_read_pixels(
        context: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        extents_ptr: u32,
        extent_count: u32,
    ) -> i32;
    #[link_name = "is_lost"]
    fn import_is_lost() -> i32;
}

/// The backend the GPU worker supplies through `kgpu_backend` imports.
/// Status-returning imports answer 0 or a negative errno.
pub struct ImportBackend;

impl Backend for ImportBackend {
    fn create_context(&mut self, context: u32) -> Result<(), i32> {
        match unsafe { import_create_context(context) } {
            0 => Ok(()),
            status => Err(status),
        }
    }
    fn destroy_context(&mut self, context: u32) {
        unsafe { import_destroy_context(context) }
    }
    fn create_surface(
        &mut self,
        context: u32,
        surface: u32,
        width: u32,
        height: u32,
    ) -> Result<(), i32> {
        match unsafe { import_create_surface(context, surface, width, height) } {
            0 => Ok(()),
            status => Err(status),
        }
    }
    fn destroy_surface(&mut self, context: u32, surface: u32) {
        unsafe { import_destroy_surface(context, surface) }
    }
    fn bind_surface(&mut self, context: u32, surface: u32) {
        unsafe { import_bind_surface(context, surface) }
    }
    fn viewport(&mut self, context: u32, x: i32, y: i32, w: i32, h: i32) {
        unsafe { import_viewport(context, x, y, w, h) }
    }
    fn clear_color(&mut self, context: u32, rgba: [f32; 4]) {
        unsafe { import_clear_color(context, rgba[0], rgba[1], rgba[2], rgba[3]) }
    }
    fn clear(&mut self, context: u32, mask: u32) {
        unsafe { import_clear(context, mask) }
    }
    fn read_pixels(
        &mut self,
        context: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        dst: &[Extent],
    ) -> Result<(), i32> {
        let status = unsafe {
            import_read_pixels(context, x, y, w, h, dst.as_ptr() as u32, dst.len() as u32)
        };
        if status == 0 { Ok(()) } else { Err(status) }
    }
    fn is_lost(&self) -> bool {
        unsafe { import_is_lost() != 0 }
    }
}

struct Global<T>(UnsafeCell<T>);
// One GPU worker, one thread: see the module comment.
unsafe impl<T> Sync for Global<T> {}

static EXECUTOR: Global<Executor<ImportBackend>> =
    Global(UnsafeCell::new(Executor::new(ImportBackend)));
/// Live `ge_alloc` allocations, start -> length.
static ALLOCATIONS: Global<BTreeMap<u32, u32>> = Global(UnsafeCell::new(BTreeMap::new()));

/// Bounds one allocation. A maximal submission record (`KGPU_MAX_BUFFERS`
/// buffers of `KGPU_MAX_EXTENTS` extents) is about 4.2 MiB and a maximal
/// stream 1 MiB, so 16 MiB leaves headroom without letting one request
/// claim most of the 256 MiB memory.
const MAX_ALLOCATION: u32 = 16 << 20;
const ALIGN: usize = 8;
const EFAULT: i32 = -(Errno::EFAULT as i32);

fn allocations() -> &'static mut BTreeMap<u32, u32> {
    unsafe { &mut *ALLOCATIONS.0.get() }
}

/// Whether `[ptr, ptr+len)` lies inside one live allocation.
fn inside_allocation(ptr: u32, len: u32) -> bool {
    let Some((&start, &size)) = allocations().range(..=ptr).next_back() else {
        return false;
    };
    u64::from(ptr) + u64::from(len) <= u64::from(start) + u64::from(size)
}

fn region<'a>(ptr: u32, len: u32) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    if !inside_allocation(ptr, len) {
        return None;
    }
    Some(unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) })
}

#[unsafe(no_mangle)]
pub extern "C" fn ge_version() -> u32 {
    KGPU_PROTOCOL_VERSION
}

/// Allocate `len` bytes for the shell to fill, or 0.
#[unsafe(no_mangle)]
pub extern "C" fn ge_alloc(len: u32) -> u32 {
    if len == 0 || len > MAX_ALLOCATION {
        return 0;
    }
    let Ok(layout) = Layout::from_size_align(len as usize, ALIGN) else {
        return 0;
    };
    let ptr = unsafe { alloc::alloc::alloc(layout) } as usize as u32;
    if ptr != 0 {
        allocations().insert(ptr, len);
    }
    ptr
}

/// Free an allocation by its exact `ge_alloc` pointer and length; anything
/// else is ignored rather than corrupting the heap.
#[unsafe(no_mangle)]
pub extern "C" fn ge_free(ptr: u32, len: u32) {
    if allocations().get(&ptr) != Some(&len) {
        return;
    }
    allocations().remove(&ptr);
    unsafe {
        alloc::alloc::dealloc(
            ptr as usize as *mut u8,
            Layout::from_size_align_unchecked(len as usize, ALIGN),
        )
    }
}

/// Handle one submission record and write its 24-byte completion to
/// `out_ptr`. Returns the bytes written, or `-EFAULT` (writing nothing) if
/// any range is not inside a live allocation.
#[unsafe(no_mangle)]
pub extern "C" fn ge_handle(
    record_ptr: u32,
    record_len: u32,
    stream_ptr: u32,
    stream_len: u32,
    out_ptr: u32,
) -> i32 {
    if !inside_allocation(out_ptr, COMPLETION_SIZE as u32) {
        return EFAULT;
    }
    let (Some(record), Some(stream)) = (
        region(record_ptr, record_len),
        region(stream_ptr, stream_len),
    ) else {
        return EFAULT;
    };
    let executor = unsafe { &mut *EXECUTOR.0.get() };
    let completion = executor.handle_record(record, stream);
    let out =
        unsafe { core::slice::from_raw_parts_mut(out_ptr as usize as *mut u8, COMPLETION_SIZE) };
    match encode_completion(out, &completion) {
        Ok(written) => written as i32,
        Err(_) => EFAULT,
    }
}
