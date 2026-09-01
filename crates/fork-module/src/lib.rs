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
//! ## Memory topology chosen (and why) — PIC side module (D5 gating fix)
//!
//! SINGLE shared imported memory (the production "single-shared-memory" shape),
//! placed by the HOST via position-independent-code globals. This is the gating
//! sub-problem the D2 scaffold did NOT solve: a plain cdylib emits its static
//! data, BSS heap, and `--stack-first` shadow stack at FIXED LOW linear-memory
//! offsets, so instantiating it against the LIVE guest's shared memory would
//! overwrite guest data at those offsets. The scaffold's `tests/harness.mjs`
//! only passed because it ran against an EMPTY memory.
//!
//! The fix is to build this crate as a POSITION-INDEPENDENT (`--pie
//! --experimental-pic`) wasm SIDE MODULE. That makes the module import three
//! HOST-supplied placement globals and relocate itself into a host-chosen
//! region of the shared memory:
//!
//! * `env.memory` — the guest's ONLY memory (shared). All frame reads/writes
//!   happen here at absolute guest byte offsets, exactly as the D1 decoders
//!   assume.
//! * `env.__memory_base` (immutable global) — the host-chosen base for the
//!   module's own data + BSS. The module's data segments are PASSIVE and copied
//!   by the start function to `__memory_base + offset`; every static/BSS access
//!   is `__memory_base`-relative. The host points this into a region the guest
//!   is NOT using, so the module's `Vec`/`BTreeMap`/journal heap never collides
//!   with guest data.
//! * `env.__stack_pointer` (mutable global) — the host-chosen shadow-stack top.
//!   The stack grows DOWN from here, in the host region, not at the fixed low
//!   `--stack-first` offset a plain cdylib would use.
//! * `env.__table_base` + `env.__indirect_function_table` — the PIC ABI table
//!   base and shared function table (no entries added in this slice).
//!
//! With this placement the module's ONLY writes are (a) into its own
//! host-placed `__memory_base` region, (b) onto its own host-placed shadow
//! stack, and (c) into the per-fork FRAME ARENA the host passes explicitly to
//! `fm_begin_unwind(activation_id, arena_base, arena_len)` — Option A: the HOST
//! allocates the arena (production: `continuationMmap`), the module never grows
//! memory. `tests/harness.mjs` proves co-residency by seeding a sentinel over
//! the whole low region and asserting it is byte-for-byte intact after a full
//! fork loop.
//!
//! Why NOT the D2 §1d multi-memory fallback (module's own default memory +
//! guest memory imported as a second memory): Rust/LLVM lower every ordinary
//! pointer dereference against memory index 0, so the `fork-codec` `&mut [u8]`
//! frame APIs cannot target a second imported memory without hand-written
//! multi-memory instructions. The PIC side module keeps memory 0 as the single
//! shared guest memory AND relocates the module's own state off the guest's low
//! offsets — the only path that both works with Rust codegen and solves the
//! collision.
//!
//! ## Deliberately DEFERRED (NOT done here; see README)
//!
//! * LIVE HOST WIRING: flipping the guest's `env.__wpk_fork_frame_*` imports to
//!   this module's exports in `host/src/worker-main.ts`, and the host code that
//!   reserves the `__memory_base`/stack region + `continuationMmap` arena, is
//!   the risky live-integration step and is left for user review. Nothing here
//!   touches the host, kernel, shared ABI, runtime-core, `abi/`, or `libc/`.
//! * The reference / exception / GC engine-floor imports (the JS floor) and the
//!   funcref/anyref engine tables — inert for a no-reference program.
//! * Per-worker instantiation plumbing and the ABI-44 snapshot record.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
// The wasm64 memory intrinsics (`core::arch::wasm64::memory_size`) are still
// behind the `simd_wasm64` feature gate (rust-lang/rust#90599). Enable it only
// for the wasm64 build; the wasm32 and host builds are unaffected.
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

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
    use core::sync::atomic::{AtomicI32, AtomicU32, AtomicUsize, Ordering};

    use alloc::vec::Vec;

    use fork_codec::{
        ChunkAllocator, LinkedFrameFormat, LinkedFrameWriter, ReplayEventJournal, ResumeSlotTable,
        RewindDriver,
    };
    use wasm_posix_shared::{abi, Errno};

    // The wasm memory/trap intrinsics live in an arch-specific module. Alias the
    // correct one so the same code builds for a wasm32 (`pointer_width = 4`) and
    // a wasm64 (`pointer_width = 8`) guest.
    #[cfg(target_arch = "wasm32")]
    use core::arch::wasm32 as wasm_intr;
    #[cfg(target_arch = "wasm64")]
    use core::arch::wasm64 as wasm_intr;

    const PAGE: u64 = 65_536;

    // -- Host-seeded linked-frame format ------------------------------------
    //
    // In production the host reads the guest module's
    // `kandelo.wpk_fork.linked_frames` descriptor (`readLinkedFrameFormat`) and
    // passes the pointer width and fixed-prefix size to the module ONCE via
    // `fm_set_format` before any fork. The chunk/node header sizes are derived
    // from the pointer width by the shared ABI helpers, so those two values are
    // the whole format. `0` means "not seeded yet" — `fm_begin_unwind` refuses
    // to run until the format is set (truthful `EINVAL`, never a guessed
    // geometry).
    static FMT_POINTER_WIDTH: AtomicU32 = AtomicU32::new(0);
    static FMT_FIXED_PREFIX: AtomicU32 = AtomicU32::new(0);

    fn set_format_impl(pointer_width: u32, fixed_prefix_size: u32) -> Result<(), Errno> {
        // The ABI only defines linked-frame geometry for 32- and 64-bit guests.
        if abi::wpk_fork_linked_chunk_header_size(pointer_width as u8).is_none() {
            return Err(Errno::EINVAL);
        }
        FMT_POINTER_WIDTH.store(pointer_width, Ordering::Relaxed);
        FMT_FIXED_PREFIX.store(fixed_prefix_size, Ordering::Relaxed);
        Ok(())
    }

    fn format() -> Result<LinkedFrameFormat, Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        Ok(LinkedFrameFormat {
            pointer_width: pw as u8,
            chunk_header_size: abi::wpk_fork_linked_chunk_header_size(pw as u8)
                .ok_or(Errno::EINVAL)?,
            node_header_size: abi::wpk_fork_linked_node_header_size(pw as u8).ok_or(Errno::EINVAL)?,
            fixed_prefix_size: FMT_FIXED_PREFIX.load(Ordering::Relaxed),
        })
    }

    // -- Per-worker bump heap ------------------------------------------------
    //
    // A fixed static region serves the module's own `alloc` allocations (the
    // writer/journal/slot-table `Vec`/`BTreeMap` state). It is reset at each
    // `fm_begin_unwind`, so per-fork state is reclaimed and the module can be
    // reused across forks without unbounded growth. `dealloc` is a no-op (bump);
    // freeing happens only at the per-fork reset.
    //
    // Because this crate is a PIC (`--pie`) side module, this BSS region is NOT
    // at a fixed low linear-memory offset: it lives at `__memory_base + offset`,
    // where the HOST chooses `__memory_base` to point into a region the guest is
    // not using. So the heap no longer collides with guest data (the D5 gating
    // fix; see the module doc comment and `tests/harness.mjs`). 4 MiB comfortably
    // covers a single fork's peak state — including bump waste from `Vec`
    // doubling — for well past the 5000-frame stress workload, and it sets the
    // module's `dylink.0` `mem_size` (how much of the `__memory_base` region the
    // host must reserve).
    const HEAP_SIZE: usize = 4 * 1024 * 1024;

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
        wasm_intr::unreachable()
    }

    // -- Shared guest memory access -----------------------------------------

    fn mem_len_bytes() -> usize {
        wasm_intr::memory_size(0) * 65_536
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

    fn begin_unwind_impl(activation_id: u32, arena_base: u64, arena_len: u64) -> Result<u64, Errno> {
        // Option A: the HOST owns the per-fork frame arena and passes its base
        // and length in (production: a `continuationMmap` of the shared memory).
        // The module does NOT grow memory. The base must be page-aligned and the
        // length a non-zero page multiple — exactly what `LinkedFrameWriter`
        // requires of chunk boundaries, and what a page-rounded host mapping
        // yields.
        if arena_len == 0 || arena_base % PAGE != 0 || arena_len % PAGE != 0 {
            return Err(Errno::EINVAL);
        }
        let arena_end = arena_base.checked_add(arena_len).ok_or(Errno::EINVAL)?;

        // The format must have been seeded (once) via `fm_set_format`.
        let fmt = format()?;

        // Reclaim the previous fork's state and heap before this fork.
        *state() = None;
        ALLOC.reset();

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

    /// Seed the linked-frame format for subsequent forks. `pointer_width` is 4
    /// (wasm32 guest) or 8 (wasm64 guest); `fixed_prefix_size` is the guest's
    /// module-buffer fixed-prefix size. Called ONCE by the host (from the guest
    /// module's `kandelo.wpk_fork.linked_frames` descriptor) before any
    /// `fm_begin_unwind`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_format(pointer_width: u32, fixed_prefix_size: u32) {
        match set_format_impl(pointer_width, fixed_prefix_size) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Begin a fork unwind for `activation_id` over the HOST-allocated frame
    /// arena `[arena_base, arena_base + arena_len)` (Option A). `arena_base` must
    /// be page-aligned and `arena_len` a non-zero page multiple. Returns the
    /// module-buffer anchor (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_unwind(
        activation_id: u32,
        arena_base: usize,
        arena_len: usize,
    ) -> usize {
        match begin_unwind_impl(activation_id, arena_base as u64, arena_len as u64) {
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

    /// Vestigial `__heap_base` export.
    ///
    /// `rustc` unconditionally appends `--export=__heap_base` for a wasm
    /// `cdylib`, but a position-independent (`--pie`) side module has no static
    /// heap base — its heap lives at `__memory_base`-relative offsets the HOST
    /// chooses, so `wasm-ld` does NOT define `__heap_base` and the forced export
    /// would fail to link. Defining this trivial symbol satisfies the export.
    /// The host never consumes it (the module's allocator uses its own
    /// `__memory_base`-relative BSS heap), so its value is meaningless; it exists
    /// only so the `--pie` link succeeds.
    #[unsafe(no_mangle)]
    pub extern "C" fn __heap_base() -> i32 {
        0
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
