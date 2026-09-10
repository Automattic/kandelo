//! `crates/dylink` — the dynamic linker, as a pure planner.
//!
//! # What this crate is
//!
//! `host/src/dylink.ts` (4,188 lines) plus `host/src/dylink-fork-archive.ts`
//! (2,152) are a complete `ld.so` written in TypeScript. `crates/host-native`
//! defines none of the six `env.__wasm_dl*` guest imports, so they fall to
//! `Linker::define_unknown_imports_as_traps` and **a native guest that calls
//! `dlopen()` traps**. Moving the linker to Rust therefore *gains* a
//! capability rather than relocating one — that is K5's V1 prize.
//!
//! This crate is the deterministic half: `dylink.0` parsing, placement
//! arithmetic, symbol scope and interposition, the GOT plan, the dependency
//! graph, the element-segment→table-index map, handle allocation, and the
//! staged `dlopen` state machine. It has **no wasm host, no engine objects and
//! no JavaScript assumptions**, so it is unit-testable with plain
//! `cargo test`.
//!
//! # The shape, and why it is not a co-resident wasm module
//!
//! K10 put the WASI shim in a co-resident PIC module. That precedent does NOT
//! transfer, and the reason is decisive: **every act a WASI call performs is a
//! syscall on the channel, which wasm can do unaided; every act the linker
//! performs is a JS-API object construction, which wasm fundamentally
//! cannot.** A co-resident `dylink-module` could do `table.grow`/`get`/`set`
//! and `memory.grow` natively, but not `new Module`, `new Instance`,
//! `new Global`, `Global.value`, `new Tag`, or import-object construction.
//! Those would have to become *imports* of the dylink module — host surface
//! growth wearing a Rust disguise, and a V4 regression.
//!
//! So the planner emits [`act::LinkAct`] values and consumes
//! [`act::ActResult`] answers. Three thin executors realize them: browser,
//! Node, and `wasmtime`. All eight act kinds have a wasmtime 48 equivalent
//! (`Tag::new` is already used in `crates/host-native`), and all eight collapse
//! into ONE typed executor a new host implements once.
//!
//! # The ordered-binding invariant
//!
//! `wasm-ld` can emit two import entries with the same `(module, name)`, and
//! the engine resolves imports in declaration order. `dylink.ts` depends on
//! this through a stateful counting `Proxy` (`:1793-1888`). Here the ordering
//! is explicit data: [`act::LinkAct::Instantiate`] carries
//! `Vec<`[`act::ImportBinding`]`>`, one entry per declaration, in order. That
//! is exactly `wasmtime::Instance::new`'s positional `&[Extern]` slice, and it
//! is what a ~25-line counting `Proxy` consumes on the JS side. See
//! [`act`]'s module documentation.
//!
//! # Relationship to `fork-codec`
//!
//! `crates/fork-codec/src/dylink_archive.rs` — 1,318 lines, decoder-complete,
//! ported from `dylink-fork-archive.ts` — had **zero callers**, the same shape
//! `sffs.rs` was in before K1. This crate consumes its
//! [`fork_codec::dylink_archive::DylinkModule`],
//! `DylinkAllocation`, `DylinkTransaction` and `DylinkInitializationStage`
//! records directly as its replay input rather than declaring a second set of
//! the same types. It is now wired.
//!
//! # Generic correctness (value plan §1, BINDING)
//!
//! PHP is the only artifact in this tree that performs a runtime `dlopen`.
//! That bounds what can be regression-tested; it does not bound the design.
//! `dlopen`/`dlsym`/`dlclose`/`dlerror` are POSIX interfaces and this planner
//! implements them for paths no in-repo artifact exercises. Two places where
//! that mattered are documented at the point of decision: the D4 adjudication
//! of the unresolved-symbol value ([`got`]), decided on ELF and `RTLD_LAZY`
//! semantics rather than on which symbols PHP leaves unresolved; and the
//! function→table-index map ([`scope`]), whose structure is keyed on the
//! identity wasm itself assigns rather than tuned to one library's symbol
//! profile.
//!
//! # Scope of this increment
//!
//! The planner and its tests. The three executors and native `dlopen` follow.
//! Nothing in the host runtime calls this crate yet; `host/src/dylink.ts` still
//! drives every load on every host.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod act;
pub mod error;
pub mod got;
pub mod handles;
pub mod metadata;
pub mod placement;
pub mod plan;
pub mod scope;
pub mod wasm;
pub mod wire;

pub use act::{
    ActResult, BindingValue, GlobalId, ImportBinding, ImportPlan, InstanceExport, InstanceId,
    LinkAct, ModuleId, ModuleSource, PointerWidth, TableValue, TagId, WasmValue,
};
pub use error::{DylinkError, DylinkResult};
pub use got::{
    decide_got_cell, refresh_shared_cells, GotCell, GotDecision, GotInit, GotPlacement, GotRequest,
    GotTable, UnresolvedPolicy,
};
pub use handles::{CloseOutcome, HandleTable, MAIN_PROGRAM_HANDLE};
pub use metadata::{parse_dylink_section, DylinkMetadata, GotKind};
pub use placement::{
    align_up, check_allocation, check_archived_allocations, check_tls, plan_memory, plan_table,
    MemoryPlacement, TablePlacement, TlsRegion,
};
pub use plan::{
    HostRequest, InitializationStage, LinkPlan, Linker, LinkerConfig, LoadRequest,
    PendingTransaction, PlanStep, ReplayInputs, StagedCall,
};
pub use scope::{
    is_fork_runtime_export, is_public_dylink_export, DataBinding, LinkerScope, LoadState,
    LoadedLibrary, ResolvedSymbol, SymbolValue, MAIN_INSTANCE,
};
pub use wire::{
    decode_act_result, decode_plan_step, encode_act_result, encode_plan_step, Reader, Writer,
};
pub use wasm::{
    custom_section, read_module_shape, require_passive_data_segments,
    without_borrowed_replay_start, ExportDecl, ExternKind, ImportDecl, ImportType, ModuleShape,
    ValType,
};
