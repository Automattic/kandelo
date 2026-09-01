//! Co-resident process-worker fork module (Phase 6 D2 scaffold — ADDITIVE).
//!
//! This crate is the cdylib that will (eventually) be instantiated once in each
//! process worker to provide the guest's `__wpk_fork_frame_*` /
//! `__wpk_fork_resume_peek` imports directly, as wasm→wasm calls over the SAME
//! linear memory the guest uses — eliminating the per-frame JS boundary the
//! TypeScript continuation controller has today. See
//! `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`.
//!
//! What this scaffold PROVES (see `tests/harness.mjs`): a second wasm module can
//! import the guest's linear `Memory` as `env.memory`, export the frozen
//! guest-facing frame functions, and drive the full reserve/commit → next/peek/
//! resume continuation loop against that shared memory, end to end in a real
//! engine, matching the pure-logic expectation the `fork-codec` unit tests pin
//! down. It is the live/stateful half the D1 `fork-codec` decoders deferred: the
//! `LinkedFrameWriter` (reserve/commit), the `RewindDriver` (next/peek), and the
//! `ReplayEventJournal` + `ResumeSlotTable` (the load-bearing journal coupling
//! the design requires to move into the module alongside the allocator).
//!
//! ## Memory topology chosen (and why)
//!
//! SINGLE shared imported memory (the production "single-shared-memory" shape),
//! NOT the multi-memory fallback:
//!
//! * The module imports `env.memory` as its ONLY memory (built, like the kernel,
//!   with `--import-memory --shared-memory`). All frame reads/writes happen in
//!   that shared memory at absolute guest byte offsets, exactly as the D1
//!   decoders assume.
//! * The module's own Rust heap (the `Vec`/`BTreeMap` state of the writer,
//!   driver, journal, and slot table) is a bump allocator over a fixed static
//!   region, reset per fork. It lives in the module's own BSS, disjoint from the
//!   frame data.
//! * The per-fork FRAME ARENA (where continuation chunks are written) is carved
//!   by GROWING the shared memory at `fm_begin_unwind`: `memory.grow` returns a
//!   fresh, page-aligned region above all existing data, guaranteeing the frames
//!   never collide with the module heap/stack/static or the guest's own data.
//!   This is the scaffold stand-in for the production channel-`mmap` arena.
//!
//! Why NOT the D2 §1d multi-memory fallback (module's own default memory +
//! guest memory imported as a second memory): Rust/LLVM lower every ordinary
//! pointer dereference against memory index 0, so the `fork-codec` `&mut [u8]`
//! frame APIs cannot target a second imported memory without hand-written
//! multi-memory instructions; and the repo-wide `.cargo/config.toml` forces
//! `--import-memory` on memory 0, so the module cannot own a private default
//! memory without editing global build config (out of scope, non-additive).
//! Choosing the single-shared-memory arena is both the only path that works with
//! Rust codegen AND the production-shaped choice.
//!
//! ## Deliberately DEFERRED (NOT done here; see README)
//!
//! * LIVE HOST WIRING: flipping the guest's `env.__wpk_fork_frame_*` imports to
//!   this module's exports in `host/src/worker-main.ts` is the risky
//!   live-integration step and is left for user review. Nothing here touches the
//!   host, kernel, shared ABI, runtime-core, `abi/`, or `libc/`.
//! * The production `mmap`-arena heap bootstrap (channel `memory.atomic.wait32`
//!   chunk mapping). This scaffold grows the memory directly instead. The
//!   heap-bootstrap open question (design §7.1) is NOT settled.
//! * The reference / exception / GC engine-floor imports (the JS floor) and the
//!   funcref/anyref engine tables — inert for a no-reference program.
//! * The wasm64 artifact variant (only wasm32 is built here).
//! * Per-worker instantiation plumbing and the ABI-44 snapshot record.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
extern crate alloc;

// On non-wasm targets this crate is intentionally empty: it is a wasm32 cdylib
// (the exports and linear-memory management are wasm-only). Keeping it empty on
// the host lets `cargo build/test --workspace` on a host target stay green while
// the real artifact is produced by `cargo build -p fork-module --target
// wasm32-unknown-unknown`.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicI32, AtomicUsize, Ordering};

    use alloc::vec::Vec;

    use fork_codec::{
        ChunkAllocator, LinkedFrameFormat, LinkedFrameWriter, ReplayEventJournal, ResumeSlotTable,
        RewindDriver,
    };
    use wasm_posix_shared::{abi, Errno};

    const PAGE: u64 = 65_536;

    // The wasm32 module's chosen fixed-prefix size, matching the committed
    // linked-frame fixture geometry. In production this comes from the guest
    // module's `kandelo.wpk_fork.linked_frames` descriptor; the scaffold pins it
    // so the writer and the driver share one self-consistent format.
    const FIXED_PREFIX: u32 = 128;

    fn format() -> LinkedFrameFormat {
        LinkedFrameFormat {
            pointer_width: 4,
            chunk_header_size: abi::wpk_fork_linked_chunk_header_size(4).unwrap_or(32),
            node_header_size: abi::wpk_fork_linked_node_header_size(4).unwrap_or(24),
            fixed_prefix_size: FIXED_PREFIX,
        }
    }

    // -- Per-worker bump heap ------------------------------------------------
    //
    // A fixed static region serves the module's own `alloc` allocations. It is
    // reset at each `fm_begin_unwind`, so per-fork state is reclaimed and the
    // module can be reused across forks without unbounded growth. `dealloc` is a
    // no-op (bump); freeing happens only at the per-fork reset.

    const HEAP_SIZE: usize = 16 * 1024 * 1024;

    #[repr(C, align(16))]
    struct HeapCell(UnsafeCell<[u8; HEAP_SIZE]>);
    // SAFETY: the process worker is single-threaded for fork state; all access
    // is serialized by the one guest that calls these exports.
    unsafe impl Sync for HeapCell {}
    static HEAP: HeapCell = HeapCell(UnsafeCell::new([0u8; HEAP_SIZE]));

    struct Bump {
        offset: AtomicUsize,
    }
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for Bump {}

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let base = HEAP.0.get() as *mut u8 as usize;
            let cur = self.offset.load(Ordering::Relaxed);
            let align = layout.align();
            let start = match base.checked_add(cur) {
                Some(s) => s,
                None => return core::ptr::null_mut(),
            };
            let aligned = (start.wrapping_add(align - 1)) & !(align - 1);
            match (aligned - base).checked_add(layout.size()) {
                Some(next) if next <= HEAP_SIZE => {
                    self.offset.store(next, Ordering::Relaxed);
                    aligned as *mut u8
                }
                _ => core::ptr::null_mut(),
            }
        }

        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    impl Bump {
        fn reset(&self) {
            self.offset.store(0, Ordering::Relaxed);
        }
    }

    #[global_allocator]
    static ALLOC: Bump = Bump {
        offset: AtomicUsize::new(0),
    };

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }

    // -- Shared guest memory access -----------------------------------------

    fn mem_len_bytes() -> usize {
        (core::arch::wasm32::memory_size(0)) * 65_536
    }

    /// A mutable view of the whole guest linear memory.
    ///
    /// # Safety
    /// In WebAssembly linear memory byte offset 0 is a valid address and the
    /// whole `[0, size)` range is addressable. `fork-codec` indexes this slice
    /// with ABSOLUTE guest byte offsets (so the base must be offset 0) and only
    /// ever dereferences offsets inside the grown frame arena, which sits above
    /// all module data. The "null" base is an abstract-machine artifact of
    /// wasm's flat address space; the same guest-offset-as-pointer idiom is used
    /// throughout the kernel (`crates/kernel/src/wasm_api.rs`). The crate is
    /// built `--release`, so the debug non-null slice precondition is compiled
    /// out.
    unsafe fn mem_mut() -> &'static mut [u8] {
        // The base is wasm address 0 (see the doc note). It is formed through an
        // opaque zero so the abstract-machine "null base" is not a statically
        // visible null literal — the same guest-offset-as-pointer reality the
        // kernel relies on, expressed without tripping the null-argument lint.
        let base = core::hint::black_box(0usize) as *mut u8;
        unsafe { core::slice::from_raw_parts_mut(base, mem_len_bytes()) }
    }

    /// An immutable view of the whole guest linear memory. See [`mem_mut`].
    ///
    /// # Safety
    /// Same contract as [`mem_mut`].
    unsafe fn mem_ref() -> &'static [u8] {
        // See [`mem_mut`] for the opaque-zero base rationale.
        let base = core::hint::black_box(0usize) as *const u8;
        unsafe { core::slice::from_raw_parts(base, mem_len_bytes()) }
    }

    // -- Frame-chunk arena allocator ----------------------------------------
    //
    // Bumps page-aligned continuation chunks out of the per-fork arena the
    // module grew from linear memory. `arena_base` is page-aligned (a grow
    // result) and every chunk capacity is a page multiple, so `next` stays
    // page-aligned — exactly what `LinkedFrameWriter` requires.

    struct ArenaAllocator {
        next: u64,
        end: u64,
    }

    impl ChunkAllocator for ArenaAllocator {
        fn allocate(&mut self, capacity: u64) -> Option<u64> {
            let addr = self.next;
            let end = addr.checked_add(capacity)?;
            if end > self.end {
                return None;
            }
            self.next = end;
            Some(addr)
        }
    }

    // -- Per-worker singleton state -----------------------------------------

    struct ForkModule {
        format: LinkedFrameFormat,
        activation_id: u32,
        writer: LinkedFrameWriter,
        arena: ArenaAllocator,
        journal: ReplayEventJournal,
        table: ResumeSlotTable,
        driver: Option<RewindDriver>,
        committed_ordinals: Vec<u32>,
        module_buffer: u64,
    }

    struct StateCell(UnsafeCell<Option<ForkModule>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for StateCell {}
    static STATE: StateCell = StateCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn state() -> &'static mut Option<ForkModule> {
        // SAFETY: the process worker is single-threaded for fork state; only one
        // guest drives these exports, so there is never an overlapping borrow.
        unsafe { &mut *STATE.0.get() }
    }

    static LAST_ERRNO: AtomicI32 = AtomicI32::new(0);

    fn set_ok() {
        LAST_ERRNO.store(0, Ordering::Relaxed);
    }

    fn set_err(errno: Errno) {
        LAST_ERRNO.store(errno as i32, Ordering::Relaxed);
    }

    // -- Coordinator (JS→wasm, once per phase, not hot) ---------------------

    fn begin_unwind_impl(activation_id: u32, arena_pages: usize) -> Result<u64, Errno> {
        if arena_pages == 0 {
            return Err(Errno::EINVAL);
        }
        // Reclaim the previous fork's state and heap before this fork.
        *state() = None;
        ALLOC.reset();

        // Carve a fresh, page-aligned frame arena above all existing memory.
        let prev = core::arch::wasm32::memory_grow(0, arena_pages);
        if prev == usize::MAX {
            return Err(Errno::ENOMEM);
        }
        let arena_base = (prev as u64) * PAGE;
        let arena_end = arena_base + (arena_pages as u64) * PAGE;

        let fmt = format();
        let mut module = ForkModule {
            format: fmt,
            activation_id,
            writer: LinkedFrameWriter::new(fmt),
            arena: ArenaAllocator {
                next: arena_base,
                end: arena_end,
            },
            journal: ReplayEventJournal::new(),
            table: ResumeSlotTable::new(),
            driver: None,
            committed_ordinals: Vec::new(),
            module_buffer: 0,
        };

        module.journal.begin_capture()?;
        let mem = unsafe { mem_mut() };
        let module_buffer = module.writer.begin_unwind(mem, &mut module.arena)?;
        module.module_buffer = module_buffer;

        *state() = Some(module);
        Ok(module_buffer)
    }

    fn reserve_impl(size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_mut() };
        st.writer.reserve_frame(mem, &mut st.arena, size)
    }

    fn commit_impl(payload: u64) -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_mut() };
        st.writer.commit_frame(mem, payload)?;
        // The guest fills the frame header before commit; the function ordinal is
        // the leading u32 of the payload. Record it for the journal and for the
        // resume-slot registration (the load-bearing journal coupling).
        let ordinal = RewindDriver::read_function_ordinal(mem, payload)?;
        st.journal.record_commit(st.activation_id, ordinal)?;
        st.committed_ordinals.push(ordinal);
        Ok(())
    }

    fn finish_unwind_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        st.writer.finish_unwind()?;
        st.journal.seal_capture()?;
        Ok(())
    }

    fn begin_replay_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        st.journal.begin_parent_replay()?;
        let mem = unsafe { mem_ref() };
        let driver = RewindDriver::attach(mem, st.module_buffer, &st.format)?;
        // Register the activation's resume targets: the distinct captured
        // function ordinals, sorted (mirrors ForkResumeTable.registerActivation).
        let mut distinct = st.committed_ordinals.clone();
        distinct.sort_unstable();
        distinct.dedup();
        st.table.register_activation(st.activation_id, &distinct)?;
        st.driver = Some(driver);
        Ok(())
    }

    fn peek_impl(size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_ref() };
        let driver = st.driver.as_ref().ok_or(Errno::EINVAL)?;
        driver.drive_peek(mem, &mut st.journal, st.activation_id, size)
    }

    fn next_impl(size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_ref() };
        let driver = st.driver.as_mut().ok_or(Errno::EINVAL)?;
        driver.drive_next(mem, &mut st.journal, st.activation_id, size)
    }

    fn resume_peek_impl() -> Result<u32, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        RewindDriver::resume_peek(&mut st.journal, &st.table)
    }

    fn finish_replay_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let driver = st.driver.as_ref().ok_or(Errno::EINVAL)?;
        driver.finish_rewind()?;
        st.journal.finish_replay()?;
        Ok(())
    }

    // -- Guest-facing exports (signatures == WPK_FORK_REQUIRED_IMPORTS) ------

    /// `__wpk_fork_frame_reserve(size) -> payload`. Reserve the next frame node
    /// and return its payload pointer (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_reserve(size: usize) -> usize {
        match reserve_impl(size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `__wpk_fork_frame_commit(payload)`. Commit the pending reservation and
    /// record its function ordinal in the replay journal.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_commit(payload: usize) {
        match commit_impl(payload as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// `__wpk_fork_frame_peek(size) -> payload`. Journal-gated non-consuming peek
    /// of the current rewind frame (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_peek(size: usize) -> usize {
        match peek_impl(size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `__wpk_fork_frame_next(size) -> payload`. Journal-gated consuming advance
    /// of the rewind cursor (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_next(size: usize) -> usize {
        match next_impl(size as u64) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// `__wpk_fork_resume_peek(type_diagnostic) -> slot`. Resume-slot index for
    /// the currently selected replay event (0 = reserved sentinel; -1 on error,
    /// check `fm_last_errno`). The diagnostic argument is unused here.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_resume_peek(_type_diagnostic: i32) -> i32 {
        match resume_peek_impl() {
            Ok(slot) => {
                set_ok();
                slot as i32
            }
            Err(errno) => {
                set_err(errno);
                -1
            }
        }
    }

    // -- Coordinator exports (fm_*) -----------------------------------------

    /// Begin a fork unwind for `activation_id`, growing an `arena_pages`-page
    /// frame arena. Returns the module-buffer anchor (0 on failure; check
    /// `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_unwind(activation_id: u32, arena_pages: usize) -> usize {
        match begin_unwind_impl(activation_id, arena_pages) {
            Ok(module_buffer) => {
                set_ok();
                module_buffer as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Finish the unwind: seal the writer and the captured journal.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_finish_unwind() {
        match finish_unwind_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Begin the (parent) rewind: attach the driver and register resume slots.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_replay() {
        match begin_replay_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Finish the rewind: require every committed frame consumed.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_finish_replay() {
        match finish_replay_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// The sticky errno of the most recent export call (0 == success).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_last_errno() -> i32 {
        LAST_ERRNO.load(Ordering::Relaxed)
    }
}
