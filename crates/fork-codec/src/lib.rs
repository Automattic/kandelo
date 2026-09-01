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

pub mod linked_frames;
pub mod module_state;
pub mod replay_events;

pub use linked_frames::{
    decode_linked_frames, FrameHeader, LinkedChunk, LinkedFrameFormat, LinkedFrameNode,
    LinkedFrames,
};
pub use module_state::{
    decode_module_state, ModuleState, ModuleStateChunk, ModuleStateFormat, ModuleStateRecord,
};
pub use replay_events::{decode_replay_events, ReplayEvent, ReplayEvents};
