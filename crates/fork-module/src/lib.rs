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
//! ## Multi-activation frames (Phase 6 D7a.2 — ADDITIVE)
//!
//! A `dlopen` fork has N ACTIVATIONS: activation 0 is the main module, 1..N are
//! the dlopen'd side modules, each with its OWN linked-frame writer, frame
//! arena, fixed runtime prefix, and rewind driver. The module keys those
//! per-activation writers/drivers in a `BTreeMap` (`ForkModule::activations`),
//! while the replay JOURNAL and RESUME-SLOT TABLE stay PROCESS-WIDE — the
//! journal already tags every event with its `activation_id`, so it records the
//! interleaved commit order across all activations and replays the global
//! reverse. `fm_begin_unwind` opens the first activation; `fm_add_activation_
//! unwind` adds the rest to the same fork (no reset). Each activation's guest
//! reaches its own frame state through the activation-parameterized shared
//! exports `fm_frame_{reserve,commit,peek,next}(act, ...)` / `fm_resume_peek(act)`
//! — the targets a per-activation wasm TRAMPOLINE calls with a constant
//! activation-id immediate (the production port is
//! `host/src/fork-module-trampoline.ts`, proven by
//! `host/test/fork-module-trampoline.test.ts`; the multi-activation frame/journal
//! primitives are unit-tested in `crates/fork-codec`). The FROZEN guest-facing
//! `__wpk_fork_frame_*` exports remain the single-activation path (they route to
//! `PRIMARY_ACTIVATION`), so no guest re-instrumentation is required. The LIVE
//! host wiring of the trampolines, per-activation references, and the KFLA
//! archive is deferred to D7a.1.
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
//! stack, and (c) into the per-fork FRAME CHUNKS the module maps itself.
//! Option B (minimize host surface): the MODULE owns its frame allocation,
//! issuing each chunk's `SYS_MMAP` through the guest syscall channel
//! (`fm_begin_unwind(activation_id, channel_base)`, in-realm
//! `memory_atomic_wait32`), growing memory ON DEMAND like the JS continuation
//! path — so there is no fixed host-reserved arena and no host arena-reservation
//! surface, and continuation depth is bounded only by available memory. The
//! chunks are released (`munmap`) on replay finish/abort. `tests/harness.mjs`
//! proves co-residency by seeding a sentinel over the whole low region and
//! asserting it is byte-for-byte intact after a full fork loop.
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
//!   reserves the `__memory_base`/stack region, is the risky live-integration
//!   step. Under Option B the host no longer reserves a frame arena — it passes
//!   the syscall channel base and the module maps its own chunks.
//! * The reference / exception / GC engine-floor imports (the JS floor) and the
//!   funcref/anyref engine tables — inert for a no-reference program.
//! * Per-worker instantiation plumbing and the ABI-44 snapshot record.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
// The wasm64 memory intrinsics (`core::arch::wasm64::memory_size`) are still
// behind the `simd_wasm64` feature gate (rust-lang/rust#90599). Enable it only
// for the wasm64 build; the wasm32 and host builds are unaffected.
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]
// The in-realm channel handshake blocks on `memory_atomic_wait32` and wakes the
// kernel worker with `memory_atomic_notify` (Option B). Both intrinsics are
// still behind this feature gate (rust-lang/rust#77839); enable it for the wasm
// builds (the host build compiles this module out entirely).
#![cfg_attr(
    any(target_arch = "wasm32", target_arch = "wasm64"),
    feature(stdarch_wasm_atomic_wait)
)]

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
extern crate alloc;

// H3 (host-surface minimization, 2026-09-06): the Wasm-import-backed
// `wpk_fork_host.*` engine-floor seam (Phase 6 D6, `mod host_capabilities`)
// was DELETED here. It declared 6 host imports
// (`host_mint_exception_tag`/`host_provide_unwind_transport_tag`/
// `host_recognize_unwind_transport`/`host_instantiate_child`/
// `host_spawn_thread`/`host_last_errno`) but was never wired to the guest on
// any host, and the completed F5/F6 reference-completeness work bypassed it
// entirely (exnref is handled by a guest-local export; typed-GC reuses the
// pre-existing JS drive-order). Deleting it removes those 6 imports from the
// compiled fork-module artifact on every host.

// On non-wasm targets this crate is intentionally empty: it is a wasm32 cdylib
// (the exports and linear-memory management are wasm-only). Keeping it empty on
// the host lets `cargo build/test --workspace` on a host target stay green while
// the real artifact is produced by `cargo build -p fork-module --target
// wasm32-unknown-unknown`.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};

    use alloc::collections::BTreeMap;
    use alloc::vec::Vec;

    use fork_codec::{
        decode_journal_image, decode_module_state, decode_replay_events_image,
        decode_segmented_reference_transaction,
        drive_plan, encode_module_record, encode_replay_events, AggregateKind, ChunkAllocator,
        GcProvenance, LinkedFrameFormat, LinkedFrameWriter, ModuleStateFormat, ReconstructionState,
        ReferenceGraphBuilder, ReferenceRecipeNode, ReferenceReplayDriver, ReferenceReplayFeed,
        ModuleStateWriter, ReferenceSegmentsWriter, ReferenceTransactionRecord, ReplayEvent,
        ReplayEventJournal, ResumeSlotTable, RewindDriver, SegmentedReferenceTransaction,
    };
    use wasm_posix_shared::{abi, channel, mmap, ChannelStatus, Errno, Syscall};

    // The wasm memory/trap intrinsics live in an arch-specific module. Alias the
    // correct one so the same code builds for a wasm32 (`pointer_width = 4`) and
    // a wasm64 (`pointer_width = 8`) guest.
    #[cfg(target_arch = "wasm32")]
    use core::arch::wasm32 as wasm_intr;
    #[cfg(target_arch = "wasm64")]
    use core::arch::wasm64 as wasm_intr;

    const PAGE: u64 = 65_536;

    // -- Injector-wired drive placeholder (control-flow inversion) ----------
    //
    // The coarse per-phase entries (`fm_parent_replay`, rewind or abort)
    // sequence the fine-grained primitives INTERNALLY in Rust — begin the
    // replay, build the per-activation begin drive plan, then DRIVE it — so the
    // host issues ONE module call per phase instead of an `fm_begin_*` call plus
    // a per-activation `wpk_fork_rewind_begin` / `wpk_fork_abort_begin` loop.
    //
    // The drive itself is the walrus-injected `fm_drive_execute` shim, which
    // `call_indirect`s the host-bound `__wpk_fork_drive_table` — a reference-
    // typed call Rust/LLVM cannot emit (why `lib.rs` declares zero real Wasm
    // imports and every outward ref-typed call is injected). A Rust coarse entry
    // therefore cannot call the shim directly. Instead it calls this PLACEHOLDER
    // import, which `crates/fork-module-inject` rewrites (`replace_imported_func`)
    // into a thunk that forwards to the injected `fm_drive_execute` shim — the
    // same injector-wiring seam `resolve_externref` and the decode shims already
    // use. It is a plain `(ptr, i32) -> ()` import (no reference types), which
    // Rust CAN emit; after injection it is a local function, so the emitted
    // module carries no unresolved import for it. Before injection (a bare
    // `cargo build`) it is an unsatisfied import, exactly like `resolve_externref`.
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        /// Drive a serialized drive plan of `count` steps at guest address
        /// `plan`. Injector-rewritten to forward to the `fm_drive_execute` shim.
        fn __wpk_fork_drive_plan(plan: usize, count: u32);

        /// Encode the constructor-provenance witness at `witness_slot` for
        /// `activation`, returning its recipe id. Injector-rewritten to a
        /// `call_indirect` through the drive table (F3 step 2).
        fn __wpk_fork_capture_witness(activation: u32, witness_slot: u32) -> i32;

        /// Type-test the value staged in anyref transit slot `slot`, returning
        /// `(type_ordinal << 32) | layout_id`, or 0 when no layout matched.
        /// Injector-rewritten to a `call_indirect` through the drive table.
        fn __wpk_fork_capture_probe(activation: u32, slot: u32) -> i64;

        /// Encode the value already staged in anyref transit slot `slot` using
        /// `activation`'s codec, returning its recipe id. Injector-rewritten to
        /// a `call_indirect` through the drive table.
        fn __wpk_fork_capture_encode(activation: u32, slot: u32) -> i32;

        /// Write one funcref table slot during a reconcile: set
        /// `__indirect_function_table[dest]` from `__wpk_fork_function_catalog[
        /// catalog_slot]`, or to null when `clear` is non-zero.
        /// Injector-rewritten into a local thunk.
        fn __wpk_fork_table_apply(dest: u32, catalog_slot: u32, clear: u32);

        /// `memory.atomic.wait32(addr, expected, timeout_ns) -> i32`.
        /// Returns 0 "ok", 1 "not-equal", 2 "timed-out". `-1` timeout waits
        /// forever. Injector-rewritten into a local thunk.
        fn __wpk_fork_atomic_wait32(addr: u32, expected: i32, timeout_ns: i64) -> i32;

        /// `memory.atomic.notify(addr, count) -> i32`, returning how many
        /// waiters were woken. Injector-rewritten into a local thunk.
        fn __wpk_fork_atomic_notify(addr: u32, count: u32) -> i32;

        /// Which merged function-catalog slot holds the function at
        /// `__indirect_function_table[dest]`: `-1` if the slot is null, `-2` if
        /// the function is not catalogued. Injector-emitted; see
        /// `inject_indirect_slot_catalog`.
        fn fm_indirect_slot_catalog_index(dest: u32) -> i32;

        /// `table.size` of the guest's indirect function table.
        fn fm_indirect_table_size() -> i32;
    }

    /// Block until the i32 at `addr` stops being `expected`.
    ///
    /// A spin would be correct and unacceptable: the archive writer holds the
    /// lock across guest bootstrap and constructor calls, so a peer could spin
    /// for the length of a `dlopen`.
    fn atomic_wait32(addr: usize, expected: i32) -> i32 {
        let Ok(addr) = u32::try_from(addr) else {
            // A wasm64 address above 4 GiB. The thunk widens what it is given,
            // so refusing here is honest rather than silently waiting on the
            // wrong word.
            return -1;
        };
        // SAFETY: after injection this is a local thunk performing one
        // `memory.atomic.wait32` on the guest's shared memory, which traps on an
        // unaligned or out-of-bounds address rather than reading elsewhere.
        unsafe { __wpk_fork_atomic_wait32(addr, expected, -1) }
    }

    /// Wake every waiter on the i32 at `addr`.
    fn atomic_notify(addr: usize) -> i32 {
        let Ok(addr) = u32::try_from(addr) else {
            return -1;
        };
        // SAFETY: as `atomic_wait32`.
        unsafe { __wpk_fork_atomic_notify(addr, u32::MAX) }
    }

    /// Safe wrapper over the injector-wired table-write placeholder.
    ///
    /// One slot per call, with Rust owning the loop. The alternative — a loop
    /// inside the shim — would put the step striding and bounds logic in
    /// emitted wasm, where it is far harder to test than in Rust.
    fn table_apply_via_injector(dest: u32, catalog_slot: u32, clear: bool) {
        // SAFETY: after injection this is a local thunk doing one `table.get`
        // on the imported function catalog and one `table.set` on the guest's
        // indirect function table, both bounds-checked by wasm itself.
        unsafe { __wpk_fork_table_apply(dest, catalog_slot, u32::from(clear)) }
    }

    /// Safe wrapper over the injector-wired encode placeholder.
    ///
    /// Unlike `capture_witness_via_injector` this stages nothing: the value is
    /// already in the transit slot, which is the case whenever the GUEST put it
    /// there before asking the module a question about it.
    fn capture_encode_via_injector(activation: u32, slot: u32) -> i32 {
        // SAFETY: after injection this is a local thunk that `call_indirect`s
        // the guest's `__wpk_fork_ref_gc_encode_slot` through
        // `drive_table[base(activation) + DRIVE_SLOT_GC_ENCODE]`.
        unsafe { __wpk_fork_capture_encode(activation, slot) }
    }

    /// Safe wrapper over the injector-wired probe placeholder.
    fn capture_probe_via_injector(activation: u32, slot: u32) -> i64 {
        // SAFETY: after injection this is a local thunk that `call_indirect`s
        // the guest's `__wpk_fork_ref_gc_probe` through
        // `drive_table[base(activation) + DRIVE_SLOT_GC_PROBE]`. The guest owns
        // the type test; the module only unpacks the answer.
        unsafe { __wpk_fork_capture_probe(activation, slot) }
    }

    /// Safe wrapper over the injector-wired capture placeholder.
    ///
    /// Encodes the witness at `witness_slot` and returns its recipe id, or a
    /// negative value on failure. Injector-rewritten into a local thunk, so the
    /// emitted module carries no unresolved import for it and the host supplies
    /// nothing new -- the same arrangement `__wpk_fork_drive_plan` uses.
    fn capture_witness_via_injector(activation: u32, witness_slot: u32) -> i32 {
        // SAFETY: after injection this is a local thunk that copies
        // `witness_table[witness_slot]` into anyref transit slot 0 and
        // `call_indirect`s the guest's `__wpk_fork_ref_gc_encode_slot` through
        // `drive_table[base(activation) + DRIVE_SLOT_GC_ENCODE]`. Both tables and
        // the drive slot are module-known; the guest export owns its own failure.
        unsafe { __wpk_fork_capture_witness(activation, witness_slot) }
    }

    /// Safe wrapper over the injector-wired drive placeholder. Isolated so the
    /// coarse entries read as ordinary Rust and the single `unsafe` FFI call has
    /// one auditable site.
    fn drive_plan_via_injector(plan: usize, count: u32) {
        // SAFETY: after injection `__wpk_fork_drive_plan` is a local thunk that
        // forwards `(plan, count)` to the `fm_drive_execute` shim; the shim
        // strides `count` 16-byte steps from `plan` (bounds-checked wasm loads)
        // and owns its own truthful failure (a post-allocate integrity trap).
        unsafe { __wpk_fork_drive_plan(plan, count) }
    }

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

    // -- Host-seeded resume-slot catalog ------------------------------------
    //
    // Resume-slot PARITY (D5 §"Other couplings" 1): the guest imports the JS
    // `__wpk_fork_resume_table` (a `WebAssembly.Table` numbered from the FULL
    // resume catalog, slot 0 reserved, then slots 1..N by sorted function
    // ordinal). The module's `resume_peek` returns an index INTO that JS table,
    // so the module's `ResumeSlotTable` numbering MUST match the JS one exactly
    // or `call_indirect` targets the wrong thunk (silent corruption).
    //
    // The JS table registers the WHOLE catalog; the module, left to its own
    // devices, would number from the COMMITTED ordinals only, diverging whenever
    // committed != catalog. To make the numbering identical BY CONSTRUCTION, the
    // host seeds the same full catalog (the fork-instrumented function ordinals,
    // any order) into the module ONCE per worker via `fm_set_resume_catalog`,
    // and the module registers its resume table from that catalog instead of the
    // committed ordinals. Both sides then sort the identical ordinal set and
    // assign slots 1..N the same way. A committed frame's function always has a
    // resume thunk, so committed is always a subset of the catalog.
    //
    // A fixed BSS buffer holds the catalog so it survives the per-fork heap
    // reset (`fm_begin_unwind` clears the bump heap). A catalog larger than the
    // cap yields a truthful `E2BIG`, which the host surfaces as a FAIL-LOUD
    // module-capacity boundary (Phase 3: the module backs every fork; there is
    // no JS continuation fallback to decline to). The cap holds every real
    // guest's catalog with headroom — the largest shipped programs (php-fpm
    // 19190, php 19026, node/spidermonkey 16555) all fit; keep this value >=
    // `FORK_MODULE_RESUME_CATALOG_CAP` in `host/src/fork-module-backend.ts`,
    // `crates/host-native/src/guest.rs`, and the staging slab in
    // `host/src/fork-module-instance.ts` (`FORK_MODULE_STAGING_BYTES` must hold
    // `RESUME_CATALOG_CAP * 4` bytes).
    const RESUME_CATALOG_CAP: usize = 65_536;

    #[repr(C, align(4))]
    struct CatalogCell(UnsafeCell<[u32; RESUME_CATALOG_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CatalogCell {}
    static RESUME_CATALOG: CatalogCell =
        CatalogCell(UnsafeCell::new([0u32; RESUME_CATALOG_CAP]));
    static RESUME_CATALOG_LEN: AtomicU32 = AtomicU32::new(0);

    fn set_resume_catalog_impl(ptr: u64, count: u64) -> Result<(), Errno> {
        let count = usize::try_from(count).map_err(|_| Errno::EINVAL)?;
        if count > RESUME_CATALOG_CAP {
            return Err(Errno::E2BIG);
        }
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let byte_len = count.checked_mul(4).ok_or(Errno::EINVAL)?;
        let end = start.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // catalog region past the end of guest memory
        }
        // Copy the little-endian u32 ordinals out of guest memory through raw
        // pointers (the same aliasing-safe idiom the journal image copy uses).
        // SAFETY: `[start, end)` is within guest linear memory (checked above);
        // the destination is the distinct static BSS catalog buffer.
        let dst = unsafe { &mut *RESUME_CATALOG.0.get() };
        let src = core::hint::black_box(start) as *const u8;
        for (index, slot) in dst.iter_mut().take(count).enumerate() {
            let mut bytes = [0u8; 4];
            unsafe {
                core::ptr::copy(src.add(index * 4), bytes.as_mut_ptr(), 4);
            }
            *slot = u32::from_le_bytes(bytes);
        }
        RESUME_CATALOG_LEN.store(count as u32, Ordering::Relaxed);
        Ok(())
    }

    /// The seeded resume catalog, or an empty slice if the host never seeded one
    /// (legacy harness path: fall back to committed-ordinal numbering).
    fn resume_catalog() -> &'static [u32] {
        let len = RESUME_CATALOG_LEN.load(Ordering::Relaxed) as usize;
        if len == 0 {
            return &[];
        }
        // SAFETY: single-threaded per worker; `len <= RESUME_CATALOG_CAP` by the
        // `set_resume_catalog_impl` bound. The buffer outlives every borrow.
        let all = unsafe { &*RESUME_CATALOG.0.get() };
        &all[..len]
    }

    // -- Per-activation resume catalogs (Phase 6 D7a.1a — ADDITIVE) ----------
    //
    // A `dlopen` multi-activation fork loads N modules, and EACH module ships
    // its OWN fork-instrumented function catalog (its own imported
    // `__wpk_fork_resume_table`). The single process-wide `RESUME_CATALOG` above
    // cannot number every activation's slots by construction: activation 0's
    // table and activation 1's table are distinct JS `WebAssembly.Table`s with
    // independent slot spaces. So the host seeds a SEPARATE resume catalog PER
    // ACTIVATION via `fm_set_activation_resume_catalog(act, ptr, count)`, and the
    // module registers each activation's `ResumeSlotTable` entry from ITS OWN
    // catalog (see `register_activation_slots`). The resume-slot PARITY contract
    // is unchanged (D5 §"Other couplings" 1): both the JS table and the module
    // sort the identical per-activation ordinal set and assign slots the same
    // way, so `call_indirect` never targets the wrong thunk.
    //
    // Like the global catalog, these live in a fixed BSS region so they survive
    // the per-fork bump-heap reset (`fm_begin_unwind` / `fm_begin_child_replay`
    // clear the heap). Storage is a single flat ordinal arena plus a small index
    // mapping each activation id to its `[offset, len)` slice. Both the ordinal
    // arena and the index are capped; overflow is a truthful `E2BIG` and the host
    // keeps the JavaScript continuation for that program.
    const ACTIVATION_CATALOG_ORD_CAP: usize = 65_536; // total ordinals, all activations
    const ACTIVATION_CATALOG_MAX_ACTS: usize = 64; // distinct activations

    #[repr(C, align(4))]
    struct ActivationCatalogOrds(UnsafeCell<[u32; ACTIVATION_CATALOG_ORD_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActivationCatalogOrds {}
    static ACT_CATALOG_ORDS: ActivationCatalogOrds =
        ActivationCatalogOrds(UnsafeCell::new([0u32; ACTIVATION_CATALOG_ORD_CAP]));

    /// The index: each entry is `[activation_id, offset, len]` into the ordinal
    /// arena. Only the first `ACT_CATALOG_ACT_COUNT` entries are live.
    #[repr(C, align(4))]
    struct ActivationCatalogIndex(UnsafeCell<[[u32; 3]; ACTIVATION_CATALOG_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActivationCatalogIndex {}
    static ACT_CATALOG_INDEX: ActivationCatalogIndex =
        ActivationCatalogIndex(UnsafeCell::new([[0u32; 3]; ACTIVATION_CATALOG_MAX_ACTS]));

    static ACT_CATALOG_ACT_COUNT: AtomicU32 = AtomicU32::new(0);
    static ACT_CATALOG_ORD_USED: AtomicU32 = AtomicU32::new(0);

    fn set_activation_resume_catalog_impl(
        activation_id: u32,
        ptr: u64,
        count: u64,
    ) -> Result<(), Errno> {
        let count = usize::try_from(count).map_err(|_| Errno::EINVAL)?;
        let act_count = ACT_CATALOG_ACT_COUNT.load(Ordering::Relaxed) as usize;
        let ord_used = ACT_CATALOG_ORD_USED.load(Ordering::Relaxed) as usize;
        if act_count >= ACTIVATION_CATALOG_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        let ord_end = ord_used.checked_add(count).ok_or(Errno::EINVAL)?;
        if ord_end > ACTIVATION_CATALOG_ORD_CAP {
            return Err(Errno::E2BIG); // combined catalogs exceed the arena
        }
        // Reject a re-seeded activation (each is seeded once per worker), matching
        // the once-per-worker `fm_set_format` / `fm_set_resume_catalog` contract.
        // SAFETY: single-threaded; the index is a static buffer read here only.
        let index = unsafe { &*ACT_CATALOG_INDEX.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let byte_len = count.checked_mul(4).ok_or(Errno::EINVAL)?;
        let end = start.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // catalog region past the end of guest memory
        }
        // Copy the little-endian u32 ordinals out of guest memory through raw
        // pointers into the flat static arena (the same aliasing-safe idiom the
        // global catalog uses).
        // SAFETY: `[start, end)` is within guest linear memory (checked above);
        // the destination is the distinct static ordinal arena, at a slice
        // `[ord_used, ord_end)` bounded by the cap check above.
        let ords = unsafe { &mut *ACT_CATALOG_ORDS.0.get() };
        let src = core::hint::black_box(start) as *const u8;
        for (index, slot) in ords[ord_used..ord_end].iter_mut().enumerate() {
            let mut bytes = [0u8; 4];
            unsafe {
                core::ptr::copy(src.add(index * 4), bytes.as_mut_ptr(), 4);
            }
            *slot = u32::from_le_bytes(bytes);
        }
        // Publish the index entry, then bump the counters.
        // SAFETY: single-threaded; `act_count < MAX_ACTS` by the check above.
        let index = unsafe { &mut *ACT_CATALOG_INDEX.0.get() };
        index[act_count] = [activation_id, ord_used as u32, count as u32];
        ACT_CATALOG_ACT_COUNT.store((act_count + 1) as u32, Ordering::Relaxed);
        ACT_CATALOG_ORD_USED.store(ord_end as u32, Ordering::Relaxed);
        Ok(())
    }

    /// This activation's seeded resume catalog, or `None` if the host never
    /// seeded one for it (single-activation / legacy paths fall back to the
    /// global catalog then the committed ordinals — see
    /// `register_activation_slots`).
    fn activation_catalog(activation_id: u32) -> Option<&'static [u32]> {
        let act_count = ACT_CATALOG_ACT_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffers outlive every borrow
        // and every live entry's `[offset, len)` was bounded on seed.
        let index = unsafe { &*ACT_CATALOG_INDEX.0.get() };
        let ords = unsafe { &*ACT_CATALOG_ORDS.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                let offset = entry[1] as usize;
                let len = entry[2] as usize;
                return Some(&ords[offset..offset + len]);
            }
        }
        None
    }

    /// Register `activation_id`'s resume targets into `table`, choosing the
    /// ordinal source by the resume-slot parity contract, in precedence order:
    ///
    /// 1. the activation's OWN seeded catalog (`fm_set_activation_resume_catalog`)
    ///    — the multi-activation path, each dlopen module's own catalog;
    /// 2. else the process-wide global catalog (`fm_set_resume_catalog`) —
    ///    back-compat for a single-activation worker that seeded only the global;
    /// 3. else the activation's distinct committed ordinals, sorted — the legacy
    ///    harness path (no catalog seeded at all).
    ///
    /// The single-activation numbering is byte-identical to before this slice:
    /// with no per-activation catalog, precedence falls straight to (2)/(3),
    /// exactly the previous `begin_replay_impl` / `begin_child_replay_impl` logic.
    fn register_activation_slots(
        table: &mut ResumeSlotTable,
        activation_id: u32,
        global_catalog: &[u32],
        committed_ordinals: &[u32],
    ) -> Result<(), Errno> {
        if let Some(catalog) = activation_catalog(activation_id) {
            table.register_activation(activation_id, catalog)
        } else if !global_catalog.is_empty() {
            table.register_activation(activation_id, global_catalog)
        } else {
            let mut distinct: Vec<u32> = committed_ordinals.to_vec();
            distinct.sort_unstable();
            distinct.dedup();
            if distinct.is_empty() {
                Ok(())
            } else {
                table.register_activation(activation_id, &distinct)
            }
        }
    }

    // -- Per-activation function-catalog bases (Phase 6 D7a.1b — ADDITIVE) ---
    //
    // D6.1 imported ONE funcref catalog table and required every funcref to name
    // a single activation (`sole_funcref_activation`). D7a.1b lifts that: the host
    // lays every activation's function catalog into ONE merged imported table,
    // each activation at a distinct BASE, and seeds the module the
    // `activation_id -> base` map once per worker via
    // `fm_set_activation_catalog_base`. `funcref_ordinal_impl` then returns the
    // GLOBAL slot `base(module_activation) + function_ordinal`, so a funcref
    // minted in activation A but held by activation B's frame resolves against
    // A's catalog slice — the coordinate the RECIPE names, never the caller. A
    // dynamic wasm table cannot be selected per funcref, so the single merged
    // table with per-activation bases is the mechanism.
    //
    // Like the resume catalogs, the map lives in a fixed BSS region so it
    // survives the per-fork bump-heap reset. The map stays EMPTY for a
    // single-activation worker (the host seeds no base), and `funcref_ordinal_
    // impl` then defaults `base = 0` — byte-identical to the D6.1 raw-ordinal
    // mapping. Too many distinct activations is a truthful `E2BIG`; a re-seeded
    // activation is a truthful `EINVAL`.
    const FUNC_CATALOG_BASE_MAX_ACTS: usize = 64;

    #[repr(C, align(4))]
    struct ActFuncCatalogBase(UnsafeCell<[[u32; 2]; FUNC_CATALOG_BASE_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActFuncCatalogBase {}
    /// Each live entry is `[activation_id, base]`; only the first
    /// `ACT_FUNC_CATALOG_BASE_COUNT` entries are live.
    static ACT_FUNC_CATALOG_BASE: ActFuncCatalogBase =
        ActFuncCatalogBase(UnsafeCell::new([[0u32; 2]; FUNC_CATALOG_BASE_MAX_ACTS]));
    static ACT_FUNC_CATALOG_BASE_COUNT: AtomicU32 = AtomicU32::new(0);

    // -- Per-activation module template ids ---------------------------------
    //
    // The 32-byte template id identifying the Wasm module behind an activation.
    // It is a hash of the module BYTES, which only the host holds, so it is
    // seeded rather than computed here -- the same shape as the catalog bases
    // above and for the same reason.
    //
    // The module needs it because the `Module` record it writes into the KFMS
    // arena carries it, and that record IS the arena's activation set: the
    // child-install path filters the arena on kind 1 to decide which
    // activations to drive. An arena built without them installs nothing.
    const TEMPLATE_ID_MAX_ACTS: usize = 64;
    const TEMPLATE_ID_BYTES: usize =
        abi::WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE as usize;

    #[repr(C, align(4))]
    struct ActTemplateIds(UnsafeCell<[(u32, [u8; TEMPLATE_ID_BYTES]); TEMPLATE_ID_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActTemplateIds {}
    /// Each live entry is `(activation_id, template_id)`; only the first
    /// `ACT_TEMPLATE_ID_COUNT` entries are live.
    static ACT_TEMPLATE_IDS: ActTemplateIds =
        ActTemplateIds(UnsafeCell::new([(0u32, [0u8; TEMPLATE_ID_BYTES]); TEMPLATE_ID_MAX_ACTS]));
    static ACT_TEMPLATE_ID_COUNT: AtomicU32 = AtomicU32::new(0);

    /// Seed one activation's module template id, read from `ptr` in guest memory.
    ///
    /// Once per activation per worker. A re-seed is refused rather than
    /// overwriting: the id identifies the module behind the activation, so a
    /// second different value means the host has confused two activations, and
    /// silently taking the last one would put the wrong module in the arena's
    /// activation set.
    fn set_activation_template_id_impl(activation_id: u32, ptr: u64) -> Result<(), Errno> {
        // Bounded and read the way every other host-supplied-pointer seed here
        // does it (`set_activation_gc_codec_impl`): check the range against
        // guest memory, then build the slice from the raw address. Reading
        // through `mem_ref()`'s whole-memory slice is NOT equivalent in this
        // module -- the same range that passes this check comes back `None`
        // from that slice -- so the established pattern is the one to follow.
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(TEMPLATE_ID_BYTES).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // template id runs past the end of memory
        }
        // SAFETY: `[start, end)` is inside guest linear memory (checked above).
        let bytes: &[u8] =
            unsafe { core::slice::from_raw_parts(core::hint::black_box(start) as *const u8, TEMPLATE_ID_BYTES) };
        let count = ACT_TEMPLATE_ID_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker.
        let table = unsafe { &mut *ACT_TEMPLATE_IDS.0.get() };
        for entry in table.iter().take(count) {
            if entry.0 == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        if count >= TEMPLATE_ID_MAX_ACTS {
            return Err(Errno::E2BIG);
        }
        table[count].0 = activation_id;
        table[count].1.copy_from_slice(bytes);
        ACT_TEMPLATE_ID_COUNT.store(count as u32 + 1, Ordering::Relaxed);
        Ok(())
    }

    /// This activation's seeded template id, or `None` if the host never seeded one.
    fn activation_template_id(activation_id: u32) -> Option<[u8; TEMPLATE_ID_BYTES]> {
        let count = ACT_TEMPLATE_ID_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker.
        let table = unsafe { &*ACT_TEMPLATE_IDS.0.get() };
        table
            .iter()
            .take(count)
            .find(|entry| entry.0 == activation_id)
            .map(|entry| entry.1)
    }

    /// Seed one activation's module template id (32 bytes at `ptr`).
    ///
    /// `EINVAL` for an out-of-range pointer or a re-seed, `E2BIG` past
    /// `TEMPLATE_ID_MAX_ACTS`; check `fm_last_errno`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_template_id(activation_id: u32, ptr: usize) {
        match set_activation_template_id_impl(activation_id, ptr as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    // -- Table sparse-state ownership ---------------------------------------
    //
    // Which `(activation, owner)` coordinate writes a physical table's sparse
    // state. The host ELECTS: imported aliases name one `WebAssembly.Table`, and
    // deciding which coordinate is canonical means comparing Table OBJECT
    // IDENTITY, which wasm cannot observe -- there is no `table.eq` and this
    // module does not import the activations' tables at all.
    //
    // But the host does not have to keep ANSWERING. It seeds the election result
    // once per coordinate through `fm_set_activation_table_state_owner`, and the
    // guest's `__wpk_fork_module_state_table_state_owned` import is then served
    // from here instead of by a host callback. That moves one function off the
    // host floor while leaving the part that genuinely needs JavaScript -- the
    // identity comparison -- where it has to be.
    //
    // Storage is a flat array of live `[activation_id, owner_id, owns]` triples
    // rather than a per-activation sub-array, because an activation usually has
    // exactly ONE table coordinate and a rectangular map would be almost all
    // padding. Lookup is a linear scan over the live prefix.
    const TABLE_STATE_OWNER_MAX: usize = 256;

    #[repr(C, align(4))]
    struct ActTableStateOwners(UnsafeCell<[[u32; 3]; TABLE_STATE_OWNER_MAX]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActTableStateOwners {}
    /// Each live entry is `[activation_id, owner_id, owns]`; only the first
    /// `ACT_TABLE_STATE_OWNER_COUNT` entries are live.
    static ACT_TABLE_STATE_OWNERS: ActTableStateOwners =
        ActTableStateOwners(UnsafeCell::new([[0u32; 3]; TABLE_STATE_OWNER_MAX]));
    static ACT_TABLE_STATE_OWNER_COUNT: AtomicU32 = AtomicU32::new(0);

    /// Seed one coordinate's election result.
    ///
    /// Re-seeding an existing coordinate UPDATES it rather than being refused,
    /// which is the opposite of the once-per-worker catalogs above and is
    /// deliberate: the host re-elects whenever a lower coordinate registers for
    /// the same physical table, so the incumbent must be demotable. Refusing the
    /// second seed would freeze the first election and leave two writers.
    fn set_activation_table_state_owner_impl(
        activation_id: u32,
        owner_id: u32,
        owns: u32,
    ) -> Result<(), Errno> {
        // Owner 0 is not a coordinate; the host rejects it too.
        if owner_id == 0 {
            return Err(Errno::EINVAL);
        }
        let count = ACT_TABLE_STATE_OWNER_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded; the map is a static buffer.
        let map = unsafe { &mut *ACT_TABLE_STATE_OWNERS.0.get() };
        for entry in map.iter_mut().take(count) {
            if entry[0] == activation_id && entry[1] == owner_id {
                entry[2] = u32::from(owns != 0);
                return Ok(());
            }
        }
        if count >= TABLE_STATE_OWNER_MAX {
            return Err(Errno::E2BIG);
        }
        map[count] = [activation_id, owner_id, u32::from(owns != 0)];
        ACT_TABLE_STATE_OWNER_COUNT.store(count as u32 + 1, Ordering::Relaxed);
        Ok(())
    }

    /// Answer the guest's `table_state_owned` import for one coordinate.
    ///
    /// An UNSEEDED coordinate answers 0, never 1. Answering 1 by default would
    /// make two aliases both write sparse state for one physical table, and that
    /// duplicate does not trap -- it surfaces as a child rebuilt wrong.
    fn table_state_owned_impl(activation_id: u32, owner_id: u32) -> u32 {
        let count = ACT_TABLE_STATE_OWNER_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded; read-only over the live prefix.
        let map = unsafe { &*ACT_TABLE_STATE_OWNERS.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id && entry[1] == owner_id {
                return entry[2];
            }
        }
        0
    }

    fn set_activation_catalog_base_impl(activation_id: u32, base: u32) -> Result<(), Errno> {
        let count = ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) as usize;
        if count >= FUNC_CATALOG_BASE_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        // Reject a re-seeded activation (each is seeded once per worker), matching
        // the once-per-worker `fm_set_activation_resume_catalog` contract.
        // SAFETY: single-threaded; the map is a static buffer read here only.
        let map = unsafe { &*ACT_FUNC_CATALOG_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        // Publish the entry, then bump the count.
        // SAFETY: single-threaded; `count < MAX_ACTS` by the check above.
        let map = unsafe { &mut *ACT_FUNC_CATALOG_BASE.0.get() };
        map[count] = [activation_id, base];
        ACT_FUNC_CATALOG_BASE_COUNT.store((count + 1) as u32, Ordering::Relaxed);
        Ok(())
    }

    /// The seeded merged-catalog base for `activation_id`, or `None` if the host
    /// seeded no base for it.
    fn func_catalog_base(activation_id: u32) -> Option<u32> {
        let count = ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives every borrow.
        let map = unsafe { &*ACT_FUNC_CATALOG_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Some(entry[1]);
            }
        }
        None
    }

    /// True when the host seeded NO catalog base — the single-activation worker
    /// path, where `funcref_ordinal_impl` defaults `base = 0` (byte-identical to
    /// D6.1). Distinguishes that path from a corrupt multi-activation graph whose
    /// funcref names an un-seeded activation.
    fn func_catalog_base_map_empty() -> bool {
        ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) == 0
    }

    // -- Per-activation static-root catalog bases (the static-root binder) ------
    //
    // Exactly the funcref merged-catalog mechanism, for static roots. The host
    // lays every activation's instantiation-time static-root catalog into ONE
    // merged imported anyref table (`env.__wpk_fork_static_root_catalog`), each
    // activation at a distinct BASE, and seeds the `activation_id -> base` map
    // once per worker via `fm_set_activation_static_root_base`.
    // `static_root_slot_impl` then returns the GLOBAL catalog index
    // `base(module_activation) + static_root_ordinal`, so a static root minted in
    // activation A but held by activation B's frame resolves against A's catalog
    // slice — the coordinate the RECIPE names, never the caller. The map stays
    // EMPTY for a single-activation worker, and `static_root_slot_impl` then
    // defaults `base = 0` — byte-identical to the raw-ordinal mapping.
    const STATIC_ROOT_BASE_MAX_ACTS: usize = 64;

    #[repr(C, align(4))]
    struct ActStaticRootBase(UnsafeCell<[[u32; 2]; STATIC_ROOT_BASE_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActStaticRootBase {}
    /// Each live entry is `[activation_id, base]`; only the first
    /// `ACT_STATIC_ROOT_BASE_COUNT` entries are live.
    static ACT_STATIC_ROOT_BASE: ActStaticRootBase =
        ActStaticRootBase(UnsafeCell::new([[0u32; 2]; STATIC_ROOT_BASE_MAX_ACTS]));
    static ACT_STATIC_ROOT_BASE_COUNT: AtomicU32 = AtomicU32::new(0);

    fn set_activation_static_root_base_impl(activation_id: u32, base: u32) -> Result<(), Errno> {
        let count = ACT_STATIC_ROOT_BASE_COUNT.load(Ordering::Relaxed) as usize;
        if count >= STATIC_ROOT_BASE_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        // Reject a re-seeded activation (each is seeded once per worker).
        // SAFETY: single-threaded; the map is a static buffer read here only.
        let map = unsafe { &*ACT_STATIC_ROOT_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Err(Errno::EINVAL);
            }
        }
        // Publish the entry, then bump the count.
        // SAFETY: single-threaded; `count < MAX_ACTS` by the check above.
        let map = unsafe { &mut *ACT_STATIC_ROOT_BASE.0.get() };
        map[count] = [activation_id, base];
        ACT_STATIC_ROOT_BASE_COUNT.store((count + 1) as u32, Ordering::Relaxed);
        Ok(())
    }

    /// The seeded merged-catalog base for `activation_id`, or `None` if the host
    /// seeded no static-root base for it.
    fn static_root_catalog_base(activation_id: u32) -> Option<u32> {
        let count = ACT_STATIC_ROOT_BASE_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives every borrow.
        let map = unsafe { &*ACT_STATIC_ROOT_BASE.0.get() };
        for entry in map.iter().take(count) {
            if entry[0] == activation_id {
                return Some(entry[1]);
            }
        }
        None
    }

    /// True when the host seeded NO static-root base — the single-activation
    /// worker path, where `static_root_slot_impl` defaults `base = 0`.
    /// Distinguishes that path from a corrupt multi-activation graph whose static
    /// root names an un-seeded activation.
    fn static_root_catalog_base_map_empty() -> bool {
        ACT_STATIC_ROOT_BASE_COUNT.load(Ordering::Relaxed) == 0
    }

    // -- Per-activation GC codec catalogs (Phase 6 item 3c — real drive plan) --
    //
    // The REAL topological GC drive plan (`fm_build_gc_plan`) reproduces the JS
    // `materializeTypedGraph` order, which needs the per-activation GC-layout
    // facts the reference-recipe graph does not carry: which of a struct/array's
    // edges are constructor (allocation-time) dependencies, which layouts are
    // defaultable shells, and the i31 owner. Those live in each activation's
    // decoded `kandelo.wpk_fork.gc_codec` catalog. The host decodes the section
    // for admission already; it seeds the SAME raw section bytes into the module
    // ONCE per activation per worker via `fm_set_activation_gc_codec(act, ptr,
    // count)`, and `build_gc_plan_impl` decodes them into a `GcCodec` per
    // activation to build `fork_codec::GcCodecHints` (the faithful port of the JS
    // `gcAllocationDependencies` / owner derivation).
    //
    // Like the resume catalogs, storage is a fixed BSS byte arena plus a small
    // index (activation id -> `[offset, byte_len)`), so it survives the per-fork
    // bump-heap reset. Both are capped; overflow is a truthful `E2BIG` and the
    // host keeps the JS drive-order for that program. A re-seeded activation is a
    // truthful `EINVAL`.
    const ACT_GC_CODEC_BYTES_CAP: usize = 262_144; // total section bytes, all activations
    const ACT_GC_CODEC_MAX_ACTS: usize = 64; // distinct activations

    #[repr(C, align(8))]
    struct ActGcCodecBytes(UnsafeCell<[u8; ACT_GC_CODEC_BYTES_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActGcCodecBytes {}
    static ACT_GC_CODEC_BYTES: ActGcCodecBytes =
        ActGcCodecBytes(UnsafeCell::new([0u8; ACT_GC_CODEC_BYTES_CAP]));

    /// Each live entry is `[activation_id, offset, byte_len]` into the byte arena.
    #[repr(C, align(4))]
    struct ActGcCodecIndex(UnsafeCell<[[u32; 3]; ACT_GC_CODEC_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActGcCodecIndex {}
    static ACT_GC_CODEC_INDEX: ActGcCodecIndex =
        ActGcCodecIndex(UnsafeCell::new([[0u32; 3]; ACT_GC_CODEC_MAX_ACTS]));

    static ACT_GC_CODEC_ACT_COUNT: AtomicU32 = AtomicU32::new(0);
    static ACT_GC_CODEC_BYTES_USED: AtomicU32 = AtomicU32::new(0);

    // The `hostExceptionOwner` the host computed (the smallest activation that
    // declared an exception descriptor), used to remap a host-exception exnref's
    // owner, exactly as the JS `directOwner`. `u32::MAX` means "no host-exception
    // owner" (the JS `null`); `build_gc_plan_impl` then leaves such an exnref
    // ownerless so `build_drive_plan` fails loudly. Seeded once per worker.
    static HOST_EXCEPTION_OWNER: AtomicU32 = AtomicU32::new(u32::MAX);

    fn set_activation_gc_codec_impl(activation_id: u32, ptr: u64, byte_len: u64) -> Result<(), Errno> {
        let byte_len = usize::try_from(byte_len).map_err(|_| Errno::EINVAL)?;
        let act_count = ACT_GC_CODEC_ACT_COUNT.load(Ordering::Relaxed) as usize;
        let used = ACT_GC_CODEC_BYTES_USED.load(Ordering::Relaxed) as usize;
        // Bound the incoming section against guest memory FIRST, so the identical-
        // re-seed comparison below can read it safely.
        let start = usize::try_from(ptr).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // section region past the end of guest memory
        }
        // The raw incoming section bytes in guest linear memory.
        // SAFETY: `[start, end)` is within guest linear memory (checked above). An
        // empty section uses a valid empty slice rather than a possibly-null raw
        // part (`from_raw_parts` requires a non-null base even for len 0).
        let incoming: &[u8] = if byte_len == 0 {
            &[]
        } else {
            unsafe {
                core::slice::from_raw_parts(core::hint::black_box(start) as *const u8, byte_len)
            }
        };
        // DECODE IT NOW, and discard the result.
        //
        // The module owns this wire format, so it is the module that should say
        // whether a section is well-formed -- and it should say so when the
        // section ARRIVES, not at the first fork that needs it. Before this, the
        // host parsed the descriptor in TypeScript purely to get that early
        // answer, which meant two decoders of one format: the drift
        // `dylink_archive`'s doc names, where "two readers of the same wire
        // format drift, and the drift surfaces as a fork child silently
        // disagreeing with its parent."
        //
        // The result is deliberately thrown away. `build_gc_plan` decodes from
        // the stored bytes when it needs the layouts; holding a decoded copy here
        // would be a second source of truth for the same bytes, inside the module
        // this time.
        if !incoming.is_empty() {
            fork_codec::gc_codec::decode_gc_codec(incoming)?;
        }
        // Idempotent re-seed of an already-present activation. A COW fork CHILD
        // inherits the parent's already-seeded catalog through the memory clone
        // (the module's BSS lives inside the shared linear memory and is NOT
        // re-zeroed on instantiation), yet the production Node/browser host
        // RE-SEEDS every activation's GC codec on the child (`worker-main.ts`'s
        // per-activation `setActivationGcCodec`), while the native host relies on
        // inheritance and does NOT re-seed. A GC codec is the activation module's
        // invariant KFGC section, so a re-seed is byte-IDENTICAL by construction:
        // accept it as a no-op here so BOTH hosts converge on the same (correct)
        // catalog. This replaces a blanket `fm_set_format` GC-codec reset that
        // destroyed the inherited catalog on the host that never re-seeds, which
        // broke `fm_build_gc_plan` (`errno 22`) for every GC / static-root fork. A
        // CONFLICTING re-seed (same activation, DIFFERENT bytes) is still a
        // truthful `EINVAL` — the guard's real purpose.
        // SAFETY: single-threaded; the index/bytes are static buffers read here.
        let index = unsafe { &*ACT_GC_CODEC_INDEX.0.get() };
        let stored_bytes = unsafe { &*ACT_GC_CODEC_BYTES.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                let off = entry[1] as usize;
                let len = entry[2] as usize;
                let stored = stored_bytes.get(off..off + len).ok_or(Errno::EINVAL)?;
                if stored == incoming {
                    return Ok(()); // identical re-seed: no-op
                }
                return Err(Errno::EINVAL); // conflicting re-seed of the same activation
            }
        }
        if act_count >= ACT_GC_CODEC_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        let end_used = used.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end_used > ACT_GC_CODEC_BYTES_CAP {
            return Err(Errno::E2BIG); // combined catalogs exceed the arena
        }
        // Copy the raw section bytes out of guest memory into the flat static arena
        // (the same aliasing-safe idiom the resume catalog uses).
        // SAFETY: the destination is the distinct static byte arena slice
        // `[used, end_used)`; `incoming` is a distinct guest-memory region.
        let bytes = unsafe { &mut *ACT_GC_CODEC_BYTES.0.get() };
        unsafe {
            core::ptr::copy(incoming.as_ptr(), bytes.as_mut_ptr().add(used), byte_len);
        }
        // Publish the index entry, then bump the counters.
        // SAFETY: single-threaded; `act_count < MAX_ACTS` by the check above.
        let index = unsafe { &mut *ACT_GC_CODEC_INDEX.0.get() };
        index[act_count] = [activation_id, used as u32, byte_len as u32];
        ACT_GC_CODEC_ACT_COUNT.store((act_count + 1) as u32, Ordering::Relaxed);
        ACT_GC_CODEC_BYTES_USED.store(end_used as u32, Ordering::Relaxed);
        Ok(())
    }

    // -- Per-activation exnref tag catalog (the exnref tag-validity admission
    //    gate's seeding) ---------------------------------------------------------
    //
    // The module owns the exnref tag-validity ADMISSION gate at the child-install
    // entry (`fm_attach_child`, COW and borrowed alike): before it builds the
    // reconstruction drive plan whose `DRIVE_OP_EXN` step `call_indirect`s the
    // guest exception-materialize export, it re-checks that every captured exnref
    // recipe names a tag its OWNING activation's exception codec declared. This
    // supersedes the former host boundary (`assertForkModuleExnrefTagsDeclared`):
    // to re-check in the module, the module needs each activation's declared tag
    // ordinals. The host seeds them ONCE per activation per worker via
    // `fm_set_activation_exception_tags(act, ptr, count)` — `[ptr, ptr+count*4)` is
    // the little-endian `u32` array of the tag ordinals that activation's
    // `kandelo.wpk_fork.exception_codec` section declares. A corrupt / mismatched
    // exnref (an activation that seeded no tags, or a tag not in its set) then
    // fails loud with `EINVAL`, exactly as the host boundary did.
    //
    // Like the resume / GC-codec catalogs, storage is a fixed BSS ordinal arena
    // plus a small index (activation id -> `[offset, len)`), so it survives the
    // per-fork bump-heap reset. Both are capped; overflow is a truthful `E2BIG`.
    // A COW fork CHILD inherits the parent's already-seeded tags through the memory
    // clone (the module's BSS lives inside the shared linear memory and is NOT
    // re-zeroed on instantiation), yet the production Node/browser host RE-SEEDS
    // every activation's tags on the child (`worker-main.ts`'s per-activation
    // `setActivationExceptionTags`), while the native host relies on inheritance and
    // does NOT re-seed. Exception tags are the activation module's invariant codec
    // section, so a re-seed is byte-IDENTICAL by construction: accept it as a no-op
    // so BOTH hosts converge on the same catalog. A CONFLICTING re-seed (same
    // activation, DIFFERENT tags) is a truthful `EINVAL`.
    const ACT_EXN_TAGS_ORD_CAP: usize = 65_536; // total tag ordinals, all activations
    const ACT_EXN_TAGS_MAX_ACTS: usize = 64; // distinct activations

    #[repr(C, align(4))]
    struct ActExnTagsOrds(UnsafeCell<[u32; ACT_EXN_TAGS_ORD_CAP]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActExnTagsOrds {}
    static ACT_EXN_TAGS_ORDS: ActExnTagsOrds =
        ActExnTagsOrds(UnsafeCell::new([0u32; ACT_EXN_TAGS_ORD_CAP]));

    /// Each live entry is `[activation_id, offset, len]` into the ordinal arena.
    #[repr(C, align(4))]
    struct ActExnTagsIndex(UnsafeCell<[[u32; 3]; ACT_EXN_TAGS_MAX_ACTS]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ActExnTagsIndex {}
    static ACT_EXN_TAGS_INDEX: ActExnTagsIndex =
        ActExnTagsIndex(UnsafeCell::new([[0u32; 3]; ACT_EXN_TAGS_MAX_ACTS]));

    static ACT_EXN_TAGS_ACT_COUNT: AtomicU32 = AtomicU32::new(0);
    static ACT_EXN_TAGS_ORD_USED: AtomicU32 = AtomicU32::new(0);


    /// Record one activation's exception tag ordinals.
    ///
    /// Split out of the host-facing entry so the codec path can reuse it: the
    /// storage rules (idempotent re-seed, conflicting re-seed is `EINVAL`, caps
    /// are `E2BIG`) are the same whoever produced the ordinals.
    fn store_activation_exception_tags(
        activation_id: u32,
        incoming: &[u32],
    ) -> Result<(), Errno> {
        let count = incoming.len();
        let act_count = ACT_EXN_TAGS_ACT_COUNT.load(Ordering::Relaxed) as usize;
        let ord_used = ACT_EXN_TAGS_ORD_USED.load(Ordering::Relaxed) as usize;
        // Idempotent re-seed of an already-present activation (see the block
        // comment): identical tags are a no-op; conflicting tags are `EINVAL`.
        // SAFETY: single-threaded; the index/ordinals are static buffers read here.
        let index = unsafe { &*ACT_EXN_TAGS_INDEX.0.get() };
        let stored_all = unsafe { &*ACT_EXN_TAGS_ORDS.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                let off = entry[1] as usize;
                let len = entry[2] as usize;
                let stored = stored_all.get(off..off + len).ok_or(Errno::EINVAL)?;
                if stored == incoming {
                    return Ok(()); // identical re-seed: no-op
                }
                return Err(Errno::EINVAL); // conflicting re-seed of the same activation
            }
        }
        if act_count >= ACT_EXN_TAGS_MAX_ACTS {
            return Err(Errno::E2BIG); // too many distinct activations
        }
        let ord_end = ord_used.checked_add(count).ok_or(Errno::EINVAL)?;
        if ord_end > ACT_EXN_TAGS_ORD_CAP {
            return Err(Errno::E2BIG); // combined catalogs exceed the arena
        }
        // Publish the ordinals into the flat static arena, then the index entry.
        // SAFETY: single-threaded; the destination slice `[ord_used, ord_end)` is
        // bounded by the cap check; `incoming` is a distinct local buffer.
        let ords = unsafe { &mut *ACT_EXN_TAGS_ORDS.0.get() };
        ords[ord_used..ord_end].copy_from_slice(incoming);
        let index = unsafe { &mut *ACT_EXN_TAGS_INDEX.0.get() };
        index[act_count] = [activation_id, ord_used as u32, count as u32];
        ACT_EXN_TAGS_ACT_COUNT.store((act_count + 1) as u32, Ordering::Relaxed);
        ACT_EXN_TAGS_ORD_USED.store(ord_end as u32, Ordering::Relaxed);
        Ok(())
    }

    /// Guest-facing `fm_set_activation_exception_codec(activation, ptr, byte_len)`.
    ///
    /// Seed ONE activation's exception codec from its raw
    /// `kandelo.wpk_fork.exception_codec` section, and derive from it the two
    /// things the host used to derive for itself.
    ///
    /// Replaces `fm_set_activation_exception_tags`, which took a `u32` array the
    /// HOST produced by decoding this very section -- a second decoder of a format
    /// this module owns. The module decodes it now.
    ///
    /// An empty section is not an error: it is an activation whose codec declares
    /// no tags, which still makes it a candidate owner.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_exception_codec(
        activation_id: u32,
        ptr: usize,
        byte_len: usize,
    ) {
        match set_activation_exception_codec_impl(activation_id, ptr, byte_len) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    fn set_activation_exception_codec_impl(
        activation_id: u32,
        ptr: usize,
        byte_len: usize,
    ) -> Result<(), Errno> {
        let end = ptr.checked_add(byte_len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // section region past the end of memory
        }
        let ordinals: Vec<u32> = if byte_len == 0 {
            Vec::new()
        } else {
            // SAFETY: `[ptr, end)` is inside guest linear memory, checked above,
            // and the module shares that memory.
            let bytes = unsafe {
                core::slice::from_raw_parts(core::hint::black_box(ptr) as *const u8, byte_len)
            };
            let codec = fork_codec::exception_codec::decode_exception_codec(bytes)?;
            codec.tags.iter().map(|tag| tag.tag_ordinal).collect()
        };
        store_activation_exception_tags(activation_id, &ordinals)
        // NOTE: this entry deliberately does NOT derive the host-exception owner,
        // even though it could -- the owner is the smallest activation that
        // declared a codec, which is exactly the set of activations that reach
        // here. It is left host-seeded because nothing can OBSERVE the derivation:
        // the owner is module-internal state with no accessor, `fm_stats` is a
        // counter surface rather than a state read, and adding an accessor would
        // put an entry nothing in production calls into a bucket whose target is
        // 0. An untested derivation of a value that decides which activation owns
        // a host exnref is worse than one more host call. See census section 67.
    }

    /// The exception tag ordinals `activation_id`'s codec declared, or `None` when
    /// the host seeded none for it (an activation that declared no exception codec
    /// at all). An exnref naming a `None` activation, or a tag outside the returned
    /// set, fails the admission gate below.
    fn activation_exception_tags(activation_id: u32) -> Option<&'static [u32]> {
        let act_count = ACT_EXN_TAGS_ACT_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffers outlive every borrow and
        // every live entry's `[offset, len)` was bounded on seed.
        let index = unsafe { &*ACT_EXN_TAGS_INDEX.0.get() };
        let ords = unsafe { &*ACT_EXN_TAGS_ORDS.0.get() };
        for entry in index.iter().take(act_count) {
            if entry[0] == activation_id {
                let offset = entry[1] as usize;
                let len = entry[2] as usize;
                return Some(&ords[offset..offset + len]);
            }
        }
        None
    }

    /// Exnref tag-validity ADMISSION gate. Walks the resident replay graph's exnref
    /// nodes (seeded by `begin_reference_replay_impl`) and fails loud with `EINVAL`
    /// on the first recipe whose `(module_activation, tag_ordinal)` its owning
    /// activation's seeded exception codec does not declare. Runs at the
    /// child-install entry BEFORE the reconstruction plan is built, so a corrupt /
    /// mismatched exnref recipe is REJECTED rather than `call_indirect`-driven
    /// through the guest exception-materialize export. Mirrors — and supersedes —
    /// the former host boundary `assertForkModuleExnrefTagsDeclared`. A missing
    /// resident driver is itself `EINVAL` (the gate must never silently pass
    /// without a graph to check).
    fn assert_exnref_tags_admissible() -> Result<(), Errno> {
        let driver = reference_state().as_ref().ok_or(Errno::EINVAL)?;
        match driver.first_undeclared_exnref(|activation, tag| {
            activation_exception_tags(activation)
                .map(|tags| tags.contains(&tag))
                .unwrap_or(false)
        }) {
            Some(_) => Err(Errno::EINVAL),
            None => Ok(()),
        }
    }

    /// Decode every seeded activation's GC codec catalog into a `GcCodec`, keyed by
    /// activation id — the per-activation catalog map `GcCodecHints` consumes. A
    /// section that fails to decode is a truthful `EINVAL` (the host would have
    /// declined admission; a corrupt seed must not silently build a wrong plan).
    fn decoded_gc_codecs() -> Result<BTreeMap<u32, fork_codec::GcCodec>, Errno> {
        let act_count = ACT_GC_CODEC_ACT_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffers outlive every borrow and
        // every live entry's `[offset, byte_len)` was bounded on seed.
        let index = unsafe { &*ACT_GC_CODEC_INDEX.0.get() };
        let bytes = unsafe { &*ACT_GC_CODEC_BYTES.0.get() };
        let mut map = BTreeMap::new();
        for entry in index.iter().take(act_count) {
            let offset = entry[1] as usize;
            let len = entry[2] as usize;
            let slice = bytes.get(offset..offset + len).ok_or(Errno::EINVAL)?;
            map.insert(entry[0], fork_codec::decode_gc_codec(slice)?);
        }
        Ok(map)
    }

    fn host_exception_owner() -> Option<u32> {
        match HOST_EXCEPTION_OWNER.load(Ordering::Relaxed) {
            u32::MAX => None,
            owner => Some(owner),
        }
    }

    /// Build the REAL topological GC drive plan for the current fork's reference
    /// graph (Phase 6 item 3c) and serialize it into the module-owned scratch
    /// buffer, returning its guest address for `fm_drive_execute`.
    ///
    /// Reproduces the JS `materializeTypedGraph` drive-order via
    /// `fork_codec::build_drive_plan` over the resident driver's decoded reference
    /// graph, with `GcCodecHints` supplying the per-recipe GC-layout facts from the
    /// seeded per-activation catalogs. Requires `fm_begin_reference_replay` to have
    /// seeded the driver. Since M2 the externref-transit rooting for reachable
    /// leaves is a `DRIVE_OP_EXTERNREF_TRANSIT` step THIS function's
    /// `build_drive_plan` call emits (Phase 0, before any allocate/fill) — not
    /// something `drive_reconstruction` does at seed time; `drive_reconstruction`
    /// is now a host-free bookkeeping pass (see its doc).
    ///
    /// The post-allocate integrity guard the injected `fm_drive_execute` shim runs
    /// after each ALLOC step reads STORE #2 — the guest's shared Wasm-GC transit
    /// table (`__wpk_fork_ref_gc_transit`) at slot `recipe + 1` — which the guest's
    /// `_gc_allocate` publishes into. That is a pure wasm `table.get` + `ref.is_null`
    /// in the shim (Rust holds no `anyref`), so this planner opens no host
    /// generation for it and stores no R1 state.
    /// Build the topological reconstruction steps (Phase 0/0b/3/4/5) for the
    /// resident reference graph. Shared by `build_gc_plan_impl` and the child-
    /// install `attach_from_arena_impl` (which appends the restore/finish steps).
    fn build_reconstruction_steps() -> Result<Vec<drive_plan::DriveStep>, Errno> {
        let driver = reference_state().as_ref().ok_or(Errno::EINVAL)?;
        let nodes = &driver.transaction().nodes;

        let gc_codecs = decoded_gc_codecs()?;
        let hints = fork_codec::GcCodecHints::new(nodes, &gc_codecs, host_exception_owner())?;
        drive_plan::build_drive_plan(nodes, &hints)
    }

    /// Serialize `steps` into the module-owned scratch buffer, root the bytes in
    /// the `DRIVE_PLAN` cell, publish the count via `GC_PLAN_COUNT`, and return the
    /// plan's guest address for `fm_drive_execute`. Shared by every plan producer
    /// (only one plan is live at a time).
    fn serialize_and_store_plan(steps: &[drive_plan::DriveStep]) -> Result<usize, Errno> {
        let mut buf = Vec::new();
        buf.resize(drive_plan::DRIVE_STEP_SIZE * steps.len(), 0u8);
        drive_plan::serialize_plan(steps, &mut buf)?;
        let ptr = buf.as_ptr() as usize;
        GC_PLAN_COUNT.store(steps.len() as u32, Ordering::Relaxed);
        // SAFETY: single-threaded per worker; root the backing bytes so the returned
        // pointer stays valid for the shim's reads (shares the DRIVE_PLAN cell with
        // the trivial-plan path — only one plan is live at a time).
        unsafe {
            *DRIVE_PLAN.0.get() = Some(buf);
        }
        Ok(ptr)
    }

    fn build_gc_plan_impl(_pid: u32) -> Result<usize, Errno> {
        let steps = build_reconstruction_steps()?;
        serialize_and_store_plan(&steps)
    }

    /// Build a REPLAY-begin drive plan: one `DRIVE_OP_REWIND_BEGIN` (`abort`
    /// false) or `DRIVE_OP_ABORT_BEGIN` (`abort` true) step per open activation,
    /// each carrying that activation's stored continuation root
    /// (`ActivationFrames::module_buffer`) so the injected shim can
    /// `call_indirect` the guest's `wpk_fork_rewind_begin` / `wpk_fork_abort_begin`
    /// with the correct pointer-width argument. Activations iterate in ascending
    /// id order (activation 0 first), matching the host's former per-activation
    /// begin-drive loop. Serialized through the shared plan scratch, so the step
    /// count is read back via `fm_gc_plan_count` exactly as a GC plan.
    fn build_rewind_plan_impl(abort: bool) -> Result<usize, Errno> {
        let st = state().as_ref().ok_or(Errno::EINVAL)?;
        let roots: alloc::vec::Vec<(u32, u64)> = st
            .activations
            .iter()
            .map(|(id, act)| (*id, act.module_buffer))
            .collect();
        let mut steps = alloc::vec::Vec::new();
        if abort {
            drive_plan::append_abort_begin_steps(&mut steps, &roots);
        } else {
            drive_plan::append_rewind_begin_steps(&mut steps, &roots);
        }
        serialize_and_store_plan(&steps)
    }

    /// Sequence a parent REPLAY-begin (`abort` false) or ABORT-replay-begin
    /// (`abort` true) phase entirely in the module: begin the (parent) rewind,
    /// build the per-activation begin drive plan, then drive it through the
    /// injector-wired shim. Shared body of both `fm_parent_replay` phases.
    ///
    /// Order matches the host loop this replaces: begin FIRST (attach each
    /// driver + register resume slots — abort additionally sets `in_abort`), then
    /// the per-activation guest begin drive. A plan with zero steps (no open
    /// activation) drives nothing, which is the same no-op the empty host loop
    /// was.
    fn parent_replay_impl(abort: bool) -> Result<(), Errno> {
        if abort {
            begin_abort_impl()?;
        } else {
            begin_replay_impl()?;
        }
        let plan = build_rewind_plan_impl(abort)?;
        let count = GC_PLAN_COUNT.load(Ordering::Relaxed);
        if count > 0 {
            drive_plan_via_injector(plan, count);
        }
        Ok(())
    }

    /// Build a CHILD REWIND-begin drive plan: one `DRIVE_OP_REWIND_BEGIN` step per
    /// activation carrying that activation's `child_rewind_root` — the exact root
    /// the host's former per-activation `wpk_fork_rewind_begin(replayRoot)` loop
    /// used (`module_buffer` for a COW child, the child-private prefix for a
    /// borrowed/vfork child). Ascending id order (a `BTreeMap` iterates sorted
    /// keys), matching that loop. Reuses `DRIVE_OP_REWIND_BEGIN` — the same op and
    /// drive-table slot parent replay uses — so no new codec op or injector branch
    /// is needed; only the root differs (child rewind root vs the parent's
    /// `module_buffer`). Serialized through the shared plan scratch; the count is
    /// read back via `GC_PLAN_COUNT`.
    fn build_child_rewind_plan_impl() -> Result<usize, Errno> {
        let st = state().as_ref().ok_or(Errno::EINVAL)?;
        let roots: alloc::vec::Vec<(u32, u64)> = st
            .activations
            .iter()
            .map(|(id, act)| (*id, act.child_rewind_root))
            .collect();
        let mut steps = alloc::vec::Vec::new();
        drive_plan::append_rewind_begin_steps(&mut steps, &roots);
        serialize_and_store_plan(&steps)
    }

    /// Sequence a whole CHILD reconstruct rewind-begin phase in the module
    /// (control-flow inversion): build the per-activation REWIND-begin drive plan
    /// from each activation's stored `child_rewind_root`, then drive it through the
    /// injector-wired shim, which `call_indirect`s each activation's guest
    /// `wpk_fork_rewind_begin(root)` in ascending id order.
    ///
    /// Unlike `parent_replay_impl` there is NO begin step here: the child's replay
    /// state was already seeded by `fm_begin_child_replay` /
    /// `fm_add_activation_child_replay` (or the borrowed variants) BEFORE this
    /// call — the coarse entry folds ONLY the host's former per-activation
    /// `wpk_fork_rewind_begin` loop in `attachModuleChild` /
    /// `attachBorrowedModuleChild`. A zero-activation state is a truthful `EINVAL`
    /// (a child always has at least the primary activation); a guest reconstruction
    /// failure traps inside the shim exactly as it did under the host loop.
    fn child_reconstruct_impl() -> Result<(), Errno> {
        {
            let st = state().as_ref().ok_or(Errno::EINVAL)?;
            if st.activations.is_empty() {
                return Err(Errno::EINVAL);
            }
        }
        let plan = build_child_rewind_plan_impl()?;
        let count = GC_PLAN_COUNT.load(Ordering::Relaxed);
        if count > 0 {
            drive_plan_via_injector(plan, count);
        }
        Ok(())
    }

    /// Build a capture-SEAL drive plan: one `DRIVE_OP_UNWIND_END` step per open
    /// activation (ascending id order — a `BTreeMap` iterates sorted keys), so the
    /// injected shim `call_indirect`s each activation's guest
    /// `wpk_fork_unwind_end()` in the same order the host's former per-activation
    /// seal loop used. The step is argument-free (`() -> ()`), so it carries no
    /// root. Serialized through the shared plan scratch; the step count is read
    /// back via `GC_PLAN_COUNT` exactly as the rewind plan.
    fn build_seal_plan_impl() -> Result<usize, Errno> {
        let st = state().as_ref().ok_or(Errno::EINVAL)?;
        let activations: alloc::vec::Vec<u32> = st.activations.keys().copied().collect();
        let mut steps = alloc::vec::Vec::new();
        drive_plan::append_unwind_end_steps(&mut steps, &activations);
        serialize_and_store_plan(&steps)
    }

    /// Sequence a whole capture SEAL in the module (control-flow inversion): drive
    /// each open activation's guest `wpk_fork_unwind_end()` (moving it from
    /// `UNWINDING` back to `NORMAL`) through the injector-wired shim, then seal
    /// every activation's frame writer + the process journal (`finish_unwind_impl`)
    /// and serialize the child-inheritable KFRE journal image into a freshly
    /// channel-mmap'd chunk (`serialize_journal_alloc_impl`). Returns the image
    /// chunk's guest offset (the byte length is read back via
    /// `fm_journal_image_len`).
    ///
    /// This folds the host's former three-part seal — a per-activation
    /// `wpk_fork_unwind_end()` loop, then `fm_finish_unwind`, then
    /// `fm_serialize_journal_alloc` — into ONE module call. Order is identical to
    /// that host sequence: drive FIRST (every activation to `NORMAL`), THEN seal +
    /// serialize the now-complete journal.
    ///
    /// ONLY for a COMPLETE capture — every frame committed. A partial/aborted
    /// capture (a mid-unwind `frame_reserve` failure) must NOT reach here: driving
    /// `wpk_fork_unwind_end` while the guest is mid-unwind corrupts the guest
    /// unwind state machine (the prior trap). That path stays on the host's
    /// `fm_finish_unwind`-only `sealForAbort` + abort-replay.
    ///
    /// Truthful failure: a guest reconstruction/seal failure traps inside the shim
    /// exactly as it did under the host loop; a `finish_unwind` or serialize error
    /// (e.g. the child-inheritable image chunk could not be channel-mmap'd) is a
    /// truthful errno (`fm_last_errno`) with a 0 return, so the host can reroute a
    /// seal-time OOM to abort-replay rather than trap.
    fn seal_capture_impl(channel_base: u64) -> Result<u64, Errno> {
        let plan = build_seal_plan_impl()?;
        let count = GC_PLAN_COUNT.load(Ordering::Relaxed);
        if count > 0 {
            drive_plan_via_injector(plan, count);
        }
        finish_unwind_impl()?;
        serialize_journal_alloc_impl(channel_base)
    }

    /// Build a REPLAY-FINISH drive plan: one `DRIVE_OP_REWIND_END` (`abort` false)
    /// or `DRIVE_OP_ABORT_END` (`abort` true) step per open activation (ascending
    /// id order — a `BTreeMap` iterates sorted keys), so the injected shim
    /// `call_indirect`s each activation's guest `wpk_fork_rewind_end()` /
    /// `wpk_fork_abort_end()` in the same order the host's former per-activation
    /// finish loop used. Each step is argument-free (`() -> ()`), so it carries no
    /// root. Serialized through the shared plan scratch; the step count is read
    /// back via `GC_PLAN_COUNT` exactly as the seal plan.
    fn build_finish_plan_impl(abort: bool) -> Result<usize, Errno> {
        let st = state().as_ref().ok_or(Errno::EINVAL)?;
        let activations: alloc::vec::Vec<u32> = st.activations.keys().copied().collect();
        let mut steps = alloc::vec::Vec::new();
        drive_plan::append_replay_end_steps(&mut steps, &activations, abort);
        serialize_and_store_plan(&steps)
    }

    /// Sequence a whole REPLAY FINISH in the module (control-flow inversion): drive
    /// each open activation's guest `wpk_fork_rewind_end()` (`abort` false, moving
    /// it from `REWINDING` back to `NORMAL`) or `wpk_fork_abort_end()` (`abort`
    /// true, `ABORT_UNWINDING` back to `NORMAL`) through the injector-wired shim,
    /// then finish the process replay/abort — exhaust every activation's driver +
    /// finish the process journal + release this fork's channel-mapped chunks
    /// (`finish_replay_impl` / `finish_abort_impl`).
    ///
    /// This folds the host's former two-part finish — a per-activation
    /// `wpk_fork_rewind_end()` / `wpk_fork_abort_end()` loop, then
    /// `fm_finish_replay` / `fm_finish_abort` — into ONE module call. Order is
    /// identical to that host sequence: drive FIRST (every activation to `NORMAL`),
    /// THEN finish. The abort finish still asserts the `in_abort` pairing
    /// `fm_parent_replay(abort=1)` set (`finish_abort_impl`), so a `fm_parent_finish(abort=1)`
    /// without a matching abort begin is a loud `EINVAL`, never a silent no-op.
    ///
    /// A guest end flip that traps (e.g. finishing before the rewind consumed
    /// every frame) traps inside the shim exactly as it did under the host loop; a
    /// driver-not-exhausted / journal error is a truthful errno.
    fn finish_transaction_impl(abort: bool) -> Result<(), Errno> {
        let plan = build_finish_plan_impl(abort)?;
        let count = GC_PLAN_COUNT.load(Ordering::Relaxed);
        if count > 0 {
            drive_plan_via_injector(plan, count);
        }
        if abort {
            finish_abort_impl()
        } else {
            finish_replay_impl()
        }
    }

    // The step count of the plan `fm_build_gc_plan` last serialized (the `count`
    // argument for `fm_drive_execute`).
    static GC_PLAN_COUNT: AtomicU32 = AtomicU32::new(0);

    // Monotonic count of DRIVE STEPS this module has executed since worker start
    // (Phase 6 item 3c — the production typed-GC drive flip). The injected
    // `fm_drive_execute` shim calls `fm_drive_bump` once per plan step it drives
    // (each `call_indirect` into the guest's `_gc_allocate`/`_gc_fill`/
    // `_exception_materialize`), so a nonzero value is positive proof the MODULE
    // drove the typed allocate/fill/exn topological order — distinct from
    // `GC_NODES_RECONSTRUCTED`, which `fm_begin_reference_replay` bumps merely by
    // ADMITTING a typed-GC graph (the item 3a data feed). A flag-on fork that fell
    // back to the JS `materializeAllTyped` drive-order leaves this at zero. Never
    // resets.
    static DRIVE_STEPS_EXECUTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of frames the module has committed since worker start.
    // Proof-of-use for the host: after a flag-on fork drives the continuation
    // through this module, the counter has advanced past its pre-fork value. A
    // silent fallback to the JavaScript path leaves it unchanged.
    static FRAMES_COMMITTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of frames the module has REPLAYED (consuming rewind
    // advances via `__wpk_fork_frame_next`) since worker start. The replay-side
    // proof-of-use mirror of `FRAMES_COMMITTED`: a replay-only forked CHILD
    // never commits a frame (`FRAMES_COMMITTED` stays 0 there), so the frame
    // count alone cannot prove the child drove its rewind through this module.
    // A fork-from-thread child (Phase 6 D7b) carries no references either, so
    // `REFERENCES_RECONSTRUCTED` also stays 0. This counter advances once per
    // consumed frame on any worker that rewinds through the module (parent
    // replay AND child replay), so the child worker can positively prove module
    // use; a silent JS fallback leaves it unchanged. Never resets.
    static FRAMES_REPLAYED: AtomicU64 = AtomicU64::new(0);

    // -- Reference reconstruction (Phase 6 D6.1 — funcref + null) -----------
    //
    // The decoded funcref/null reference graph for the current fork, seeded once
    // by `fm_begin_reference_replay` from the KFMS module-state arena and
    // consulted by `fm_funcref_ordinal` (the helper the injected
    // `__wpk_fork_ref_decode_funcref` shim calls) during the guest's rewind.
    // Held in its own static so it is independent of the frame `ForkModule`
    // lifecycle: the guest interleaves reference decode with frame next/peek.
    struct ReferenceStateCell(UnsafeCell<Option<ReferenceReplayDriver>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ReferenceStateCell {}
    static REFERENCE_STATE: ReferenceStateCell = ReferenceStateCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn reference_state() -> &'static mut Option<ReferenceReplayDriver> {
        // SAFETY: single-threaded per worker; only one guest drives the imports.
        unsafe { &mut *REFERENCE_STATE.0.get() }
    }

    // Monotonic count of references the module has reconstructed (funcref or
    // null) since worker start. Proof-of-use mirror of `FRAMES_COMMITTED`: after
    // a flag-on funcref fork drives reconstruction through the module this has
    // advanced; a silent JS fallback leaves it unchanged. Never resets.
    static REFERENCES_RECONSTRUCTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of externrefs this fork's graph reconstructs since worker
    // start (Phase 6 D6.2, host seam retired M2). Proof-of-use mirror of
    // `REFERENCES_RECONSTRUCTED` for the externref path: `fm_begin_reference_
    // replay` bumps this by `drive_reconstruction`'s graph-derived externref-node
    // count — the GRAPH'S expectation of how many externrefs get resolved, not a
    // live host round trip (since M2 no Rust `wpk_fork_host` seam performs that
    // resolve/publish; it is injected wasm). Since the 2026-09-05 substrate fix,
    // EVERY `Externref` recipe — directly held (frame-vector-only) and
    // GC/exnref-reachable alike — is resolved+published by a
    // `DRIVE_OP_EXTERNREF_TRANSIT` step through `fm_externref_handle`; there is
    // no separate lazy per-value decode import in the built architecture. A
    // silent JS fallback (the module was never asked to drive the reference
    // reconstruction) leaves this unchanged. Never resets.
    static EXTERNREFS_RESOLVED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of exnref nodes the module has admitted and driven through
    // reference reconstruction since worker start (Phase 6 D6.3a). Proof-of-use
    // mirror of `EXTERNREFS_RESOLVED` for the exnref path: `fm_begin_reference_
    // replay` bumps this by the admitted graph's exnref-node count. The DRIVE
    // itself leaves the Exnref arm inert — the guest export
    // `__wpk_fork_exception_materialize` mints/throws its own module-local tag —
    // so this count (not the externref `reconstructed` count) is what proves the
    // module, not a silent JS fallback, handled an exnref-bearing graph. Its
    // reachable externref payloads are rooted by the same PHASE B transit path.
    // Never resets.
    static EXNREFS_RECONSTRUCTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of typed-GC nodes (struct + array + i31) the module has
    // admitted and driven since worker start (Phase 6 D6.4a). Proof-of-use mirror
    // of `EXNREFS_RECONSTRUCTED` for the typed-GC path: `fm_begin_reference_replay`
    // bumps this by the admitted graph's GC-node count. The DRIVE itself leaves the
    // Struct/Array/I31 arms inert — the module precedes the guest, so the guest
    // export drives the GC allocate/fill under the JS order, and i31 is a scalar
    // leaf — so this count (not the externref `reconstructed` count) is what proves
    // the module, not a silent JS fallback, admitted a typed-GC graph. Any
    // struct/array-reachable externref leaves are rooted by the same PHASE B
    // transit path. Never resets.
    static GC_NODES_RECONSTRUCTED: AtomicU64 = AtomicU64::new(0);

    // Monotonic count of static roots the static-root binder has resolved for
    // publish since worker start. Proof-of-use for the static-root DRIVE step: the
    // injected `fm_drive_execute` shim calls `fm_static_root_slot` once per
    // DRIVE_OP_STATIC_ROOT step to get the merged-catalog index it `table.get`s and
    // publishes into the anyref transit, and that helper bumps this. A nonzero
    // value after a flag-on static-root fork proves the module — not a silent JS
    // `publishTransit` fallback — republished the immutable roots. Never resets.
    static STATIC_ROOTS_PUBLISHED: AtomicU64 = AtomicU64::new(0);

    // The bookkeeping result of the last `fm_begin_reference_replay` drive for
    // this fork. Since M2 `ReconstructionState` carries NO host identities and NO
    // host generation (that seam retired — see its doc): it is just the
    // graph-derived externref count already folded into `EXTERNREFS_RESOLVED`.
    // Held alongside `REFERENCE_STATE`, independent of the frame `ForkModule`
    // lifecycle, as a diagnostic anchor for the last drive.
    struct ReconstructionStateCell(UnsafeCell<Option<ReconstructionState>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ReconstructionStateCell {}
    static RECONSTRUCTION_STATE: ReconstructionStateCell =
        ReconstructionStateCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn reconstruction_state() -> &'static mut Option<ReconstructionState> {
        // SAFETY: single-threaded per worker; only one guest drives the imports.
        unsafe { &mut *RECONSTRUCTION_STATE.0.get() }
    }

    // -- Reference RESTORE data-feed (Phase 6 item 3a — minimize host surface)
    //
    // The mutable per-fork REPLAY state the seven `fm_ref_*` data-feed exports
    // accumulate on top of the immutable decoded transaction (the growing
    // reference-vector overlay + its intern index + the GC-vector ordinal cache
    // + the exnref cache-index map). Seeded by `fm_begin_reference_replay`
    // alongside the driver and consulted by the guest's typed-GC/exnref codec
    // through the flipped `__wpk_fork_ref_{gc,exn,vector}_*` imports during the
    // JS drive-order's `_gc_allocate`/`_gc_fill` walk. Held in its OWN static so
    // it is independent of the immutable `REFERENCE_STATE` driver: the driver's
    // transaction is READ-ONLY here and the feed's mutation is confined to this
    // cell, so the module->guest->module reentrancy (the still-JS drive calls the
    // guest `_gc_allocate`, which calls back into these module exports) is
    // borrow-safe — each export borrows this cell fresh, does its synchronous
    // work, and returns before the guest can re-enter.
    struct ReferenceFeedCell(UnsafeCell<Option<ReferenceReplayFeed>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for ReferenceFeedCell {}
    static REFERENCE_FEED: ReferenceFeedCell = ReferenceFeedCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn reference_feed() -> &'static mut Option<ReferenceReplayFeed> {
        // SAFETY: single-threaded per worker; only one guest drives the imports.
        unsafe { &mut *REFERENCE_FEED.0.get() }
    }

    // Monotonic count of RESTORE data-feed reads the module has served since
    // worker start (Phase 6 item 3a). Proof-of-use: after a flag-on GC/exnref
    // fork drives its typed-graph reconstruction, the guest codec reads the graph
    // through the module's `fm_ref_*` feed exports and this advances; a silent JS
    // fallback (the imports stayed on the JS reference provider) leaves it
    // unchanged. Bumped by every route/payload-length/load/vector read. Never
    // resets.
    static REFERENCE_FEED_READS: AtomicU64 = AtomicU64::new(0);

    // -- Module-owned wire-graph decode + externref-handle scan (orchestration
    //    migration increment 1) -------------------------------------------------
    //
    // The decoded reference transaction the module OWNS for the current fork's
    // decode/scan path, seeded by `fm_decode_reference_graph` from the KFMS
    // module-state arena. This is the module-owned equivalent of the JS
    // `decodeSegmentedForkReferenceTransaction` result: it lets the host (in a
    // later host-rewire increment) stop decoding the wire graph in TypeScript
    // (`fork-reference-segments.ts`) and stop scanning externref handles in
    // TypeScript (`scanSegmentedForkReferenceExternrefHandles`,
    // `fork-externref-process-owner.ts`), routing both through the ONE shared
    // `fork_codec` decoder that already backs `fm_begin_reference_replay`. Held
    // in its OWN static, independent of the replay `REFERENCE_STATE` driver: the
    // pre-launch externref-handle scan runs BEFORE any replay driver is seeded,
    // and a decode may be requested purely to inspect the graph.
    struct DecodedGraphCell(UnsafeCell<Option<SegmentedReferenceTransaction>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for DecodedGraphCell {}
    static DECODED_GRAPH: DecodedGraphCell = DecodedGraphCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn decoded_graph() -> &'static mut Option<SegmentedReferenceTransaction> {
        // SAFETY: single-threaded per worker; only one host drives decode/scan.
        unsafe { &mut *DECODED_GRAPH.0.get() }
    }

    // Monotonic count of reference graphs the module has DECODED from a KFMS
    // arena since worker start. Proof-of-use for the decode flip: after the host
    // routes wire-graph decode through `fm_decode_reference_graph` this has
    // advanced past its pre-fork value; a silent fallback to the TypeScript
    // `decodeSegmentedForkReferenceTransaction` leaves it unchanged. Never resets.
    static REFERENCE_GRAPHS_DECODED: AtomicU64 = AtomicU64::new(0);

    // Retained STATS SLOT (fm_stats field 10) held for the frozen host/native
    // stats-field contract. The externref-handle scan primitive that once wrote
    // it (`fm_scan_externref_handles`) was a JS-test-only export and has been
    // removed; no production or native path ever called it, so this counter now
    // stays 0. Keeping the slot avoids renumbering the downstream FM_STAT_* field
    // indices native and the host depend on.
    static EXTERNREF_HANDLES_SCANNED: AtomicU64 = AtomicU64::new(0);

    // -- Reference CAPTURE session (Path B P3 — module-owned encode graph) ----
    //
    // The encode-side sibling of `REFERENCE_STATE`/`REFERENCE_FEED`. As the
    // parent's instrumented `wpk_fork_module_state_save` walk discovers Wasm
    // reference values, the host's thin capture-import bodies resolve each value
    // to its recipe COORDINATE using the irreducible per-host identity floor (V8
    // `WeakMap` externref provenance / the transit `table.get`; native's
    // `Rooted`+`ref_eq`) and then intern that coordinate here through the SHARED
    // `fork_codec::ReferenceGraphBuilder` — byte-for-byte the same graph the
    // decoder reconstructs. This is exactly native's shape (`guest.rs`'s capture
    // bodies call `graph.intern_externref`, etc.), lifted to a module export so
    // BOTH V8 hosts route capture interning through the ONE shared builder
    // instead of the per-host TypeScript `ForkReferenceTransaction` capture graph.
    // The floor stays host-side: the module never sees a live reference — only
    // resolved i32/i64 coordinates.
    struct CaptureCell(UnsafeCell<Option<ReferenceGraphBuilder>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CaptureCell {}
    static CAPTURE_STATE: CaptureCell = CaptureCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn capture_state() -> &'static mut Option<ReferenceGraphBuilder> {
        // SAFETY: single-threaded per worker; only one guest drives capture.
        unsafe { &mut *CAPTURE_STATE.0.get() }
    }

    // Whether a capture session is live for the current fork. `fm_capture_begin`
    // sets this AND creates the builder EAGERLY (see there); `fm_begin_unwind`
    // consumes it (`swap(0)`) to decide whether it, rather than
    // `fm_capture_begin`, owns the fork's single bump-heap reset. The builder
    // must be allocated from a bump that is reset exactly once per fork, at the
    // true fork start (`fm_capture_begin`), because the guest encodes references
    // BOTH before and after `fm_begin_unwind`; resetting again in
    // `fm_begin_unwind` would reclaim the live builder mid-fork. So the builder
    // survives capture, seal, and the parent's own `fm_capture_vector_get` replay
    // reads (no further reset occurs on the parent path).
    static CAPTURE_ARMED: AtomicU32 = AtomicU32::new(0);

    /// Host-assigned reference identity -> recipe, for the current capture.
    ///
    /// Wasm can COMPARE two GC references (`ref.eq` validates on `eqref`) but
    /// cannot HASH one: there is no `ref.hash`, so a reference cannot key a map
    /// inside the module and the only in-module algorithm is a linear scan of
    /// every value published so far -- O(n) per lookup, O(n^2) over a capture.
    /// The host hands back a stable small integer per distinct reference and
    /// this maps it, which is O(1) amortised.
    ///
    /// Per-CAPTURE, so bump-backed and reclaimed with the fork is correct here
    /// -- unlike the dirty-page set, which records mutations made long before
    /// any fork and therefore cannot live in the bump.
    struct IdentityCell(UnsafeCell<Option<BTreeMap<u32, u32>>>);
    // SAFETY: single-threaded per worker, as `state()`.
    unsafe impl Sync for IdentityCell {}
    static GC_IDENTITY: IdentityCell = IdentityCell(UnsafeCell::new(None));

    #[allow(clippy::mut_from_ref)]
    fn gc_identity() -> &'static mut Option<BTreeMap<u32, u32>> {
        unsafe { &mut *GC_IDENTITY.0.get() }
    }

    /// In-flight guest reference-vector: `(handle + 1, promised, appended)`.
    /// Zero in slot 0 means no vector is open.
    ///
    /// The guest declares its slot count up front — `fork-instrument` emits
    /// `i32.const slots.len()` immediately before `__wpk_fork_ref_vector_begin`
    /// — and then appends exactly that many recipes. Recording the promise is
    /// what lets `__wpk_fork_ref_vector_finish` reject a vector that did not
    /// receive the appends it declared, which matters because the guest-facing
    /// `append` returns NOTHING: without this, a failed append would be visible
    /// only as a short vector at replay, in the child, long after the cause.
    ///
    /// One slot is enough because the emitted sequence is straight-line:
    /// `begin`, N x (`encoder`, `append`), `finish`, with no guest call between
    /// them (the encoders re-enter this module, never the guest). A second
    /// `begin` before a `finish` would mean that shape changed, so it is a loud
    /// `EINVAL` rather than a silently mis-counted vector.
    static VECTOR_IN_FLIGHT: [AtomicU32; 3] =
        [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)];

    /// The resident capture builder for the current fork. `fm_capture_begin`
    /// creates it eagerly; this is the accessor the capture exports use. As a
    /// defensive fallback it also creates the builder if a session is armed but
    /// the builder is somehow absent. `Err(EINVAL)` if no capture session is
    /// armed (a misordered host call).
    #[allow(clippy::mut_from_ref)]
    fn capture_builder() -> Result<&'static mut ReferenceGraphBuilder, Errno> {
        let slot = capture_state();
        if slot.is_none() {
            if CAPTURE_ARMED.load(Ordering::Relaxed) == 0 {
                return Err(Errno::EINVAL);
            }
            *slot = Some(ReferenceGraphBuilder::begin());
        }
        Ok(slot.as_mut().unwrap())
    }

    // Owns the serialized KFRV/KFRS record stream `fm_capture_serialize` emits so
    // the pointer it returns stays valid while the host drains the records into
    // its module-state arena (mirrors `DRIVE_PLAN`'s rooting of the drive plan).
    struct CaptureSerializedCell(UnsafeCell<Option<Vec<u8>>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CaptureSerializedCell {}
    static CAPTURE_SERIALIZED: CaptureSerializedCell = CaptureSerializedCell(UnsafeCell::new(None));

    // Monotonic count of reference coordinates the module has INTERNED into the
    // shared capture builder since worker start (Path B P3). Proof-of-use mirror
    // of `REFERENCES_RECONSTRUCTED` for the CAPTURE (parent/encode) side: after a
    // flag-on fork routes capture through the module this has advanced past its
    // pre-fork value; a silent fallback to the TypeScript capture graph leaves it
    // unchanged. Bumped once per successful intern/claim/define/gated-placeholder.
    // Never resets.
    static CAPTURE_INTERNED: AtomicU64 = AtomicU64::new(0);

    // The i32 sentinels `fm_funcref_ordinal` returns to the injected wasm shim.
    // A NON-NEGATIVE value is a catalog ordinal for `table.get`; `NULL_ORDINAL`
    // means reconstruct `ref.null func`. The shim treats every other negative as
    // impossible: `fm_funcref_ordinal` traps (unreachable) on any inconsistency
    // rather than hand back a value the shim would misread, so a corrupt graph is
    // a truthful hard failure, never a wrong funcref.
    const NULL_ORDINAL: i32 = -1;

    // Owns the serialized drive plan's backing bytes so the guest pointer a plan
    // builder returns stays valid while the injected `fm_drive_execute` shim reads
    // it. Held in its OWN static (the bump `dealloc` is a no-op, but keeping the
    // `Vec` rooted here is explicit and independent of the per-fork heap reset).
    struct DrivePlanCell(UnsafeCell<Option<Vec<u8>>>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for DrivePlanCell {}
    static DRIVE_PLAN: DrivePlanCell = DrivePlanCell(UnsafeCell::new(None));

    fn build_trivial_plan_impl(activation: u32, recipe: u32, _pid: u32) -> Result<usize, Errno> {
        // The injected shim's post-ALLOC integrity guard reads STORE #2 (the
        // guest's Wasm-GC transit table) directly, so no host generation is opened
        // here.
        // Serialize the trivial ALLOC-then-FILL plan into a module-owned buffer;
        // its guest address is what `fm_drive_execute` strides over.
        let steps = drive_plan::trivial_struct_plan(activation, recipe);
        let mut buf = Vec::new();
        buf.resize(drive_plan::DRIVE_STEP_SIZE * steps.len(), 0u8);
        drive_plan::serialize_plan(&steps, &mut buf)?;
        let ptr = buf.as_ptr() as usize;
        // SAFETY: single-threaded per worker; rooting the backing bytes so the
        // returned pointer stays valid for the shim's reads.
        unsafe {
            *DRIVE_PLAN.0.get() = Some(buf);
        }
        Ok(ptr)
    }

    fn set_format_impl(
        pointer_width: u32,
        fixed_prefix_size: u32,
        archive_control_addr: usize,
        table_owner: u32,
        channel_base: usize,
    ) -> Result<(), Errno> {
        // The ABI only defines linked-frame geometry for 32- and 64-bit guests.
        if abi::wpk_fork_linked_chunk_header_size(pointer_width as u8).is_none() {
            return Err(Errno::EINVAL);
        }
        // `fm_set_format` is the FIRST module call of a worker's setup (see the
        // "once-per-worker fm_set_format / fm_set_resume_catalog contract"), run
        // once before any fork drives capture or reconstruction. Reset the
        // per-worker "seeded once" catalogs here so a COW child starts clean.
        //
        // These catalogs (funcref catalog, funcref/static-root activation bases,
        // host-exception owner, resume catalog) live in the module's BSS, which
        // sits INSIDE the guest's shared linear memory at `__memory_base` (the PIC
        // placement). A COW child's memory is a CLONE of the parent's, so the
        // child's fresh fork-module instance sees the PARENT's already-populated
        // catalogs — and BSS is not re-zeroed on instantiation. Each catalog
        // rejects a re-seed of an already-present activation with `EINVAL`, so
        // without this reset the child's own per-activation seeding (which happens
        // AFTER `fm_set_format`) fails as a spurious re-seed. This surfaced as
        // errno 22 on real command-substitution/pipeline forks once the
        // capture-builder trap that previously masked it was fixed. Resetting the
        // counters is enough: the backing arenas are addressed by these offsets and
        // are overwritten by the fresh seeds.
        //
        // The GC codec catalog (`ACT_GC_CODEC_*`) is DELIBERATELY NOT reset here.
        // Unlike the capture-side catalogs above, the native host does NOT re-seed
        // it on a COW child — it relies on inheriting the parent's already-seeded
        // codec — while the Node/browser host DOES re-seed it. A reset here
        // destroyed the inherited codec on the native host, breaking
        // `fm_build_gc_plan` (`errno 22`) for every GC / static-root fork. Instead
        // `set_activation_gc_codec_impl` is idempotent on an identical re-seed, so
        // both a re-seeding host and an inheriting host converge on the same codec
        // without a reset. See that function.
        ACT_CATALOG_ACT_COUNT.store(0, Ordering::Relaxed);
        ACT_CATALOG_ORD_USED.store(0, Ordering::Relaxed);
        ACT_FUNC_CATALOG_BASE_COUNT.store(0, Ordering::Relaxed);
        ACT_STATIC_ROOT_BASE_COUNT.store(0, Ordering::Relaxed);
        // Table-state ownership resets for the same COW reason: a child
        // inheriting the parent's election would answer for coordinates that
        // belong to a table it no longer shares.
        ACT_TABLE_STATE_OWNER_COUNT.store(0, Ordering::Relaxed);
        // Also per-capture state a COW child inherits. `begin_capture_impl`
        // already clears it, and today every read follows a capture -- but that
        // is a reasoning dependency, and this block exists so a COW child starts
        // clean without anyone having to trace call orders.
        reset_captured_externrefs();
        HOST_EXCEPTION_OWNER.store(u32::MAX, Ordering::Relaxed);
        RESUME_CATALOG_LEN.store(0, Ordering::Relaxed);
        // The dylink archive coordinates reset for the same COW reason as the
        // catalogs above, but with a worse failure mode if they did not: a child
        // inheriting the parent's APPLIED generation would decide it is already
        // coherent and skip writes its own table never received. That is a
        // silent wrong answer rather than an errno, so the reset matters more
        // here than anywhere else in this block.
        //
        // Re-seeded, not just cleared, and this is why the coordinates are
        // arguments to THIS call rather than to an entry of their own: a
        // borrowed fork child does not use its own channel's control block, it
        // uses its OWNER's, so the address is not derivable inside the module
        // and has to arrive with the rest of the per-worker setup.
        ARCHIVE_CONTROL.store(archive_control_addr, Ordering::Relaxed);
        ARCHIVE_OWNER.store(table_owner, Ordering::Relaxed);
        CHANNEL_BASE.store(channel_base, Ordering::Relaxed);
        ARCHIVE_APPLIED[0].store(0, Ordering::Relaxed);
        ARCHIVE_APPLIED[1].store(0, Ordering::Relaxed);
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

    /// Transient exchange storage for the guest's recursive payload codecs.
    ///
    /// `fork-instrument` reserves a staging buffer before encoding an
    /// aggregate's payloads and releases it after `define`, strictly nested:
    /// reserve, recurse, define, release. So this is a LIFO STACK, not a bump —
    /// and it is deliberately NOT the module bump heap above, which never
    /// reclaims (`dealloc` is a no-op). Routing scratch through the bump would
    /// make a deep object graph consume the same 4 MiB the capture builder
    /// needs, and never give it back until the next fork.
    ///
    /// **Exhaustion and misuse TRAP rather than returning an error, because the
    /// generator does not check.** The emitted code is
    /// `call scratch_reserve ; local.set $staging` followed directly by writes
    /// through `$staging`; there is no null test. A 0 return would therefore be
    /// written through as an address, corrupting low guest memory. A trap is the
    /// truthful failure — the same choice the drive shim's post-allocate
    /// integrity guard makes.
    /// Dirty table pages for THIS worker, keyed by the physical table's OWNER
    /// id. Worker-level and durable, NOT per-fork.
    ///
    /// # Why not in `ForkModule`
    ///
    /// It was, and that was wrong. `fork-instrument` wraps EVERY `table.set`,
    /// `table.copy`, `table.fill`, `table.init` and `table.grow` in the program
    /// with a mark, gated only on a non-empty range and a last-page cache --
    /// there is no fork-active condition. Marks therefore happen throughout
    /// ordinary execution, because the set has to record what changed SINCE
    /// INSTANTIATION so that whenever a fork does happen the sparse overlay is
    /// correct. A per-fork home dropped almost every mark, and a `BTreeMap` in
    /// the bump heap would not have survived `reset_bump_heap` anyway.
    ///
    /// # Why a fixed bitmap rather than a map
    ///
    /// The bump heap is reclaimed wholesale at each fork, so anything durable
    /// cannot allocate from it. This is a fixed region with a SATURATION flag:
    /// if a page or an owner does not fit, the worker records "everything is
    /// dirty" instead of recording less. Over-approximating the overlay makes a
    /// capture larger; under-approximating makes it WRONG, so saturation is the
    /// only safe direction to fail in.
    const DIRTY_OWNERS: usize = 32;
    const DIRTY_PAGES_PER_OWNER: usize = 4096;
    const DIRTY_WORDS_PER_OWNER: usize = DIRTY_PAGES_PER_OWNER / 64;

    struct DirtyCell(UnsafeCell<DirtyState>);
    // SAFETY: one guest drives these exports per worker, as with every other
    // module static here.
    unsafe impl Sync for DirtyCell {}

    struct DirtyState {
        /// Owner id per slot, `u32::MAX` when the slot is free.
        owners: [u32; DIRTY_OWNERS],
        bits: [[u64; DIRTY_WORDS_PER_OWNER]; DIRTY_OWNERS],
        /// Set when a mark could not be recorded exactly. Every query then
        /// answers as if all pages of every table are dirty.
        saturated: bool,
    }

    static DIRTY: DirtyCell = DirtyCell(UnsafeCell::new(DirtyState {
        owners: [u32::MAX; DIRTY_OWNERS],
        bits: [[0u64; DIRTY_WORDS_PER_OWNER]; DIRTY_OWNERS],
        saturated: false,
    }));

    #[allow(clippy::mut_from_ref)]
    fn dirty() -> &'static mut DirtyState {
        // SAFETY: single-threaded per worker, as `state()` above.
        unsafe { &mut *DIRTY.0.get() }
    }

    impl DirtyState {
        fn slot(&mut self, owner: u32) -> Option<usize> {
            if let Some(i) = self.owners.iter().position(|o| *o == owner) {
                return Some(i);
            }
            let free = self.owners.iter().position(|o| *o == u32::MAX)?;
            self.owners[free] = owner;
            Some(free)
        }

        fn mark(&mut self, owner: u32, first_page: u64, page_count: u64) {
            let Some(last) = first_page.checked_add(page_count) else {
                self.saturated = true;
                return;
            };
            if last > DIRTY_PAGES_PER_OWNER as u64 {
                self.saturated = true;
                return;
            }
            let Some(slot) = self.slot(owner) else {
                self.saturated = true;
                return;
            };
            for page in first_page..last {
                let page = page as usize;
                self.bits[slot][page / 64] |= 1u64 << (page % 64);
            }
        }

        fn count(&self, owner: u32) -> u32 {
            if self.saturated {
                return DIRTY_PAGES_PER_OWNER as u32;
            }
            match self.owners.iter().position(|o| *o == owner) {
                Some(slot) => self.bits[slot].iter().map(|w| w.count_ones()).sum(),
                None => 0,
            }
        }

        fn page(&self, owner: u32, ordinal: u32) -> Option<u64> {
            if self.saturated {
                return (ordinal < DIRTY_PAGES_PER_OWNER as u32).then_some(u64::from(ordinal));
            }
            let slot = self.owners.iter().position(|o| *o == owner)?;
            let mut seen = 0u32;
            for (word_index, word) in self.bits[slot].iter().enumerate() {
                let mut w = *word;
                while w != 0 {
                    let bit = w.trailing_zeros() as usize;
                    if seen == ordinal {
                        return Some((word_index * 64 + bit) as u64);
                    }
                    seen += 1;
                    w &= w - 1;
                }
            }
            None
        }
    }

    const SCRATCH_SIZE: usize = 64 * 1024;

    #[repr(C, align(16))]
    struct ScratchCell(UnsafeCell<[u8; SCRATCH_SIZE]>);
    // SAFETY: single-threaded per worker, exactly as HeapCell above.
    unsafe impl Sync for ScratchCell {}
    static SCRATCH: ScratchCell = ScratchCell(UnsafeCell::new([0u8; SCRATCH_SIZE]));
    static SCRATCH_TOP: AtomicUsize = AtomicUsize::new(0);

    /// The deepest `SCRATCH_TOP` reached since the last per-fork reset.
    ///
    /// The scratch stack is strictly nested (reserve/release around a recursive
    /// encode), so its CURRENT top is 0 again by the time a capture seals and
    /// says nothing about how much room the encode actually needed. A vfork
    /// BORROWED child re-runs the decode side of that same graph in memory it
    /// must own privately, and the capture high-water is the bound the host
    /// reserves from. Kept beside the allocator that moves it, and reset with
    /// it, because a high-water carried across forks would over-reserve every
    /// later child by the worst fork the worker ever ran.
    static SCRATCH_HIGH_WATER: AtomicUsize = AtomicUsize::new(0);

    fn scratch_align(len: usize) -> usize {
        (len.wrapping_add(15)) & !15
    }

    /// Clear a resident bump-backed static WITHOUT running its `Drop`.
    ///
    /// This is the reclaim primitive for the module's resident fork statics
    /// (`DECODED_GRAPH`, `REFERENCE_STATE`, `RECONSTRUCTION_STATE`,
    /// `REFERENCE_FEED`) at the sites the HOST may reach on a COW child before
    /// that child's own `fm_begin_child_replay` bump reset. Each of these statics
    /// lives in the module's BSS at `__memory_base` inside the shared linear
    /// memory, so a COW child's fresh fork-module instance inherits the PARENT's
    /// populated value (wasm does not re-zero BSS on instantiation). By fork time
    /// the parent has already reset and REUSED the low bump addresses those
    /// values' `Vec`/`BTreeMap` interiors point into, so the inherited value is
    /// clobbered: its tree/vector child pointers are garbage. A plain `*slot =
    /// None` would run `Drop`, walking those clobbered nodes and dereferencing
    /// garbage pointers — the fault behind the real pipeline-in-command-
    /// substitution trap (`echo $(echo a | cat)`), seen as "memory access out of
    /// bounds" (a child pointer landing outside guest memory) or `unreachable`.
    ///
    /// `forget` is safe here and frees no real resource: these types own ONLY
    /// bump memory (reclaimed wholesale by the next `ALLOC.reset()`; `dealloc` is
    /// a no-op) plus trivially-droppable scalar leaves. On a NON-COW second fork
    /// in the same worker the slot holds this worker's own live value; forgetting
    /// it merely defers reclaim to the next bump reset, which is exactly what the
    /// bump model already does. So this is a universally-safe replacement for a
    /// reclaiming `*slot = None`, minus the unsafe walk of clobbered inheritance.
    fn abandon_resident<T>(slot: &mut Option<T>) {
        core::mem::forget(slot.take());
    }

    /// Reclaim the module bump heap for a fresh fork, first DROPPING every
    /// bump-allocated static WITHOUT running its `Drop`.
    ///
    /// `ALLOC.reset()` only rewinds the bump cursor; it neither frees nor zeroes
    /// the bytes, and the next allocations REUSE those low addresses. A value
    /// left resident in a static (`state()`'s `ForkModule`, `capture_state()`'s
    /// `ReferenceGraphBuilder`) owns `BTreeMap`s/`Vec`s whose `Drop` WALKS their
    /// nodes in place. If such a value is dropped AFTER the reset+realloc has
    /// overwritten its nodes — or, for a COW child, after the PARENT reused the
    /// bump those inherited nodes point into — the walk follows clobbered child
    /// pointers and traps (`unreachable` or "memory access out of bounds"). This
    /// bit real command-substitution / pipeline forks in several places (capture
    /// builder, decoded graph, replay driver/feed). None of these resident types
    /// has a side-effecting `Drop` — they own ONLY bump memory (reclaimed
    /// wholesale by `ALLOC.reset()` below) plus trivially-droppable scalar leaves
    /// — so `abandon_resident` (`forget`) clears them with zero semantic change
    /// and no unsafe walk. See `abandon_resident`.
    ///
    /// Callers that must KEEP a value live across the reset (an armed capture
    /// builder) skip the reset entirely (see `fm_begin_unwind`'s `CAPTURE_ARMED`
    /// gate) rather than calling this.
    fn reset_bump_heap() {
        abandon_resident(state());
        abandon_resident(capture_state());
        // Bump-backed like the capture builder, so it is abandoned rather than
        // dropped: its `BTreeMap` nodes live in memory the reset reclaims.
        abandon_resident(gc_identity());
        // A capture that trapped or aborted mid-encode leaves its staging frames
        // on the scratch stack. Reclaim them with the bump, or the next fork in
        // this worker starts with a stack that never comes back down.
        SCRATCH_TOP.store(0, Ordering::Relaxed);
        SCRATCH_HIGH_WATER.store(0, Ordering::Relaxed);
        CAPTURE_ARMED.store(0, Ordering::Relaxed);
        // SAFETY: single-threaded per worker; only one fork drives these at a time.
        unsafe {
            abandon_resident(&mut *CAPTURE_SERIALIZED.0.get());
            abandon_resident(&mut *DRIVE_PLAN.0.get());
        }
        ALLOC.reset();
    }

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

    // -- In-realm channel SYS_MMAP (Option B) --------------------------------
    //
    // The module allocates each frame chunk by issuing `SYS_MMAP` through the
    // SAME syscall channel the guest uses, field-for-field mirroring the JS
    // `continuationMmap` (host/src/worker-main.ts). It publishes the request,
    // blocks in-realm on `memory_atomic_wait32(status, PENDING)` until the
    // kernel worker services it, then reads the result. Every offset comes from
    // the shared `channel` ABI module (no re-hardcoded layout).
    //
    // This replaces Option A's fixed host-reserved arena: the module grows
    // memory ON DEMAND like the JS path, so continuation depth is bounded only
    // by available memory, and the host no longer reserves or threads a
    // per-fork arena. `SYS_MMAP` GROWS the shared linear memory, so the caller
    // MUST re-derive any pre-captured memory view afterward (see the
    // `ChunkAllocator::current_memory` re-slice in `fork-codec`).

    /// The combined `PROT_READ | PROT_WRITE` and `MAP_PRIVATE | MAP_ANONYMOUS`
    /// the JS `continuationMmap` uses, composed from the shared flags.
    const PROT_READ_WRITE: i64 = (mmap::PROT_READ | mmap::PROT_WRITE) as i64;
    const MAP_PRIVATE_ANONYMOUS: i64 = (mmap::MAP_PRIVATE | mmap::MAP_ANONYMOUS) as i64;

    /// Absolute-offset little-endian scalar writes into the channel region (the
    /// same guest-offset-as-pointer idiom the frame paths use; no `&mut [u8]`
    /// slice is formed over the channel, so no aliasing with the atomic below).
    unsafe fn ch_write_u32(base: u64, off: usize, value: u32) {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *mut u8;
        unsafe { core::ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), ptr, 4) };
    }
    unsafe fn ch_write_i64(base: u64, off: usize, value: i64) {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *mut u8;
        unsafe { core::ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), ptr, 8) };
    }
    unsafe fn ch_read_u32(base: u64, off: usize) -> u32 {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *const u8;
        let mut bytes = [0u8; 4];
        unsafe { core::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), 4) };
        u32::from_le_bytes(bytes)
    }
    unsafe fn ch_read_i64(base: u64, off: usize) -> i64 {
        let ptr = core::hint::black_box((base as usize).wrapping_add(off)) as *const u8;
        let mut bytes = [0u8; 8];
        unsafe { core::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), 8) };
        i64::from_le_bytes(bytes)
    }

    const CH_PENDING: i32 = ChannelStatus::Pending as i32;
    const CH_IDLE: i32 = ChannelStatus::Idle as i32;

    /// Issue a channel syscall (`nr` + six i64 args), block in-realm until the
    /// kernel worker services it, and return `(ret, errno)`. Mirrors the JS
    /// `continuationMmap`/`continuationMunmap` handshake exactly: write the
    /// request + the DEFER-SIGNAL flag, atomic-store PENDING + notify, spin in
    /// `memory_atomic_wait32` until the status leaves PENDING, read RETURN/ERRNO,
    /// clear the flag, and atomic-store IDLE.
    fn channel_syscall(channel_base: u64, nr: u32, args: [i64; 6]) -> (i64, u32) {
        // SAFETY: `channel_base` is the guest syscall channel region (page-aligned
        // in production). All accesses are within `[channel_base, +HEADER_SIZE)`.
        unsafe {
            ch_write_u32(channel_base, channel::SYSCALL_OFFSET, nr);
            for (index, value) in args.iter().enumerate() {
                ch_write_i64(
                    channel_base,
                    channel::ARGS_OFFSET + index * channel::ARG_SIZE,
                    *value,
                );
            }
            // Caught signals must remain kernel-pending across this host
            // transition (the guest is mid-continuation), exactly as the JS
            // continuation allocator marks its own channel syscalls.
            ch_write_u32(
                channel_base,
                channel::REQUEST_FLAGS_OFFSET,
                channel::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
            );
            let status_ptr =
                core::hint::black_box((channel_base as usize) + channel::STATUS_OFFSET) as *mut i32;
            // Publish PENDING (seq-cst, so the request writes above are visible to
            // the kernel worker) and wake it.
            let status = &*(status_ptr as *const AtomicI32);
            status.store(CH_PENDING, Ordering::SeqCst);
            wasm_intr::memory_atomic_notify(status_ptr, 1);
            // Block until the worker clears PENDING. `== 0` is "woken"; a status
            // that already left PENDING returns "not-equal" and exits the loop.
            while wasm_intr::memory_atomic_wait32(status_ptr, CH_PENDING, -1) == 0 {}
            let ret = ch_read_i64(channel_base, channel::RETURN_OFFSET);
            let err = ch_read_u32(channel_base, channel::ERRNO_OFFSET);
            ch_write_u32(channel_base, channel::REQUEST_FLAGS_OFFSET, 0);
            status.store(CH_IDLE, Ordering::SeqCst);
            (ret, err)
        }
    }

    /// `mmap(NULL, size, RW, MAP_PRIVATE|ANON, -1, 0)` over the channel. Returns
    /// the mapped guest offset, or a TRUTHFUL errno (`ENOMEM`/`EAGAIN`; never a
    /// flattened `EINVAL`) on failure. NOTE: this GROWS shared memory — callers
    /// re-derive their memory view via `ChunkAllocator::current_memory`.
    fn channel_mmap(channel_base: u64, size: u64) -> Result<u64, Errno> {
        let (ret, err) = channel_syscall(
            channel_base,
            Syscall::Mmap as u32,
            [0, size as i64, PROT_READ_WRITE, MAP_PRIVATE_ANONYMOUS, -1, 0],
        );
        if err != 0 || ret < 0 {
            let code = if err != 0 { err } else { (-ret) as u32 };
            return Err(Errno::from_u32(code).unwrap_or(Errno::ENOMEM));
        }
        Ok(ret as u64)
    }

    /// `munmap(addr, size)` over the channel. Symmetric with `channel_mmap`;
    /// returns the truthful errno on failure.
    fn channel_munmap(channel_base: u64, addr: u64, size: u64) -> Result<(), Errno> {
        let (ret, err) = channel_syscall(
            channel_base,
            Syscall::Munmap as u32,
            [addr as i64, size as i64, 0, 0, 0, 0],
        );
        if err != 0 || ret < 0 {
            let code = if err != 0 { err } else { (-ret) as u32 };
            return Err(Errno::from_u32(code).unwrap_or(Errno::EINVAL));
        }
        Ok(())
    }

    // -- Module-owned growing frame-chunk allocator (Option B) --------------
    //
    // Each `allocate` issues a fresh `SYS_MMAP` through the channel, growing the
    // shared memory on demand, and records `(addr, size)` so the chunks can be
    // released (`munmap`) when the fork's replay finishes or aborts. `SYS_MMAP`
    // returns a page-aligned address and every capacity is a page multiple, so
    // the writer's page-alignment invariant holds.
    //
    // A replay-only forked CHILD constructs this with `channel_base == 0` and
    // never calls `allocate` (its `replay_only` guard rejects reserve/commit), so
    // the child mmaps nothing; its `chunks` stays empty and `release_all` is a
    // no-op there.
    /// The fork's chunk list: a doubly-linked run of page-rounded mappings, each
    /// `SYS_MMAP`'d from the kernel on demand at capture time.
    ///
    /// NOT an arena, despite what this type was called until 2026-09-12 and what
    /// several of the comments around it still imply. There is no fixed region
    /// and no cap: `allocate` issues a fresh `SYS_MMAP` per chunk through the
    /// guest syscall channel, the kernel's `find_gap` allocator places it, and
    /// the chunks link to each other (`ModuleStateChunk` carries `previous` and
    /// `next`). Fork depth is bounded by what the kernel will map, nothing more.
    ///
    /// The name mattered: a 2 MiB bounded arena WAS the design briefly, was
    /// reverted when its cap turned out to be a fixture artefact, and the word
    /// outlived it — after which agents kept re-deriving a fixed-size constraint
    /// that no longer exists.
    struct ForkChunkList {
        /// Channel mode: issue each chunk's `SYS_MMAP` through this guest syscall
        /// channel base (page-aligned). `0` on a replay-only child (allocates
        /// nothing).
        channel_base: u64,
        chunks: Vec<(u64, u64)>,
    }

    impl ForkChunkList {
        /// The production growing chunk list: each chunk is `SYS_MMAP`'d through the
        /// guest syscall channel at `channel_base`, growing shared memory on
        /// demand. `0` = a replay-only child that allocates nothing.
        fn new_channel(channel_base: u64) -> Self {
            ForkChunkList {
                channel_base,
                chunks: Vec::new(),
            }
        }

        /// How many chunks this allocator has mapped and not yet released.
        ///
        /// Zero means it owns nothing to free -- either it never allocated, or
        /// it is a `new_channel(0)` allocator that cannot.
        fn release_count(&self) -> usize {
            self.chunks.len()
        }

        /// Best-effort release of every chunk this allocator mapped. Called after
        /// a successful replay finish and on abort; a `munmap` hiccup does not
        /// fail an already-complete fork, so errors are ignored here.
        fn release_all(&mut self) {
            for (addr, size) in self.chunks.drain(..) {
                let _ = channel_munmap(self.channel_base, addr, size);
            }
        }
    }

    impl ChunkAllocator for ForkChunkList {
        fn allocate(&mut self, capacity: u64) -> Result<u64, Errno> {
            let addr = channel_mmap(self.channel_base, capacity)?;
            self.chunks.push((addr, capacity));
            Ok(addr)
        }

        fn current_memory(&self) -> Option<(*mut u8, usize)> {
            // `channel_mmap` grew the shared linear memory; hand the writer a
            // fresh (base, len) so the just-mapped high chunk is in bounds. Base
            // is wasm address 0 (see `mem_mut`); the length is re-queried live.
            Some((core::hint::black_box(0usize) as *mut u8, mem_len_bytes()))
        }
    }

    // -- Per-worker state: activation-keyed frames + process-wide journal ----
    //
    // Phase 6 D7a.2: a dlopen fork has N ACTIVATIONS (activation 0 = the main
    // module, 1..N = the dlopen'd side modules). Each activation owns its own
    // linked-frame writer, frame arena, fixed runtime prefix, rewind driver, and
    // continuation anchor — its FRAMES are independent. The replay JOURNAL and
    // the RESUME-SLOT TABLE stay PROCESS-WIDE: the journal already tags every
    // event with its `activation_id`, so it records the exact interleaved order
    // frames commit across every activation and replays the reverse; the table
    // keys slots by `(activation_id, function_ordinal)`. A single-activation fork
    // is the degenerate case: one entry in the map (`primary_activation`).

    /// The per-activation frame state (one entry per activation id).
    struct ActivationFrames {
        format: LinkedFrameFormat,
        writer: LinkedFrameWriter,
        arena: ForkChunkList,
        driver: Option<RewindDriver>,
        committed_ordinals: Vec<u32>,
        module_buffer: u64,
        /// The continuation root the guest's `wpk_fork_rewind_begin` is driven
        /// with when THIS instance is a replay CHILD (the coarse
        /// `fm_child_reconstruct` drive plan carries it per activation). For a COW
        /// child it equals `module_buffer` (the inherited anchor the guest rewinds
        /// in place); for a vfork BORROWED child it is the child-PRIVATE replay
        /// prefix (`private_prefix`) the module copied the parent's fixed prefix
        /// into, so the guest's active-frame-pointer write lands in private scratch
        /// and never touches the parked parent's prefix. Unused on the parent
        /// (unwind) path, where `fm_parent_replay` drives from `module_buffer`
        /// directly; left 0 there.
        child_rewind_root: u64,
        /// A child (forked) instance seeds its journal from copied guest memory
        /// and only ever replays; it never unwinds, so it has no live frame
        /// arena to reserve into. Guard the reserve/commit exports against it so
        /// a stray guest reserve on a replay-only child is a truthful `EINVAL`
        /// rather than a write into an unowned region.
        replay_only: bool,
    }

    struct ForkModule {
        /// Per-activation frame state, keyed by activation id.
        activations: BTreeMap<u32, ActivationFrames>,
        /// The guest syscall channel base this fork issues chunk `SYS_MMAP`
        /// through (Option B). 0 on a replay-only child, which allocates nothing.
        /// The image chunk `fm_serialize_journal_alloc` maps is released through
        /// this same channel on finish/abort.
        channel_base: u64,
        /// Guest offsets + sizes of any chunk this fork mapped OUTSIDE an
        /// activation's own writer (currently the serialized-journal image
        /// chunk). Released alongside the per-activation chunks on finish/abort.
        extra_chunks: Vec<(u64, u64)>,
        /// The guest offset + byte length of the KFRE journal image
        /// `fm_serialize_journal_alloc` channel-mmap'd (0 until it runs). The
        /// host reads both back (`fm_journal_image_len`) to write the
        /// `JournalImage` KFMS record so the child can find the inherited image.
        journal_image_ptr: u64,
        journal_image_len: u64,
        /// Process-wide KFMS chunk list: the module-state records the guest
        /// writes during `wpk_fork_module_state_save`, and the chunks they live
        /// in. The host owned this until 2026-09-12; the module owns it now, so
        /// the format has one implementation rather than two.
        module_state: ModuleStateWriter,
        module_state_chunks: ForkChunkList,
        /// Process-wide replay-event journal (records `(activation_id, ordinal)`
        /// commits across every activation; replays the global reverse order).
        journal: ReplayEventJournal,
        /// Process-wide resume-slot table (slots keyed by activation + ordinal).
        table: ResumeSlotTable,
        /// A forked CHILD's decoded (capture-order) replay events, ALL
        /// activations, retained from `fm_begin_child_replay` so a later
        /// `fm_add_activation_child_replay` can rebuild a side activation's
        /// committed ordinals by filtering on `activation_id` (the journal itself
        /// is already in the Replay phase and no longer exposes its events).
        /// Empty on the parent (unwind) path.
        replay_events: Vec<ReplayEvent>,
        /// Set by `fm_begin_abort`, asserted by `fm_finish_abort`, cleared by
        /// `fm_finish_abort`/`fm_abort`. Abort-replay drives the exact same
        /// frame/journal mechanics as parent replay (`begin_replay_impl`/
        /// `finish_replay_impl` are delegated to, not duplicated); this flag
        /// only tags the drive so a stray `fm_finish_abort` without a matching
        /// `fm_begin_abort` is a loud `EINVAL` rather than a silent pairing
        /// with `fm_finish_replay`'s bookkeeping.
        in_abort: bool,
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

    // The activation the guest-facing `__wpk_fork_frame_*` exports resolve to.
    // Set by `fm_begin_unwind` / `fm_begin_child_replay`; the legacy
    // single-activation path uses this so the guest ABI is unchanged.
    static PRIMARY_ACTIVATION: AtomicU32 = AtomicU32::new(0);

    fn primary_activation() -> u32 {
        PRIMARY_ACTIVATION.load(Ordering::Relaxed)
    }

    static LAST_ERRNO: AtomicI32 = AtomicI32::new(0);

    fn set_ok() {
        LAST_ERRNO.store(0, Ordering::Relaxed);
    }

    fn set_err(errno: Errno) {
        LAST_ERRNO.store(errno as i32, Ordering::Relaxed);
    }

    // -- Fork lifecycle phase ------------------------------------------------
    //
    // Which capture/replay step the process is in, and which entry points are
    // legal from it. This lived in TypeScript (`ForkProcessContinuationCoordinator`
    // in attic/fork-typescript-do-not-use/fork-process-continuation.ts) as a
    // `requirePhase(expected, operation)` guard in front of every coarse call.
    //
    // It is POLICY, not host floor: nothing about "you cannot seal a capture you
    // never began" needs to observe a JavaScript object. Leaving it in the host
    // meant every host reimplemented the same state machine, and a host that got
    // it wrong called the module out of order -- which the module then had no way
    // to refuse. That is the decoder-drift shape this campaign exists to remove,
    // applied to control flow instead of a wire format.
    //
    // A wrong-phase call answers EBUSY, an errno the module uses for NOTHING else,
    // so a test asserting it cannot be satisfied by an unrelated failure. EINVAL
    // would not have that property: 207 sites already answer it.

    const PHASE_IDLE: u32 = 0;
    const PHASE_CAPTURE: u32 = 1;
    const PHASE_SEALED_PARENT: u32 = 2;
    const PHASE_PARENT_REPLAY: u32 = 3;
    const PHASE_CHILD_REPLAY: u32 = 4;
    const PHASE_ABORT_REPLAY: u32 = 5;

    static PHASE: AtomicU32 = AtomicU32::new(PHASE_IDLE);

    /// Refuse an entry point that is not legal from the current phase.
    fn require_phase(expected: u32) -> Result<(), Errno> {
        if PHASE.load(Ordering::Relaxed) == expected {
            Ok(())
        } else {
            Err(Errno::EBUSY)
        }
    }

    /// Refuse an entry point legal from either of two phases.
    ///
    /// Only the replay-finish entries need this: a parent replay and a child
    /// replay both end at idle through the same call, and collapsing them into
    /// one `require_phase` would mean accepting every phase instead.
    fn require_phase_either(first: u32, second: u32) -> Result<(), Errno> {
        let current = PHASE.load(Ordering::Relaxed);
        if current == first || current == second {
            Ok(())
        } else {
            Err(Errno::EBUSY)
        }
    }

    fn enter_phase(next: u32) {
        PHASE.store(next, Ordering::Relaxed);
    }

    /// Read the coordinator phase: one of the `PHASE_*` values above.
    ///
    /// This is a READ of state the module already owns, not a second copy of
    /// it. The host used to keep its own `phase` field and answer from that,
    /// which is precisely the drift this machine exists to end: two authorities
    /// for one fact, and the module unable to refuse a host that had gotten it
    /// wrong. The module stays the single authority; the host asks.
    ///
    /// Deliberately infallible and not errno-reporting. Every other entry here
    /// answers `EBUSY` when the phase is wrong, but "what phase are we in" has
    /// no wrong phase to be in, and a host branching on the answer must not
    /// have to distinguish "idle" from "the call failed". `PHASE_IDLE` before
    /// any activation exists is the truthful answer, not a default.
    ///
    /// PREFER ACTING TO ASKING. A read followed by the call it guards is two
    /// steps the module cannot make atomic, so the answer is stale in principle
    /// by the time the host branches on it; the refusal is not. This exists for
    /// the host decisions that are not a prelude to a call -- choosing WHICH
    /// entry point to run, and asserting an invariant -- where there is nothing
    /// to attempt and catch. `host/test/fork-module-phase.test.ts` deliberately
    /// does not use it: a behavioural refusal test is the stronger claim,
    /// because an accessor can agree with a broken machine.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_phase() -> u32 {
        PHASE.load(Ordering::Relaxed)
    }

    // -- Coordinator (JS→wasm, once per phase, not hot) ---------------------

    /// Register a fresh unwind activation into `module` over its own MODULE-OWNED
    /// growing arena (Option B: chunks are channel-mmap'd on demand), using `fmt`
    /// (the activation's own fixed runtime prefix). Publishes the activation's
    /// module-buffer anchor and returns it. Rejects a duplicate activation id
    /// with `EINVAL` (each activation is registered once per fork).
    fn register_unwind_activation(
        module: &mut ForkModule,
        activation_id: u32,
        fmt: LinkedFrameFormat,
        mut arena: ForkChunkList,
    ) -> Result<u64, Errno> {
        if module.activations.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // activation already open in this fork
        }
        let mut writer = LinkedFrameWriter::new(fmt);
        // `begin_unwind` channel-mmaps the root chunk, which GROWS shared memory;
        // it re-derives its own memory view via `arena.current_memory`, so the
        // stale pre-grow `mem` slice below is only its entry view.
        let mem = unsafe { mem_mut() };
        let module_buffer = writer.begin_unwind(mem, &mut arena)?;
        module.activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer,
                arena,
                driver: None,
                committed_ordinals: Vec::new(),
                module_buffer,
                // Parent (unwind) path: `fm_parent_replay` drives from
                // `module_buffer`, never this field.
                child_rewind_root: 0,
                replay_only: false,
            },
        );
        Ok(module_buffer)
    }

    fn begin_unwind_impl(activation_id: u32, channel_base: u64) -> Result<u64, Errno> {
        // Option B: the MODULE owns the per-fork frame allocation, issuing each
        // chunk's `SYS_MMAP` through `channel_base` (the guest syscall channel),
        // growing memory on demand like the JS path — no host arena reservation.
        // `fm_begin_unwind` starts a FRESH fork: it reclaims the previous fork's
        // state + heap and registers this activation as the first (and, for a
        // single-activation fork, only) one. Additional activations (a dlopen
        // fork's side modules) are added to the SAME fork with
        // `fm_add_activation_unwind` — no reset.
        if channel_base == 0 || channel_base % PAGE != 0 {
            return Err(Errno::EINVAL); // the syscall channel is page-aligned
        }

        // The format must have been seeded (once) via `fm_set_format`.
        let fmt = format()?;

        // Reclaim the previous fork's state before this fork. The bump-HEAP reset
        // is skipped when a capture session is armed: `fm_capture_begin` already
        // reset the bump at the true fork start (before the guest began encoding
        // references into the co-resident capture builder), and resetting again
        // here would reclaim that live builder mid-fork. `swap(0)` consumes the
        // arming so a later non-capture fork (or a flag-off fork that never calls
        // `fm_capture_begin`) still reclaims the heap here as before.
        if CAPTURE_ARMED.swap(0, Ordering::Relaxed) == 0 {
            // No live capture builder in the bump: reclaim the whole heap,
            // dropping every resident bump-allocated static (including any stale
            // capture builder) BEFORE the reset so a later drop never walks
            // clobbered memory (see `reset_bump_heap`).
            reset_bump_heap();
        } else {
            // A capture is armed: `fm_capture_begin` already reset the bump and the
            // live builder must survive across this unwind, so reclaim only the
            // previous fork's `ForkModule` and leave the bump (and builder) intact.
            *state() = None;
        }

        let mut module = ForkModule {
            activations: BTreeMap::new(),
            channel_base,
            extra_chunks: Vec::new(),
            journal_image_ptr: 0,
            journal_image_len: 0,
            module_state: ModuleStateWriter::new(module_state_format()?),
            module_state_chunks: ForkChunkList::new_channel(channel_base),
            journal: ReplayEventJournal::new(),
            table: ResumeSlotTable::new(),
            replay_events: Vec::new(),
            in_abort: false,
        };
        // One capture spans every activation: commits from all activations are
        // recorded in the single process-wide journal in interleaved order.
        module.journal.begin_capture()?;
        let arena = ForkChunkList::new_channel(channel_base);
        let module_buffer = register_unwind_activation(&mut module, activation_id, fmt, arena)?;

        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(module_buffer)
    }

    /// Add ANOTHER activation to the fork already begun by `fm_begin_unwind`
    /// (Phase 6 D7a.2 — a dlopen fork's side module). `fixed_prefix` is THIS
    /// activation's own module-buffer fixed runtime prefix (side modules carry
    /// their own). The pointer width is the guest's, shared across activations
    /// (seeded once via `fm_set_format`); the fork's channel base is shared too
    /// (this activation mmaps its chunks through the same channel). No reset: the
    /// process-wide journal stays in its capture phase across every activation.
    fn add_activation_unwind_impl(
        activation_id: u32,
        channel_base: u64,
        fixed_prefix: u32,
    ) -> Result<u64, Errno> {
        // Derive this activation's format from the seeded pointer width plus its
        // own fixed prefix, so a side module with a different prefix is honored.
        let base = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base
        };
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Every activation in one worker shares the one syscall channel; a
        // disagreeing base is a host bug, not a silent second channel.
        if channel_base != st.channel_base {
            return Err(Errno::EINVAL);
        }
        let arena = ForkChunkList::new_channel(channel_base);
        register_unwind_activation(st, activation_id, fmt, arena)
    }

    /// Publish the sealed KFMS arena root into an activation's module-buffer
    /// prefix word (`WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET`) — the
    /// module-side of the host `writeForkModuleStateRoot`. Word 0 of the prefix is
    /// the activation-frame cursor (owned by the frame writer); this writes the
    /// arena root into word 1 so a COW child copy finds the inherited arena from
    /// its module buffer. `module_buffer` is the activation's continuation anchor;
    /// `arena_root` the sealed KFMS arena root (page-aligned, host-checked before
    /// the call). Writes `pointer_width` little-endian bytes.
    fn write_module_state_root(module_buffer: u64, arena_root: u64) -> Result<(), Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw != 4 && pw != 8 {
            return Err(Errno::EINVAL);
        }
        let off = module_buffer
            .checked_add(abi::WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET as u64 * pw as u64)
            .ok_or(Errno::EINVAL)?;
        let end = off.checked_add(pw as u64).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() as u64 {
            return Err(Errno::EINVAL);
        }
        // SAFETY: `[off, off + pw)` is within guest linear memory (checked above);
        // the same guest-offset-as-pointer idiom the frame paths use.
        unsafe {
            let ptr = core::hint::black_box(off as usize) as *mut u8;
            if pw == 4 {
                core::ptr::copy_nonoverlapping(
                    (arena_root as u32).to_le_bytes().as_ptr(),
                    ptr,
                    4,
                );
            } else {
                core::ptr::copy_nonoverlapping(arena_root.to_le_bytes().as_ptr(), ptr, 8);
            }
        }
        Ok(())
    }

    /// Sequence a whole capture BEGIN in the module (control-flow inversion): open
    /// the fork's activations, publish each activation's arena root into its
    /// module-buffer prefix, then drive each activation's guest
    /// `wpk_fork_unwind_begin(root)` through the injector-wired `fm_drive_execute`
    /// shim in ascending id order. Folds the host's former per-activation
    /// `fm_begin_unwind` / `fm_add_activation_unwind` + `writeForkModuleStateRoot`
    /// + `wpk_fork_unwind_begin` loop into ONE module call.
    ///
    /// Activation 0 opens the FRESH capture (`begin_unwind_impl`, which reclaims
    /// the previous fork's state). Each side activation (a dlopen fork's side
    /// module) is read as an `(id: u32, fixed_prefix: u32)` pair from the
    /// host-seeded `sides` scratch (`[sides_ptr, sides_ptr + sides_count*8)`) and
    /// added to the SAME capture (`add_activation_unwind_impl`). A single-activation
    /// fork passes `sides_count == 0`. Returns activation 0's module-buffer anchor
    /// (0 on failure; check `fm_last_errno`) — the host publishes it as the process
    /// launch root and records `forkBufAddr`. The host reads each side activation's
    /// anchor back via `fm_activation_module_buffer` for the activation-continuation
    /// manifest. A guest reconstruction failure traps inside the shim exactly as it
    /// did under the host loop; a create/plan-build failure is a truthful errno.
    fn begin_capture_impl(
        channel_base: u64,
        arena_root: u64,
        sides_ptr: u64,
        sides_count: u64,
    ) -> Result<u64, Errno> {
        // A fresh capture records a fresh externref set. Without this a COW child,
        // which inherits this module's memory, would report the handles its
        // PARENT interned and lease references it does not hold.
        reset_captured_externrefs();
        // Activation 0: open the fresh capture (reclaims prior fork state) and
        // publish its arena root.
        let root0 = begin_unwind_impl(0, channel_base)?;
        // `arena_root == 0` asks the module to allocate the KFMS arena root
        // itself, instead of the host allocating it and handing the address in.
        //
        // That handoff is the ownership split census section 133 found: the host
        // mapped chunk one, the module mapped every later chunk as the guest
        // reserved records, and the host freed them ALL by walking the linked
        // list back out of guest memory to rediscover addresses it never held.
        // Allocating here is what lets the module free exactly what it mapped,
        // from a list the guest cannot reach -- which retires the cycle check,
        // the chain-length bound, the per-chunk validation and the
        // publish-only-after-validation ordering the host needed to keep a
        // malformed arena from steering a munmap.
        //
        // A nonzero `arena_root` keeps the old contract, so `crates/host-native`
        // is unaffected and the two hosts can differ while the JS side moves.
        // The host reads the allocated root back with `fm_module_state_arena(0)`
        // rather than it being returned here, because this entry's return value
        // is already activation 0's module-buffer anchor.
        // Whether the MODULE owns this arena. It decides who declares the
        // activation set below: a host that supplies its own root also writes
        // its own `Module` records, and the module writing a second set would
        // not overwrite them -- the writer's root is still 0, so `reserve` would
        // start a SEPARATE arena on the same channel, and the records would land
        // somewhere nothing reads while the host's arena stayed empty.
        let module_owns_arena = arena_root == 0;
        let arena_root = if arena_root == 0 {
            let st = state().as_mut().ok_or(Errno::EINVAL)?;
            let mem = unsafe { mem_mut() };
            let ForkModule { module_state, module_state_chunks, .. } = st;
            module_state.begin(module_state_chunks, mem)?
        } else {
            arena_root
        };
        write_module_state_root(root0, arena_root)?;

        // Side activations (a dlopen fork): read each (id, fixed_prefix) pair from
        // the host-seeded scratch, add it to the SAME capture, publish its root.
        let count = usize::try_from(sides_count).map_err(|_| Errno::EINVAL)?;
        if count > 0 {
            let bytes = (count as u64).checked_mul(8).ok_or(Errno::EINVAL)?;
            let end = sides_ptr.checked_add(bytes).ok_or(Errno::EINVAL)?;
            if sides_ptr == 0 || end > mem_len_bytes() as u64 {
                return Err(Errno::EINVAL);
            }
            for i in 0..count {
                let off = (i as u64) * 8;
                let id = unsafe { ch_read_u32(sides_ptr, off as usize) };
                let fixed_prefix = unsafe { ch_read_u32(sides_ptr, (off + 4) as usize) };
                if id == 0 {
                    // Activation 0 is opened above; a side entry naming it is a
                    // host bug, not a silent double-open.
                    return Err(Errno::EINVAL);
                }
                let root = add_activation_unwind_impl(id, channel_base, fixed_prefix)?;
                write_module_state_root(root, arena_root)?;
            }
        }

        // Drive each activation's guest `wpk_fork_unwind_begin(root)` in ascending
        // id order (a `BTreeMap` iterates sorted keys) through the injected shim —
        // ONE control-flow-inverted drive replacing the host per-activation loop.
        let roots: Vec<(u32, u64)> = {
            let st = state().as_ref().ok_or(Errno::EINVAL)?;
            st.activations
                .iter()
                .map(|(id, act)| (*id, act.module_buffer))
                .collect()
        };
        // Declare the activation set into the arena before anything writes to
        // it. One `Module` record per activation, carrying the template id the
        // host seeded -- and the arena has no activation set without them: the
        // child-install path filters the arena on this record kind to decide
        // which activations to drive, so an arena missing them installs nothing
        // rather than failing. This replaces the JS registry's
        // `arena.appendModule({ activationId, templateId })` loop, which ran at
        // exactly this point and for the same reason.
        //
        // ONLY when the module allocated the arena. A caller that passed its own
        // root writes its own records into it, and this block cannot add to that
        // arena anyway -- see `module_owns_arena` above.
        //
        // A host that seeded no template id for an activation is a host bug, not
        // an activation without a module, so it is `EINVAL` rather than a record
        // with a zero id.
        if module_owns_arena {
            let ids: Vec<u32> = {
                let st = state().as_ref().ok_or(Errno::EINVAL)?;
                st.activations.keys().copied().collect()
            };
            let payload_size =
                u64::from(abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE);
            for id in ids {
                let template_id = activation_template_id(id).ok_or(Errno::EINVAL)?;
                let st = state().as_mut().ok_or(Errno::EINVAL)?;
                let mem = unsafe { mem_mut() };
                let ForkModule { module_state, module_state_chunks, .. } = st;
                let payload = module_state.reserve(
                    module_state_chunks,
                    mem,
                    abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
                    id,
                    0,
                    payload_size,
                )?;
                let start = usize::try_from(payload).map_err(|_| Errno::EINVAL)?;
                let end = start
                    .checked_add(payload_size as usize)
                    .ok_or(Errno::EINVAL)?;
                if end > mem_len_bytes() {
                    return Err(Errno::EINVAL);
                }
                // NOT `mem.get_mut(start..end)`. That is the shape census
                // section 140 measured returning `None` for an in-bounds range
                // -- including `0..32` on a 16 MiB memory -- because the
                // whole-memory slice is built from a null base and the bounds
                // check gets folded. This write would have failed `EINVAL` on
                // the first real capture, and the errno would have looked like a
                // bad argument rather than a miscompiled read.
                //
                // SAFETY: `[start, end)` is inside guest linear memory (checked
                // above), and the base is non-null for any real payload offset.
                let out: &mut [u8] = unsafe {
                    core::slice::from_raw_parts_mut(
                        core::hint::black_box(start) as *mut u8,
                        payload_size as usize,
                    )
                };
                encode_module_record(
                    out,
                    &fork_codec::ModuleDescriptor { template_id, flags: 0 },
                )?;
                module_state.commit(mem, payload)?;
            }
        }

        let mut steps = Vec::new();
        // The CAPTURE-side guest save walk, driven before any unwind begins.
        //
        // This is what a module-driven capture was missing. The module could
        // drive the child's RESTORE (`append_attach_steps`) and never the
        // parent's SAVE, because no drive op existed for it -- so a capture
        // sequenced entirely by the module produced an arena with no global or
        // table records in it, silently. The JS `ForkActivationRegistry`
        // `beginCapture` loop was the only thing calling
        // `wpk_fork_module_state_save`.
        //
        // Order matters both ways and matches that loop. AFTER the arena root
        // is published above, because the guest save reserves its records
        // through the module's own record-reserve import and there must be an
        // arena to reserve into. BEFORE `wpk_fork_unwind_begin`, because the
        // save is capturing the state the unwind is about to walk away from.
        let save_activations: Vec<u32> = roots.iter().map(|(id, _)| *id).collect();
        drive_plan::append_module_state_save_steps(&mut steps, &save_activations);
        drive_plan::append_unwind_begin_steps(&mut steps, &roots);
        let plan = serialize_and_store_plan(&steps)?;
        let count = GC_PLAN_COUNT.load(Ordering::Relaxed);
        if count > 0 {
            drive_plan_via_injector(plan, count);
        }
        Ok(root0)
    }

    /// Read one activation's module-buffer anchor (its continuation root) from the
    /// current fork's state. The host reads a side activation's anchor back after
    /// `fm_parent_begin_capture` (which returns only activation 0's) for the
    /// activation-continuation manifest. `EINVAL` if no fork is open or the
    /// activation is not registered.
    fn activation_module_buffer_impl(activation_id: u32) -> Result<u64, Errno> {
        let st = state().as_ref().ok_or(Errno::EINVAL)?;
        let act = st.activations.get(&activation_id).ok_or(Errno::EINVAL)?;
        Ok(act.module_buffer)
    }

    fn reserve_impl(activation_id: u32, size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let act = st.activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        if act.replay_only {
            return Err(Errno::EINVAL); // a forked child never unwinds
        }
        let mem = unsafe { mem_mut() };
        act.writer.reserve_frame(mem, &mut act.arena, size)
    }

    fn commit_impl(activation_id: u32, payload: u64) -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Split-borrow the disjoint fields: the per-activation writer and the
        // process-wide journal are borrowed together.
        let ForkModule {
            activations, journal, ..
        } = st;
        let act = activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        if act.replay_only {
            return Err(Errno::EINVAL); // a forked child never unwinds
        }
        let mem = unsafe { mem_mut() };
        act.writer.commit_frame(mem, payload)?;
        // The guest fills the frame header before commit; the function ordinal is
        // the leading u32 of the payload. Record it in the process-wide journal
        // TAGGED with this activation, and for the resume-slot registration.
        let ordinal = RewindDriver::read_function_ordinal(mem, payload)?;
        journal.record_commit(activation_id, ordinal)?;
        act.committed_ordinals.push(ordinal);
        FRAMES_COMMITTED.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn finish_unwind_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Seal every activation's writer, then the one process-wide journal.
        for act in st.activations.values() {
            act.writer.finish_unwind()?;
        }
        st.journal.seal_capture()?;
        Ok(())
    }

    fn begin_replay_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        st.journal.begin_parent_replay()?;
        let mem = unsafe { mem_ref() };
        // Register each activation's resume targets by the parity precedence
        // (per-activation catalog -> global catalog -> distinct committed
        // ordinals). A multi-activation (dlopen) fork gives each activation its
        // OWN seeded catalog; a single-activation fork with no catalog falls
        // straight through to the previous distinct-ordinals numbering, so the
        // single-activation slot assignment is byte-identical.
        let global = resume_catalog();
        let ForkModule {
            activations, table, ..
        } = st;
        for (activation_id, act) in activations.iter_mut() {
            let driver = RewindDriver::attach(mem, act.module_buffer, &act.format)?;
            register_activation_slots(table, *activation_id, global, &act.committed_ordinals)?;
            act.driver = Some(driver);
        }
        Ok(())
    }

    fn peek_impl(activation_id: u32, size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_ref() };
        let ForkModule {
            activations, journal, ..
        } = st;
        let act = activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        let driver = act.driver.as_ref().ok_or(Errno::EINVAL)?;
        driver.drive_peek(mem, journal, activation_id, size)
    }

    fn next_impl(activation_id: u32, size: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let mem = unsafe { mem_ref() };
        let ForkModule {
            activations, journal, ..
        } = st;
        let act = activations.get_mut(&activation_id).ok_or(Errno::EINVAL)?;
        let driver = act.driver.as_mut().ok_or(Errno::EINVAL)?;
        let payload = driver.drive_next(mem, journal, activation_id, size)?;
        // Count only a successful consuming advance: this is the replay-side
        // proof-of-use a replay-only child (which never commits) reports.
        FRAMES_REPLAYED.fetch_add(1, Ordering::Relaxed);
        Ok(payload)
    }

    /// The resume slot for the currently selected replay event. This is a
    /// process-wide journal + table concern — the slot is for whichever
    /// activation's event the global journal currently selects — so the
    /// `activation_id` argument (which activation's guest asked) is not needed to
    /// resolve it. It is accepted so the export shape matches the frame ops and
    /// the trampoline can pass a uniform activation immediate.
    fn resume_peek_impl(_activation_id: u32) -> Result<u32, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        let ForkModule {
            journal, table, ..
        } = st;
        RewindDriver::resume_peek(journal, table)
    }

    /// Release (munmap) every chunk this fork mapped through the channel: each
    /// activation's own frame chunks plus the extra (journal-image) chunk.
    /// Best-effort — a `munmap` hiccup does not fail an already-complete fork. A
    /// replay-only child mapped nothing (empty allocators), so this is a no-op
    /// there. The channel base is captured before the per-activation borrow to
    /// keep the borrow checker happy while draining both.
    fn release_fork_chunks(st: &mut ForkModule) {
        let channel_base = st.channel_base;
        for act in st.activations.values_mut() {
            act.arena.release_all();
        }
        for (addr, size) in st.extra_chunks.drain(..) {
            let _ = channel_munmap(channel_base, addr, size);
        }
    }

    fn finish_replay_impl() -> Result<(), Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // Every activation's driver must be exhausted, then the one journal.
        for act in st.activations.values() {
            let driver = act.driver.as_ref().ok_or(Errno::EINVAL)?;
            driver.finish_rewind()?;
        }
        st.journal.finish_replay()?;
        // Option B: the module owns the frame + image chunks it mapped; release
        // them now the replay is complete (parent path; a child mapped nothing).
        release_fork_chunks(st);
        Ok(())
    }

    fn begin_abort_impl() -> Result<(), Errno> {
        // Abort replay drives the exact same frames/journal as parent replay;
        // the only difference is the guest export the host calls
        // (wpk_fork_abort_begin vs wpk_fork_rewind_begin). Record the abort state
        // so finish_abort_impl can assert the pairing is honored.
        begin_replay_impl()?;
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        st.in_abort = true;
        Ok(())
    }

    fn finish_abort_impl() -> Result<(), Errno> {
        {
            let st = state().as_mut().ok_or(Errno::EINVAL)?;
            if !st.in_abort {
                // fm_finish_abort without a matching fm_begin_abort: loud, not silent.
                return Err(Errno::EINVAL);
            }
        }
        finish_replay_impl()?;
        if let Some(st) = state().as_mut() {
            st.in_abort = false;
        }
        Ok(())
    }

    /// Release every channel-mapped chunk WITHOUT requiring the replay to have
    /// finished (the abort path). Idempotent: draining leaves the allocators
    /// empty, so a later finish/abort maps nothing.
    fn abort_impl() -> Result<(), Errno> {
        if let Some(st) = state().as_mut() {
            release_fork_chunks(st);
            st.in_abort = false;
        }
        Ok(())
    }

    // -- Child replay seeding across the fork memory copy -------------------
    //
    // In a live fork the child inherits a COPY of the parent's guest linear
    // memory (including the linked-frame chunks the parent wrote) but runs a
    // FRESH module instance placed at a DIFFERENT `__memory_base`, whose journal
    // starts EMPTY. So the child's module cannot see the parent module's
    // in-memory journal. The parent therefore serializes its sealed journal as a
    // KFRE image into a freshly channel-mmap'd guest-memory chunk BEFORE the
    // fork (`fm_serialize_journal_alloc`); the host records that chunk's
    // `(ptr, len)` in a `JournalImage` KFMS record so the child, after the
    // memory copy, decodes the image from the inherited offset and seeds its own
    // journal + resume-slot table (`fm_begin_child_replay`). With Option B the
    // image no longer sits at a host-computed arena offset — the module mmaps it
    // on demand, exactly like the frame chunks — so the manifest record is how
    // the child finds it. This mirrors the JS path: `sealCapture` ->
    // `arena.appendReplayEvents(events)` (parent) and `attachChild` ->
    // `replayEventsForChild(records)` -> `events.attachChild` (child) in
    // `host/src/fork-process-continuation.ts`.

    fn serialize_journal_alloc_impl(channel_base: u64) -> Result<u64, Errno> {
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        // One syscall channel per worker; a disagreeing base is a host bug.
        if channel_base != st.channel_base {
            return Err(Errno::EINVAL);
        }
        // The journal must be sealed (post `fm_finish_unwind`) so the captured
        // events are complete and still capture-readable — exactly when JS
        // `sealCapture` serializes them.
        let image = encode_replay_events(st.journal.captured_events()?);
        let len = image.len() as u64;
        // Channel-mmap a page-rounded image chunk. This GROWS shared memory, so
        // the memory length MUST be re-derived AFTER the map before the copy.
        let capacity = len
            .checked_add(PAGE - 1)
            .ok_or(Errno::EINVAL)?
            / PAGE
            * PAGE;
        let capacity = capacity.max(PAGE);
        let addr = channel_mmap(channel_base, capacity)?;
        st.extra_chunks.push((addr, capacity));
        // Re-derive the length after the grow; a stale pre-grow length would
        // wrongly reject the freshly mapped high image chunk.
        let start = usize::try_from(addr).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(image.len()).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // image chunk past the end of guest memory
        }
        // Copy through raw pointers (never an exclusive whole-memory `&mut [u8]`,
        // which is `noalias` yet aliases the module-heap `image` and miscompiles
        // under release LLVM): source (module heap) and destination (the mapped
        // guest chunk) are distinct byte ranges.
        let dst = core::hint::black_box(start) as *mut u8;
        // SAFETY: `[start, end)` is within the just-mapped guest memory (checked
        // above); `image` is a distinct heap allocation. `copy` (memmove
        // semantics) tolerates any overlap defensively.
        unsafe {
            core::ptr::copy(image.as_ptr(), dst, image.len());
        }
        st.journal_image_ptr = addr;
        st.journal_image_len = len;
        Ok(addr)
    }

    fn begin_child_replay_impl(
        module_buffer: u64,
        image_ptr: u64,
        image_len: u64,
    ) -> Result<(), Errno> {
        // Reclaim any prior state and heap before this COW child's replay. A
        // BORROWED (vfork) child must NOT do this (it shares the parked parent's
        // memory and its module instance is fresh + single-use), so the reclaim
        // lives here in the COW entry rather than in the shared builder.
        //
        // A COW child INHERITS the parent's live `capture_state` builder through
        // the memory clone. It lives in this same bump heap, so it must be dropped
        // BEFORE the reset (via `reset_bump_heap`) — otherwise the child's next
        // `fm_capture_begin` would drop the inherited builder AFTER this reset had
        // clobbered its `BTreeMap` nodes, trapping. This was the real
        // command-substitution / pipeline fork failure: the subshell (a COW child)
        // trapped on its second fork because its inherited builder was corrupted
        // here and never cleared.
        reset_bump_heap();

        let (module, activation_id) =
            build_child_replay_module(module_buffer, image_ptr, image_len)?;
        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(())
    }

    /// Seed a replay-only child `ForkModule` from the inherited journal image and
    /// a READ-ONLY rewind driver over the continuation at `module_buffer`, and
    /// return it together with the primary activation id — WITHOUT storing it,
    /// touching `PRIMARY_ACTIVATION`, or reclaiming the heap. Shared by the COW
    /// child (`begin_child_replay_impl`) and the vfork BORROWED child
    /// (`begin_borrowed_child_replay_impl`); the caller stores it and, for the
    /// borrowed path, first isolates its private module prefix. The built module
    /// owns NO chunks (arena `new_channel(0)`, empty `extra_chunks`,
    /// `channel_base == 0`), so its finish/abort munmaps nothing — the invariant a
    /// borrowed child depends on so it never unmaps the parent's live storage.
    fn build_child_replay_module(
        module_buffer: u64,
        image_ptr: u64,
        image_len: u64,
    ) -> Result<(ForkModule, u32), Errno> {
        // The format must have been seeded (once) on THIS fresh child instance,
        // exactly as the host seeds every process-worker instance.
        let fmt = format()?;

        // Decode the KFRE image the parent serialized, read from the child's
        // COPIED guest memory. Copy the image bytes out through raw pointers into
        // a module-heap buffer first: forming a `&[u8]` sub-slice of a
        // whole-guest-memory slice and decoding from it in-place miscompiles the
        // bounds checks under release LLVM (the same aliasing hazard the
        // serialize path avoids). `decode_replay_events_image` then reuses the D1
        // `decode_replay_events` codec — no framing logic is duplicated here.
        let start = usize::try_from(image_ptr).map_err(|_| Errno::EINVAL)?;
        let len = usize::try_from(image_len).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // image region past the end of guest memory
        }
        let mut image_bytes = alloc::vec![0u8; len];
        let src = core::hint::black_box(start) as *const u8;
        // SAFETY: `[start, end)` is within guest linear memory (checked above);
        // `image_bytes` is a distinct heap allocation of exactly `len` bytes.
        unsafe {
            core::ptr::copy(src, image_bytes.as_mut_ptr(), len);
        }
        let decoded = decode_replay_events_image(&image_bytes)?;

        // Choose the activation this call SEEDS (the main module). A
        // single-activation fork seeds its sole activation (byte-identical to
        // before this slice — the id may be any value, e.g. the harness's act 7).
        // A multi-activation (dlopen) fork seeds the MAIN module, activation 0,
        // and the host adds each side activation 1..N with
        // `fm_add_activation_child_replay`. An empty journal seeds activation 0.
        let activation_id = match decoded.activation_ids.len() {
            0 => 0, // empty journal: no frames to replay
            1 => *decoded.activation_ids.iter().next().ok_or(Errno::EINVAL)?,
            _ => {
                // Multi-activation: the main module (activation 0) anchors this
                // seed. Its absence is a malformed image, not a guessable anchor.
                if !decoded.activation_ids.contains(&0) {
                    return Err(Errno::EINVAL);
                }
                0
            }
        };

        // Seed the process-wide journal ONCE from ALL decoded events (every
        // activation, capture order); it will replay the exact global reverse,
        // in lockstep with each activation's frame chain. The events are already
        // tagged with their `activation_id`, so one image seeds N activations.
        let mut journal = ReplayEventJournal::new();
        journal.attach_child(&decoded.events)?;

        // This seed activation's committed ordinals (filter the decoded events).
        let committed_ordinals: Vec<u32> = decoded
            .events
            .iter()
            .filter(|event| event.activation_id == activation_id)
            .map(|event| event.function_ordinal)
            .collect();

        // Register the seed activation's resume slots by the parity precedence
        // (per-activation catalog -> global catalog -> distinct committed). For a
        // single-activation fork with no catalog this is byte-identical to the
        // previous distinct-decoded-ordinals numbering.
        let global = resume_catalog();
        let mut table = ResumeSlotTable::new();
        register_activation_slots(&mut table, activation_id, global, &committed_ordinals)?;

        // Attach the rewind driver to the continuation the parent published,
        // read from the COPIED arena at the same guest offset the child
        // inherited. The child mutates none of the guest frame memory.
        let driver = {
            let mem = unsafe { mem_ref() };
            RewindDriver::attach(mem, module_buffer, &fmt)?
        };

        // Seed the first activation into the activation-keyed map (replay-only).
        // Side activations are added by `fm_add_activation_child_replay` against
        // the SAME process-wide journal + table; the decoded events are retained
        // so each add can rebuild its own activation's committed ordinals.
        let mut activations = BTreeMap::new();
        activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer: LinkedFrameWriter::new(fmt),
                // A replay-only child mmaps nothing: `channel_base == 0` and the
                // `replay_only` guard rejects any reserve/commit, so `allocate`
                // is never called.
                arena: ForkChunkList::new_channel(0),
                driver: Some(driver),
                committed_ordinals,
                module_buffer,
                // COW child default: the guest rewinds the inherited continuation
                // in place, so the rewind root IS `module_buffer`. The vfork
                // BORROWED primary path overrides this to its child-private prefix
                // in `begin_borrowed_child_replay_impl` after the prefix copy.
                child_rewind_root: module_buffer,
                replay_only: true,
            },
        );
        let module = ForkModule {
            activations,
            channel_base: 0,
            extra_chunks: Vec::new(),
            journal_image_ptr: 0,
            journal_image_len: 0,
            // A replay-only child never writes module state: it DECODES the
            // list it inherited. The writer is present but its chunk list
            // allocates nothing (`channel_base == 0`), so a stray guest reserve
            // here fails truthfully instead of writing into an unowned region.
            module_state: ModuleStateWriter::new(module_state_format()?),
            module_state_chunks: ForkChunkList::new_channel(0),
            journal,
            table,
            replay_events: decoded.events,
            in_abort: false,
        };
        Ok((module, activation_id))
    }

    // -- vfork BORROWED child replay (shares the parked parent's memory) -----
    //
    // A COW fork child inherits a private COPY of the parent's memory, so
    // `begin_child_replay_impl` may reclaim its heap and (harmlessly) own its
    // inherited chunks. A vfork BORROWED child instead runs a FRESH module
    // instance at a DISTINCT `__memory_base` inside the SAME shared memory as the
    // still-parked parent, whose fork-module instance, continuation storage, and
    // frame chunks are live there. So the borrowed child must:
    //   (i)   NOT reclaim the heap (its instance is fresh + single-use, and a
    //         reset is meaningless; the reclaim stays in the COW entry);
    //   (ii)  decode the journal image READ-ONLY (the shared builder already
    //         copies the image bytes out before decoding — no guest write);
    //   (iii) own NO chunks (the shared builder's `new_channel(0)` arena +
    //         `channel_base == 0` guarantee finish/abort munmap nothing);
    //   (iv)  write the guest's mutable fixed runtime prefix (whose offset-0 word
    //         is the active-frame pointer the guest rewind overwrites) into a
    //         CHILD-PRIVATE `private_prefix` region, copied from the parent's
    //         prefix at `module_buffer`, so the parked parent's prefix is never
    //         touched. The rewind driver still reads the BORROWED frame nodes at
    //         the parent's addresses (read-only), exactly as the JS
    //         `attachForBorrowedReplay` does.

    fn begin_borrowed_child_replay_impl(
        module_buffer: u64,
        image_ptr: u64,
        image_len: u64,
        private_prefix: u64,
    ) -> Result<(), Errno> {
        // (i) NO heap reclaim / no `*state() = None` reset here: this is a fresh,
        // single-use borrowed-child instance sharing the parent's memory.
        let (mut module, activation_id) =
            build_child_replay_module(module_buffer, image_ptr, image_len)?;

        // (iv) Isolate the child's mutable module prefix. Copy the parent's fixed
        // runtime prefix from `module_buffer` into the child-private
        // `private_prefix`, after proving the target is in range, aligned, and
        // does NOT overlap the borrowed continuation storage or the source
        // anchor. The guest's `wpk_fork_rewind_begin` is then handed
        // `private_prefix`, so every active-frame-pointer write lands in private
        // scratch, never the parked parent's prefix.
        let fixed_prefix = module
            .activations
            .get(&activation_id)
            .ok_or(Errno::EINVAL)?
            .format
            .fixed_prefix_size as u64;
        copy_borrowed_child_prefix(&module, activation_id, module_buffer, private_prefix, fixed_prefix)?;

        // The borrowed child's guest rewind begins at the child-PRIVATE prefix
        // (not `module_buffer`, the read-only parent anchor), so the coarse
        // `fm_child_reconstruct` drive plan must carry `private_prefix` for this
        // activation. This overrides the COW default `build_child_replay_module`
        // seeded (== `module_buffer`).
        module
            .activations
            .get_mut(&activation_id)
            .ok_or(Errno::EINVAL)?
            .child_rewind_root = private_prefix;

        *state() = Some(module);
        PRIMARY_ACTIVATION.store(activation_id, Ordering::Relaxed);
        Ok(())
    }

    /// Validate and copy the parent's fixed runtime prefix from `source`
    /// (`module_buffer`) into the child-private `target` (`private_prefix`), the
    /// module equivalent of `attachForBorrowedReplay`'s prefix copy. Both regions
    /// live in the shared guest memory; the copy goes through raw pointers (never
    /// an exclusive whole-memory `&mut [u8]`, which would `noalias`-miscompile),
    /// and the ranges are proven distinct first, so a bad `private_prefix` fails
    /// truthfully instead of corrupting the parked parent.
    fn copy_borrowed_child_prefix(
        module: &ForkModule,
        activation_id: u32,
        source: u64,
        target: u64,
        len: u64,
    ) -> Result<(), Errno> {
        if len == 0 {
            return Err(Errno::EINVAL); // a borrowed child always has a runtime prefix
        }
        let act = module.activations.get(&activation_id).ok_or(Errno::EINVAL)?;
        let driver = act.driver.as_ref().ok_or(Errno::EINVAL)?;
        let alignment = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT as u64;
        if alignment == 0 || target == 0 || target % alignment != 0 {
            return Err(Errno::EINVAL); // target must be nonzero + prefix-aligned
        }
        let src_end = source.checked_add(len).ok_or(Errno::EINVAL)?;
        let tgt_end = target.checked_add(len).ok_or(Errno::EINVAL)?;
        let mem_len = mem_len_bytes() as u64;
        if src_end > mem_len || tgt_end > mem_len {
            return Err(Errno::EINVAL); // either range escapes guest memory
        }
        // The private prefix must not alias the borrowed continuation storage or
        // the parent's prefix source (which includes `module_buffer`).
        if driver.borrowed_prefix_conflicts(target, len)? {
            return Err(Errno::EINVAL);
        }
        let src = usize::try_from(source).map_err(|_| Errno::EINVAL)?;
        let dst = usize::try_from(target).map_err(|_| Errno::EINVAL)?;
        // SAFETY: `[source, source+len)` and `[target, target+len)` are both
        // within guest memory (checked above) and proven non-overlapping by the
        // conflict guard; `copy` (memmove semantics) is defensive regardless.
        unsafe {
            let src_ptr = core::hint::black_box(src) as *const u8;
            let dst_ptr = core::hint::black_box(dst) as *mut u8;
            core::ptr::copy(src_ptr, dst_ptr, len as usize);
        }
        Ok(())
    }

    /// Add a dlopen-vfork ("mode-1") SIDE activation to a BORROWED child replay
    /// begun by `fm_begin_borrowed_child_replay` (Phase 6 item 4). The direct
    /// borrowed sibling of `add_activation_child_replay_impl`: it attaches a
    /// READ-ONLY rewind driver over the PARENT's borrowed continuation at
    /// `module_buffer` and rebuilds this activation's committed ordinals + resume
    /// slots exactly the same way, but additionally copies THIS activation's fixed
    /// runtime prefix into its own child-private `private_prefix` region (so the
    /// guest's per-activation rewind writes its active-frame pointer there, never
    /// the parked parent's prefix). Owns no chunks, so finish/abort release
    /// nothing. `module_buffer` is the side's borrowed anchor; `fixed_prefix` its
    /// own runtime-prefix size.
    fn add_activation_borrowed_child_replay_impl(
        activation_id: u32,
        module_buffer: u64,
        fixed_prefix: u32,
        private_prefix: u64,
    ) -> Result<(), Errno> {
        let base = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base
        };
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        if st.activations.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // activation already seeded in this child
        }
        let committed_ordinals: Vec<u32> = st
            .replay_events
            .iter()
            .filter(|event| event.activation_id == activation_id)
            .map(|event| event.function_ordinal)
            .collect();
        // Attach the READ-ONLY driver to the parent's BORROWED continuation at
        // this side's inherited anchor, then register its resume slots.
        let mem = unsafe { mem_ref() };
        let driver = RewindDriver::attach(mem, module_buffer, &fmt)?;
        let global = resume_catalog();
        register_activation_slots(&mut st.table, activation_id, global, &committed_ordinals)?;
        st.activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer: LinkedFrameWriter::new(fmt),
                // Borrowed side activation: mmaps nothing, releases nothing.
                arena: ForkChunkList::new_channel(0),
                driver: Some(driver),
                committed_ordinals,
                module_buffer,
                // Borrowed side activation: the guest rewinds at its own
                // child-private prefix (see the primary borrowed path), so the
                // coarse child-reconstruct plan drives from `private_prefix`.
                child_rewind_root: private_prefix,
                replay_only: true,
            },
        );
        // Isolate this side's mutable prefix into its child-private region (the
        // per-activation mirror of the primary borrowed path); validates the
        // target is in range, aligned, and non-overlapping before copying.
        copy_borrowed_child_prefix(
            st,
            activation_id,
            module_buffer,
            private_prefix,
            fixed_prefix as u64,
        )?;
        Ok(())
    }

    /// Add ANOTHER activation (a dlopen fork's side module) to the child replay
    /// begun by `fm_begin_child_replay` (Phase 6 D7a.1a). `activation_id` is the
    /// side activation (must not already be seeded); `module_buffer` is ITS
    /// continuation anchor, inherited at the same guest offset via the fork
    /// memory copy; `fixed_prefix` is ITS own module-buffer fixed runtime prefix.
    /// (Side modules carry their own prefix — the direct child-side mirror of
    /// `fm_add_activation_unwind`'s `fixed_prefix` — and the rewind decode needs
    /// it to locate the root chunk's first node; the journal image does not carry
    /// it, so the host supplies it.) The process-wide journal is NOT reseeded:
    /// this attaches the activation's replay-only frame state, rebuilds its
    /// committed ordinals from the retained decoded events (filtered by
    /// `activation_id`), and registers its resume slots against the SAME table.
    fn add_activation_child_replay_impl(
        activation_id: u32,
        module_buffer: u64,
        fixed_prefix: u32,
    ) -> Result<(), Errno> {
        // Derive this activation's format from the seeded pointer width plus its
        // own fixed prefix (shared pointer width, per-activation prefix), exactly
        // as the parent's `add_activation_unwind_impl` does.
        let base = format()?;
        let fmt = LinkedFrameFormat {
            fixed_prefix_size: fixed_prefix,
            ..base
        };

        // Rebuild this activation's committed ordinals from the retained decoded
        // events BEFORE taking the mutable field borrows below (the immutable
        // borrow of `replay_events` ends once collected into an owned `Vec`).
        let st = state().as_mut().ok_or(Errno::EINVAL)?;
        if st.activations.contains_key(&activation_id) {
            return Err(Errno::EINVAL); // activation already seeded in this child
        }
        let committed_ordinals: Vec<u32> = st
            .replay_events
            .iter()
            .filter(|event| event.activation_id == activation_id)
            .map(|event| event.function_ordinal)
            .collect();

        // Attach the rewind driver to the COPIED continuation at its inherited
        // anchor, then register the activation's resume slots on the SAME table.
        let mem = unsafe { mem_ref() };
        let driver = RewindDriver::attach(mem, module_buffer, &fmt)?;
        let global = resume_catalog();
        register_activation_slots(&mut st.table, activation_id, global, &committed_ordinals)?;

        st.activations.insert(
            activation_id,
            ActivationFrames {
                format: fmt,
                writer: LinkedFrameWriter::new(fmt),
                // Replay-only side activation: mmaps nothing (see the primary).
                arena: ForkChunkList::new_channel(0),
                driver: Some(driver),
                committed_ordinals,
                module_buffer,
                // COW side activation: the guest rewinds the inherited
                // continuation in place, so the rewind root IS `module_buffer`.
                child_rewind_root: module_buffer,
                replay_only: true,
            },
        );
        Ok(())
    }

    /// Decode the inherited `JournalImage` KFMS record from the COPIED module-state
    /// arena rooted at `module_state_root`, returning `(image_ptr, image_len)` — the
    /// guest offset and byte length of the channel-mmap'd KFRE journal image the
    /// forked child inherits. Scans the sealed KFMS envelope for the single
    /// `JournalImage` record and decodes its payload via `fork_codec`. Exactly one
    /// such record must exist (the parent wrote it at seal); zero or many is a
    /// malformed inheritance (`EINVAL`). The module-side of the host
    /// `journalImageForChild`.
    fn journal_image_from_arena(module_state_root: u64) -> Result<(u64, u64), Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        let chunk_header_size =
            abi::wpk_fork_module_state_chunk_header_size(pw as u8).ok_or(Errno::EINVAL)?;
        let fmt = ModuleStateFormat {
            pointer_width: pw as u8,
            chunk_header_size,
        };
        let mem = unsafe { mem_ref() };
        let module_state = decode_module_state(mem, module_state_root, &fmt)?;
        let mut found: Option<(u64, u64)> = None;
        for record in &module_state.records {
            if record.kind != abi::WPK_FORK_MODULE_STATE_RECORD_KIND_JOURNAL_IMAGE {
                continue;
            }
            if found.is_some() {
                return Err(Errno::EINVAL); // more than one JournalImage record
            }
            let start = usize::try_from(record.payload_offset).map_err(|_| Errno::EINVAL)?;
            let size = usize::try_from(record.payload_size).map_err(|_| Errno::EINVAL)?;
            let end = start.checked_add(size).ok_or(Errno::EINVAL)?;
            if end > mem_len_bytes() {
                return Err(Errno::EINVAL);
            }
            // NOT `mem.get(start..end)` -- see census section 140. The
            // whole-memory slice is built from a null base, and `.get` on it was
            // measured returning `None` for ranges that are plainly in bounds.
            // SAFETY: `[start, end)` is inside guest linear memory (checked
            // above); the base is non-null for any real payload offset.
            let payload: &[u8] = unsafe {
                core::slice::from_raw_parts(core::hint::black_box(start) as *const u8, size)
            };
            found = Some(decode_journal_image(payload)?);
        }
        found.ok_or(Errno::EINVAL)
    }

    /// Sequence a whole CHILD SEED in the module (control-flow inversion): decode
    /// the inherited `JournalImage` record from the COPIED KFMS arena and seed
    /// activation 0's replay from it (`begin_child_replay_impl`), then seed each
    /// side activation (a dlopen fork's side module) from the host-passed scratch
    /// (`add_activation_child_replay_impl`). Folds the host's former
    /// `beginChildReplay` + per-activation `addActivationChildReplay` loop in
    /// `attachModuleChild` into ONE module call.
    ///
    /// `act0_root` is activation 0's inherited continuation anchor (the launch
    /// anchor the host reads). The `sides` scratch is an array of 16-byte records
    /// `[sides_ptr, sides_ptr + sides_count*16)`, each `(id: u32, fixed_prefix: u32,
    /// root_lo: u32, root_hi: u32)`: a side activation's id, its own module-buffer
    /// fixed prefix, and its inherited continuation anchor (low/high words). The
    /// `fixed_prefix` is a static property of the child's loaded side module —
    /// absent from every inherited KFMS record (see `add_activation_child_replay_impl`),
    /// so the host supplies it. A single-activation fork passes `sides_count == 0`
    /// (only activation 0 is seeded from the launch anchor + journal image).
    /// Truthful failure: a malformed inheritance or an already-seeded activation is
    /// a `fm_last_errno`.
    fn child_seed_impl(
        module_state_root: u64,
        act0_root: u64,
        sides_ptr: u64,
        sides_count: u64,
    ) -> Result<(), Errno> {
        let (image_ptr, image_len) = journal_image_from_arena(module_state_root)?;
        begin_child_replay_impl(act0_root, image_ptr, image_len)?;
        let count = usize::try_from(sides_count).map_err(|_| Errno::EINVAL)?;
        if count > 0 {
            let bytes = (count as u64).checked_mul(16).ok_or(Errno::EINVAL)?;
            let end = sides_ptr.checked_add(bytes).ok_or(Errno::EINVAL)?;
            if sides_ptr == 0 || end > mem_len_bytes() as u64 {
                return Err(Errno::EINVAL);
            }
            for i in 0..count {
                let base = (i as u64) * 16;
                let id = unsafe { ch_read_u32(sides_ptr, base as usize) };
                let fixed_prefix = unsafe { ch_read_u32(sides_ptr, (base + 4) as usize) };
                let root_lo = unsafe { ch_read_u32(sides_ptr, (base + 8) as usize) };
                let root_hi = unsafe { ch_read_u32(sides_ptr, (base + 12) as usize) };
                let root = ((root_hi as u64) << 32) | root_lo as u64;
                if id == 0 {
                    // Activation 0 is seeded from the launch anchor + journal image
                    // above; a side entry naming it is a host bug.
                    return Err(Errno::EINVAL);
                }
                add_activation_child_replay_impl(id, root, fixed_prefix)?;
            }
        }
        Ok(())
    }

    /// Sequence a whole BORROWED (vfork) CHILD SEED in the module (control-flow
    /// inversion): decode the inherited `JournalImage` record from the KFMS arena
    /// and seed activation 0's borrowed replay from it
    /// (`begin_borrowed_child_replay_impl`), then seed each side activation from
    /// the host-passed scratch (`add_activation_borrowed_child_replay_impl`).
    /// Folds the host's former `beginBorrowedChildReplay` + per-activation
    /// `addActivationBorrowedChildReplay` loop in `attachBorrowedModuleChild` into
    /// ONE module call — the borrowed sibling of `child_seed_impl`.
    ///
    /// Unlike the COW `child_seed_impl`, a borrowed child shares the PARKED
    /// parent's live memory read-only, so every activation additionally carries a
    /// child-PRIVATE prefix the module copies the parent's fixed runtime prefix
    /// into (so the guest's per-activation rewind writes its active-frame pointer
    /// THERE, never the parked parent's prefix). `act0_root` is activation 0's
    /// borrowed continuation anchor (the parent launch anchor); `act0_private_prefix`
    /// its child-private prefix. The `sides` scratch is an array of 24-byte records
    /// `[sides_ptr, sides_ptr + sides_count*24)`, each `(id: u32, fixed_prefix: u32,
    /// root_lo: u32, root_hi: u32, private_lo: u32, private_hi: u32)`: a side
    /// activation's id, its own module-buffer fixed prefix, its inherited borrowed
    /// continuation anchor (low/high words), and its child-private prefix (low/high
    /// words). The `fixed_prefix` and `private_prefix` are host-supplied for the
    /// same reasons as the fine-grained path. A single-activation vfork passes
    /// `sides_count == 0`. Truthful failure: a malformed inheritance, an
    /// already-seeded activation, or an out-of-range/aliasing private prefix is a
    /// `fm_last_errno`.
    fn child_seed_borrowed_impl(
        module_state_root: u64,
        act0_root: u64,
        act0_private_prefix: u64,
        sides_ptr: u64,
        sides_count: u64,
    ) -> Result<(), Errno> {
        let (image_ptr, image_len) = journal_image_from_arena(module_state_root)?;
        begin_borrowed_child_replay_impl(act0_root, image_ptr, image_len, act0_private_prefix)?;
        let count = usize::try_from(sides_count).map_err(|_| Errno::EINVAL)?;
        if count > 0 {
            let bytes = (count as u64).checked_mul(24).ok_or(Errno::EINVAL)?;
            let end = sides_ptr.checked_add(bytes).ok_or(Errno::EINVAL)?;
            if sides_ptr == 0 || end > mem_len_bytes() as u64 {
                return Err(Errno::EINVAL);
            }
            for i in 0..count {
                let base = (i as u64) * 24;
                let id = unsafe { ch_read_u32(sides_ptr, base as usize) };
                let fixed_prefix = unsafe { ch_read_u32(sides_ptr, (base + 4) as usize) };
                let root_lo = unsafe { ch_read_u32(sides_ptr, (base + 8) as usize) };
                let root_hi = unsafe { ch_read_u32(sides_ptr, (base + 12) as usize) };
                let priv_lo = unsafe { ch_read_u32(sides_ptr, (base + 16) as usize) };
                let priv_hi = unsafe { ch_read_u32(sides_ptr, (base + 20) as usize) };
                let root = ((root_hi as u64) << 32) | root_lo as u64;
                let private_prefix = ((priv_hi as u64) << 32) | priv_lo as u64;
                if id == 0 {
                    // Activation 0 is seeded from the launch anchor + journal image
                    // above; a side entry naming it is a host bug.
                    return Err(Errno::EINVAL);
                }
                add_activation_borrowed_child_replay_impl(id, root, fixed_prefix, private_prefix)?;
            }
        }
        Ok(())
    }

    // -- Reference reconstruction impls (Phase 6 D6.1) ----------------------

    /// Decode the funcref/null reference graph for this fork from the KFMS
    /// module-state arena rooted at `module_state_root` (inherited via the fork
    /// memory copy, same as `fm_begin_child_replay`'s frame arena), and seed the
    /// reference-replay driver. Reuses the D6.0 live decode
    /// (`decode_segmented_reference_transaction`) over the arena's reference
    /// records; no framing logic is duplicated here.
    ///
    /// D6.1 admits FUNCREF + NULL only, from a SINGLE activation (one imported
    /// catalog table). A graph with any other kind, or funcrefs spanning more
    /// than one activation, is a truthful `EOPNOTSUPP` — the host predicate keeps
    /// such a fork on the JS path, and this re-check means a disagreeing host can
    /// never drive an unsupported reference through the funcref import.
    // `pid` (the child process image) is retained in the export signature for the
    // host call site's contract, but M2 no longer opens a host root generation
    // scoped by it — the externref host seam retired (see `ReconstructionState`'s
    // doc) — so it is unused inside this impl.
    /// Decode a sealed module-state (KFMS) arena rooted at `module_state_root`
    /// from the COPIED guest memory into the canonical reference transaction.
    ///
    /// This is the arena->records->transaction path shared by
    /// `fm_begin_reference_replay` (the guest-driven replay) and
    /// `fm_decode_reference_graph` / `fm_restore_from_arena` (the module-owned
    /// orchestration entries). It uses the IMMUTABLE whole-memory view (reads
    /// only, so the release-LLVM `&mut`-noalias miscompile the serialize/child
    /// paths avoid does not apply), lifts each module-state record's payload into
    /// a borrowed `ReferenceTransactionRecord`, and reuses the D6.0 transaction
    /// decode. The pointer width was seeded once (with the linked-frame format)
    /// via `fm_set_format`; not seeding it yet is a truthful `EINVAL`, never a
    /// guessed geometry.
    fn decode_reference_transaction_from_arena(
        module_state_root: u64,
    ) -> Result<SegmentedReferenceTransaction, Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        let chunk_header_size =
            abi::wpk_fork_module_state_chunk_header_size(pw as u8).ok_or(Errno::EINVAL)?;
        let fmt = ModuleStateFormat {
            pointer_width: pw as u8,
            chunk_header_size,
        };
        let mem = unsafe { mem_ref() };
        let module_state = decode_module_state(mem, module_state_root, &fmt)?;
        let mut records: Vec<ReferenceTransactionRecord> =
            Vec::with_capacity(module_state.records.len());
        for record in &module_state.records {
            let start = usize::try_from(record.payload_offset).map_err(|_| Errno::EINVAL)?;
            let size = usize::try_from(record.payload_size).map_err(|_| Errno::EINVAL)?;
            let end = start.checked_add(size).ok_or(Errno::EINVAL)?;
            if end > mem_len_bytes() {
                return Err(Errno::EINVAL);
            }
            // NOT `mem.get(start..end)` -- see census section 140. The
            // whole-memory slice is built from a null base, and `.get` on it was
            // measured returning `None` for ranges that are plainly in bounds.
            // SAFETY: `[start, end)` is inside guest linear memory (checked
            // above); the base is non-null for any real payload offset.
            let payload: &[u8] = unsafe {
                core::slice::from_raw_parts(core::hint::black_box(start) as *const u8, size)
            };
            records.push(ReferenceTransactionRecord {
                kind: record.kind,
                activation_id: record.activation_id,
                owner_id: record.owner_id,
                payload,
            });
        }
        decode_segmented_reference_transaction(&records, abi::WPK_FORK_REFERENCE_TRANSACTION_OWNER)
    }

    fn begin_reference_replay_impl(module_state_root: u64, _pid: u32) -> Result<(), Errno> {
        // Reclaim any prior fork's reference state WITHOUT running Drop: a COW
        // child inherits these statics (each owning a `SegmentedReferenceTransaction`
        // or replay feed whose `Vec`/`BTreeMap` interiors point into the parent's
        // since-reused bump), so dropping the inherited value walks clobbered nodes
        // and traps. See `abandon_resident`. This was the pipeline-in-command-
        // substitution replay-setup trap that remained after the decode-site fix.
        abandon_resident(reference_state());
        abandon_resident(reconstruction_state());
        abandon_resident(reference_feed());

        // Decode the sealed module-state arena into the canonical transaction
        // (shared arena->transaction path; see the helper).
        let transaction = decode_reference_transaction_from_arena(module_state_root)?;
        // Seed the RESTORE data-feed (Phase 6 item 3a) from the SAME decoded
        // transaction before it moves into the driver: the feed reproduces the JS
        // provider's mutable replay state (the reference-vector overlay + intern
        // index + GC-vector cache + exnref cache-index map) that the guest codec
        // reads through the flipped `fm_ref_*` imports.
        let feed = ReferenceReplayFeed::new(&transaction);
        let driver = ReferenceReplayDriver::new(transaction);

        // Module-admissibility gate (defense in depth; the host computes the same
        // predicate, plus a GC-descriptor validity check only the host can see).
        // Admits null/funcref/externref/exnref, typed GC (struct / array / i31),
        // and static-root — the whole reference kind set the module reconstructs.
        // Admitting typed GC adds NO new engine-floor callback and moves NO
        // drive-order into the module: the fork side module is instantiated BEFORE
        // the guest exists, so it cannot import the guest's `_gc_allocate`/
        // `_gc_fill` exports; the PROVEN JS drive-order (reproduced by
        // `build_drive_plan`) keeps the topological allocate/fill walk plus
        // cycle-breaking and aliases. The module's only GC job is leaf identity +
        // transit rooting — a `DRIVE_OP_EXTERNREF_TRANSIT` step (`fm_build_gc_plan`
        // / `build_drive_plan`, Phase 0) roots every struct/array-reachable
        // externref leaf (`transit_rooted_recipes` seeds from Struct/Array edges)
        // with the non-null R1 assert, both wasm (`fm_externref_handle` +
        // `resolve_externref` + `any.convert_extern` + `table.set`, injected in
        // Task 3) — no host seam beyond the single `resolve_externref` import, and
        // i31 is a scalar leaf. A static-root is published into the anyref transit
        // by a DRIVE_OP_STATIC_ROOT step (`table.get` catalog + `table.set`
        // transit, both wasm) — no host seam. An unadmitted kind is a truthful
        // `EOPNOTSUPP` that keeps the fork on the JS path.
        if !driver.all_nodes_module_admissible() {
            return Err(Errno::EOPNOTSUPP);
        }
        // Phase 6 D7a.1b: funcrefs may now span MULTIPLE activations — each
        // resolves against the MERGED, activation-namespaced catalog. Every
        // funcref's activation must therefore have a seeded catalog base, UNLESS
        // the host seeded NO base at all (a single-activation worker, which keeps
        // the byte-identical base-0 mapping). A funcref naming an un-seeded
        // activation in a multi-activation worker is a truthful `EOPNOTSUPP` (the
        // host keeps that fork on the JS reference path), never a silent read
        // against slot 0 / the wrong activation's catalog.
        if !func_catalog_base_map_empty() {
            for activation_id in driver.funcref_activations() {
                if func_catalog_base(activation_id).is_none() {
                    return Err(Errno::EOPNOTSUPP);
                }
            }
        }
        // Static-root binder: every static-root activation must have a seeded
        // merged-catalog base UNLESS the host seeded none at all (a
        // single-activation worker keeps the byte-identical base-0 mapping). A
        // static-root naming an un-seeded activation in a multi-activation worker
        // is a truthful `EOPNOTSUPP` (the host keeps that fork on the JS reference
        // path), never a silent read against the wrong catalog slice.
        if !static_root_catalog_base_map_empty() {
            for activation_id in driver.static_root_activations() {
                if static_root_catalog_base(activation_id).is_none() {
                    return Err(Errno::EOPNOTSUPP);
                }
            }
        }

        // Bookkeeping pass (M2): count the externref nodes this fork's graph
        // reconstructs. This is now a host-free pass over the decoded graph — it
        // calls no `wpk_fork_host` import and opens no host generation (that seam
        // retired; see `ReconstructionState`'s doc). The actual resolve + transit
        // publish happen later, in injected wasm: EVERY externref recipe —
        // directly held (frame-vector-only) and GC/exnref-reachable alike — is
        // published into the anyref transit by a `DRIVE_OP_EXTERNREF_TRANSIT`
        // drive step (via
        // `fm_externref_handle`), both driven by the injected `fm_drive_execute`
        // shim (Task 3), not by this function.
        let reconstruction = driver.drive_reconstruction()?;
        EXTERNREFS_RESOLVED.fetch_add(reconstruction.reconstructed() as u64, Ordering::Relaxed);
        // D6.3a proof-of-use: the drive's Exnref arm is inert (the guest export
        // materializes the exception), so count the admitted exnref nodes here.
        EXNREFS_RECONSTRUCTED.fetch_add(driver.exnref_node_count() as u64, Ordering::Relaxed);
        // D6.4a proof-of-use: the Struct/Array/I31 arms are inert (the guest drives
        // the GC allocate/fill under the JS order), so count the admitted typed-GC
        // nodes here. The struct/array-reachable externref leaves are rooted via
        // the same PHASE B transit path (`EXTERNREFS_RESOLVED` also advances).
        GC_NODES_RECONSTRUCTED.fetch_add(driver.gc_node_count() as u64, Ordering::Relaxed);

        *reference_state() = Some(driver);
        *reconstruction_state() = Some(reconstruction);
        *reference_feed() = Some(feed);
        Ok(())
    }

    // -- Module-owned wire-graph decode / scan / restore impls (orchestration
    //    migration increment 1) -------------------------------------------------

    /// Decode the sealed KFMS arena rooted at `module_state_root` into the
    /// module-owned decoded graph and return its node count (`>= 0`). Reuses the
    /// SAME shared arena decode as `fm_begin_reference_replay`; unlike replay it
    /// seeds NO driver/feed — it only makes the decoded graph resident for the
    /// per-node structure readout (`fm_decoded_node_*`) and host inspection.
    /// Reclaims any prior graph.
    fn decode_reference_graph_impl(module_state_root: u64) -> Result<u32, Errno> {
        // Clear any prior resident graph WITHOUT running its `Drop`: the host runs
        // `fm_decode_reference_graph` during child setup (for the exnref-tag and
        // static-root gates; see `worker-main.ts`), BEFORE the child's own
        // `fm_begin_child_replay` bump reset, so a COW child's inherited
        // `DECODED_GRAPH` is clobbered and dropping it traps. See
        // `abandon_resident`. This was the ORIGINAL pipeline-in-command-substitution
        // decode trap (`echo $(echo a | cat)` -> "memory access out of bounds").
        abandon_resident(decoded_graph());
        let transaction = decode_reference_transaction_from_arena(module_state_root)?;
        let node_count = u32::try_from(transaction.nodes.len()).map_err(|_| Errno::EINVAL)?;
        *decoded_graph() = Some(transaction);
        REFERENCE_GRAPHS_DECODED.fetch_add(1, Ordering::Relaxed);
        Ok(node_count)
    }

    // -- Module-owned decoded-graph STRUCTURE readout (orchestration migration
    //    increment C) -----------------------------------------------------------
    //
    // The host's fork wiring (`worker-main.ts`) keeps a `decodedChildReferences`
    // decode ONLY for two structural consumers that the count/handle-scan
    // surface above cannot serve: the HOST-owned exnref tag-validity admission
    // gate (`assertForkModuleExnrefTagsDeclared`, needs each exnref node's
    // `moduleActivation` + `tagOrdinal`) and the merged static-root catalog
    // mirror seeding (needs each static-root node's `moduleActivation` +
    // `staticRootOrdinal`, plus the per-activation max ordinal it derives from
    // them). These per-node accessors expose exactly that decoded structure over
    // the resident graph (`fm_decode_reference_graph`), so a later increment can
    // retire the JS `decodeSegmentedForkReferenceTransaction` structural decode.
    // The wire format is FROZEN and no new algorithm is introduced: they read
    // the SAME decoded `ReferenceRecipeNode` the shared `reference_segments.rs`
    // decode already produced.

    /// The wire node-kind discriminant for a decoded node, mirroring the TS
    /// `WireNodeKind` const enum (`fork-reference-recipes.ts`) and the writer's
    /// `KIND_*` constants: null 0, funcref 1, externref 2, exnref 3, i31 4,
    /// struct 5, array 6, static-root 7. This is the same mapping the segment
    /// writer uses (`reference_segments_writer.rs`), read back off the decoded
    /// node so the host can filter the graph by kind exactly as the JS decode's
    /// `entry.node.kind` string does.
    fn wire_node_kind(node: &ReferenceRecipeNode) -> u8 {
        match node {
            ReferenceRecipeNode::Null => 0,
            ReferenceRecipeNode::Funcref { .. } => 1,
            ReferenceRecipeNode::Externref { .. } => 2,
            ReferenceRecipeNode::Exnref { .. } => 3,
            ReferenceRecipeNode::I31 { .. } => 4,
            ReferenceRecipeNode::Struct { .. } => 5,
            ReferenceRecipeNode::Array { .. } => 6,
            ReferenceRecipeNode::StaticRoot { .. } => 7,
        }
    }

    /// Run `f` against the resident decoded graph node at `index`. A missing
    /// resident graph or an out-of-range index is a truthful `EINVAL` — never a
    /// fabricated or wrapped node. Bounded to a closure so the shared borrow of
    /// the decoded-graph static never escapes.
    fn with_decoded_node<T>(
        index: usize,
        f: impl FnOnce(&ReferenceRecipeNode) -> Result<T, Errno>,
    ) -> Result<T, Errno> {
        let transaction = decoded_graph().as_ref().ok_or(Errno::EINVAL)?;
        let entry = transaction.nodes.get(index).ok_or(Errno::EINVAL)?;
        f(&entry.node)
    }

    /// The wire node-kind discriminant (`0..=7`) of the resident decoded graph's
    /// node at `index`. See `wire_node_kind`.
    fn decoded_node_kind_impl(index: usize) -> Result<u8, Errno> {
        with_decoded_node(index, |node| Ok(wire_node_kind(node)))
    }

    /// The `module_activation` coordinate of the resident decoded graph's node at
    /// `index`. Defined for the kinds that carry one — funcref, exnref, struct,
    /// array, static-root; a kind without an activation (null, externref, i31) is
    /// a truthful `EINVAL`, so the host only queries it after filtering by kind
    /// (exactly as the exnref gate and static-root seeding do).
    fn decoded_node_module_activation_impl(index: usize) -> Result<u32, Errno> {
        with_decoded_node(index, |node| match node {
            ReferenceRecipeNode::Funcref {
                module_activation, ..
            }
            | ReferenceRecipeNode::Exnref {
                module_activation, ..
            }
            | ReferenceRecipeNode::Struct {
                module_activation, ..
            }
            | ReferenceRecipeNode::Array {
                module_activation, ..
            }
            | ReferenceRecipeNode::StaticRoot {
                module_activation, ..
            } => Ok(*module_activation),
            ReferenceRecipeNode::Null
            | ReferenceRecipeNode::Externref { .. }
            | ReferenceRecipeNode::I31 { .. } => Err(Errno::EINVAL),
        })
    }

    /// The kind-specific ordinal ("second word") of the resident decoded graph's
    /// node at `index`: funcref `function_ordinal`, exnref `tag_ordinal`,
    /// struct/array `type_ordinal`, static-root `static_root_ordinal` — the SAME
    /// `second` word the segment writer emits (`reference_segments_writer.rs`).
    /// A kind without an ordinal (null, externref, i31) is a truthful `EINVAL`.
    /// This is what the host exnref gate reads as `tagOrdinal` and the static-root
    /// mirror seeding reads as `staticRootOrdinal`.
    fn decoded_node_ordinal_impl(index: usize) -> Result<u32, Errno> {
        with_decoded_node(index, |node| match node {
            ReferenceRecipeNode::Funcref {
                function_ordinal, ..
            } => Ok(*function_ordinal),
            ReferenceRecipeNode::Exnref { tag_ordinal, .. } => Ok(*tag_ordinal),
            ReferenceRecipeNode::Struct { type_ordinal, .. }
            | ReferenceRecipeNode::Array { type_ordinal, .. } => Ok(*type_ordinal),
            ReferenceRecipeNode::StaticRoot {
                static_root_ordinal,
                ..
            } => Ok(*static_root_ordinal),
            ReferenceRecipeNode::Null
            | ReferenceRecipeNode::Externref { .. }
            | ReferenceRecipeNode::I31 { .. } => Err(Errno::EINVAL),
        })
    }

    /// Seed the reference replay driver/feed from the KFMS arena rooted at
    /// `module_state_root` AND build the whole topological drive plan in ONE
    /// module call, returning the plan's guest address (the `plan_ptr` argument
    /// for the injected `fm_drive_execute` shim; the step count is
    /// `fm_gc_plan_count`). This is the replay-orchestration ENTRY: it collapses
    /// the JS `beginReferenceReplay` + `restoreModuleState`/`materializeAllTyped`
    /// wrapper — which sized transit and sequenced the drive host-side, looping
    /// leaf drives — into the module, so the module now owns seeding + drive-order
    /// construction and the host issues a SINGLE `fm_drive_execute(plan, count)`.
    /// GC graphs still require each participating activation's
    /// `fm_set_activation_gc_codec` to have run first, exactly as
    /// `fm_build_gc_plan` does today; an un-seeded GC activation, a malformed
    /// arena, or an unadmitted reference kind (`EOPNOTSUPP`, host keeps the JS
    /// path) is a truthful failure, never a wrong plan.
    fn restore_from_arena_impl(module_state_root: u64, pid: u32) -> Result<usize, Errno> {
        begin_reference_replay_impl(module_state_root, pid)?;
        build_gc_plan_impl(pid)
    }

    /// The full ordered activation set of the fork, decoded from the inherited
    /// KFMS arena's `Module` records (kind 1) — one per activation, even for an
    /// activation that carries no references. Sorted + deduped so the child-install
    /// restore/finish steps run in a deterministic per-activation order matching
    /// the host's sorted activation binding. This is the module-owned equivalent of
    /// the JS `records.filter(kind === Module).map(activationId)` the registry
    /// validates the fresh child against.
    fn arena_module_activations(module_state_root: u64) -> Result<Vec<u32>, Errno> {
        let pw = FMT_POINTER_WIDTH.load(Ordering::Relaxed);
        if pw == 0 {
            return Err(Errno::EINVAL);
        }
        let chunk_header_size =
            abi::wpk_fork_module_state_chunk_header_size(pw as u8).ok_or(Errno::EINVAL)?;
        let fmt = ModuleStateFormat {
            pointer_width: pw as u8,
            chunk_header_size,
        };
        let mem = unsafe { mem_ref() };
        let module_state = decode_module_state(mem, module_state_root, &fmt)?;
        let mut activations: Vec<u32> = module_state
            .records
            .iter()
            .filter(|record| record.kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE)
            .map(|record| record.activation_id)
            .collect();
        activations.sort_unstable();
        activations.dedup();
        if activations.is_empty() {
            // A sealed child arena always carries at least activation 0's Module
            // record; none means a corrupt/empty arena, not a valid no-op.
            return Err(Errno::EINVAL);
        }
        Ok(activations)
    }

    /// Child-install ENTRY (the module-owned `fm_attach_child`, which serves the
    /// COW and the vfork borrowed child alike). Seeds the reference replay driver/feed AND
    /// builds ONE drive plan that first reconstructs the reference graph
    /// (Phase 0/0b/3/4/5, identical to `restore_from_arena_impl`) and THEN — as the
    /// child-install tail — drives every activation's guest
    /// `wpk_fork_module_state_restore` and `wpk_fork_module_state_finish_restore`
    /// through the host-bound drive table (`append_attach_steps`). This moves the
    /// JS `ForkActivationRegistry.restoreModuleState` two-phase install SEQUENCING
    /// into the module: the guest's own layout-specific restore exports still place
    /// the reconstructed identities into the live child (only the guest knows its
    /// global/table layout), but the ORDER and DRIVE are now module-owned. Returns
    /// the plan's guest address; the step count is read from `fm_gc_plan_count`.
    ///
    /// The COW and the vfork borrowed child share this identical install plan, which
    /// is why there is ONE entry rather than two: the only borrowed-specific work is
    /// the host-side child-private replay-prefix reservation (raw memory floor, no
    /// reference values), and that never entered this module.
    fn attach_from_arena_impl(module_state_root: u64, pid: u32) -> Result<usize, Errno> {
        begin_reference_replay_impl(module_state_root, pid)?;
        // Exnref tag-validity ADMISSION gate (fail-loud SECURITY boundary). Runs
        // right after the graph is decoded and BEFORE the reconstruction drive plan
        // is built, so a corrupt / mismatched exnref recipe is rejected (`EINVAL`)
        // rather than driven blindly through the guest exception-materialize export
        // by the plan's `DRIVE_OP_EXN` step. Moved here from the host
        // (`assertForkModuleExnrefTagsDeclared`); the host seeds each activation's
        // declared tags via `fm_set_activation_exception_tags` before this entry.
        assert_exnref_tags_admissible()?;
        let mut steps = build_reconstruction_steps()?;
        let activations = arena_module_activations(module_state_root)?;
        drive_plan::append_attach_steps(&mut steps, &activations);
        serialize_and_store_plan(&steps)
    }

    // -- Reference RESTORE data-feed helpers (Phase 6 item 3a) ---------------
    //
    // Each helper borrows the immutable transaction from the resident driver and
    // the mutable feed from its own cell (two disjoint statics -> no aliasing),
    // then delegates to the field-for-field port in `fork_codec::reference_feed`.
    // On the `Err` the JS provider body would have THROWN, the export TRAPS
    // (`wasm_intr::unreachable`), exactly as `fm_funcref_ordinal` does: the host
    // gate keeps an unadmitted/corrupt graph on the JS reference path, so an Err
    // here is corruption, never a value the guest codec should read. The
    // legitimate routing sentinels (`0` for i31, `-1` for a mismatch) are `Ok`
    // and returned as-is.

    /// The resident transaction (from the driver) and mutable feed, or a trap if
    /// `fm_begin_reference_replay` did not seed them.
    #[allow(clippy::mut_from_ref)]
    fn feed_and_transaction()
    -> (&'static ReferenceReplayFeed, &'static fork_codec::SegmentedReferenceTransaction) {
        let transaction = match reference_state().as_ref() {
            Some(driver) => driver.transaction(),
            None => wasm_intr::unreachable(),
        };
        let feed = match reference_feed().as_ref() {
            Some(feed) => feed,
            None => wasm_intr::unreachable(),
        };
        (feed, transaction)
    }

    fn feed_read<T>(result: Result<T, Errno>) -> T {
        match result {
            Ok(value) => {
                REFERENCE_FEED_READS.fetch_add(1, Ordering::Relaxed);
                value
            }
            Err(_) => wasm_intr::unreachable(),
        }
    }

    fn ref_vector_get_impl(ordinal: u32, index: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.vector_get(transaction, ordinal, index))
    }

    fn ref_gc_route_impl(recipe_id: u32, expected_activation: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.gc_route(transaction, recipe_id, expected_activation))
    }

    fn ref_gc_payload_len_impl(recipe_id: u32, expected_activation: u32, expected_layout_id: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.gc_payload_len(transaction, recipe_id, expected_activation, expected_layout_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn ref_gc_load_impl(
        recipe_id: u32,
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
    ) -> i32 {
        // The mutable feed and read-only transaction come from disjoint statics;
        // `mem_mut` is the guest linear-memory data plane the writer path uses
        // (frame writes above module data), so the scalar destination never
        // overlaps the module's BSS-resident feed/transaction.
        let transaction = match reference_state().as_ref() {
            Some(driver) => driver.transaction(),
            None => wasm_intr::unreachable(),
        };
        let feed = match reference_feed().as_mut() {
            Some(feed) => feed,
            None => wasm_intr::unreachable(),
        };
        let mem = unsafe { mem_mut() };
        feed_read(feed.gc_load(
            transaction,
            mem,
            recipe_id,
            module_activation,
            type_ordinal,
            layout_id,
            kind,
            scalar_destination,
            scalar_byte_length,
        ))
    }

    fn ref_exn_route_impl(recipe_id: u32, expected_activation: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.exn_route(transaction, recipe_id, expected_activation))
    }

    #[allow(clippy::too_many_arguments)]
    fn ref_exn_load_impl(
        recipe_id: u32,
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
        reference_ids_destination: usize,
        reference_count: u32,
    ) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        let mem = unsafe { mem_mut() };
        feed_read(feed.exn_load(
            transaction,
            mem,
            recipe_id,
            module_activation,
            tag_ordinal,
            layout_id,
            scalar_destination,
            scalar_byte_length,
            reference_ids_destination,
            reference_count,
        ))
    }

    fn ref_exn_cache_index_impl(recipe_id: u32) -> i32 {
        let (feed, transaction) = feed_and_transaction();
        feed_read(feed.exn_cache_index(transaction, recipe_id))
    }

    /// Resolve a funcref recipe to a catalog ordinal for the injected shim.
    /// Returns a NON-NEGATIVE catalog ordinal for a Funcref, `NULL_ORDINAL` for
    /// the canonical Null reference, and TRAPS on any inconsistency (missing
    /// reference state, out-of-range recipe, non-funcref kind, or an ordinal that
    /// does not fit `i32`). Every success bumps `REFERENCES_RECONSTRUCTED`.
    fn funcref_ordinal_impl(recipe_id: u32) -> i32 {
        let driver = match reference_state().as_ref() {
            Some(driver) => driver,
            None => wasm_intr::unreachable(),
        };
        match driver.funcref_node(recipe_id) {
            Ok(None) => {
                REFERENCES_RECONSTRUCTED.fetch_add(1, Ordering::Relaxed);
                NULL_ORDINAL
            }
            Ok(Some(target)) => {
                // Merged-catalog GLOBAL slot: `base(module_activation) +
                // function_ordinal`. The base map is EMPTY for a single-activation
                // worker, so `base` defaults to 0 and the mapping is the
                // byte-identical D6.1 raw ordinal. A NON-empty map missing this
                // funcref's activation is corruption — the host gate seeds a base
                // for every funcref activation before replay — so it TRAPS rather
                // than read slot 0 / the wrong activation's catalog.
                let base = match func_catalog_base(target.module_activation) {
                    Some(base) => base,
                    None if func_catalog_base_map_empty() => 0,
                    None => wasm_intr::unreachable(),
                };
                let slot = match base.checked_add(target.function_ordinal) {
                    Some(slot) => slot,
                    None => wasm_intr::unreachable(),
                };
                match i32::try_from(slot) {
                    Ok(ordinal) if ordinal >= 0 => {
                        REFERENCES_RECONSTRUCTED.fetch_add(1, Ordering::Relaxed);
                        ordinal
                    }
                    // A global slot that does not fit a non-negative i32 cannot
                    // index the imported funcref table — a corrupt graph, not a
                    // value.
                    _ => wasm_intr::unreachable(),
                }
            }
            // Out-of-range recipe or a kind D6.1 does not admit: the host gate
            // should have kept this fork on JS, so reaching here is corruption.
            Err(_) => wasm_intr::unreachable(),
        }
    }

    /// Resolve a static-root recipe id to a merged anyref-catalog index for the
    /// injected drive shim (the static-root binder). Returns a NON-NEGATIVE global
    /// slot `base(module_activation) + static_root_ordinal` for the shim to
    /// `table.get(static_root_catalog)` and publish into the transit, and TRAPS on
    /// any inconsistency (missing reference state, out-of-range recipe, a
    /// non-static-root kind, an un-seeded activation in a multi-activation worker,
    /// or a slot that does not fit `i32`). Every success bumps
    /// `STATIC_ROOTS_PUBLISHED`. Mirrors `funcref_ordinal_impl`.
    fn static_root_slot_impl(recipe_id: u32) -> i32 {
        let driver = match reference_state().as_ref() {
            Some(driver) => driver,
            None => wasm_intr::unreachable(),
        };
        let target = match driver.static_root_node(recipe_id) {
            Ok(target) => target,
            // Out-of-range recipe or a non-static-root kind: the host gate should
            // have kept this off the static-root step, so reaching here is
            // corruption, never a value.
            Err(_) => wasm_intr::unreachable(),
        };
        // Merged-catalog GLOBAL slot: `base(module_activation) +
        // static_root_ordinal`. The base map is EMPTY for a single-activation
        // worker, so `base` defaults to 0 (byte-identical raw-ordinal mapping). A
        // NON-empty map missing this static root's activation is corruption — the
        // host gate seeds a base for every static-root activation before replay —
        // so it TRAPS rather than read slot 0 / the wrong activation's catalog.
        let base = match static_root_catalog_base(target.module_activation) {
            Some(base) => base,
            None if static_root_catalog_base_map_empty() => 0,
            None => wasm_intr::unreachable(),
        };
        let slot = match base.checked_add(target.static_root_ordinal) {
            Some(slot) => slot,
            None => wasm_intr::unreachable(),
        };
        match i32::try_from(slot) {
            Ok(index) if index >= 0 => {
                STATIC_ROOTS_PUBLISHED.fetch_add(1, Ordering::Relaxed);
                index
            }
            // A global slot that does not fit a non-negative i32 cannot index the
            // imported anyref catalog table — a corrupt graph, not a value.
            _ => wasm_intr::unreachable(),
        }
    }

    /// Resolve an externref recipe id to its captured broker handle (M2 — the
    /// externref host seam shrunk to a single `resolve_externref(handle) ->
    /// externref` import). This is NOT a guest-facing import: it is the helper
    /// the injected `fm_drive_execute` shim calls on a DRIVE_OP_EXTERNREF_TRANSIT
    /// step — emitted for EVERY externref recipe, directly held and
    /// GC/exnref-reachable alike, since the 2026-09-05 substrate fix — to get
    /// the `u32` handle it passes to the host `resolve_externref` import — a
    /// Rust function cannot itself return an
    /// `externref`, exactly why `fm_funcref_ordinal`/`fm_static_root_slot` hand
    /// back an index rather than a `funcref`/`anyref`. Returns the recipe's
    /// captured broker handle (the same handle a live host-import adapter minted
    /// into the broker before the fork) and TRAPS on any inconsistency (missing
    /// reference state, out-of-range recipe, a non-externref kind, or a handle
    /// that does not fit a non-negative `i32`) — the host gate should have kept an
    /// unadmitted/corrupt graph off the module path, so reaching here is
    /// corruption, never a value the shim should resolve. Mirrors
    /// `funcref_ordinal_impl`/`static_root_slot_impl`.
    fn externref_handle_impl(recipe_id: u32) -> i32 {
        let driver = match reference_state().as_ref() {
            Some(driver) => driver,
            None => wasm_intr::unreachable(),
        };
        let entry = match driver.transaction().nodes.get(recipe_id as usize) {
            // The decoder guarantees canonical id == index; assert it so a corrupt
            // graph reaching here is a loud failure, not a silent mis-resolution.
            Some(entry) if entry.id == recipe_id => entry,
            _ => wasm_intr::unreachable(),
        };
        let handle = match entry.node {
            ReferenceRecipeNode::Externref { handle } => handle,
            // Out-of-range recipe or a non-externref kind: the host gate should
            // have kept this off the externref-transit step, so reaching here is
            // corruption, never a value.
            _ => wasm_intr::unreachable(),
        };
        match i32::try_from(handle) {
            Ok(value) if value >= 0 => value,
            // A handle that does not fit a non-negative i32 cannot cross the
            // `resolve_externref` import boundary as this ABI defines it — a
            // corrupt graph, not a value.
            _ => wasm_intr::unreachable(),
        }
    }

    // -- Guest-facing exports (signatures == WPK_FORK_REQUIRED_IMPORTS) ------
    //
    // These FROZEN, activation-less names are the single-activation path: they
    // route to the fork's `primary_activation`. A multi-activation (dlopen) guest
    // instead reaches its per-activation frame state through a per-activation
    // TRAMPOLINE that folds in the activation id and calls the shared
    // `fm_frame_*(act, ...)` exports below — so these exports are unchanged and
    // no guest re-instrumentation is required.

    /// `__wpk_fork_module_state_table_state_owned(owner) -> i32` for the
    /// single-activation path, which binds the guest's frozen one-argument
    /// signature straight to this export rather than through a trampoline.
    ///
    /// The multi-activation path reaches `fm_module_state_table_state_owned`
    /// through `__wpk_fork_activation_trampolines` instead, which folds the
    /// activation in. Both answer from the same seeded election; this one just
    /// assumes the primary activation, exactly as the frame exports below do.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_state_owned(owner_id: u32) -> u32 {
        table_state_owned_impl(primary_activation(), owner_id)
    }

    /// `__wpk_fork_frame_reserve(size) -> payload`. Reserve the next frame node
    /// and return its payload pointer (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_reserve(size: usize) -> usize {
        match reserve_impl(primary_activation(), size as u64) {
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
        match commit_impl(primary_activation(), payload as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// `__wpk_fork_frame_peek(size) -> payload`. Journal-gated non-consuming peek
    /// of the current rewind frame (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_frame_peek(size: usize) -> usize {
        match peek_impl(primary_activation(), size as u64) {
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
        match next_impl(primary_activation(), size as u64) {
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
        match resume_peek_impl(primary_activation()) {
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

    // -- Shared activation-parameterized frame exports (trampoline targets) --
    //
    // Phase 6 D7a.2 (ADDITIVE): the per-activation TRAMPOLINE for activation
    // `act` calls these, folding in its constant activation id, so each
    // activation's frames route to its OWN writer/driver in the map while the
    // journal + resume table stay process-wide. The single-activation guest-
    // facing exports above are these with `act == primary_activation`.

    /// `fm_frame_reserve(act, size) -> payload`. Reserve into activation `act`'s
    /// own writer/arena (0 on failure; check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_reserve(activation_id: u32, size: usize) -> usize {
        match reserve_impl(activation_id, size as u64) {
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

    /// `fm_frame_commit(act, payload)`. Commit activation `act`'s pending
    /// reservation and record its ordinal in the process-wide journal, tagged
    /// with `act`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_commit(activation_id: u32, payload: usize) {
        match commit_impl(activation_id, payload as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// `fm_frame_peek(act, size) -> payload`. Journal-gated non-consuming peek of
    /// activation `act`'s current rewind frame (0 on failure).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_peek(activation_id: u32, size: usize) -> usize {
        match peek_impl(activation_id, size as u64) {
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

    /// `fm_frame_next(act, size) -> payload`. Journal-gated consuming advance of
    /// activation `act`'s rewind cursor (0 on failure).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_frame_next(activation_id: u32, size: usize) -> usize {
        match next_impl(activation_id, size as u64) {
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

    /// `fm_resume_peek(act) -> slot`. Resume-slot for the currently selected
    /// process-wide replay event (0 = reserved sentinel; -1 on error). The
    /// `act` argument is accepted for a uniform trampoline shape; the resume slot
    /// is a process-wide journal concern (see `resume_peek_impl`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_resume_peek(activation_id: u32) -> i32 {
        match resume_peek_impl(activation_id) {
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
    pub extern "C" fn fm_set_format(
        pointer_width: u32,
        fixed_prefix_size: u32,
        archive_control_addr: usize,
        table_owner: u32,
        channel_base: usize,
    ) {
        match set_format_impl(
            pointer_width,
            fixed_prefix_size,
            archive_control_addr,
            table_owner,
            channel_base,
        ) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
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

    /// The byte length of the KFRE image the last `fm_serialize_journal_alloc`
    /// wrote (0 if none). The host reads this together with the returned pointer
    /// to write the `JournalImage` KFMS record.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_journal_image_len() -> i64 {
        match state().as_ref() {
            Some(st) => st.journal_image_len as i64,
            None => 0,
        }
    }

    /// Release every channel-mapped frame/image chunk WITHOUT requiring the
    /// replay to have finished — the host error/abort path (mirrors the JS
    /// backend's `abort()` releasing the frame arena). Idempotent.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_abort() {
        // Deliberately legal from EVERY phase, including idle: this is the
        // teardown a failed fork unwinds through, and a teardown that can itself
        // be refused leaves the process stuck in the phase it was trying to
        // leave. It returns to idle whether or not the impl succeeded, for the
        // same reason.
        let result = abort_impl();
        enter_phase(PHASE_IDLE);
        match result {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed a forked CHILD instance's replay from copied guest memory and attach
    /// its rewind driver. `module_buffer` is the continuation anchor the parent
    /// published (inherited at the same guest offset); `[image_ptr, image_ptr +
    /// image_len)` is the KFRE image the parent serialized with
    /// `fm_serialize_journal` (also inherited via the memory copy). The child is
    /// a FRESH instance placed at a DIFFERENT `__memory_base` with an empty
    /// journal; this rebuilds the journal + resume-slot table from the COPIED
    /// bytes only, then drives replay exactly as the parent's committed order
    /// dictates. This is the module equivalent of JS `attachChild` ->
    /// `replayEventsForChild(records)` -> `events.attachChild`. On success the
    /// guest then drives `__wpk_fork_frame_peek/next` + `__wpk_fork_resume_peek`.
    /// Sequence a whole CHILD SEED in the module (control-flow inversion): decode
    /// the inherited `JournalImage` record from the COPIED KFMS arena rooted at
    /// `module_state_root` and seed activation 0's replay from it, then seed each
    /// side activation from the host-passed `sides` scratch (`[sides_ptr, sides_ptr
    /// + sides_count*16)`, each a `(id, fixed_prefix, root_lo, root_hi)` 16-byte
    /// record). Folds the host's former `fm_begin_child_replay` +
    /// per-activation `fm_add_activation_child_replay` loop in `attachModuleChild`
    /// into ONE module call. `act0_root` is activation 0's inherited launch anchor.
    /// A single-activation fork passes `sides_count == 0`. Check `fm_last_errno`.
    /// Both fine-grained exports this replaced -- `fm_begin_child_replay` and
    /// `fm_add_activation_child_replay` -- have been deleted; the side-activation
    /// seeding they performed is `add_activation_child_replay_impl` below, which
    /// this entry calls directly.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_child_seed(
        module_state_root: usize,
        act0_root: usize,
        sides_ptr: usize,
        sides_count: usize,
    ) {
        match require_phase(PHASE_IDLE).and_then(|()| {
            child_seed_impl(
                module_state_root as u64,
                act0_root as u64,
                sides_ptr as u64,
                sides_count as u64,
            )
        }) {
            Ok(()) => {
                enter_phase(PHASE_CHILD_REPLAY);
                set_ok()
            }
            Err(errno) => set_err(errno),
        }
    }

    /// Sequence a whole BORROWED (vfork) CHILD SEED in the module (control-flow
    /// inversion): decode the inherited `JournalImage` record from the KFMS arena
    /// rooted at `module_state_root` and seed activation 0's borrowed replay from
    /// it, then seed each side activation from the host-passed `sides` scratch
    /// (`[sides_ptr, sides_ptr + sides_count*24)`, each a `(id, fixed_prefix,
    /// root_lo, root_hi, private_lo, private_hi)` 24-byte record). Folds the host's
    /// former `fm_begin_borrowed_child_replay` + per-activation
    /// `fm_add_activation_borrowed_child_replay` loop in `attachBorrowedModuleChild`
    /// into ONE module call — the borrowed sibling of `fm_child_seed`. `act0_root`
    /// is activation 0's borrowed launch anchor; `act0_private_prefix` its
    /// child-private prefix. A single-activation vfork passes `sides_count == 0`.
    /// Check `fm_last_errno`. Both fine-grained exports this replaced --
    /// `fm_begin_borrowed_child_replay` and
    /// `fm_add_activation_borrowed_child_replay` -- have been deleted; the
    /// side-activation seeding they performed is
    /// `add_activation_borrowed_child_replay_impl` below, which this entry calls
    /// directly.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_child_seed_borrowed(
        module_state_root: usize,
        act0_root: usize,
        act0_private_prefix: usize,
        sides_ptr: usize,
        sides_count: usize,
    ) {
        match require_phase(PHASE_IDLE).and_then(|()| {
            child_seed_borrowed_impl(
                module_state_root as u64,
                act0_root as u64,
                act0_private_prefix as u64,
                sides_ptr as u64,
                sides_count as u64,
            )
        }) {
            Ok(()) => {
                enter_phase(PHASE_CHILD_REPLAY);
                set_ok()
            }
            Err(errno) => set_err(errno),
        }
    }

    /// Seed one table coordinate's sparse-state election result.
    ///
    /// The HOST elects -- it compares `WebAssembly.Table` object identity, which
    /// wasm cannot do -- and tells the module the answer here, once per
    /// coordinate. The guest's `__wpk_fork_module_state_table_state_owned`
    /// import is then served by `fm_module_state_table_state_owned` below instead of by a
    /// host callback, which takes one function off every JS host's floor.
    ///
    /// Re-seeding a known coordinate UPDATES it. The host re-elects when a lower
    /// coordinate registers for the same physical table, so an incumbent must be
    /// demotable; refusing the second seed would freeze the first election and
    /// leave the table with two writers. `owner_id` 0 is rejected (`EINVAL`) and
    /// a 257th distinct coordinate is `E2BIG`. Check `fm_last_errno`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_table_state_owner(
        activation_id: u32,
        owner_id: u32,
        owns: u32,
    ) {
        match set_activation_table_state_owner_impl(activation_id, owner_id, owns) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_state_owned(owner) -> i32`,
    /// reached through the per-activation trampoline that folds the activation in.
    ///
    /// Infallible: an unseeded coordinate is 0, not an error. It does not touch
    /// `fm_last_errno`, because the guest calls it on the table-mutation path and
    /// a reader must not clobber the errno a caller is about to inspect.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_module_state_table_state_owned(activation_id: u32, owner_id: u32) -> u32 {
        table_state_owned_impl(activation_id, owner_id)
    }

    /// Seed the FULL resume catalog for this worker: `[ptr, ptr + count*4)` is a
    /// little-endian `u32` array of the fork-instrumented function ordinals (the
    /// same set the host registers into the JS `__wpk_fork_resume_table`). The
    /// module registers its `ResumeSlotTable` from this catalog at replay so its
    /// slot numbering matches the JS table by construction (resume-slot parity).
    /// Called ONCE per worker (like `fm_set_format`), before any fork. A catalog
    /// larger than the module's cap fails with `E2BIG` (check `fm_last_errno`);
    /// the host then keeps the JavaScript continuation for that program.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_resume_catalog(ptr: usize, count: usize) {
        match set_resume_catalog_impl(ptr as u64, count as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's resume catalog for this worker (Phase 6 D7a.1a — the
    /// multi-activation path): `[ptr, ptr + count*4)` is a little-endian `u32`
    /// array of `activation_id`'s OWN fork-instrumented function ordinals (the set
    /// the host registers into THAT activation's JS `__wpk_fork_resume_table`).
    /// A dlopen fork loads N modules, each with its own catalog table; the module
    /// registers each activation's resume slots from ITS catalog so the numbering
    /// matches that activation's JS table by construction (resume-slot parity).
    /// Called ONCE per activation per worker, before any fork, alongside
    /// `fm_set_format`. Too many activations, or catalogs that jointly exceed the
    /// module's arena, fail with `E2BIG`; a re-seeded activation fails with
    /// `EINVAL` (check `fm_last_errno`), and the host keeps the JavaScript
    /// continuation for that program.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_resume_catalog(
        activation_id: u32,
        ptr: usize,
        count: usize,
    ) {
        match set_activation_resume_catalog_impl(activation_id, ptr as u64, count as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's function-catalog BASE for this worker (Phase 6
    /// D7a.1b — the merged-catalog mechanism): the host lays every activation's
    /// funcref catalog into ONE merged `__wpk_fork_function_catalog` table, with
    /// `activation_id`'s catalog occupying slots `[base, base + len)`.
    /// `fm_funcref_ordinal` then returns the GLOBAL slot
    /// `base(module_activation) + function_ordinal` for the injected funcref shim
    /// to `table.get`, so a funcref minted in one activation but held by another's
    /// frame resolves against its OWN activation's slice. Called ONCE per
    /// activation per worker (like `fm_set_activation_resume_catalog`), before any
    /// fork drives reference reconstruction. A SINGLE-activation worker seeds no
    /// base at all; `fm_funcref_ordinal` then defaults `base = 0`, byte-identical
    /// to the D6.1 raw-ordinal mapping. Too many activations fail with `E2BIG`; a
    /// re-seeded activation fails with `EINVAL` (check `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_catalog_base(activation_id: u32, base: u32) {
        match set_activation_catalog_base_impl(activation_id, base) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's static-root catalog BASE for this worker (the
    /// static-root binder — the funcref merged-catalog mechanism, for static
    /// roots): the host lays every activation's instantiation-time static-root
    /// catalog into ONE merged `env.__wpk_fork_static_root_catalog` anyref table,
    /// with `activation_id`'s catalog occupying slots `[base, base + len)`.
    /// `fm_static_root_slot` then returns the GLOBAL slot
    /// `base(module_activation) + static_root_ordinal` for the injected drive shim
    /// to `table.get`. Called ONCE per activation per worker, before any fork
    /// drives reference reconstruction. A SINGLE-activation worker seeds no base at
    /// all; `fm_static_root_slot` then defaults `base = 0`. Too many activations
    /// fail with `E2BIG`; a re-seeded activation fails with `EINVAL` (check
    /// `fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_static_root_base(activation_id: u32, base: u32) {
        match set_activation_static_root_base_impl(activation_id, base) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Seed ONE activation's raw `kandelo.wpk_fork.gc_codec` section bytes for this
    /// worker (Phase 6 item 3c — the real GC drive plan). `ptr`/`byte_len` point at
    /// the section bytes the host wrote into guest memory; the module copies them
    /// into its own arena and decodes them (into a `GcCodec`) when
    /// `fm_build_gc_plan` runs, to supply the per-recipe GC-layout facts the JS
    /// `materializeTypedGraph` drive-order needs (constructor dependencies,
    /// defaultable shells, the i31 owner). Called ONCE per activation per worker,
    /// before any fork drives GC reconstruction, alongside `fm_set_format`. Too
    /// many activations, or catalogs that jointly exceed the module's arena, fail
    /// with `E2BIG`; a re-seeded activation fails with `EINVAL` (check
    /// `fm_last_errno`), and the host keeps the JS drive-order for that program.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_activation_gc_codec(activation_id: u32, ptr: usize, byte_len: usize) {
        match set_activation_gc_codec_impl(activation_id, ptr as u64, byte_len as u64) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    // `fm_set_activation_exception_tags` was DELETED here: it took a `u32` array
    // the host produced by decoding the exception codec section, which made the
    // host a second decoder of a module-owned format.
    // `fm_set_activation_exception_codec` above takes the raw section instead.

    /// Seed which activation owns a HOST exnref (one with no activation of its
    /// own): the smallest activation that declared an exception codec, or
    /// `u32::MAX` for "none". `build_gc_plan_impl` leaves an exnref ownerless when
    /// this is `u32::MAX` so `build_drive_plan` fails loudly rather than guessing.
    ///
    /// Still host-seeded, and the module COULD derive it -- the owning set is
    /// exactly the activations that reach `fm_set_activation_exception_codec`. It
    /// is not derived because nothing could observe that it had been: see census
    /// section 67.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_set_host_exception_owner(owner: u32) {
        HOST_EXCEPTION_OWNER.store(owner, Ordering::Relaxed);
        set_ok();
    }


    /// Seed the reference graph for this fork from the KFMS module-state arena
    /// rooted at `module_state_root` and run its bookkeeping reconstruction pass
    /// (Phase 6 D6.2, widened from D6.1). The host calls this once on a qualifying
    /// fork after `fm_begin_child_replay`, before the guest rewind reconstructs
    /// references. `pid` names the child process image; retained in this export's
    /// signature for the host call site, but unused since M2 — the reconstruction
    /// no longer opens a host root generation (that seam retired, see
    /// `ReconstructionState`'s doc).
    ///
    /// On success the guest's `__wpk_fork_ref_decode_funcref` is served by this
    /// module; EVERY externref recipe — directly held (frame-vector-only) and
    /// GC/exnref-reachable alike — is published into the anyref transit by a
    /// `DRIVE_OP_EXTERNREF_TRANSIT` drive step (via `fm_externref_handle`) when
    /// `fm_drive_execute` runs the plan `fm_build_gc_plan` built. Failure (check
    /// `fm_last_errno`: `EOPNOTSUPP` for an unadmitted kind, `EINVAL` for a
    /// malformed arena) means the host must keep the byte-identical JS reference
    /// path for this fork.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_begin_reference_replay(module_state_root: usize, pid: u32) {
        match begin_reference_replay_impl(module_state_root as u64, pid) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Resolve a funcref recipe id to a function-catalog ordinal (Phase 6 D6.1).
    /// This is NOT a guest-facing import: it is the helper the injected
    /// `__wpk_fork_ref_decode_funcref` wasm shim calls to get the ordinal, then
    /// does `table.get` on the imported `__wpk_fork_function_catalog` table (a
    /// funcref a Rust function cannot itself return). Returns a non-negative
    /// catalog ordinal for a Funcref, `-1` for the canonical Null reference, and
    /// TRAPS on any inconsistency. See `funcref_ordinal_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_funcref_ordinal(recipe_id: u32) -> i32 {
        funcref_ordinal_impl(recipe_id)
    }

    /// Resolve a static-root recipe id to a merged anyref-catalog index (the
    /// static-root binder). This is NOT a guest-facing import: it is the helper the
    /// injected `fm_drive_execute` shim calls on a DRIVE_OP_STATIC_ROOT step to get
    /// the index it `table.get`s on the imported `env.__wpk_fork_static_root_catalog`
    /// table (an anyref a Rust function cannot itself return) before publishing the
    /// value into the transit at slot `recipe + 1`. Returns a non-negative catalog
    /// index and TRAPS on any inconsistency. See `static_root_slot_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_static_root_slot(recipe_id: u32) -> i32 {
        static_root_slot_impl(recipe_id)
    }

    /// Resolve an externref recipe id to its captured broker handle (M2 — the
    /// externref host seam). This is NOT a guest-facing import: it is the helper
    /// the injected binder calls to get the `u32` handle it passes to the single
    /// residual host import `resolve_externref(handle) -> externref` (an
    /// `externref` a Rust function cannot itself return) on a
    /// DRIVE_OP_EXTERNREF_TRANSIT step (emitted for EVERY externref recipe —
    /// directly held and GC/exnref-reachable alike — since the 2026-09-05
    /// substrate fix) before `any.convert_extern` + `table.set`-ing the result
    /// into the anyref transit at slot `recipe + 1`. Returns a non-negative
    /// broker handle and TRAPS on any inconsistency. See
    /// `externref_handle_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_externref_handle(recipe_id: u32) -> i32 {
        externref_handle_impl(recipe_id)
    }

    // -- Reference RESTORE data-feed exports (Phase 6 item 3a) ---------------
    //
    // These seven exports are guest-facing: the host flips the guest's
    // `__wpk_fork_ref_{vector_get,gc_route,gc_payload_len,gc_load,exn_route,
    // exn_load,exn_cache_index}` imports to them per-activation (the same
    // per-activation flip as `__wpk_fork_ref_decode_funcref`). Unlike the funcref
    // decode (which RETURNS a funcref, so it needs the walrus-injected shim),
    // these have pure i32/i64 signatures, so plain Rust `#[no_mangle]` exports the
    // guest imports directly. Signatures match the guest imports in
    // `host/src/generated/abi.ts` (`ptr` -> `usize`, i32 -> u32/i32).

    /// `__wpk_fork_ref_vector_get(ordinal, index) -> recipe_id`.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_vector_get(ordinal: u32, index: u32) -> i32 {
        ref_vector_get_impl(ordinal, index)
    }

    /// `__wpk_fork_ref_gc_route(recipe_id, expected_activation) -> layout|0|-1`.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_route(recipe_id: u32, expected_activation: u32) -> i32 {
        ref_gc_route_impl(recipe_id, expected_activation)
    }

    /// `__wpk_fork_ref_gc_payload_len(recipe_id, activation, layout) -> len`.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_payload_len(
        recipe_id: u32,
        expected_activation: u32,
        expected_layout_id: u32,
    ) -> i32 {
        ref_gc_payload_len_impl(recipe_id, expected_activation, expected_layout_id)
    }

    /// `__wpk_fork_ref_gc_load(recipe_id, activation, type, layout, kind, dst,
    /// len) -> vector_ordinal|0`. `dst` is an absolute guest byte offset (`ptr`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_load(
        recipe_id: u32,
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
    ) -> i32 {
        ref_gc_load_impl(
            recipe_id,
            module_activation,
            type_ordinal,
            layout_id,
            kind,
            scalar_destination,
            scalar_byte_length,
        )
    }

    /// `__wpk_fork_ref_exn_route(recipe_id, expected_activation) -> layout|-1`.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_route(recipe_id: u32, expected_activation: u32) -> i32 {
        ref_exn_route_impl(recipe_id, expected_activation)
    }

    /// `__wpk_fork_ref_exn_load(recipe_id, activation, tag, layout, scalar_dst,
    /// scalar_len, ref_ids_dst, ref_count) -> 1`. Both `dst` args are absolute
    /// guest byte offsets (`ptr`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_load(
        recipe_id: u32,
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalar_destination: usize,
        scalar_byte_length: u32,
        reference_ids_destination: usize,
        reference_count: u32,
    ) -> i32 {
        ref_exn_load_impl(
            recipe_id,
            module_activation,
            tag_ordinal,
            layout_id,
            scalar_destination,
            scalar_byte_length,
            reference_ids_destination,
            reference_count,
        )
    }

    /// `__wpk_fork_ref_exn_cache_index(recipe_id) -> index`.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_cache_index(recipe_id: u32) -> i32 {
        ref_exn_cache_index_impl(recipe_id)
    }

    // -- GC drive-shim exports (Phase 6 item 3b) -----------------------------

    /// The first `env.__wpk_fork_drive_table` slot for `activation` (item 3b).
    /// The host reads this to bind each activation's `_gc_allocate`/`_gc_fill`
    /// guest exports at `base + {ALLOC, FILL}`, matching the absolute slot numbers
    /// the Rust drive PLAN encodes. A single-activation fork uses base 0.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_drive_table_base(activation: u32) -> i32 {
        drive_plan::drive_table_base(activation) as i32
    }

    /// Build the REAL topological GC drive plan (Phase 6 item 3c) for the fork's
    /// whole reference graph, reproducing the JS `materializeTypedGraph` order, and
    /// return its guest address for `fm_drive_execute`. Requires
    /// `fm_begin_reference_replay` to have seeded the driver and each participating
    /// activation's `fm_set_activation_gc_codec` to have seeded its layout catalog.
    /// Returns 0 on failure (check `fm_last_errno`): a missing driver, an un-seeded
    /// GC activation, a mismatched recipe/layout coordinate, or an unallocatable
    /// constructor/exception cycle is a truthful failure, never a wrong plan.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_build_gc_plan(pid: u32) -> usize {
        match build_gc_plan_impl(pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// The step count of the plan `fm_build_gc_plan` last serialized (the `count`
    /// argument for `fm_drive_execute`). 0 before the first successful build.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_gc_plan_count() -> i32 {
        GC_PLAN_COUNT.load(Ordering::Relaxed) as i32
    }

    /// Serialize a TRIVIAL single-struct drive plan (ALLOC then FILL for one
    /// `recipe` in `activation`) into a module-owned scratch buffer and return its
    /// guest address for `fm_drive_execute`. The shim's post-ALLOC integrity guard
    /// reads STORE #2 (the guest's Wasm-GC transit table) directly, so no host
    /// generation is opened here. Returns 0 on failure (check `fm_last_errno`).
    ///
    /// RETENTION: this is a test-only plan builder — no production or native path
    /// calls it. It survives ONLY to enable the sole runtime regression test of
    /// the injected `fm_drive_execute` shim's store-#2 GC-integrity trap
    /// (`host/test/fork-module-drive-shim.test.ts`): the load-bearing
    /// `table.get`+`ref.is_null` guard that turns a guest `_gc_allocate` that
    /// failed to publish a live GC object into a truthful trap instead of a silent
    /// wrong reconstruction. That coverage is wasmtime-runnable (the guard is in
    /// the injected wasm, not V8-specific) and should migrate to a host-native
    /// wasmtime instantiation test built on `fork_codec::drive_plan`'s public
    /// `trivial_struct_plan` + `serialize_plan`; once it does, this export and
    /// `fm_trivial_plan_count` can be deleted.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_build_trivial_plan(activation: u32, recipe: u32, pid: u32) -> usize {
        match build_trivial_plan_impl(activation, recipe, pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// The step count of the plan `fm_build_trivial_plan` wrote (the `count`
    /// argument for `fm_drive_execute`). The trivial plan is exactly ALLOC + FILL.
    /// Test-only; see the retention note on `fm_build_trivial_plan`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_trivial_plan_count() -> i32 {
        2
    }

    /// Sequence a whole PARENT REPLAY-begin phase in the module (control-flow
    /// inversion): begin the parent rewind (`begin_replay_impl` — attach every
    /// activation's driver + register its resume slots), build the per-activation
    /// REWIND-begin drive plan (one `DRIVE_OP_REWIND_BEGIN` step per open
    /// activation carrying its stored continuation root), then DRIVE it through
    /// the injector-wired `fm_drive_execute` shim, which `call_indirect`s each
    /// activation's guest `wpk_fork_rewind_begin(root)` in ascending id order.
    ///
    /// This replaces the host's former two-part sequence — `fm_begin_replay`
    /// followed by a per-activation `wpk_fork_rewind_begin(root)` loop — with ONE
    /// module call. The host must have bound each activation's
    /// `wpk_fork_rewind_begin` into `__wpk_fork_drive_table` at
    /// `fm_drive_table_base(activation) + DRIVE_SLOT_REWIND_BEGIN` before calling
    /// this (the ref-typed table bind is a host floor). Behaviourally identical
    /// to the old host loop: same guest export, same roots, same order. A zero-
    /// activation state or a plan-build failure is a truthful errno
    /// (`fm_last_errno`); a guest reconstruction failure traps inside the shim
    /// exactly as it did under the host loop.
    ///
    /// `abort != 0` selects the ABORT-replay phase instead: `begin_abort_impl`
    /// rather than `begin_replay_impl`, and `DRIVE_OP_ABORT_BEGIN` steps driving
    /// the guest's `wpk_fork_abort_begin(root)` (bound at `DRIVE_SLOT_ABORT_BEGIN`)
    /// rather than `wpk_fork_rewind_begin`. Both phases take the SAME continuation
    /// root — the module's per-activation `module_buffer` — so the two plans are
    /// byte-identical except for the op tag.
    ///
    /// This replaced a separate `fm_parent_abort()` export. The flag is safe to
    /// carry at the boundary because `parent_replay_impl` already took it, both
    /// values drive the guest (they differ only in which drive-table slot), and a
    /// mismatched flag is caught LOUDLY: `fm_parent_finish` asserts the `in_abort`
    /// pairing this call armed, so a replay begun here and finished as an abort is
    /// `EINVAL`, not silent divergence. `fm_parent_finish(abort: u32)` is the
    /// precedent — the same flag, at the same layer, for the paired finish.
    ///
    /// Contrast `fm_parent_abort_seal`, which is deliberately NOT folded into
    /// `fm_parent_seal_capture`: there the two entries differ in whether they
    /// drive the guest AT ALL, and a wrong flag would corrupt the guest's unwind
    /// state machine silently. Two names are the guard there. Here they are not.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_parent_replay(abort: u32) {
        match require_phase(PHASE_SEALED_PARENT)
            .and_then(|()| parent_replay_impl(abort != 0))
        {
            Ok(()) => {
                // The two replays END differently -- an abort replay finishes
                // with `fm_parent_finish(abort=1)` and returns `-errno` to the
                // guest's `kernel_fork`, an ordinary one with `abort=0` -- so
                // they are separate phases rather than one "replaying".
                enter_phase(if abort != 0 {
                    PHASE_ABORT_REPLAY
                } else {
                    PHASE_PARENT_REPLAY
                });
                set_ok()
            }
            Err(errno) => set_err(errno),
        }
    }

    /// Sequence a whole CHILD reconstruct rewind-begin phase in the module
    /// (control-flow inversion, the child-worker mirror of [`fm_parent_replay`]):
    /// build the per-activation REWIND-begin drive plan from each activation's
    /// stored `child_rewind_root`, then DRIVE it through the injector-wired
    /// `fm_drive_execute` shim, which `call_indirect`s each activation's guest
    /// `wpk_fork_rewind_begin(root)` in ascending id order.
    ///
    /// This replaces the host's former per-activation `wpk_fork_rewind_begin`
    /// loop in `attachModuleChild` / `attachBorrowedModuleChild` with ONE module
    /// call. The child's replay state (journal, resume-slot table, per-activation
    /// frame drivers, and the `child_rewind_root` each step carries) was ALREADY
    /// seeded by `fm_begin_child_replay` / `fm_add_activation_child_replay` (COW)
    /// or `fm_begin_borrowed_child_replay` / `fm_add_activation_borrowed_child_replay`
    /// (vfork borrowed) before this entry — so, unlike `fm_parent_replay`, there is
    /// NO begin step; this folds only the guest rewind DRIVE. The host must have
    /// bound each activation's `wpk_fork_rewind_begin` into `__wpk_fork_drive_table`
    /// at `fm_drive_table_base(activation) + DRIVE_SLOT_REWIND_BEGIN` before calling
    /// this (the ref-typed table bind is a host floor). Behaviourally identical to
    /// the old host loop: same guest export, same roots (COW: `module_buffer`;
    /// borrowed: child-private prefix), same ascending order. A guest reconstruction
    /// failure traps inside the shim exactly as it did under the host loop; a
    /// zero-activation state or plan-build failure is a truthful errno
    /// (`fm_last_errno`).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_child_reconstruct() {
        match child_reconstruct_impl() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Sequence a whole capture SEAL in the module (control-flow inversion): drive
    /// each open activation's guest `wpk_fork_unwind_end()` through the injector-
    /// wired `fm_drive_execute` shim (one `DRIVE_OP_UNWIND_END` step per
    /// activation, ascending id order — the argument-free `() -> ()` capture-seal
    /// flip), then seal every frame writer + the process journal
    /// (`finish_unwind_impl`) and serialize the child-inheritable KFRE image into a
    /// freshly channel-mmap'd chunk (`serialize_journal_alloc_impl`). Returns that
    /// chunk's guest offset (0 on failure; check `fm_last_errno`), and
    /// `fm_journal_image_len` returns its byte length — identical to the return
    /// contract of the fine-grained `fm_serialize_journal_alloc`.
    ///
    /// This replaces the host's former three-part seal — a per-activation
    /// `wpk_fork_unwind_end()` loop, then `fm_finish_unwind`, then
    /// `fm_serialize_journal_alloc` — with ONE module call. The host must have
    /// bound each activation's `wpk_fork_unwind_end` into `__wpk_fork_drive_table`
    /// at `fm_drive_table_base(activation) + DRIVE_SLOT_UNWIND_END` before calling
    /// this (the ref-typed table bind is a host floor). Behaviourally identical to
    /// the old host sequence: same guest export, same order, seal FIRST then
    /// serialize.
    ///
    /// ONLY for a COMPLETE capture (every frame committed). A partial/aborted
    /// capture must NOT call this — driving `wpk_fork_unwind_end` mid-unwind
    /// corrupts the guest state machine (the prior trap); that path stays on
    /// `fm_finish_unwind` (`sealForAbort`) + abort-replay. A seal-time serialize
    /// OOM returns 0 with `fm_last_errno` set so the host reroutes to abort-replay
    /// rather than trapping.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_parent_seal_capture(channel_base: usize) -> usize {
        match require_phase(PHASE_CAPTURE)
            .and_then(|()| seal_capture_impl(channel_base as u64))
        {
            Ok(ptr) => {
                enter_phase(PHASE_SEALED_PARENT);
                set_ok();
                ptr as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Sequence a whole capture BEGIN in the module (control-flow inversion): open
    /// activation 0 (`begin_unwind_impl`, reclaiming the previous fork), add each
    /// side activation read as an `(id: u32, fixed_prefix: u32)` pair from the
    /// host-seeded scratch `[sides_ptr, sides_ptr + sides_count*8)`
    /// (`add_activation_unwind_impl`), publish each activation's `arena_root` into
    /// its module-buffer prefix (the module-side `writeForkModuleStateRoot`), then
    /// DRIVE each activation's guest `wpk_fork_unwind_begin(root)` through the
    /// injector-wired `fm_drive_execute` shim in ascending id order.
    ///
    /// This replaces the host's former per-activation `fm_begin_unwind` /
    /// `fm_add_activation_unwind` + `writeForkModuleStateRoot` +
    /// `wpk_fork_unwind_begin` loop with ONE module call. The host must have bound
    /// each activation's `wpk_fork_unwind_begin` into `__wpk_fork_drive_table` at
    /// `fm_drive_table_base(activation) + DRIVE_SLOT_UNWIND_BEGIN` before calling
    /// this (the ref-typed table bind is a host floor). Returns activation 0's
    /// module-buffer anchor (0 on failure; check `fm_last_errno`); side anchors are
    /// read back via `fm_activation_module_buffer`. A guest reconstruction failure
    /// traps inside the shim exactly as it did under the host loop; a create /
    /// plan-build failure is a truthful errno.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_parent_begin_capture(
        channel_base: usize,
        arena_root: usize,
        sides_ptr: usize,
        sides_count: usize,
    ) -> usize {
        match require_phase(PHASE_IDLE).and_then(|()| {
            begin_capture_impl(
                channel_base as u64,
                arena_root as u64,
                sides_ptr as u64,
                sides_count as u64,
            )
        }) {
            Ok(root) => {
                enter_phase(PHASE_CAPTURE);
                set_ok();
                root as usize
            }
            Err(errno) => {
                set_err(errno);
                0
            }
        }
    }

    /// Read one activation's module-buffer anchor (its continuation root) from the
    /// current fork's state. The host reads a side activation's anchor back after
    /// `fm_parent_begin_capture` (which returns only activation 0's) to build the
    /// activation-continuation manifest. Returns 0 on failure (check
    /// `fm_last_errno`): no fork open, or the activation is not registered.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_activation_module_buffer(activation_id: u32) -> usize {
        match activation_module_buffer_impl(activation_id) {
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

    /// Coarse ABORT-SEAL entry (the mid-unwind sibling of [`fm_parent_seal_capture`]).
    /// A partial/aborted capture — a mid-unwind `__wpk_fork_frame_reserve` failure —
    /// must seal every activation's frame writer + the process journal WITHOUT
    /// driving the guest `wpk_fork_unwind_end` (the guest is still mid-unwind; that
    /// flip would corrupt its unwind state machine) and WITHOUT serializing a
    /// child-inheritable journal image (no child is launched). This wraps
    /// `finish_unwind_impl` — the SAME seal `fm_parent_seal_capture` performs after
    /// its unwind-end drive — so the host abort path (`sealForAbort`) routes through
    /// a coarse phase entry rather than calling the fine-grained `fm_finish_unwind`
    /// directly. It has NO guest drive and NO serialize to fold, so unlike the other
    /// coarse entries it is a single-step phase entry, parallel to
    /// `fm_parent_seal_capture`. After this the host drives the ordinary module
    /// abort-replay (`fm_parent_replay(abort=1)`). A failed reserve leaves no pending frame
    /// (`LinkedFrameWriter::reserve_frame` sets `pending` only after a successful
    /// chunk allocation), so the committed chain is complete and seal-able.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_parent_abort_seal() {
        match require_phase(PHASE_CAPTURE).and_then(|()| finish_unwind_impl()) {
            Ok(()) => {
                enter_phase(PHASE_SEALED_PARENT);
                set_ok()
            }
            Err(errno) => set_err(errno),
        }
    }

    /// Sequence a whole REPLAY FINISH in the module (control-flow inversion): drive
    /// each open activation's guest `wpk_fork_rewind_end()` (`abort` == 0, moving it
    /// from `REWINDING` back to `NORMAL`) or `wpk_fork_abort_end()` (`abort` != 0,
    /// `ABORT_UNWINDING` back to `NORMAL`) through the injector-wired
    /// `fm_drive_execute` shim (one `DRIVE_OP_REWIND_END`/`DRIVE_OP_ABORT_END` step
    /// per activation, ascending id order — the argument-free `() -> ()` finish
    /// flip), then finish the process replay/abort (`finish_replay_impl` /
    /// `finish_abort_impl`): exhaust every activation's driver, finish the process
    /// journal, and release this fork's channel-mapped chunks.
    ///
    /// This replaces the host's former two-part finish — a per-activation
    /// `wpk_fork_rewind_end()` / `wpk_fork_abort_end()` loop, then `fm_finish_replay`
    /// / `fm_finish_abort` — with ONE module call. The host must have bound each
    /// activation's `wpk_fork_rewind_end` / `wpk_fork_abort_end` into
    /// `__wpk_fork_drive_table` at `fm_drive_table_base(activation) +
    /// DRIVE_SLOT_{REWIND,ABORT}_END` before calling this (the ref-typed table bind
    /// is a host floor). Behaviourally identical to the old host sequence: same
    /// guest export, same ascending order, drive FIRST then finish. The abort finish
    /// still asserts the `in_abort` pairing `fm_parent_replay(abort=1)` set, so a stray
    /// `fm_parent_finish(abort=1)` is a loud `EINVAL`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_parent_finish(abort: u32) {
        // An ordinary finish ends EITHER a parent replay or a child replay --
        // the same call closes both, which is why this takes two phases rather
        // than one. An abort finish ends only an abort replay.
        let allowed = if abort != 0 {
            require_phase(PHASE_ABORT_REPLAY)
        } else {
            require_phase_either(PHASE_PARENT_REPLAY, PHASE_CHILD_REPLAY)
        };
        match allowed.and_then(|()| finish_transaction_impl(abort != 0)) {
            Ok(()) => {
                enter_phase(PHASE_IDLE);
                set_ok()
            }
            Err(errno) => set_err(errno),
        }
    }

    /// Bump the drive-step proof-of-use counter by one (Phase 6 item 3c). NOT a
    /// guest-facing import: the walrus-injected `fm_drive_execute` shim
    /// (crates/fork-module-inject) `call`s this once per plan step it drives, so
    /// the counter equals the number of `call_indirect`s into the guest's
    /// `_gc_allocate`/`_gc_fill`/`_exception_materialize` exports. Rust cannot
    /// express the drive loop (`call_indirect`), but it CAN own the counter the
    /// loop increments, keeping the proof in one place.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_drive_bump() {
        DRIVE_STEPS_EXECUTED.fetch_add(1, Ordering::Relaxed);
    }


    // -- Reference CAPTURE session exports (Path B P3) -----------------------
    //
    // Thin, PURE-SCALAR surfaces over the shared `ReferenceGraphBuilder`. The
    // host's capture-import bodies resolve each live reference to its recipe
    // COORDINATE with the per-host identity floor and then call these to intern
    // it into the ONE shared graph. No export takes or returns a reference: the
    // live-value identity layering stays host-side (Bucket C), exactly as native
    // keeps it in `guest.rs` while calling `graph.intern_*`. Recipe ids are
    // `>= 1` (id 0 is the canonical null the builder seeds); every ID-returning
    // export returns `-1` on failure with the reason in `fm_last_errno`.

    /// GC aggregate kind discriminants `fm_capture_define_gc` accepts. Mirror the
    /// host's `defineGc` kind argument (struct=1, array=2) plus exnref=3.
    const CAPTURE_KIND_STRUCT: u32 = 1;
    const CAPTURE_KIND_ARRAY: u32 = 2;
    const CAPTURE_KIND_EXNREF: u32 = 3;

    /// `fm_capture_intern`'s leaf-reference discriminants. These select which
    /// `ReferenceGraphBuilder::intern_*` the one entry dispatches to; they are a
    /// SEPARATE numbering from the `CAPTURE_KIND_*` aggregate kinds above, which
    /// `fm_capture_define_gc` uses. Mirrored by `FORK_INTERN_KIND_*` in
    /// `host/src/fork-reference-capture-module.ts`.
    const INTERN_KIND_FUNCREF: u32 = 1;
    const INTERN_KIND_EXTERNREF: u32 = 2;
    const INTERN_KIND_I31: u32 = 3;
    const INTERN_KIND_STATIC_ROOT: u32 = 4;

    /// Fixed header of one record in the `fm_capture_serialize` record stream:
    /// `u16 kind, u16 reserved, u32 activation_id, u32 owner_id, u32 payload_len`.
    const CAPTURE_RECORD_HEADER: usize = 16;

    /// Copy `len` bytes out of guest linear memory at absolute offset `ptr`.
    ///
    /// Uses the module's proven whole-memory read idiom (bounds-check against
    /// `mem_len_bytes` then a raw `ptr::copy`), NOT `<[u8]>::get(range)` on the
    /// whole-memory slice: that slice is based at wasm address 0, and range
    /// indexing/`get` on a null-base slice miscompiles under `--release` (it
    /// reports out-of-bounds for an in-bounds range), whereas single-element
    /// access and raw pointer reads are correct — the same reason
    /// `fm_set_activation_gc_codec` copies via a raw pointer.
    fn read_capture_bytes(ptr: usize, len: usize) -> Result<Vec<u8>, Errno> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let end = ptr.checked_add(len).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL); // span past the end of guest memory
        }
        let mut out = alloc::vec![0u8; len];
        // SAFETY: `[ptr, ptr+len)` is within guest linear memory (checked above);
        // the destination is a distinct freshly-allocated `Vec`.
        let src = core::hint::black_box(ptr) as *const u8;
        unsafe {
            core::ptr::copy(src, out.as_mut_ptr(), len);
        }
        Ok(out)
    }

    fn read_capture_u32_array(ptr: usize, count: usize) -> Result<Vec<u32>, Errno> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let byte_len = count.checked_mul(4).ok_or(Errno::EINVAL)?;
        let raw = read_capture_bytes(ptr, byte_len)?;
        let mut out = Vec::with_capacity(count);
        for chunk in raw.chunks_exact(4) {
            out.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok(out)
    }

    /// Fold a builder `Result<u32>` into the ID-return convention: on success set
    /// errno OK, bump the capture proof-of-use counter, and return the id (a
    /// recipe id or vector handle/ordinal); on failure record the errno and
    /// return `-1`. A recipe id that would not fit in `i32` is a truthful
    /// `EINVAL` rather than a value the host would misread as an error.
    fn capture_ok_id(result: Result<u32, Errno>) -> i32 {
        match result {
            Ok(id) if id <= i32::MAX as u32 => {
                set_ok();
                CAPTURE_INTERNED.fetch_add(1, Ordering::Relaxed);
                id as i32
            }
            Ok(_) => {
                set_err(Errno::EINVAL);
                -1
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Fold a builder `Result<()>` into the VOID-return convention: `0` on
    /// success, `-1` on failure (reason in `fm_last_errno`).
    fn capture_ok_void(result: Result<(), Errno>) -> i32 {
        match result {
            Ok(()) => {
                set_ok();
                CAPTURE_INTERNED.fetch_add(1, Ordering::Relaxed);
                0
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Begin (or restart) a reference-capture session: seed a fresh shared
    /// builder (recipe 0 = canonical null, vector 0 = empty sentinel) and drop
    /// any previously serialized record stream. Mirrors the host's `beginCapture`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_begin() {
        // `fm_capture_begin` is the FIRST module call of a capture fork (the host
        // issues it in the fork syscall handler, before the guest unwinds). Make
        // it the fork's SINGLE bump-heap reset point: reclaim the previous fork's
        // state here, then ARM the session so `fm_begin_unwind` (which runs LATER,
        // interleaved with the reference encode) does NOT reset again and wipe the
        // capture builder. Empirically the guest encodes references BOTH before
        // and after `fm_begin_unwind`, so the builder must be allocated from a
        // bump that is reset exactly once, at the true fork start — here.
        // Drop the PREVIOUS fork's capture builder and serialized record stream
        // BEFORE resetting the bump. Both live in the bump heap `ALLOC.reset()`
        // is about to reclaim. `ReferenceGraphBuilder` owns `BTreeMap`s whose
        // `Drop` WALKS their tree nodes in place, so if we reset first and then
        // allocate the fresh builder (which reuses the same low bump addresses),
        // the old builder's nodes are overwritten and dropping it later walks
        // clobbered pointers and traps (`unreachable`). Every fork after the
        // first therefore trapped here: the resident builder from the prior fork
        // was still `Some(..)` when the reassignment below dropped it, AFTER the
        // reset+realloc had corrupted its backing store. Clearing the statics
        // first drops those values while their bump memory is still valid (a
        // no-op `dealloc`), so the subsequent reset is safe.
        // Drop the PREVIOUS fork's capture builder + serialized record stream
        // BEFORE `ALLOC.reset()` reclaims the bump they live in (see
        // `reset_bump_heap`): a `ReferenceGraphBuilder` owns `BTreeMap`s whose
        // `Drop` walks their nodes in place, so dropping one after the reset has
        // reused its low bump addresses walks clobbered pointers and traps.
        reset_bump_heap();
        // Create the builder EAGERLY, now that the bump is fresh for this fork:
        // the guest may issue its first reference encode BEFORE `fm_begin_unwind`,
        // and `fm_begin_unwind` consumes the arming (so it won't reset the bump),
        // so a deferred builder could be requested when neither the builder nor
        // the arming is present. Eager creation makes the builder always available
        // for the rest of the fork.
        *capture_state() = Some(ReferenceGraphBuilder::begin());
        CAPTURE_ARMED.store(1, Ordering::Relaxed);
        set_ok();
    }

    /// Turn a MERGED function-catalog slot into a funcref recipe.
    ///
    /// The injected `__wpk_fork_ref_encode_funcref` scan finds which catalog slot
    /// holds the funcref it was handed, and this turns that slot into the
    /// `(activation, ordinal)` coordinate the graph records. The split is the one
    /// `fm_capture_intern`'s doc already describes -- the host resolves identity,
    /// the module owns the recipe -- except that with
    /// `__wpk_fork_host_func_identity` the SCAN is the module's too, and the host
    /// answers only "are these the same function?".
    ///
    /// The owning activation is the one with the LARGEST base not above `slot`:
    /// bases partition the merged catalog, so that is the slice `slot` falls in.
    /// A worker that seeded no bases at all is the single-activation case, where
    /// activation 0 owns everything.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_funcref_slot_to_recipe(slot: u32) -> i32 {
        let count = ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives this borrow.
        let map = unsafe { &*ACT_FUNC_CATALOG_BASE.0.get() };
        let mut owner: Option<(u32, u32)> = None;
        for entry in map.iter().take(count) {
            let (activation, base) = (entry[0], entry[1]);
            if base <= slot && owner.is_none_or(|(_, best)| base > best) {
                owner = Some((activation, base));
            }
        }
        let (activation, base) = owner.unwrap_or((0, 0));
        if count > 0 && owner.is_none() {
            // Bases were seeded but none covers this slot, so the catalog and the
            // scan disagree about the table's shape. Guessing activation 0 here
            // would record a recipe that decodes to another activation's function.
            set_err(Errno::EINVAL);
            return -1;
        }
        fm_capture_intern(INTERN_KIND_FUNCREF, activation, slot - base)
    }

    /// A funcref the scan could not find in the merged catalog.
    ///
    /// Its own entry rather than a sentinel from the scan, so the errno is set by
    /// the same code that owns every other capture failure. A function the loader
    /// never catalogued has no coordinate to record, and inventing one would put
    /// a recipe in the graph that decodes to the WRONG function in the child.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_funcref_uncatalogued() -> i32 {
        set_err(Errno::EINVAL);
        -1
    }

    /// Intern one LEAF reference into the capture graph by its already-resolved
    /// coordinate, dispatched on `kind`. Returns its recipe id (`>= 1`), or `-1`
    /// with `fm_last_errno` set.
    ///
    /// | `kind` | meaning | `a` | `b` |
    /// |---|---|---|---|
    /// | `INTERN_KIND_FUNCREF` (1) | function reference | catalog activation | catalog ordinal |
    /// | `INTERN_KIND_EXTERNREF` (2) | durable host externref | broker handle (`1..=0xffff_ffff`) | must be 0 |
    /// | `INTERN_KIND_I31` (3) | `i31ref` | signed 31-bit payload, bit-cast to `u32` | must be 0 |
    /// | `INTERN_KIND_STATIC_ROOT` (4) | statically-rooted reference | catalog activation | catalog ordinal |
    ///
    /// This ONE entry replaces the four per-type exports
    /// `fm_capture_intern_{funcref,externref,i31,static_root}`. They expressed a
    /// single concept — "intern a leaf reference at a coordinate the host already
    /// resolved" — as four exports with four host-side marshalling wrappers, which
    /// is the per-type-variant multiplication the fork transport is large because
    /// of. The same fold already happened one export over: `fm_decoded_node_field`
    /// replaced three same-signature accessors.
    ///
    /// The host resolves every coordinate with its per-host identity floor (the
    /// funcref catalog, the externref broker's `WeakMap` provenance) BEFORE
    /// calling. The module never sees a live reference, only scalars.
    ///
    /// An unknown `kind`, or a non-zero `b` where the table says it must be 0, is
    /// `EINVAL` and `-1`. The `b` check is not pedantry: it is what stops a caller
    /// that passes `(EXTERNREF, activation, ordinal)` — funcref argument order,
    /// wrong kind — from silently interning the activation id as a broker handle.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_intern(kind: u32, a: u32, b: u32) -> i32 {
        let g = match capture_builder() {
            Ok(g) => g,
            Err(e) => {
                set_err(e);
                return -1;
            }
        };
        let id = match kind {
            INTERN_KIND_FUNCREF => g.intern_funcref(a, b),
            INTERN_KIND_STATIC_ROOT => g.intern_static_root(a, b),
            INTERN_KIND_EXTERNREF | INTERN_KIND_I31 if b != 0 => {
                set_err(Errno::EINVAL);
                return -1;
            }
            INTERN_KIND_EXTERNREF => {
                record_captured_externref(a);
                g.intern_externref(a)
            }
            INTERN_KIND_I31 => g.intern_i31(a as i32),
            _ => {
                set_err(Errno::EINVAL);
                return -1;
            }
        };
        capture_ok_id(id)
    }

    // -- Captured externref handles -----------------------------------------
    //
    // Every broker handle interned into this capture, in intern order.
    //
    // The KERNEL worker needs this set to lease the parent's externrefs to the
    // child's generation. Today it derives the set itself, by reading the parked
    // parent's KFMS arena and running the full segmented-transaction parser and
    // semantic validator over it -- roughly 4,956 lines of host decoder that
    // duplicate what this module already did when the handle was interned here.
    //
    // Recording it at intern time removes that decode entirely rather than
    // relocating it: the parent knows its own externrefs, and the kernel worker
    // is the one thread every process's syscalls serialize through, so parsing
    // there blocks unrelated processes.
    //
    // Capture-scoped: cleared when a capture begins, so a child that inherits
    // this module's memory does not report its parent's handles.
    const CAPTURED_EXTERNREF_MAX: usize = 4096;

    #[repr(C, align(4))]
    struct CapturedExternrefs(UnsafeCell<[u32; CAPTURED_EXTERNREF_MAX]>);
    // SAFETY: single-threaded per worker (see HeapCell).
    unsafe impl Sync for CapturedExternrefs {}
    static CAPTURED_EXTERNREFS: CapturedExternrefs =
        CapturedExternrefs(UnsafeCell::new([0u32; CAPTURED_EXTERNREF_MAX]));
    static CAPTURED_EXTERNREF_COUNT: AtomicU32 = AtomicU32::new(0);
    /// Set when a capture interned more handles than the arena holds, so the
    /// host is told to fall back rather than silently leasing a truncated set.
    static CAPTURED_EXTERNREF_OVERFLOW: AtomicU32 = AtomicU32::new(0);

    fn record_captured_externref(handle: u32) {
        let count = CAPTURED_EXTERNREF_COUNT.load(Ordering::Relaxed) as usize;
        if count >= CAPTURED_EXTERNREF_MAX {
            CAPTURED_EXTERNREF_OVERFLOW.store(1, Ordering::Relaxed);
            return;
        }
        // SAFETY: single-threaded; `count < CAPTURED_EXTERNREF_MAX` above.
        let arena = unsafe { &mut *CAPTURED_EXTERNREFS.0.get() };
        arena[count] = handle;
        CAPTURED_EXTERNREF_COUNT.store(count as u32 + 1, Ordering::Relaxed);
    }

    fn reset_captured_externrefs() {
        CAPTURED_EXTERNREF_COUNT.store(0, Ordering::Relaxed);
        CAPTURED_EXTERNREF_OVERFLOW.store(0, Ordering::Relaxed);
    }

    /// How many externref handles this capture interned, or -1 if it interned
    /// more than the module can record (the host must then not trust the list).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_captured_externref_count() -> i32 {
        if CAPTURED_EXTERNREF_OVERFLOW.load(Ordering::Relaxed) != 0 {
            return -1;
        }
        CAPTURED_EXTERNREF_COUNT.load(Ordering::Relaxed) as i32
    }

    /// One recorded handle by index, or -1 if the index is past the count.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_captured_externref(index: u32) -> i64 {
        let count = CAPTURED_EXTERNREF_COUNT.load(Ordering::Relaxed);
        if index >= count {
            return -1;
        }
        // SAFETY: single-threaded; `index < count <= CAPTURED_EXTERNREF_MAX`.
        let arena = unsafe { &*CAPTURED_EXTERNREFS.0.get() };
        i64::from(arena[index as usize])
    }

    /// Claim a fresh graph identity for a GC value before its fields are known,
    /// returning the placeholder recipe id. The host publishes the id first, then
    /// recurses into the value's fields (closing cycles), then completes it with
    /// `fm_capture_define_gc`. Mirrors native's `gc_claim` body.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_claim_gc() -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.claim_gc()),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Reserve a self-contained placeholder leaf for a GATED capture kind (an
    /// externref/anyref with no recoverable production-site provenance). Returns
    /// a fresh distinct recipe id; the host keeps the live value beside it so the
    /// PARENT's own abort-replay hands the exact value back. Mirrors native's
    /// `gated_placeholder`. The soundness gate itself (`EOPNOTSUPP`, no child) is
    /// the host's decision; this only keeps the sealed graph canonical.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_gated_placeholder() -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.push_gated_placeholder()),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Complete a claimed struct/array/exnref placeholder into its final
    /// aggregate recipe. `scalar_ptr`/`scalar_len` is the COMBINED scalar span in
    /// guest linear memory (constructor-provenance seed bytes then the live field
    /// snapshot) the host already assembled. `reference_vector_ordinal` names the
    /// module-interned field/element vector; the edge vector is assembled here
    /// exactly as native's `gc_define` does — provenance recipe ids first, then
    /// that field vector — so the host never re-reads the vector it just interned.
    /// `has_provenance != 0` records a `GcProvenance` for validation (its ids,
    /// read from `prov_ptr`/`prov_count`, must name existing recipes and are the
    /// prepended edges). Returns `0` or `-1`.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_define_gc(
        recipe_id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_ptr: usize,
        scalar_len: usize,
        reference_vector_ordinal: u32,
        has_provenance: u32,
        prov_ptr: usize,
        prov_count: usize,
    ) -> i32 {
        let kind_enum = match kind {
            CAPTURE_KIND_STRUCT => AggregateKind::Struct,
            CAPTURE_KIND_ARRAY => AggregateKind::Array,
            CAPTURE_KIND_EXNREF => AggregateKind::Exnref,
            _ => {
                set_err(Errno::EINVAL);
                return -1;
            }
        };
        let assembled = (|| -> Result<(), Errno> {
            let scalars = read_capture_bytes(scalar_ptr, scalar_len)?;
            let prov_ids = if has_provenance != 0 {
                read_capture_u32_array(prov_ptr, prov_count)?
            } else {
                Vec::new()
            };
            let g = capture_builder()?;
            // Assemble edges = provenance ids ++ the interned field vector,
            // mirroring native's `gc_define`. Ordinal 0 is the canonical empty
            // vector (no field edges).
            let field_vector = g
                .vectors()
                .get(reference_vector_ordinal as usize)
                .ok_or(Errno::EINVAL)?
                .clone();
            let mut edges = prov_ids.clone();
            edges.extend_from_slice(&field_vector);
            let provenance = if has_provenance != 0 {
                Some(GcProvenance {
                    reference_ids: prov_ids,
                })
            } else {
                None
            };
            g.define_gc(
                recipe_id,
                activation,
                type_ordinal,
                layout_id,
                kind_enum,
                &scalars,
                &edges,
                provenance,
            )
        })();
        capture_ok_void(assembled)
    }

    /// Read entry `index` of interned reference vector `ordinal` from the RESIDENT
    /// capture builder (the graph `fm_capture_*` is still building/has built this
    /// fork), returning the recipe id or `-1` on out-of-bounds. This is the
    /// PARENT's own post-fork replay read: after the parent seals, its frame
    /// rewind asks which recipe ids each frame's reference vector holds so it can
    /// hand back the ORIGINAL live values (kept host-side in `capturedValues`, and
    /// in the module-owned transit table). Unlike `__wpk_fork_ref_vector_get` — which
    /// reads a DECODED transaction a child reconstructs from the wire — this reads
    /// the live capture builder directly, so the parent never re-decodes its own
    /// graph and never reconstructs (its live references keep their identity by
    /// construction). Requires an active capture session.
    /// The KFMS geometry for this guest's pointer width. Derived, never
    /// host-supplied: the chunk header size is a pure function of the width.
    fn module_state_format() -> Result<ModuleStateFormat, Errno> {
        let pointer_width = core::mem::size_of::<usize>() as u8;
        let chunk_header_size = abi::wpk_fork_module_state_chunk_header_size(pointer_width)
            .ok_or(Errno::EINVAL)?;
        Ok(ModuleStateFormat { pointer_width, chunk_header_size })
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_dirty_mark(owner,
    /// first_page, page_count)`.
    ///
    /// Records that pages `[first_page, first_page + page_count)` of the
    /// physical table `owner` have been mutated since instantiation.
    ///
    /// **This runs during ORDINARY execution, not only during a fork.**
    /// `fork-instrument` wraps every `table.set`, `table.copy`, `table.fill`,
    /// `table.init` and `table.grow` with a call to it, gated only on a
    /// non-empty range and a last-page cache. That is the whole point: the set
    /// has to record what changed since instantiation so that WHENEVER a fork
    /// happens, the sparse overlay it serialises is correct. So there is no
    /// fork-state requirement here, and a mark with no fork in flight is the
    /// normal case rather than an error.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_dirty_mark(
        owner: u32,
        first_page: u64,
        page_count: u64,
    ) {
        dirty().mark(owner, first_page, page_count);
        set_ok();
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_dirty_count(owner)`.
    ///
    /// How many distinct pages of this physical table are dirty. The guest
    /// sizes its table record from this, then walks
    /// `__wpk_fork_module_state_table_dirty_page` from 0 to this count.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_dirty_count(owner: u32) -> i32 {
        set_ok();
        i32::try_from(dirty().count(owner)).unwrap_or(i32::MAX)
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_dirty_page(owner,
    /// ordinal) -> page`.
    ///
    /// The `ordinal`-th dirty page, ascending, so the walk order matches the
    /// count. An out-of-range ordinal is `EINVAL` rather than 0, because page 0
    /// is a legitimate answer and the two cannot share a return value.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_dirty_page(owner: u32, ordinal: u32) -> u64 {
        match dirty().page(owner, ordinal) {
            Some(page) => {
                set_ok();
                page
            }
            None => {
                set_err(Errno::EINVAL);
                0
            }
        }
    }

    /// Guest-facing `env.__wpk_fork_module_state_record_reserve(kind,
    /// activation, owner, payload_size) -> payload_ptr`.
    ///
    /// Carves a KFMS record and hands back the address the guest writes its
    /// payload into. The record is invisible to any decoder until
    /// `__wpk_fork_module_state_record_commit`, so a guest that traps midway
    /// leaves a chunk list a child can still read.
    ///
    /// Returns 0 with `fm_last_errno` set on failure, matching every other
    /// pointer-returning entry in this module.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_record_reserve(
        kind: u32,
        activation_id: u32,
        owner_id: u32,
        payload_size: usize,
    ) -> usize {
        let Ok(kind) = u16::try_from(kind) else {
            set_err(Errno::EINVAL);
            return 0;
        };
        let Some(module) = state().as_mut() else {
            set_err(Errno::EINVAL);
            return 0;
        };
        let mem = unsafe { mem_mut() };
        let ForkModule { module_state, module_state_chunks, .. } = module;
        match module_state.reserve(
            module_state_chunks,
            mem,
            kind,
            activation_id,
            owner_id,
            payload_size as u64,
        ) {
            Ok(payload) => {
                set_ok();
                payload as usize
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// Guest-facing `env.__wpk_fork_module_state_record_commit(payload_ptr)`.
    ///
    /// Publishes the reserved record. Returns nothing — the guest ABI has no
    /// error channel here — so a failure is latched in `fm_last_errno`, the
    /// same shape `__wpk_fork_ref_vector_append` uses.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_record_commit(payload: usize) {
        let Some(module) = state().as_mut() else {
            set_err(Errno::EINVAL);
            return;
        };
        let mem = unsafe { mem_mut() };
        match module.module_state.commit(mem, payload as u64) {
            Ok(()) => set_ok(),
            Err(e) => set_err(e),
        }
    }

    /// Guest-facing `env.__wpk_fork_module_state_record_find(kind, activation,
    /// owner, ordinal) -> payload_ptr`, or 0 when there is no such record.
    ///
    /// **`ordinal` is a design decision, not a recovered fact.** The guest DOES
    /// call this — `fork-instrument`'s `find_record` emits `call(imports.find)`
    /// from three sites (`emit_restore_helper` per restorable global,
    /// `emit_restore_segments`, `emit_restore_table`) — but every one of
    /// them passes a literal `0`, so no call site constrains the fourth
    /// argument. It is taken as "the Nth record matching the first three",
    /// which is the only reading that makes the triple useful when a kind
    /// repeats per activation (table pages do). A guest that starts passing a
    /// nonzero ordinal should be checked against that choice rather than
    /// assumed to agree with it.
    ///
    /// **A child always gets 0 from this, whatever it asks for.** `root` below
    /// is the writer's, and a replay-only child's writer is deliberately inert
    /// (`ModuleStateWriter::new` + `new_channel(0)`; see the child construction
    /// in `begin_child_replay_impl`), so `root == 0` and every lookup misses.
    /// The parent's arena root IS known during replay, but only as the
    /// `module_state_root` ARGUMENT threaded through `attach_from_arena_impl`
    /// and friends — it is never stored anywhere this function can see. That
    /// asymmetry is inert today because nothing in production drives the
    /// guest's `wpk_fork_module_state_restore`: its only entries,
    /// `fm_attach_child` / `fm_attach_borrowed_child`, have no caller in
    /// `host/src`, and the scalar globals a live fork actually depends on
    /// (`__stack_pointer` among them) are restored by the continuation buffer
    /// instead, via `fork_instrument::runtime::emit_restore_globals`. It stops
    /// being inert the moment that drive is wired up — the guest would then
    /// load its restored global from linear address 0. Whoever wires it must
    /// give this function the replay root first.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_record_find(
        kind: u32,
        activation_id: u32,
        owner_id: u32,
        ordinal: u32,
    ) -> usize {
        let Ok(kind) = u16::try_from(kind) else {
            set_err(Errno::EINVAL);
            return 0;
        };
        let Some(module) = state().as_ref() else {
            set_err(Errno::EINVAL);
            return 0;
        };
        let root = module.module_state.root();
        if root == 0 {
            set_ok();
            return 0;
        }
        let Ok(format) = module_state_format() else {
            set_err(Errno::EINVAL);
            return 0;
        };
        let mem = unsafe { mem_ref() };
        let Ok(decoded) = decode_module_state(mem, root, &format) else {
            set_err(Errno::EINVAL);
            return 0;
        };
        let mut seen = 0u32;
        for record in &decoded.records {
            if record.kind == kind
                && record.activation_id == activation_id
                && record.owner_id == owner_id
            {
                if seen == ordinal {
                    set_ok();
                    return record.payload_offset as usize;
                }
                seen += 1;
            }
        }
        set_ok();
        0
    }

    /// Guest-facing `env.__wpk_fork_ref_scratch_reserve(len) -> ptr`.
    ///
    /// Hands back `len` bytes of transient exchange storage, 16-byte aligned.
    /// The pointer is a guest linear-memory address because the module is
    /// co-resident in the guest's memory — its BSS lives at `__memory_base`
    /// inside that same memory, which is what lets the guest write through the
    /// result directly.
    ///
    /// Traps on exhaustion. See `SCRATCH_SIZE` for why an error return is not
    /// available: the generator does not check this result.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_scratch_reserve(len: usize) -> usize {
        let need = scratch_align(len);
        let top = SCRATCH_TOP.load(Ordering::Relaxed);
        let next = match top.checked_add(need) {
            Some(next) if next <= SCRATCH_SIZE => next,
            _ => wasm_intr::unreachable(),
        };
        SCRATCH_TOP.store(next, Ordering::Relaxed);
        if next > SCRATCH_HIGH_WATER.load(Ordering::Relaxed) {
            SCRATCH_HIGH_WATER.store(next, Ordering::Relaxed);
        }
        (SCRATCH.0.get() as usize).wrapping_add(top)
    }

    /// Guest-facing `env.__wpk_fork_ref_scratch_release(ptr, len)`.
    ///
    /// Pops the stack. The release must name the TOP frame: the generator emits
    /// reserve/release strictly nested around a recursive encode, so a release
    /// that does not match the top means the nesting the whole scheme assumes
    /// has been violated, and continuing would hand the next reserve a region
    /// that overlaps a live one. That is silent capture corruption, so it traps.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_scratch_release(ptr: usize, len: usize) {
        let need = scratch_align(len);
        let base = SCRATCH.0.get() as usize;
        let top = SCRATCH_TOP.load(Ordering::Relaxed);
        if need > top || ptr != base.wrapping_add(top - need) {
            wasm_intr::unreachable();
        }
        SCRATCH_TOP.store(top - need, Ordering::Relaxed);
    }

    /// Recipe already bound to this host-assigned reference identity, or 0.
    ///
    /// Called by the injected `__wpk_fork_ref_gc_lookup` shim, which resolves
    /// the identity through the host import first. Rust holds the map because
    /// Rust can hold a map; wasm holds the reference because only wasm can.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_gc_identity_find(identity: u32) -> i32 {
        set_ok();
        gc_identity()
            .as_ref()
            .and_then(|map| map.get(&identity))
            .map_or(0, |recipe| *recipe as i32)
    }

    /// Claim a fresh recipe and bind it to this reference identity.
    ///
    /// The bind is what makes a later `fm_gc_identity_find` hit, which is what
    /// terminates a cyclic object graph: the generator publishes identity
    /// BEFORE recursing into fields precisely so the walk back finds it.
    ///
    /// Re-binding an identity already claimed is `EINVAL`: it would mean the
    /// same object was claimed twice, giving the child two objects where the
    /// parent had one -- a fork-only identity split, and silent.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_gc_identity_claim(identity: u32) -> i32 {
        let recipe = match capture_builder() {
            Ok(g) => capture_ok_id(g.claim_gc()),
            Err(e) => {
                set_err(e);
                return -1;
            }
        };
        if recipe < 0 {
            return recipe;
        }
        let map = gc_identity().get_or_insert_with(BTreeMap::new);
        if map.insert(identity, recipe as u32).is_some() {
            set_err(Errno::EINVAL);
            return -1;
        }
        set_ok();
        recipe
    }

    /// Guest-facing `env.__wpk_fork_ref_exn_broker_encode(slot) -> recipe`.
    ///
    /// The UNKNOWN-tag path: `fork-instrument` calls this when a caught
    /// exception matched none of this module's declared tag layouts. Refuses,
    /// loudly, with `EOPNOTSUPP` and a poisoned recipe.
    ///
    /// # Why it cannot do better yet
    ///
    /// A foreign exception is opaque to the module on every axis. Its payload
    /// needs `catch_ref` against the tag that threw it, which by definition this
    /// module does not have; it cannot be identified (`ref.eq` does not validate
    /// on `exnref`); and it cannot be handed to a host to inspect (an `exnref`
    /// value cannot cross into a JS import). Real handling means routing to the
    /// activation whose codec DOES own the tag, which needs the module to drive
    /// the capture walk across activations -- there is no capture-side drive
    /// today, and that is F3's work. See census sections 26, 28a and 28b.
    ///
    /// # Why loud rather than a gated placeholder
    ///
    /// `fm_capture_gated_placeholder` is the designed mechanism for a value with
    /// no recoverable provenance, but its contract is that the HOST notices and
    /// gates the fork -- and no signal for that is exported (`fm_stats` has no
    /// gated counter). A placeholder here would therefore be silent: the child
    /// would rebuild the `i31(0)` sentinel where an exception had been, and
    /// nothing would say so. Returning a poisoned recipe instead makes the
    /// failure structural. The value is not a valid recipe id, so any edge
    /// naming it is rejected by `define_gc`'s bounds check and by
    /// `fm_capture_validate`, and the capture cannot seal.
    ///
    /// That is a real restriction -- a fork cannot be taken while a foreign
    /// exception is live -- and it is stated as one rather than hidden. It is
    /// also not a regression: an unserved import leaves the same case to a host
    /// that cannot inspect the exception either.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_broker_encode(_slot: u32) -> i32 {
        set_err(Errno::EOPNOTSUPP);
        -1
    }

    /// Intern every witness this layout recorded, newest-first ordinal order,
    /// returning their recipe ids.
    ///
    /// Lazy and cached: a witness is shared by EVERY object of its layout, so
    /// the encode happens once and a thousand objects reference one recipe.
    ///
    /// An empty result is the ordinary case — a layout with no mutable non-null
    /// internal reference field records no witness — and is NOT an error.
    fn intern_layout_witnesses(activation: u32, layout: u32) -> Result<Vec<u32>, Errno> {
        if layout > 0x00ff_ffff {
            return Err(Errno::E2BIG);
        }
        let mut ids = Vec::new();
        for ordinal in 0u32..=0xff {
            let key = (layout << 8) | ordinal;
            let slot = {
                let w = witness();
                match w.keys.iter().position(|k| *k == key) {
                    Some(slot) if w.occupied[slot] => slot,
                    // Ordinals are dense from 0, so the first gap ends the list.
                    _ => break,
                }
            };
            let cached = witness().recipes[slot];
            if cached != 0 {
                ids.push(cached);
                continue;
            }
            let recipe = capture_witness_via_injector(activation, slot as u32);
            if recipe <= 0 {
                // 0 is the canonical NULL recipe, which a witness can never be:
                // it was stored from a live constructor argument. Treat it as
                // failure rather than silently seeding a child with null.
                return Err(Errno::EINVAL);
            }
            witness().recipes[slot] = recipe as u32;
            ids.push(recipe as u32);
        }
        Ok(ids)
    }

    /// Guest linear memory as archive storage.
    ///
    /// The archive's record pointers are absolute offsets into the guest's
    /// memory, and the module shares that memory, so a record is readable in
    /// place. Raw-pointer slicing rather than indexing a whole-memory slice is
    /// deliberate, for the reason `read_capture_bytes` documents: a slice based
    /// at wasm address 0 miscompiles under range indexing in release.
    struct GuestArchiveBytes;

    impl fork_codec::dylink_archive::ArchiveBytes for GuestArchiveBytes {
        fn len(&self) -> u64 {
            mem_len_bytes() as u64
        }

        fn slice(&self, offset: u64, len: u64) -> Result<&[u8], Errno> {
            let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
            let count = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
            let end = start.checked_add(count).ok_or(Errno::EINVAL)?;
            // UNREACHABLE BY CONSTRUCTION, and kept anyway. `decode_dylink_archive`
            // bounds-checks every range it asks for against `self.len()`, which is
            // this same value, so no perturbation of the archive bytes reaches this
            // branch -- it is not a guard in the H-2 sense and no test can make it
            // fail. It stays because the failure it prevents is not an error: the
            // raw-pointer slice below is UB on an out-of-range address, not a trap,
            // so a future decoder bug would corrupt the guest instead of erroring.
            if end > mem_len_bytes() {
                return Err(Errno::EINVAL);
            }
            // SAFETY: bounds-checked above, and the module shares the guest's
            // linear memory, so `start` is a readable address in it.
            Ok(unsafe { core::slice::from_raw_parts(start as *const u8, count) })
        }
    }

    /// Resolve a patch's `(activation, ordinal)` to a merged function-catalog
    /// slot, the same coordinate `funcref_ordinal_impl` produces.
    fn catalog_slot(activation_id: u32, ordinal: u32) -> Result<u32, Errno> {
        let base = match func_catalog_base(activation_id) {
            Some(base) => base,
            // No seeded base at all is the single-activation worker, where the
            // base is 0 by definition. A MISSING base when others were seeded is
            // a graph naming an activation this worker never registered, which
            // is corruption rather than a default.
            None if func_catalog_base_map_empty() => 0,
            None => return Err(Errno::EINVAL),
        };
        base.checked_add(ordinal).ok_or(Errno::EINVAL)
    }

    // ---- Funcref table replication -----------------------------------------
    //
    // `crates/dylink` owns the protocol; `fork_codec::dylink_table_plan` decides
    // what a reconcile must write; this applies it. See census §32 and §34.

    /// Byte offset of the archive HEAD slot below the dlopen control address,
    /// by guest pointer width.
    ///
    /// DUPLICATED from `host/src/worker-main.ts` (`DLOPEN_HEAD_OFFSET_WASM32` /
    /// `_WASM64`), which is the source of truth for this host-private control
    /// block. The duplication is deliberate: these are not ABI constants and
    /// putting them in the generated ABI surface would make a host-private
    /// layout part of the versioned contract.
    /// `host/test/fork-module-control-block.test.ts` fails if the copies drift.
    const DLOPEN_HEAD_OFFSET_WASM32: usize = 12;
    const DLOPEN_HEAD_OFFSET_WASM64: usize = 24;

    /// This worker's dlopen control-block address, or 0 for a worker with no
    /// archive at all -- which a reconcile reports as generation 0 rather than
    /// as an error. `AtomicUsize`, not `AtomicU32`: this is a guest ADDRESS, and
    /// truncating it would silently point a wasm64 worker at the wrong block.
    static ARCHIVE_CONTROL: AtomicUsize = AtomicUsize::new(0);
    /// The physical table whose patches this worker applies. Per worker rather
    /// than per activation, because the module writes exactly one table: the
    /// `__indirect_function_table` it imports.
    static ARCHIVE_OWNER: AtomicU32 = AtomicU32::new(0);
    /// This worker's syscall channel base; 0 until `fm_set_format` seeds it.
    static CHANNEL_BASE: AtomicUsize = AtomicUsize::new(0);
    /// The generation this worker has applied, low and high halves.
    static ARCHIVE_APPLIED: [AtomicU32; 2] = [AtomicU32::new(0), AtomicU32::new(0)];

    /// Read the published archive head out of the control block.
    ///
    /// The head is stored at a fixed negative offset from the control address,
    /// so no host call is needed to learn it -- only the control address, which
    /// arrives once with the rest of the per-worker format seed.
    fn archive_head() -> Result<u64, Errno> {
        let control = ARCHIVE_CONTROL.load(Ordering::Relaxed);
        if control == 0 {
            return Ok(0);
        }
        let width = format()?.pointer_width;
        let offset = match width {
            4 => DLOPEN_HEAD_OFFSET_WASM32,
            8 => DLOPEN_HEAD_OFFSET_WASM64,
            _ => return Err(Errno::EINVAL),
        };
        let slot = control.checked_sub(offset).ok_or(Errno::EINVAL)?;
        let end = slot.checked_add(usize::from(width)).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL);
        }
        // SAFETY: bounds-checked above, and the module shares the guest's
        // linear memory, so `slot` is a readable address in it.
        Ok(unsafe {
            match width {
                4 => u64::from((slot as *const u32).read_unaligned()),
                _ => (slot as *const u64).read_unaligned(),
            }
        })
    }

    /// Byte offset of the archive reader/writer lock below the control address.
    ///
    /// DUPLICATED from `host/src/worker-main.ts` (`DLOPEN_LOCK_OFFSET_WASM32` /
    /// `_WASM64`) for the reason `DLOPEN_HEAD_OFFSET_*` is, and pinned by the
    /// same test.
    const DLOPEN_LOCK_OFFSET_WASM32: usize = 20;
    const DLOPEN_LOCK_OFFSET_WASM64: usize = 40;

    /// Lock states. Zero is free, negative is the single writer, and any
    /// positive value counts concurrent readers. These are the host's values,
    /// not this module's: the word is ONE protocol shared by every participant
    /// in the process, so a module that invented its own encoding would
    /// deadlock against a host holding the same word.
    const DLOPEN_LOCK_IDLE: i32 = 0;
    const DLOPEN_LOCK_WRITER: i32 = -1;

    /// The lock word as an atomic, or `EINVAL` when this worker has no archive.
    fn archive_lock() -> Result<&'static AtomicI32, Errno> {
        let control = ARCHIVE_CONTROL.load(Ordering::Relaxed);
        if control == 0 {
            return Err(Errno::EINVAL);
        }
        let offset = match format()?.pointer_width {
            4 => DLOPEN_LOCK_OFFSET_WASM32,
            8 => DLOPEN_LOCK_OFFSET_WASM64,
            _ => return Err(Errno::EINVAL),
        };
        let addr = control.checked_sub(offset).ok_or(Errno::EINVAL)?;
        if addr % 4 != 0 || addr.checked_add(4).ok_or(Errno::EINVAL)? > mem_len_bytes() {
            return Err(Errno::EINVAL);
        }
        // SAFETY: bounds- and alignment-checked above, in the guest's shared
        // linear memory, which the module imports. The host writes this same
        // word with `Atomics.compareExchange`, which is the same operation on
        // the same bytes.
        Ok(unsafe { &*(addr as *const AtomicI32) })
    }

    /// Take the exclusive archive writer, blocking until it is free.
    fn acquire_archive_writer() -> Result<(), Errno> {
        let lock = archive_lock()?;
        loop {
            match lock.compare_exchange(
                DLOPEN_LOCK_IDLE,
                DLOPEN_LOCK_WRITER,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                // Someone else holds it -- a writer, or one or more readers.
                // Wait on the value we OBSERVED rather than on a constant: the
                // wait is a no-op if it changed in between, which is exactly the
                // race `memory.atomic.wait32`'s compare-and-block closes.
                Err(observed) => {
                    let addr = lock as *const AtomicI32 as usize;
                    if atomic_wait32(addr, observed) < 0 {
                        return Err(Errno::EINVAL);
                    }
                }
            }
        }
    }

    /// Release the exclusive archive writer and wake whoever is waiting.
    ///
    /// Fails loud rather than forcing the word to idle: not holding the writer
    /// here means some other participant's view of the protocol is already
    /// wrong, and stamping IDLE over it would hand the lock to two owners.
    fn release_archive_writer() -> Result<(), Errno> {
        let lock = archive_lock()?;
        lock.compare_exchange(
            DLOPEN_LOCK_WRITER,
            DLOPEN_LOCK_IDLE,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| Errno::EPERM)?;
        atomic_notify(lock as *const AtomicI32 as usize);
        Ok(())
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_mutation_begin() -> i64`.
    ///
    /// Take the process writer, bring this worker up to the newest published
    /// state, and report the generation it now reflects. Ownership stays live
    /// until a commit or an abort releases it.
    ///
    /// Reconciling INSIDE the lock is the point: a mutation applied on top of a
    /// stale table would publish a patch describing slots the writer never saw.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_mutation_begin() -> i64 {
        if let Err(errno) = acquire_archive_writer() {
            set_err(errno);
            return -1;
        }
        let reached = __wpk_fork_module_state_table_reconcile();
        if reached < 0 {
            // Hold nothing on the way out. A failed begin that kept the writer
            // would wedge every other worker in the process.
            let _ = release_archive_writer();
            // `reconcile` already set the errno that explains this.
            return -1;
        }
        set_ok();
        reached
    }

    /// The guest's indirect function table length, read rather than told.
    fn indirect_table_length() -> u32 {
        // SAFETY: after injection this is one `table.size` on the imported table.
        let size = unsafe { fm_indirect_table_size() };
        if size < 0 { 0 } else { size as u32 }
    }

    /// This worker's syscall channel base, seeded with the rest of the
    /// per-worker format. Needed because publishing a patch allocates its record
    /// with `SYS_MMAP` through the same channel the guest uses, and a borrowed
    /// fork child cannot derive it from the archive control address -- that one
    /// belongs to its owner.
    fn channel_base() -> Result<u64, Errno> {
        let base = CHANNEL_BASE.load(Ordering::Relaxed);
        if base == 0 {
            return Err(Errno::EINVAL);
        }
        Ok(base as u64)
    }

    /// Address of the archive's LAST table-patch record, or `None` when it has
    /// none.
    ///
    /// Read from the header's own tail cursor rather than by walking the chain:
    /// the decoder does not retain record addresses, and re-deriving the tail by
    /// walking would be a second reader of the same pointers.
    fn archive_table_patch_tail(
        archive: &fork_codec::dylink_archive::DylinkArchive,
        head: u64,
        _pointer_width: u8,
    ) -> Result<Option<u64>, Errno> {
        if archive.table_patches.is_empty() {
            return Ok(None);
        }
        const HEADER_LAST_PATCH_OFFSET: u64 = 64;
        let at = head.checked_add(HEADER_LAST_PATCH_OFFSET).ok_or(Errno::EINVAL)?;
        let bytes = fork_codec::dylink_archive::ArchiveBytes::slice(&GuestArchiveBytes, at, 8)?;
        let tail = u64::from_le_bytes(bytes.try_into().map_err(|_| Errno::EINVAL)?);
        if tail == 0 {
            // The header says there are patches but names no tail, so the image
            // is inconsistent with itself.
            return Err(Errno::EINVAL);
        }
        Ok(Some(tail))
    }

    /// Write bytes into guest linear memory, bounds-checked.
    fn write_guest_bytes(address: u64, bytes: &[u8]) -> Result<(), Errno> {
        let start = usize::try_from(address).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(bytes.len()).ok_or(Errno::EINVAL)?;
        if end > mem_len_bytes() {
            return Err(Errno::EINVAL);
        }
        // SAFETY: bounds-checked above, into the guest's shared linear memory.
        unsafe {
            core::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                core::hint::black_box(start) as *mut u8,
                bytes.len(),
            );
        }
        Ok(())
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_mutation_commit(owner,
    /// first_index, length)`.
    ///
    /// Publish what the guest just wrote into `__indirect_function_table`, then
    /// release the archive writer `begin` took.
    ///
    /// Every step is the module's: read each changed slot, resolve the function
    /// there to a catalog coordinate, coalesce equal neighbours into runs, size
    /// and allocate the record with `SYS_MMAP` through the guest's own channel,
    /// plan the append, apply it, and publish the generation LAST. The host's
    /// only contribution is answering "are these the same function?" while the
    /// coordinates are resolved.
    ///
    /// The writer is released on EVERY exit, including the failing ones. A commit
    /// that failed while holding it would wedge every other worker in the
    /// process, which is worse than the mutation being lost.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_mutation_commit(
        owner: u32,
        first_index: u64,
        length: u64,
    ) {
        let result = commit_table_mutation_impl(owner, first_index, length);
        // Release before reporting, so a caller that ignores errno still does not
        // leave the process wedged.
        let released = release_archive_writer();
        match result.and(released) {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    fn commit_table_mutation_impl(
        owner: u32,
        first_index: u64,
        length: u64,
    ) -> Result<(), Errno> {
        let first = u32::try_from(first_index).map_err(|_| Errno::EINVAL)?;
        let count = u32::try_from(length).map_err(|_| Errno::EINVAL)?;
        if count == 0 {
            // Nothing changed. Not an error -- a zero-length `table.fill` is
            // legal -- and publishing an empty patch would burn a generation
            // every peer then reconciles against for no reason.
            return Ok(());
        }
        first.checked_add(count).ok_or(Errno::EINVAL)?;

        // One run per maximal stretch of slots holding the same coordinate, which
        // is what makes a bulk `table.fill` one record instead of `count` of them.
        let mut runs: Vec<fork_codec::dylink_archive::DylinkTablePatchRun> = Vec::new();
        for offset in 0..count {
            let index = fm_indirect_slot_catalog_index_safe(first + offset)?;
            let function = match index {
                None => None,
                Some(slot) => Some(catalog_slot_coordinate(slot)?),
            };
            match runs.last_mut() {
                Some(last) if last.function == function => last.length += 1,
                _ => runs.push(fork_codec::dylink_archive::DylinkTablePatchRun {
                    length: 1,
                    function,
                }),
            }
        }

        let head = archive_head()?;
        if head == 0 {
            return Err(Errno::EINVAL); // nothing published to append to
        }
        let pointer_width = format()?.pointer_width;
        let archive = fork_codec::dylink_archive::decode_dylink_archive(
            &GuestArchiveBytes,
            head,
            pointer_width,
        )?;
        let patch = fork_codec::dylink_archive::DylinkTablePatch {
            generation: archive.generation.checked_add(1).ok_or(Errno::EINVAL)?,
            // The guest's import signature carries no activation, and the planner
            // reads each RUN's own activation rather than this field, so recording
            // a guessed one would be a fiction nothing consumes.
            activation_id: 0,
            owner_id: owner,
            start: u64::from(first),
            table_length: u64::from(indirect_table_length()),
            runs,
        };
        let size = fork_codec::dylink_archive::table_append::appended_record_size(&patch)?;
        let record_at = channel_mmap(channel_base()?, size)?;
        let plan = fork_codec::dylink_archive::table_append::plan_table_patch_append(
            &archive,
            head,
            archive_table_patch_tail(&archive, head, pointer_width)?,
            record_at,
            &patch,
        )?;
        // Every write lands BEFORE the generation. A peer that saw the newer
        // generation first would follow a `next` pointer into memory this
        // mutation had not filled in yet.
        for write in &plan.writes {
            write_guest_bytes(write.address, &write.bytes)?;
        }
        write_guest_bytes(plan.generation_address, &plan.generation.to_le_bytes())?;
        // This worker wrote it, so it already reflects it.
        ARCHIVE_APPLIED[0].store((plan.generation & 0xffff_ffff) as u32, Ordering::Relaxed);
        ARCHIVE_APPLIED[1].store((plan.generation >> 32) as u32, Ordering::Relaxed);
        Ok(())
    }

    /// Safe wrapper over the injected indirect-slot lookup. `None` is a null
    /// slot; an uncatalogued function is `EINVAL`.
    fn fm_indirect_slot_catalog_index_safe(dest: u32) -> Result<Option<u32>, Errno> {
        // SAFETY: after injection this reads one indirect-table slot and scans
        // the imported catalog, both bounds-checked by wasm itself.
        match unsafe { fm_indirect_slot_catalog_index(dest) } {
            -1 => Ok(None),
            // A function the loader never catalogued cannot be described as a
            // coordinate, and a patch that omitted it would tell peers the slot
            // was cleared.
            //
            // ENOENT rather than EINVAL, deliberately: "no such catalog entry" is
            // a different event from "bad argument", and every other way this
            // commit can fail reports EINVAL. Sharing one code made the two
            // indistinguishable to a test -- which is how a perturbation that
            // treated an uncatalogued function as a CLEARED SLOT passed.
            -2 => Err(Errno::ENOENT),
            slot => Ok(Some(slot as u32)),
        }
    }

    /// Merged catalog slot -> the `(activation, ordinal)` a patch run records.
    fn catalog_slot_coordinate(
        slot: u32,
    ) -> Result<fork_codec::dylink_archive::DylinkTableFunction, Errno> {
        let count = ACT_FUNC_CATALOG_BASE_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives this borrow.
        let map = unsafe { &*ACT_FUNC_CATALOG_BASE.0.get() };
        let mut owner: Option<(u32, u32)> = None;
        for entry in map.iter().take(count) {
            let (activation, base) = (entry[0], entry[1]);
            if base <= slot && owner.is_none_or(|(_, best)| base > best) {
                owner = Some((activation, base));
            }
        }
        match owner {
            Some((activation, base)) => Ok(fork_codec::dylink_archive::DylinkTableFunction {
                activation_id: activation,
                ordinal: slot - base,
            }),
            None if count == 0 => Ok(fork_codec::dylink_archive::DylinkTableFunction {
                activation_id: 0,
                ordinal: slot,
            }),
            None => Err(Errno::EINVAL),
        }
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_mutation_abort()`.
    ///
    /// Release the writer after a guest mutation that changed nothing -- a
    /// failed `dlopen`, or a `table.fill` of length zero.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_mutation_abort() {
        match release_archive_writer() {
            Ok(()) => set_ok(),
            Err(errno) => set_err(errno),
        }
    }

    /// Guest-facing `env.__wpk_fork_module_state_table_reconcile() -> i64`.
    ///
    /// Brings this worker's `__indirect_function_table` up to the newest
    /// published generation and returns the generation it reached.
    ///
    /// The generation is published only AFTER every write lands: storing it
    /// first would let a peer observe a generation whose entries are not there
    /// yet. `-1` on failure, with the reason in `fm_last_errno`.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_module_state_table_reconcile() -> i64 {
        let head = match archive_head() {
            Ok(head) => head,
            Err(errno) => {
                set_err(errno);
                return -1;
            }
        };
        let owner = ARCHIVE_OWNER.load(Ordering::Relaxed);
        let applied = (u64::from(ARCHIVE_APPLIED[1].load(Ordering::Relaxed)) << 32)
            | u64::from(ARCHIVE_APPLIED[0].load(Ordering::Relaxed));
        if head == 0 {
            // Nothing published yet: coherent by definition.
            set_ok();
            return applied as i64;
        }
        let reconciled = (|| -> Result<u64, Errno> {
            let pointer_width = format()?.pointer_width;
            let archive = fork_codec::dylink_archive::decode_dylink_archive(
                &GuestArchiveBytes,
                head,
                pointer_width,
            )?;
            let steps = fork_codec::dylink_table_plan::plan_table_patches(
                &archive.table_patches,
                owner,
                applied,
            )?;
            // The generation this worker has REACHED is the snapshot's, not the
            // highest one its own owner appears in. The guest caches whatever
            // this returns and compares it against the shared fence on the next
            // table access: returning the owner-filtered generation would leave
            // the cached value permanently below the fence whenever some OTHER
            // owner published last, and the guard would then re-enter on every
            // single table access forever. Applying every patch for this owner
            // up to `archive.generation` is exactly what makes the worker
            // coherent with that snapshot, which is what the fence names.
            let reached = archive.generation.max(
                fork_codec::dylink_table_plan::planned_generation(
                    &archive.table_patches,
                    owner,
                    applied,
                ),
            );
            for step in &steps {
                let slot = if step.clear {
                    0
                } else {
                    catalog_slot(step.activation_id, step.ordinal)?
                };
                table_apply_via_injector(step.dest, slot, step.clear);
            }
            Ok(reached)
        })();
        match reconciled {
            Ok(reached) => {
                ARCHIVE_APPLIED[0].store((reached & 0xffff_ffff) as u32, Ordering::Relaxed);
                ARCHIVE_APPLIED[1].store((reached >> 32) as u32, Ordering::Relaxed);
                set_ok();
                reached as i64
            }
            Err(errno) => {
                set_err(errno);
                -1
            }
        }
    }

    /// Guest-facing `env.__wpk_fork_ref_gc_broker_encode(slot) -> recipe`.
    ///
    /// The cross-activation path: `fork-instrument` calls this when a GC value
    /// staged in the transit slot matched none of the CALLING activation's
    /// layouts. A structurally canonical value can enter through another
    /// dynamically loaded module, and its codec is the one that can encode it.
    ///
    /// Probes each registered activation's codec in turn through the drive
    /// table, and routes to the first that claims the value. Both steps are the
    /// guest's own generated functions; the module only chooses who to ask.
    ///
    /// # Why this is a loop and not a lookup
    ///
    /// Which activation owns a value is a property of the VALUE's type, and the
    /// module cannot inspect a reference. Asking each codec is the only way to
    /// find out, and it is bounded by the number of registered activations —
    /// a handful even for a program that dlopens heavily, not a per-object cost.
    ///
    /// Refuses with `EOPNOTSUPP` when no activation claims the value, rather
    /// than inventing a recipe. The returned `-1` is not a valid recipe id, so
    /// an edge naming it is rejected at `define_gc` and the capture cannot seal
    /// — the same structural refusal `__wpk_fork_ref_exn_broker_encode` uses.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_broker_encode(slot: u32) -> i32 {
        let act_count = ACT_GC_CODEC_ACT_COUNT.load(Ordering::Relaxed) as usize;
        // SAFETY: single-threaded per worker; the buffer outlives the borrow.
        let index = unsafe { &*ACT_GC_CODEC_INDEX.0.get() };
        for entry in index.iter().take(act_count) {
            let activation = entry[0];
            if capture_probe_via_injector(activation, slot) == 0 {
                continue; // this codec does not recognise the value
            }
            let recipe = capture_encode_via_injector(activation, slot);
            if recipe < 0 {
                set_err(Errno::EINVAL);
                return -1;
            }
            set_ok();
            return recipe;
        }
        set_err(Errno::EOPNOTSUPP);
        -1
    }

    /// Guest-facing `env.__wpk_fork_ref_gc_capture_layout(slot, activation,
    /// layout) -> selected_layout`.
    ///
    /// Answers "which layout is the value staged in transit slot `slot`" by
    /// driving the guest's own TYPE-TEST probe, which `ref.test`s the value
    /// against each dispatch layout and returns
    /// `(type_ordinal << 32) | layout_id`.
    ///
    /// # Why this needs no per-object bookkeeping
    ///
    /// A layout is a per-OBJECT fact — two objects of one base type can be made
    /// by different constructors — so the witness trick that made provenance
    /// bounded does not apply. Recording it per object is the unbounded storage
    /// problem census §20 ran into.
    ///
    /// Asking the guest instead costs nothing and stores nothing: the value is
    /// already in the transit slot, and the guest's generated codec can test it.
    /// The module holds no map at all.
    ///
    /// Returns 0 when no layout matched, which is the probe's own answer for a
    /// value this codec does not handle. 0 is not a valid layout id, so a
    /// `gc_define` that used it fails rather than defining against layout zero.
    /// The `layout` argument is the guest's static guess and is deliberately
    /// NOT trusted over the type test.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_capture_layout(
        slot: u32,
        activation: u32,
        _layout: u32,
    ) -> i32 {
        let packed = capture_probe_via_injector(activation, slot);
        set_ok();
        // Low 32 bits are the layout id; the high half is the type ordinal,
        // which `gc_define` receives separately from the guest.
        (packed as u64 & 0xffff_ffff) as i32
    }

    /// Guest-facing `env.__wpk_fork_ref_gc_define(...)`.
    ///
    /// Completes a claimed GC placeholder into its final aggregate recipe, and
    /// is where constructor provenance finally becomes readable: the witnesses
    /// recorded at `__wpk_fork_ref_gc_provenance_ref` are interned here, through
    /// the injected capture shim, and their recipe ids become this node's
    /// provenance edges.
    ///
    /// §21 established this export must not be served WITHOUT that: serving it
    /// alone would pass `has_provenance = 0` for every object and bake in
    /// "provenance is always absent", which is true today only because nothing
    /// interned the witnesses.
    ///
    /// The guest ABI returns nothing, so a failure latches in `fm_last_errno`
    /// and the claimed-but-undefined placeholder it leaves is what
    /// `fm_capture_validate` refuses to seal.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_define(
        recipe_id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        kind: u32,
        scalar_ptr: usize,
        scalar_len: u32,
        reference_vector_ordinal: u32,
    ) {
        let kind_enum = match kind {
            CAPTURE_KIND_STRUCT => AggregateKind::Struct,
            CAPTURE_KIND_ARRAY => AggregateKind::Array,
            _ => {
                set_err(Errno::EINVAL);
                return;
            }
        };
        let assembled = (|| -> Result<(), Errno> {
            let scalars = read_capture_bytes(scalar_ptr, scalar_len as usize)?;
            let prov_ids = intern_layout_witnesses(activation, layout_id)?;
            let g = capture_builder()?;
            // Edges are provenance ids first, then the interned field vector —
            // the order `gc_allocation_dependencies` reads, where the leading
            // `provenance_reference_count` entries are the allocation deps.
            let field_vector = g
                .vectors()
                .get(reference_vector_ordinal as usize)
                .ok_or(Errno::EINVAL)?
                .clone();
            let mut edges = prov_ids.clone();
            edges.extend_from_slice(&field_vector);
            let provenance = if prov_ids.is_empty() {
                None
            } else {
                Some(GcProvenance {
                    reference_ids: prov_ids,
                })
            };
            g.define_gc(
                recipe_id,
                activation,
                type_ordinal,
                layout_id,
                kind_enum,
                &scalars,
                &edges,
                provenance,
            )
        })();
        capture_ok_void(assembled);
    }

    /// Guest-facing `env.__wpk_fork_ref_exn_lookup(slot) -> recipe`.
    ///
    /// Always reports NOT FOUND, so every catch takes a fresh recipe. That is a
    /// deliberate decision with a proof, not a shortcut.
    ///
    /// # Why dedup is impossible here
    ///
    /// Deduping needs to tell two exception references apart, and nothing can:
    ///
    /// * Wasm cannot. `exn` is a disjoint hierarchy, so `ref.eq` on two
    ///   `exnref`s does not validate, an `exnref` cannot be stored in an
    ///   `anyref` table, and no cast rescues one into the eq hierarchy. Only
    ///   `ref.is_null` accepts an `exnref`, and that separates null from
    ///   non-null, not one exception from another.
    /// * A JS host cannot. An `exnref` VALUE cannot cross into a JS import: the
    ///   module compiles and instantiates, then throws
    ///   `TypeError: type incompatibility when transforming from/to JS` at the
    ///   first call. So the host cannot be asked to do it either.
    ///
    /// Both measured with `wasm-tools validate`, against a positive and a
    /// negative control — see docs/plans/2026-09-12-lane-f-census.md sections
    /// 28a and 28b.
    ///
    /// # Why that costs nothing observable
    ///
    /// The SAME limitation makes the duplication undetectable. A guest has no
    /// instruction that distinguishes two `exnref`s and no way to hand one to
    /// JavaScript to be compared there. A child that rebuilds two exception
    /// objects where the parent had one is therefore indistinguishable, from
    /// inside the guest, from one that rebuilt a single object.
    ///
    /// Their PAYLOADS do not duplicate: those are captured as ordinary
    /// references and dedup through the normal identity path, so two exnref
    /// recipes reference the same payload objects.
    ///
    /// # Why it cannot recurse
    ///
    /// A never-hit lookup would loop forever on a self-referential exception.
    /// None exists: an exception payload is fixed at `throw`, so building a
    /// cycle would need each exception to exist before the other. Exception
    /// payload graphs are acyclic by construction, the same argument that makes
    /// constructor seeds acyclic (section 25).
    ///
    /// The `slot` argument is accepted and ignored: with no identity to read,
    /// the staged reference is not needed. It stays in the signature because
    /// the guest ABI declares it.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_lookup(_slot: u32) -> i32 {
        set_ok();
        0
    }

    /// Guest-facing `env.__wpk_fork_ref_exn_claim(slot) -> recipe`.
    ///
    /// Reserves a placeholder recipe for an exception the guest is about to
    /// describe with `__wpk_fork_ref_exn_define`. Pairs with the lookup above:
    /// since lookup never hits, every catch claims once.
    ///
    /// Like the GC claim this only reserves identity, not content — but unlike
    /// it, there is nothing to bind the identity TO, for the reasons on
    /// `__wpk_fork_ref_exn_lookup`. `slot` is accepted and ignored.
    ///
    /// A claimed recipe that is never defined is refused by
    /// `fm_capture_validate`, so a dropped `exn_define` cannot seal.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_claim(_slot: u32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.claim_gc()),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Guest-facing `env.__wpk_fork_ref_exn_define(...)`.
    ///
    /// Completes a claimed exception placeholder into its final recipe. Unlike
    /// the GC `define`, this one is SELF-CONTAINED: `fork-instrument`'s
    /// exception codec stores every payload into one scratch staging span
    /// before the call -- scalars at their field offsets, and each reference
    /// payload as the `i32` recipe id its own encoder returned, at
    /// `references_ptr + index * 4` (`module_exception_codec.rs`). So both
    /// spans arrive as plain guest linear memory and the module needs no
    /// transit table, no host import, and no separate transaction to read them.
    ///
    /// The guest ABI returns NOTHING, so a failure cannot be reported at the
    /// call. It is latched in `fm_last_errno`, and the claimed-but-undefined
    /// placeholder it leaves behind is what `fm_capture_validate` refuses to
    /// seal ("a claimed GC identity was never defined"). That is the guard
    /// which makes a void return safe: a dropped `define` cannot reach a child
    /// as a silently missing exception payload, it stops the seal instead.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_exn_define(
        recipe_id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        scalar_ptr: usize,
        scalar_len: u32,
        reference_ptr: usize,
        reference_count: u32,
    ) {
        let assembled = (|| -> Result<(), Errno> {
            let scalars = read_capture_bytes(scalar_ptr, scalar_len as usize)?;
            // Edge order is the layout's declared payload order, which is what
            // the child replays; it is NOT an interned vector ordinal, so there
            // is nothing to look up.
            let edges = read_capture_u32_array(reference_ptr, reference_count as usize)?;
            let g = capture_builder()?;
            g.define_gc(
                recipe_id,
                activation,
                type_ordinal,
                layout_id,
                AggregateKind::Exnref,
                &scalars,
                &edges,
                None,
            )
        })();
        capture_ok_void(assembled);
    }

    /// Guest-facing `env.__wpk_fork_ref_gc_i31(payload) -> recipe`.
    ///
    /// The ONE member of the GC capture family that carries no reference at
    /// all: `fork-instrument` emits `ref.cast i31` then `i31.get_s` BEFORE the
    /// call (`module_gc_codec.rs`), so the module receives the signed 31-bit
    /// payload as a plain scalar and interns it in the same recipe space as
    /// every other leaf.
    ///
    /// The guest then publishes i31 identity into the transit table itself, at
    /// `recipe + 1` — the generator's comment gives the reason: "JavaScript
    /// receives only its scalar payload and cannot manufacture an `i31ref`".
    /// That is this module's job now, and it needs no host at all.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_i31(payload: i32) -> i32 {
        match capture_builder() {
            Ok(g) => capture_ok_id(g.intern_i31(payload)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    // ---- Constructor provenance: a WITNESS per (layout, ordinal) -----------
    //
    // A non-defaultable GC shape cannot be `struct.new_default`'d, so replay's
    // allocate step must pass a type-correct non-null value for each mutable
    // internal-reference field before the true edge target may exist. That
    // seed is then OVERWRITTEN: the edge vector is
    // `[ ...provenance refs, ...snapshot refs ]` and phase two fills the real
    // edges over it.
    //
    // So the requirement is a type-correct CAPTURABLE instance of the field's
    // type -- not the specific one the original constructor used. The original
    // is what fork-instrument records only because an instance of an
    // application-defined type cannot be conjured from nothing, and a value the
    // program actually used is by construction one that existed.
    //
    // Hence a WITNESS: one retained instance per (layout, provenance ordinal),
    // rather than one record per allocated object. The count is a static
    // property of the guest's layouts, so this is bounded where a per-object
    // record is not -- and the witness is stored by the injected shim with a
    // plain `table.set`, so there is no host call on the allocation path.
    //
    // See docs/plans/2026-09-12-lane-f-census.md sections 21 and 22.
    const WITNESS_SLOTS: usize = 256;

    struct WitnessCell(UnsafeCell<WitnessState>);
    // SAFETY: one guest drives these exports per worker, as with every other
    // module static here.
    unsafe impl Sync for WitnessCell {}

    struct WitnessState {
        /// `(layout << 8) | ordinal` per slot; `u32::MAX` when free.
        keys: [u32; WITNESS_SLOTS],
        /// Set once a slot has actually been written by the shim.
        occupied: [bool; WITNESS_SLOTS],
        /// Recipe id this witness encoded to, or 0 before it is interned.
        ///
        /// Cached because a witness is shared by EVERY object of its layout: a
        /// thousand objects must reference one witness recipe, not intern the
        /// same reference a thousand times.
        recipes: [u32; WITNESS_SLOTS],
    }

    static WITNESS: WitnessCell = WitnessCell(UnsafeCell::new(WitnessState {
        keys: [u32::MAX; WITNESS_SLOTS],
        occupied: [false; WITNESS_SLOTS],
        recipes: [0u32; WITNESS_SLOTS],
    }));

    #[allow(clippy::mut_from_ref)]
    fn witness() -> &'static mut WitnessState {
        // SAFETY: single-threaded per worker, as `state()` above.
        unsafe { &mut *WITNESS.0.get() }
    }

    /// The open provenance transaction: `[token + 1, layout, declared, seen]`.
    ///
    /// One slot is enough for the same reason `VECTOR_IN_FLIGHT` needs one: the
    /// wrapper fork-instrument emits is straight-line -- `begin`, N x `ref`,
    /// `end` -- with no guest call between them.
    static PROVENANCE_IN_FLIGHT: [AtomicU32; 4] = [
        AtomicU32::new(0),
        AtomicU32::new(0),
        AtomicU32::new(0),
        AtomicU32::new(0),
    ];

    /// Guest-facing `env.__wpk_fork_ref_gc_provenance_begin(...) -> token`.
    ///
    /// Pure scalars, so this needs no shim: the object fork-instrument stages in
    /// the transit slot is the NEWLY CONSTRUCTED one, and a witness design has
    /// no use for it. Only the seeds matter, and those arrive at
    /// `__wpk_fork_ref_gc_provenance_ref`.
    ///
    /// `_slot` and the constructor scalars are accepted and ignored for the same
    /// reason: an array's length is the one constructor scalar that is not
    /// overwritten by the fill, and it is recoverable at capture by inspecting
    /// the array, so no scalar needs recording here. They stay in the signature
    /// because the guest ABI declares them.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_provenance_begin(
        _slot: u32,
        _activation: u32,
        _base_layout: u32,
        layout: u32,
        _scalar_lo: u64,
        _scalar_hi: u64,
        reference_count: u32,
    ) -> i32 {
        if PROVENANCE_IN_FLIGHT[0].load(Ordering::Relaxed) != 0 {
            // A second `begin` before an `end` means the emitted shape changed.
            set_err(Errno::EINVAL);
            return -1;
        }
        if layout > 0x00ff_ffff || reference_count > 0xff {
            // The witness key packs layout and ordinal into one u32.
            set_err(Errno::E2BIG);
            return -1;
        }
        let token = 1u32;
        PROVENANCE_IN_FLIGHT[0].store(token + 1, Ordering::Relaxed);
        PROVENANCE_IN_FLIGHT[1].store(layout, Ordering::Relaxed);
        PROVENANCE_IN_FLIGHT[2].store(reference_count, Ordering::Relaxed);
        PROVENANCE_IN_FLIGHT[3].store(0, Ordering::Relaxed);
        set_ok();
        token as i32
    }

    /// The witness table slot `(token, ordinal)` names, allocating one on first
    /// use. Returns `-1` on failure, or `-2` for "slot already witnessed, do
    /// not store" -- which is not an error.
    ///
    /// Called by the injected `__wpk_fork_ref_gc_provenance_ref` shim, which
    /// then `table.set`s the guest's staged seed into that slot. Rust picks the
    /// slot because Rust can hold the map; wasm does the store because only
    /// wasm can hold the reference.
    ///
    /// # Why the FIRST seed wins, and never a later one
    ///
    /// Replay orders allocation by constructor dependency and fails
    /// `EINVAL` on "an unallocatable constructor cycle"
    /// (`crates/fork-codec/src/drive_plan.rs`). A provenance-eligible field is
    /// mutable, NON-NULL and an internal GC reference, so seeding one always
    /// requires an instance that already existed: the original program's
    /// construction order over provenance edges is therefore acyclic.
    ///
    /// Keeping the FIRST witness preserves that order -- the first object of a
    /// layout was seeded by something built before any object of that layout.
    /// Keeping the LATEST does NOT: witness(A) may be an object whose own
    /// layout's latest witness is a LATER object, which closes a cycle that the
    /// original execution never had, and replay then refuses the whole graph.
    /// This is the one place where a witness pool can differ from per-object
    /// recording, and first-wins is what makes it equivalent.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_gc_provenance_witness_slot(token: u32, ordinal: u32) -> i32 {
        let open = PROVENANCE_IN_FLIGHT[0].load(Ordering::Relaxed);
        if open == 0 || open - 1 != token {
            set_err(Errno::EINVAL);
            return -1;
        }
        let declared = PROVENANCE_IN_FLIGHT[2].load(Ordering::Relaxed);
        if ordinal >= declared || ordinal > 0xff {
            set_err(Errno::EINVAL);
            return -1;
        }
        let layout = PROVENANCE_IN_FLIGHT[1].load(Ordering::Relaxed);
        let key = (layout << 8) | ordinal;
        let w = witness();
        let slot = match w.keys.iter().position(|k| *k == key) {
            Some(i) => i,
            None => match w.keys.iter().position(|k| *k == u32::MAX) {
                Some(free) => {
                    w.keys[free] = key;
                    free
                }
                None => {
                    // Bounded, and a truthful failure: a witness that cannot be
                    // stored would make the child allocate with a seed of the
                    // wrong type, which is worse than refusing here.
                    set_err(Errno::E2BIG);
                    return -1;
                }
            },
        };
        // Count the store as seen either way: `end` is checking that the guest
        // made the calls it declared, not that each one wrote.
        PROVENANCE_IN_FLIGHT[3].fetch_add(1, Ordering::Relaxed);
        set_ok();
        if w.occupied[slot] {
            return -2; // already witnessed; keep the first seed
        }
        w.occupied[slot] = true;
        slot as i32
    }

    /// Guest-facing `env.__wpk_fork_ref_gc_provenance_end(token)`.
    ///
    /// Closes the transaction. The guest ABI returns nothing, so a mismatch
    /// between the declared reference count and the stores actually made is
    /// latched in `fm_last_errno` rather than reported here -- but it still
    /// matters, because a missing witness means some later object of this
    /// layout would be allocated with no type-correct seed at all.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_gc_provenance_end(token: u32) {
        let open = PROVENANCE_IN_FLIGHT[0].load(Ordering::Relaxed);
        if open == 0 || open - 1 != token {
            set_err(Errno::EINVAL);
            return;
        }
        let declared = PROVENANCE_IN_FLIGHT[2].load(Ordering::Relaxed);
        let seen = PROVENANCE_IN_FLIGHT[3].load(Ordering::Relaxed);
        PROVENANCE_IN_FLIGHT[0].store(0, Ordering::Relaxed);
        if declared != seen {
            set_err(Errno::EINVAL);
            return;
        }
        set_ok();
    }

    /// Guest-facing `env.__wpk_fork_ref_vector_begin(count) -> handle`.
    ///
    /// Opens a reference vector for one call site's live references. `count` is
    /// the number of appends the guest promises to make; it is recorded and
    /// checked by `__wpk_fork_ref_vector_finish`.
    ///
    /// Returns `-1` with `fm_last_errno` set on failure, including when a
    /// vector is already open (see `VECTOR_IN_FLIGHT`).
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_vector_begin(count: u32) -> i32 {
        if VECTOR_IN_FLIGHT[0].load(Ordering::Relaxed) != 0 {
            set_err(Errno::EINVAL);
            return -1;
        }
        let handle = match capture_builder() {
            Ok(g) => capture_ok_id(g.begin_vector()),
            Err(e) => {
                set_err(e);
                -1
            }
        };
        if handle < 0 {
            return handle;
        }
        VECTOR_IN_FLIGHT[0].store(handle as u32 + 1, Ordering::Relaxed);
        VECTOR_IN_FLIGHT[1].store(count, Ordering::Relaxed);
        VECTOR_IN_FLIGHT[2].store(0, Ordering::Relaxed);
        handle
    }

    /// Guest-facing `env.__wpk_fork_ref_vector_append(handle, recipe_id)`.
    ///
    /// Returns NOTHING — that is the guest ABI, not a choice — so a failure is
    /// latched in `fm_last_errno` and surfaces at
    /// `__wpk_fork_ref_vector_finish`, which fails loud rather than interning a
    /// short vector the child would reconstruct with missing references.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_vector_append(handle: u32, recipe_id: u32) {
        match capture_builder() {
            Ok(g) => {
                if capture_ok_void(g.append_vector(handle, recipe_id)) == 0 {
                    VECTOR_IN_FLIGHT[2].fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(e) => set_err(e),
        }
    }

    /// Guest-facing `env.__wpk_fork_ref_vector_finish(handle) -> ordinal`.
    ///
    /// Interns the vector and returns the DURABLE canonical ordinal the frame
    /// stores — never the transaction-local handle, which is why the guest
    /// overwrites its saved handle with this result.
    ///
    /// Fails (`-1`, `EINVAL`) when the appends did not match the count the
    /// guest declared at `begin`, or when this names a handle that is not the
    /// open one.
    #[unsafe(no_mangle)]
    pub extern "C" fn __wpk_fork_ref_vector_finish(handle: u32) -> i32 {
        let open = VECTOR_IN_FLIGHT[0].load(Ordering::Relaxed);
        if open == 0 || open - 1 != handle {
            set_err(Errno::EINVAL);
            return -1;
        }
        let promised = VECTOR_IN_FLIGHT[1].load(Ordering::Relaxed);
        let appended = VECTOR_IN_FLIGHT[2].load(Ordering::Relaxed);
        VECTOR_IN_FLIGHT[0].store(0, Ordering::Relaxed);
        if promised != appended {
            set_err(Errno::EINVAL);
            return -1;
        }
        match capture_builder() {
            Ok(g) => capture_ok_id(g.finish_vector(handle)),
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_vector_get(ordinal: u32, index: u32) -> i32 {
        let Some(g) = capture_state().as_ref() else {
            set_err(Errno::EINVAL);
            return -1;
        };
        match g
            .vectors()
            .get(ordinal as usize)
            .and_then(|v| v.get(index as usize))
        {
            Some(&recipe_id) if recipe_id <= i32::MAX as u32 => {
                set_ok();
                recipe_id as i32
            }
            _ => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    /// Validate the built graph as a canonical, sealable capture (no pending GC
    /// placeholder, no open vector, every edge names an existing recipe). Returns
    /// `0` or `-1`. `fm_capture_serialize` validates too; this lets the host gate
    /// early, mirroring the TS `validateCanonicalCapture`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_validate() -> i32 {
        // Create-if-armed: an empty capture (no references) is still a valid
        // null-only graph the host may seal.
        match capture_builder() {
            Ok(g) => match g.validate() {
                Ok(()) => {
                    set_ok();
                    0
                }
                Err(e) => {
                    set_err(e);
                    -1
                }
            },
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Serialize the built graph into a module-owned KFRV/KFRS record stream and
    /// return its guest address (0 on failure; reason in `fm_last_errno`).
    /// The stream is a sequence of records, each `CAPTURE_RECORD_HEADER` bytes
    /// (`u16 kind, u16 reserved, u32 activation_id, u32 owner_id, u32 payload_len`)
    /// followed by `payload_len` payload bytes, in the exact emit order of the
    /// shared `ReferenceSegmentsWriter` (five KFRS sections then the KFRV
    /// manifest). The host drains each record into its module-state arena via
    /// `appendRecord({kind, activationId, ownerId, payload})` — the same records
    /// the TS `appendSegmentedForkReferenceTransaction` emitted, now from the ONE
    /// shared writer. `fm_capture_serialized_len` reports the stream length.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_serialize(owner_id: u32, segment_data_bytes: usize) -> usize {
        let built = (|| -> Result<Vec<u8>, Errno> {
            let g = capture_builder()?;
            let writer = ReferenceSegmentsWriter::new(owner_id, segment_data_bytes)?;
            let mut stream: Vec<u8> = Vec::new();
            let mut sink =
                |kind: u16, activation_id: u32, owner: u32, payload: &[u8]| -> Result<(), Errno> {
                    let len = u32::try_from(payload.len()).map_err(|_| Errno::EINVAL)?;
                    stream.extend_from_slice(&kind.to_le_bytes());
                    stream.extend_from_slice(&0u16.to_le_bytes());
                    stream.extend_from_slice(&activation_id.to_le_bytes());
                    stream.extend_from_slice(&owner.to_le_bytes());
                    stream.extend_from_slice(&len.to_le_bytes());
                    stream.extend_from_slice(payload);
                    Ok(())
                };
            writer.write(&mut sink, g)?;
            Ok(stream)
        })();
        match built {
            Ok(stream) => {
                let ptr = stream.as_ptr() as usize;
                // SAFETY: single-threaded per worker; root the bytes so the
                // returned pointer stays valid while the host drains the records.
                unsafe {
                    *CAPTURE_SERIALIZED.0.get() = Some(stream);
                }
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// The byte length of the record stream `fm_capture_serialize` last produced,
    /// or 0 if none is live. The header of each record is `CAPTURE_RECORD_HEADER`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_serialized_len() -> usize {
        // SAFETY: single-threaded per worker.
        match unsafe { &*CAPTURE_SERIALIZED.0.get() } {
            Some(stream) => stream.len(),
            None => 0,
        }
    }

    /// The record-stream header size (bytes) preceding each record's payload.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_record_header_size() -> i32 {
        CAPTURE_RECORD_HEADER as i32
    }

    /// Monotonic count of coordinates the module has interned into the shared
    /// capture builder since worker start (Path B P3). Proof-of-use for the
    /// CAPTURE flip: a value greater than its pre-fork reading proves the parent
    /// routed reference capture through the ONE shared builder; a silent fallback
    /// to the TypeScript capture graph leaves it unchanged. Never resets.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_capture_interned() -> i64 {
        CAPTURE_INTERNED.load(Ordering::Relaxed) as i64
    }

    // -- Module-owned wire-graph decode + scan + restore exports (orchestration
    //    migration increment 1) -------------------------------------------------
    //
    // Additive `fm_*` surfaces over the EXISTING `fork_codec` decode/replay/drive
    // engine (`reference_segments.rs` decode, `reference_replay.rs` driver/feed,
    // `drive_plan.rs` build_drive_plan). They let a later host-rewire increment
    // retire the TypeScript wire-graph decode (`fork-reference-segments.ts`),
    // externref-handle scan (`scanSegmentedForkReferenceExternrefHandles`), and
    // replay ENTRY wrapper (`restoreModuleState`/`materializeAllTyped`), routing
    // all three through the ONE shared engine that already backs
    // `fm_begin_reference_replay`. The wire format is FROZEN — these carry no new
    // algorithm and no new engine-floor seam.

    /// Decode the sealed KFMS module-state arena rooted at `module_state_root`
    /// into the module-owned decoded reference graph. Returns the graph's node
    /// count (`>= 0`) or `-1` (reason in `fm_last_errno`). The decoded graph
    /// stays resident for `fm_decoded_node_count` / `fm_decoded_node_*`
    /// until the next decode or replay. See `decode_reference_graph_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_decode_reference_graph(module_state_root: usize) -> i32 {
        match decode_reference_graph_impl(module_state_root as u64) {
            Ok(count) if count <= i32::MAX as u32 => {
                set_ok();
                count as i32
            }
            Ok(_) => {
                set_err(Errno::EINVAL);
                -1
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// The node count of the resident decoded graph (`fm_decode_reference_graph`
    /// result), or `-1` if none is resident. Lets the host size a per-node
    /// readout buffer without re-decoding.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_decoded_node_count() -> i32 {
        match decoded_graph().as_ref() {
            Some(t) => match i32::try_from(t.nodes.len()) {
                Ok(n) => {
                    set_ok();
                    n
                }
                Err(_) => {
                    set_err(Errno::EINVAL);
                    -1
                }
            },
            None => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    /// One field of the resident decoded graph's node at `index`, selected by
    /// `field`, or `-1` (reason in `fm_last_errno`) if no graph is resident,
    /// `index` is out of range, the node's kind does not carry the requested
    /// field, the value exceeds `i32::MAX`, or `field` is unknown.
    ///
    /// - 0 `KIND`              — the wire node-kind discriminant (`0..=7`: null 0,
    ///   funcref 1, externref 2, exnref 3, i31 4, struct 5, array 6,
    ///   static-root 7). Mirrors the JS decode's `entry.node.kind` so the host
    ///   can filter the graph by kind. See `decoded_node_kind_impl` /
    ///   `wire_node_kind`.
    /// - 1 `MODULE_ACTIVATION` — the `module_activation` coordinate
    ///   (funcref/exnref/struct/array/static-root; absent for null/externref/i31).
    ///   This is the host's `moduleActivation` for the exnref admission gate and
    ///   the static-root catalog mirror seeding. See
    ///   `decoded_node_module_activation_impl`.
    /// - 2 `ORDINAL`           — the kind-specific ordinal (funcref
    ///   `function_ordinal`, exnref `tag_ordinal`, struct/array `type_ordinal`,
    ///   static-root `static_root_ordinal`; absent for null/externref/i31). This
    ///   is the host's `tagOrdinal` (exnref admission gate) and
    ///   `staticRootOrdinal` (static-root catalog mirror seeding). See
    ///   `decoded_node_ordinal_impl`.
    ///
    /// Replaces the former `fm_decoded_node_kind`,
    /// `fm_decoded_node_module_activation` and `fm_decoded_node_ordinal`
    /// exports, which shared one concept ("read a field of a decoded node") and
    /// one signature `(usize) -> i32`. Because the operand types were already
    /// identical, folding them costs no type checking at the boundary — unlike
    /// an opaque fold over exports whose operands mean different things. Keep
    /// the selectors in lockstep with `FmDecodedNodeField` in
    /// `host/src/fork-module-backend.ts`.
    ///
    /// Unlike `fm_stats`, a `match` is safe here: the arms dispatch to distinct
    /// *functions* rather than loading from distinct statics, so it does not
    /// reproduce the post-injection `br_table` miscompile documented there.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_decoded_node_field(index: usize, field: u32) -> i32 {
        match field {
            0 => match decoded_node_kind_impl(index) {
                Ok(kind) => {
                    set_ok();
                    kind as i32
                }
                Err(e) => {
                    set_err(e);
                    -1
                }
            },
            1 => clamp_decoded_u32(decoded_node_module_activation_impl(index)),
            2 => clamp_decoded_u32(decoded_node_ordinal_impl(index)),
            _ => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    /// Shared tail for the `u32`-valued `fm_decoded_node_field` selectors: a
    /// value above `i32::MAX` is `EINVAL` rather than a negative sentinel.
    fn clamp_decoded_u32(result: Result<u32, Errno>) -> i32 {
        match result {
            Ok(value) if value <= i32::MAX as u32 => {
                set_ok();
                value as i32
            }
            Ok(_) => {
                set_err(Errno::EINVAL);
                -1
            }
            Err(e) => {
                set_err(e);
                -1
            }
        }
    }

    /// Seed the reference replay driver/feed AND build the drive plan from the
    /// KFMS arena rooted at `module_state_root` in one call, returning the drive
    /// plan's guest address (0 on failure; reason in `fm_last_errno`). The step
    /// count is read from `fm_gc_plan_count`. This is the replay-orchestration
    /// ENTRY that collapses the JS `beginReferenceReplay` + `restoreModuleState`
    /// wrapper into the module. See `restore_from_arena_impl`.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_restore_from_arena(module_state_root: usize, pid: u32) -> usize {
        match restore_from_arena_impl(module_state_root as u64, pid) {
            Ok(ptr) => {
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// Child-install ENTRY for a COW (`fork`/`posix_spawn`) module-backed child:
    /// seed the reference replay driver AND build the drive plan whose tail drives
    /// every activation's guest restore/finish install through the module (see
    /// `attach_from_arena_impl`). Returns the plan's guest address (0 on failure;
    /// reason in `fm_last_errno`); the step count is read from `fm_gc_plan_count`.
    /// Supersedes a separate `fm_restore_from_arena` call on the module-on child
    /// attach path: it does the same reconstruction seed + plan build and then
    /// appends the module-owned restore/finish sequencing.
    ///
    /// This is ALSO the vfork BORROWED child-install entry. A separate
    /// `fm_attach_borrowed_child` export existed and its body was identical to
    /// this one, character for character, because the install plan IS identical:
    /// the reconstructed reference values and the guest restore/finish
    /// sequencing do not depend on whether the child is COW or borrowed. Its
    /// stated reason to exist was to give "any future borrowed-specific install
    /// divergence a home" — a home for a divergence that has not appeared, paid
    /// for now in the surface every new host must implement.
    ///
    /// The borrowed path is still explicit where its borrowed-specific work
    /// actually lives: reserving the child-private replay prefix, so the guest's
    /// rewind never writes the parked parent's storage. That is raw host memory
    /// management with no reference values in it, it is done by the coordinator,
    /// and it never entered this module. `ForkModuleBackend.attachBorrowedChild`
    /// remains a named host entry point for it.
    ///
    /// If borrowed-specific install work ever does appear, re-splitting is a
    /// smaller change than carrying a duplicate export until then.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_attach_child(module_state_root: usize, pid: u32) -> usize {
        match require_phase(PHASE_IDLE)
            .and_then(|()| attach_from_arena_impl(module_state_root as u64, pid))
        {
            Ok(ptr) => {
                enter_phase(PHASE_CHILD_REPLAY);
                set_ok();
                ptr
            }
            Err(e) => {
                set_err(e);
                0
            }
        }
    }

    /// Read one field of the module's proof-of-use statistics record by index.
    ///
    /// This single export folds the former 11 individual counter exports
    /// (`fm_frames_committed` … `fm_externref_handles_scanned`) into one
    /// field-indexed accessor: the same monotonic-since-worker-start counts, one
    /// export instead of eleven. Each counter is a proof-of-use oracle — it
    /// advances only when the MODULE (not a silent JS fallback) performed the
    /// corresponding work — so the module's unit tests read exact before/after
    /// deltas to prove reconstruction did the right amount of work, and the host
    /// diagnostic bridge reads the same fields.
    ///
    /// Field indices (see `FmStatField` in the host backend — the two must stay
    /// in lockstep; both ship together in this crate + `fork-module-backend.ts`):
    ///
    /// - 0  `FRAMES_COMMITTED`         — frames committed
    /// - 1  `FRAMES_REPLAYED`          — frames replayed (consuming rewind)
    /// - 2  `REFERENCES_RECONSTRUCTED` — funcref/null references reconstructed
    /// - 3  `EXTERNREFS_RESOLVED`      — externrefs re-rooted via engine-floor seam
    /// - 4  `EXNREFS_RECONSTRUCTED`    — exnref nodes admitted + driven
    /// - 5  `GC_NODES_RECONSTRUCTED`   — typed-GC nodes (struct/array/i31) driven
    /// - 6  `STATIC_ROOTS_PUBLISHED`   — static roots published into transit
    /// - 7  `DRIVE_STEPS_EXECUTED`     — typed-GC drive steps executed
    /// - 8  `REF_FEED_READS`           — RESTORE data-feed reads served
    /// - 9  `REFERENCE_GRAPHS_DECODED` — reference graphs decoded from KFMS arena
    /// - 10 `EXTERNREF_HANDLES_SCANNED`— externref handles scanned out of graphs
    ///
    /// Returns the counter value, or `-1` for an unknown field index (the
    /// counters are monotonic non-negative, so `-1` is an unambiguous sentinel).
    /// Child-private workspace a vfork BORROWED child will need, by field:
    /// `0` continuation-prefix bytes, `1` reference-scratch bytes.
    ///
    /// Ported from `ForkProcessContinuationCoordinator.borrowedReplayWorkspaceRequirements`.
    /// A vfork child runs a FRESH module instance inside the SAME shared memory
    /// as the still-parked parent, so it cannot write the parent's fixed
    /// runtime prefix or reuse the parent's scratch. The host reserves it a
    /// private region and needs its size BEFORE issuing the fork syscall, which
    /// is why this is a read rather than something the child asks for later.
    ///
    /// The two halves are measured differently because they behave differently.
    /// Prefixes stay LIVE through the whole inherited-frame rewind, so every
    /// active activation needs its own simultaneously and they sum. Reference
    /// scratch is stack-disciplined -- reserve and release nest around a
    /// recursive encode -- so its current top is back to 0 at seal and only its
    /// capture HIGH-WATER bounds what the child's decode will need. Summing the
    /// scratch too would over-reserve; taking the prefix high-water instead of
    /// the sum would under-reserve, and under-reserving means one activation's
    /// rewind writing into another's prefix.
    ///
    /// Why the module and not the host. The host had to reach into each
    /// activation's frame format for `fixedPrefixSize` and into the capture
    /// session for the scratch high-water, which is per-activation module state
    /// and the module's own allocator respectively. Neither is host knowledge;
    /// the host was reading the module's bookkeeping through a JS mirror of it.
    ///
    /// Legal only at `PHASE_SEALED_PARENT`, which is the same rule the JS
    /// `requirePhase("sealed-parent", ...)` enforced -- now enforced by the
    /// phase machine instead of a copy of it. Earlier than that the activation
    /// set is still growing and the scratch high-water has not peaked, so an
    /// answer would be an undercount rather than an error, which is the worst
    /// kind. Answers `EBUSY` and `-1` off-phase, `EINVAL` and `-1` for an
    /// unknown field.
    /// The module-state (KFMS) arena, by operation:
    ///
    /// - `0` ROOT    — the arena root address, or `0` when there is none.
    /// - `1` ADOPT   — adopt the arena at `arg` (a child taking over the
    ///                 parent's inherited records). Returns `0`.
    /// - `2` RELEASE — `munmap` every arena chunk THIS module mapped. Returns
    ///                 how many were released.
    /// - `3` OWNED   — `1` when this module mapped the chunks and may free
    ///                 them, `0` when the arena was adopted or absent.
    ///
    /// One field-indexed entry rather than four exports, the shape `fm_stats`
    /// established. The surface budget drives this population toward five, so a
    /// port that needs four operations should cost one entry.
    ///
    /// **This is the module half of the arena port** (census sections 132 and
    /// 133) and it is deliberately the half that changes nothing yet. The host's
    /// `ForkModuleStateArena` still owns the live path. What section 133 found
    /// is that the two cannot be switched a method at a time: the module
    /// ALLOCATES the KFMS chunks (through `__wpk_fork_module_state_record_`
    /// `reserve`) and the host FREES them, having rediscovered the addresses by
    /// walking the linked chunk list in guest memory from the root. If both
    /// sides free, a fork double-munmaps; if neither does, it leaks the arena.
    /// So RELEASE exists here, tested, and stays uncalled until the host's
    /// `release()` goes away in the same change.
    ///
    /// OWNED is what makes that switch checkable rather than hopeful, and it is
    /// also the borrowed case for free: a vfork child's arena allocator is
    /// `new_channel(0)`, which maps nothing, so it owns nothing and releases
    /// nothing — which is exactly what the host's `detachBorrowed` does by
    /// hand. The distinction the host draws with an `ownership` field falls out
    /// of which allocator the child was built with.
    ///
    /// Answers `-1` with `EINVAL` for an unknown operation or a refused adopt.
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_module_state_arena(op: u32, arg: usize) -> i64 {
        // No `op > 3` pre-check. It would be a guard no test can show failing:
        // in every configuration a test can reach, an unknown op is already
        // refused by one of the two matches below, so removing the pre-check
        // changes nothing observable. What it WOULD do is let a catch-all arm
        // mis-dispatch op 4 as OWNED once module state exists -- so the arms are
        // exhaustive instead, and unknown ops are refused in exactly one way.
        let Some(module) = state().as_mut() else {
            // No module state means no fork has begun unwinding in this worker,
            // so there is genuinely no arena. For the two QUERIES that is the
            // truthful answer, not a default -- the same reasoning `fm_phase`
            // uses for answering IDLE before any activation exists. ADOPT and
            // RELEASE mutate, and a mutation against state that does not exist
            // is a caller error rather than a no-op.
            return match op {
                0 | 3 => {
                    set_ok();
                    0
                }
                _ => {
                    set_err(Errno::EINVAL);
                    -1
                }
            };
        };
        match op {
            0 => match i64::try_from(module.module_state.root()) {
                Ok(root) => {
                    set_ok();
                    root
                }
                Err(_) => {
                    set_err(Errno::EINVAL);
                    -1
                }
            },
            1 => match module.module_state.adopt(arg as u64) {
                Ok(()) => {
                    set_ok();
                    0
                }
                Err(e) => {
                    set_err(e);
                    -1
                }
            },
            2 => {
                let released = module.module_state_chunks.release_count();
                module.module_state_chunks.release_all();
                set_ok();
                released as i64
            }
            3 => {
                // Adopted means another process mapped these chunks; absent
                // means nobody did. Only a list this module built is safe to
                // free, which is the whole point of asking.
                let owned = !module.module_state.is_adopted()
                    && module.module_state_chunks.release_count() > 0;
                set_ok();
                if owned { 1 } else { 0 }
            }
            _ => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fm_borrowed_replay_workspace(field: u32) -> i64 {
        // Field BEFORE phase, deliberately. Which fields exist is a static
        // property of this entry, true in every phase, so a caller asking for
        // one that does not exist is wrong now and would still be wrong after a
        // seal. Checking the phase first would answer `EBUSY` to that caller and
        // invite it to retry forever -- and would make the two refusals
        // indistinguishable from idle, which is the only phase a test can reach
        // this entry from without driving a whole capture.
        if field > 1 {
            set_err(Errno::EINVAL);
            return -1;
        }
        // Propagated, not re-minted: `require_phase` is the one place that names
        // the wrong-phase errno, and a second literal here would break the pin
        // keeping that errno to exactly one meaning.
        if let Err(e) = require_phase(PHASE_SEALED_PARENT) {
            set_err(e);
            return -1;
        }
        let bytes = if field == 0 {
            let Some(module) = state().as_ref() else {
                set_err(Errno::EINVAL);
                return -1;
            };
            let alignment = abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT as u64;
            if alignment == 0 {
                set_err(Errno::EINVAL);
                return -1;
            }
            let mut total: u64 = 0;
            // Ascending activation id, matching the host's `orderedActivations()`
            // sort. The running total is aligned BEFORE each prefix is added, so
            // the order is part of the answer and both sides must walk it alike.
            for frames in module.activations.values() {
                total = match total
                    .checked_add(alignment - 1)
                    .map(|v| v / alignment * alignment)
                    .and_then(|v| v.checked_add(frames.format.fixed_prefix_size as u64))
                {
                    Some(next) => next,
                    None => {
                        set_err(Errno::EINVAL);
                        return -1;
                    }
                };
            }
            total
        } else {
            SCRATCH_HIGH_WATER.load(Ordering::Relaxed) as u64
        };
        match i64::try_from(bytes) {
            Ok(value) => {
                set_ok();
                value
            }
            Err(_) => {
                set_err(Errno::EINVAL);
                -1
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fm_stats(field: u32) -> i64 {
        // Index a table of references rather than `match`-ing over the eleven
        // atomic loads directly: a `match field { 0 => A.load(), 1 => B.load(),
        // ... }` compiles to a `br_table` selecting among eleven distinct
        // memory-base-relative atomic loads, which miscompiled after fork-module
        // injection (arms read a stale/zero value even though the counter had
        // advanced -- confirmed by an in-scope diagnostic reader seeing the real
        // value while the same-static `match` arm returned 0). Building one
        // reference table and doing a single bounds-checked `.get` + load is a
        // single computed-address load with no `br_table`, which codegens
        // correctly.
        let stats: [&AtomicU64; 11] = [
            &FRAMES_COMMITTED,
            &FRAMES_REPLAYED,
            &REFERENCES_RECONSTRUCTED,
            &EXTERNREFS_RESOLVED,
            &EXNREFS_RECONSTRUCTED,
            &GC_NODES_RECONSTRUCTED,
            &STATIC_ROOTS_PUBLISHED,
            &DRIVE_STEPS_EXECUTED,
            &REFERENCE_FEED_READS,
            &REFERENCE_GRAPHS_DECODED,
            &EXTERNREF_HANDLES_SCANNED,
        ];
        match stats.get(field as usize) {
            Some(counter) => counter.load(Ordering::Relaxed) as i64,
            None => -1,
        }
    }

    /// The sticky errno of the most recent export call (0 == success).
    #[unsafe(no_mangle)]
    pub extern "C" fn fm_last_errno() -> i32 {
        LAST_ERRNO.load(Ordering::Relaxed)
    }

}
