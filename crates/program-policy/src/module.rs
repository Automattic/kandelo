#![cfg_attr(target_arch = "wasm32", no_std)]
#![cfg_attr(target_arch = "wasm32", no_main)]

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    panic!("the policy module must be built for wasm32");
}

#[cfg(target_arch = "wasm32")]
mod module {
    extern crate alloc;
    use core::{
        alloc::{GlobalAlloc, Layout},
        cell::UnsafeCell,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use kandelo_program_policy::{
        INSPECTION_BYTES, INSPECTION_VERSION, Inspection, InspectionError,
    };
    use wasm_artifact::policy_surface::{PolicyReadError, PolicyReadLimits};

    const MAX_INPUT: usize = 64 * 1024 * 1024;
    const MAX_HEAP: usize = 96 * 1024 * 1024;
    static BUDGET: AtomicUsize = AtomicUsize::new(MAX_HEAP);
    static USED: AtomicUsize = AtomicUsize::new(0);
    static FAILED: AtomicBool = AtomicBool::new(false);
    struct State<Value>(UnsafeCell<Value>);
    unsafe impl<Value> Sync for State<Value> {}
    static INPUT: State<Option<(usize, usize)>> = State(UnsafeCell::new(None));
    static OUTPUT: State<[u8; INSPECTION_BYTES]> = State(UnsafeCell::new([0; INSPECTION_BYTES]));
    struct Allocator(UnsafeCell<dlmalloc::Dlmalloc>);
    unsafe impl Sync for Allocator {}
    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator(UnsafeCell::new(dlmalloc::Dlmalloc::new()));

    unsafe impl GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let Some(next) = USED
                .load(Ordering::Relaxed)
                .checked_add(layout.size())
                .filter(|used| *used <= BUDGET.load(Ordering::Relaxed))
            else {
                FAILED.store(true, Ordering::Relaxed);
                return core::ptr::null_mut();
            };
            let pointer = unsafe { (*self.0.get()).malloc(layout.size(), layout.align()) };
            if pointer.is_null() {
                FAILED.store(true, Ordering::Relaxed);
            } else {
                USED.store(next, Ordering::Relaxed);
            }
            pointer
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe {
                (*self.0.get()).free(pointer, layout.size(), layout.align());
            }
            USED.fetch_sub(layout.size(), Ordering::Relaxed);
        }
    }

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
        core::arch::wasm32::unreachable()
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn pp_version() -> u32 {
        INSPECTION_VERSION
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn pp_begin(length: usize, budget: usize) -> usize {
        if !(8..=MAX_INPUT).contains(&length)
            || budget < length
            || budget > MAX_HEAP
            || unsafe { (*INPUT.0.get()).is_some() }
        {
            return 0;
        }
        BUDGET.store(budget, Ordering::Relaxed);
        let Ok(layout) = Layout::from_size_align(length, 1) else {
            return 0;
        };
        let pointer = unsafe { alloc::alloc::alloc_zeroed(layout) };
        if pointer.is_null() {
            return 0;
        }
        unsafe {
            *INPUT.0.get() = Some((pointer as usize, length));
        }
        pointer as usize
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn pp_inspect(metadata_bytes: usize, work_items: usize) -> i32 {
        let Some((pointer, length)) = (unsafe { *INPUT.0.get() }) else {
            return -1;
        };
        let source = unsafe { core::slice::from_raw_parts(pointer as *const u8, length) };
        match Inspection::read(
            source,
            PolicyReadLimits {
                metadata_bytes,
                work_items,
            },
        ) {
            Ok(inspection) => {
                unsafe {
                    *OUTPUT.0.get() = inspection.encode();
                }
                INSPECTION_BYTES as i32
            }
            Err(InspectionError::Policy(PolicyReadError::InvalidLimits)) => -1,
            Err(InspectionError::Policy(PolicyReadError::MetadataLimit)) => -3,
            Err(InspectionError::Policy(PolicyReadError::WorkLimit)) => -4,
            Err(InspectionError::Policy(PolicyReadError::Allocation)) => -5,
            Err(_) => -2,
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn pp_result() -> usize {
        OUTPUT.0.get() as usize
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn pp_allocation_failed() -> u32 {
        u32::from(FAILED.load(Ordering::Relaxed))
    }
}
