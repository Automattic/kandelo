//! Co-resident Rust fork continuation codec (Phase 6, D1).
//!
//! This crate is the future home of the process-worker fork module: a small
//! `no_std + alloc` unit, instantiated in each process worker, that decodes the
//! `wpk_fork` wire formats and drives child-instance rewind. Phase 6 D0 decided
//! the codec is CO-RESIDENT with the guest instance (the guest calls
//! `__wpk_fork_frame_*` synchronously per frame, so a cross-worker round trip
//! per frame is infeasible); see
//! `.superpowers/sdd/2026-09-01-phase6-fork-exec/PLAN.md`.
//!
//! This first increment is ADDITIVE and VALIDATED-BUT-UNUSED: it ports the
//! foundational linked continuation-frame decoder that
//! `host/src/fork-continuation.ts` implements today. TypeScript still drives
//! every fork at runtime; nothing here is wired into the host yet. The Rust
//! decoder is cross-checked against a committed fixture emitted by the real TS
//! allocator (`crates/fork-codec/testdata/linked-frames-wasm32.bin`).
//!
//! The decoder is a pure `&[u8] -> struct`: the byte slice is the guest linear
//! memory and every stored pointer is a byte offset into it, exactly as the TS
//! controller reads `WebAssembly.Memory.buffer`. It is bounds-checked and
//! panic-free; malformed input returns `Err(Errno)`, never panics.
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod catalogs;
pub mod drive_plan;
pub mod drive_plan_hints;
pub mod dylink_archive;
pub mod exception_codec;
pub mod gc_codec;
pub mod host_capabilities;
pub mod imported_globals;
pub mod imported_tables;
pub mod linked_frames;
pub mod linked_frames_writer;
pub mod module_state;
pub mod module_state_records;
/// Documented native-Wasmtime backend SKETCH for the engine-floor seam. Gated
/// behind the `native-sketch` feature; adds NO `wasmtime` dependency (stub
/// bodies + a per-method mapping table). See `host_capabilities`.
#[cfg(feature = "native-sketch")]
pub mod native_sketch;
pub mod reference_feed;
pub mod reference_graph_builder;
pub mod reference_recipes;
pub mod reference_replay;
pub mod reference_segments;
pub mod reference_segments_writer;
pub mod reference_transaction;
pub mod replay_events;
pub mod replay_journal;
pub mod rewind_driver;

pub use catalogs::{
    decode_resume_catalog, decode_static_root_catalog, ForkResumeCatalog, ForkResumeCatalogRecord,
    StaticRootCatalog,
};
pub use dylink_archive::{
    decode_dylink_archive, DylinkAllocation, DylinkArchive, DylinkInitialization,
    DylinkInitializationStage, DylinkModule, DylinkTableFunction, DylinkTablePatch,
    DylinkTablePatchRun, DylinkTransaction,
};
pub use exception_codec::{
    decode_exception_codec, ForkExceptionCodec, ForkExceptionTagLayout,
};
pub use drive_plan_hints::{GcCodecHints, FORK_HOST_EXCEPTION_ACTIVATION_ID};
pub use gc_codec::{decode_gc_codec, GcCodec, GcFieldDescriptor, GcLayoutDescriptor};
pub use host_capabilities::{
    ForkHostCapabilities, ForkLifecycleCapabilities, HostGeneration, HostInstance, HostRef,
    HostTag, HostThread,
};
pub use imported_globals::{decode_imported_globals, ImportedGlobal, ImportedGlobals};
pub use imported_tables::{decode_imported_tables, ImportedTable, ImportedTables};
pub use linked_frames::{
    decode_linked_frames, FrameHeader, LinkedChunk, LinkedFrameFormat, LinkedFrameNode,
    LinkedFrames,
};
pub use linked_frames_writer::{ChunkAllocator, LinkedFrameWriter};
pub use module_state::{
    decode_module_state, ModuleState, ModuleStateChunk, ModuleStateFormat, ModuleStateRecord,
};
pub use module_state_records::{
    decode_data_segments, decode_element_segments, decode_module_record, decode_mutable_global,
    decode_record_payload, decode_table_descriptor, decode_table_page, record_payload_bytes,
    GlobalSnapshot, ModuleDescriptor, ModuleStateRecordPayload, SegmentBitmap, SparseTablePage,
    SparseTableRun, TableDescriptor,
};
pub use reference_feed::ReferenceReplayFeed;
pub use reference_graph_builder::{AggregateKind, GcProvenance, ReferenceGraphBuilder};
pub use reference_recipes::{
    decode_reference_recipes, ReferenceRecipeEntry, ReferenceRecipeNode, ReferenceRecipes,
};
pub use reference_replay::{FuncrefTarget, ReconstructionState, ReferenceReplayDriver};
pub use reference_segments::ReferenceTransactionRecord;
pub use reference_segments_writer::{ReferenceRecordSink, ReferenceSegmentsWriter};
pub use reference_transaction::{
    decode_segmented_reference_transaction, vector_intern_key, SegmentedReferenceTransaction,
    VectorInternIndex, VectorInternKey,
};
pub use replay_events::{
    decode_replay_events, decode_replay_events_image, encode_replay_events, ReplayEvent,
    ReplayEvents,
};
pub use replay_journal::{JournalPhase, ReplayEventJournal, ResumeSlotTable};
pub use rewind_driver::RewindDriver;
