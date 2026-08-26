#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

extern crate alloc;
extern crate wasm_posix_shared;

// This crate is the Wasm FFI shell over the engine-agnostic runtime-core.
// Re-export the runtime so `wasm_api.rs` and downstream keep flat
// `crate::<mod>` paths (e.g. `crate::process::HostIO`, `crate::syscalls::…`,
// `crate::debug_log`, `crate::current_time_secs`).
pub use runtime_core::*;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub mod wasm_api;

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

/// Source-shape guards for `wasm_api.rs`, the Wasm FFI shell. These assert
/// properties of the shell source text, so they live with the shell rather
/// than in the runtime-core modules they were split out of.
#[cfg(test)]
mod wasm_api_source_guards {
    use alloc::vec::Vec;

    #[test]
    fn raw_channel_pointer_allowlist_contains_only_process_addresses() {
        let dispatcher = include_str!("wasm_api.rs");
        let channel_dispatch_source = dispatcher
            .split("#[cfg(test)]\nmod channel_pointer_tests")
            .next()
            .expect("channel pointer test boundary disappeared");

        assert!(
            !dispatcher.contains("channel_pointer!("),
            "ambiguous raw channel pointer bypasses the scratch proof"
        );

        // Pin every remaining direct widened-pointer normalization site in the
        // channel dispatcher. Command-dependent SEMCTL buffers must go through
        // the named allocation-start/range proof rather than adding another
        // raw `checked_channel_pointer(args[..])` call.
        for context in [
            "fn checked_channel_pointer(raw: i64) -> Result<usize, Errno> {",
            "let pointer = checked_channel_pointer(raw)?;",
            "checked_channel_pointer(channel_scalar::process_address_argument(",
            "match checked_channel_pointer(args[$index]) {",
        ] {
            assert_eq!(
                channel_dispatch_source.matches(context).count(),
                1,
                "reviewed direct channel-pointer context changed:\n{context}"
            );
        }
        assert_eq!(
            channel_dispatch_source
                .matches("checked_channel_pointer(")
                .count(),
            4,
            "review every new direct widened-channel pointer conversion"
        );
        // WHY: rustfmt may wrap the binding before `match`; normalize only
        // whitespace so this still pins the exact binding and proof helper.
        let normalized_channel_dispatch_source = channel_dispatch_source
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized_channel_dispatch_source
                .matches("let values_pointer = match checked_channel_scratch_start_range(")
                .count(),
            1,
            "SEMCTL SETALL must prove the exact scratch allocation and range"
        );
        assert_eq!(
            normalized_channel_dispatch_source
                .matches("let output_pointer = match checked_channel_scratch_start_range(")
                .count(),
            2,
            "SEMCTL STAT/GETALL must prove the exact scratch allocation and range"
        );
        assert_eq!(
            channel_dispatch_source
                .matches("checked_channel_scratch_start_range(")
                .count(),
            4,
            "review every command-dependent scratch-start proof"
        );

        // WHY: a count alone lets a newly added raw pointer hide behind removal
        // of an existing use. Pin each reviewed process-address context, then
        // also pin the total so every addition, removal, or relocation requires
        // an explicit ownership review.
        let reviewed_process_address_contexts = [
            (
                "47 => kernel_munmap(process_address!(0), process_size!(1)), // SYS_MUNMAP",
                1,
            ),
            (
                "49 => kernel_mprotect(process_address!(0), process_size!(1), a3 as u32), // SYS_MPROTECT",
                1,
            ),
            (
                "128 => kernel_madvise(process_address!(0), process_size!(1), a3 as u32), // SYS_MADVISE",
                1,
            ),
            (
                r#"201 => kernel_clone(
            0,
            conditional_process_address!(1),
            a1 as u32,
            0,
            conditional_process_address!(2),
            conditional_process_address!(3),
            conditional_process_address!(4),"#,
                4,
            ),
            (
                r#"200 => kernel_futex(
            process_address!(0),
            a2 as u32,
            a3 as u32,
            a4 as u32,
            conditional_process_address!(4),"#,
                2,
            ),
            (
                "203 => kernel_set_tid_address(process_address!(0)), // SYS_SET_TID_ADDRESS",
                1,
            ),
            (
                "261 => kernel_set_robust_list(process_address!(0), process_size!(1)), // SYS_SET_ROBUST_LIST",
                1,
            ),
            (
                "262 => kernel_get_robust_list(a1 as u32, process_address!(1), process_address!(2)), // SYS_GET_ROBUST_LIST",
                2,
            ),
            (
                r#"let _shmaddr = conditional_process_address!(1);
            kernel_ipc_shmat(a1, a2, a3)"#,
                1,
            ),
            (
                r#"let shmaddr = conditional_process_address!(0);
            kernel_ipc_shmdt_addr(shmaddr)"#,
                1,
            ),
            (
                r#"279 | 280 => {
            // mlock, mlock2: (addr, len, ...)
            let addr = process_address!(0);"#,
                1,
            ),
            (
                r#"281 => {
            // munlock: (addr, len)
            let addr = process_address!(0);"#,
                1,
            ),
            (
                r#"278 => {
            let _address = process_address!(0);
            let _length = process_size!(1);"#,
                1,
            ),
        ];

        let mut reviewed_uses = 0;
        for (context, expected_uses) in reviewed_process_address_contexts {
            assert_eq!(
                dispatcher.matches(context).count(),
                1,
                "reviewed raw process-address context changed:\n{context}"
            );
            reviewed_uses += expected_uses;
        }
        assert_eq!(
            dispatcher.matches("process_address!(").count(),
            reviewed_uses,
            "review every new raw process-address use; scratch must use a validated pointer macro"
        );
    }

    #[test]
    fn variable_io_adapters_are_not_public_bare_pointer_exports() {
        let wasm_api = include_str!("wasm_api.rs");
        for removed_function in [
            "fn kernel_read(",
            "fn kernel_write(",
            "fn kernel_pread(",
            "fn kernel_pwrite(",
            "fn kernel_readv(",
            "fn kernel_writev(",
            "fn kernel_preadv(",
            "fn kernel_pwritev(",
            "fn kernel_prepare_write_operation(",
        ] {
            assert!(
                !wasm_api.contains(removed_function),
                "variable I/O regained a pointer-only public adapter: {removed_function}",
            );
        }
        for required_private_adapter in [
            "fn channel_read(",
            "fn channel_write(",
            "fn channel_pread(",
            "fn channel_pwrite(",
            "fn channel_readv(",
            "fn channel_writev(",
            "fn channel_preadv(",
            "fn channel_pwritev(",
        ] {
            assert!(
                wasm_api.contains(required_private_adapter),
                "bounded private adapter disappeared: {required_private_adapter}",
            );
        }
    }

    #[test]
    fn wasm_api_avoids_direct_current_tid_lookup() {
        let direct_lookup = concat!("crate::process_table::", "current_tid()");
        let wasm_api_source = include_str!("wasm_api.rs");
        assert!(!wasm_api_source.contains(direct_lookup));
    }
}
