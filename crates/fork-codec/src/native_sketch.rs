//! Native-Wasmtime backend SKETCH for [`ForkHostCapabilities`] (Phase 6 D6).
//!
//! This module is a DESIGN ARTIFACT, not a working backend. It is gated behind
//! the `native-sketch` feature and adds NO `wasmtime` dependency: every method
//! body is a panic-free `Err(Errno::ENOSYS)` stub, and every `wasmtime` type is
//! named only in the doc comments. Its purpose is to record, concretely and
//! per-method, how the engine-floor collapses when the fork core runs as NATIVE
//! code over a real `wasmtime::Store` instead of a co-resident Wasm module whose
//! host imports are JS. Type-checking it (`cargo build -p fork-codec --features
//! native-sketch`) proves the trait is genuinely native-shaped.
//!
//! # What collapses vs the Wasm backend
//!
//! In `crates/fork-module` (backend 1) the module cannot hold a reference at
//! all, so EVERY reference is an opaque `u32` ordinal into a host-owned side
//! table, and the GC transit uses a `(ref null any)` table constructed by a
//! fixed Wasm provider because WebKit's `WebAssembly.Table` constructor rejects
//! `element: "anyref"`. Natively, none of that ceremony is needed:
//!
//!   * The backend holds `wasmtime::Rooted<ExternRef>` / `AnyRef` / `Func` /
//!     `Tag` / `Instance` DIRECTLY in its own `HashMap<u32, _>`. The `u32` is
//!     still the seam the portable core speaks, but it maps to a live rooted
//!     value with no cross-module indirection and no JS boundary.
//!   * `HostGeneration` maps to a `wasmtime::RootScope` (or an owned
//!     `GcRootIndex` set) inside the `Store`. `release_generation` drops the
//!     scope, and Wasmtime's GC reclaims every root at once — no `table.fill`
//!     dance, no per-slot null-out.
//!   * The anyref transit table DISAPPEARS: there is no need to stage a value in
//!     an engine table to hand it back to guest codec, because native code
//!     passes `Rooted<AnyRef>` straight into the child `Instance`'s typed
//!     builders. `transit_publish` / `transit_read` degenerate to inserting into
//!     / reading from the generation's root map (kept only so the SAME trait
//!     drives both backends; the R1/R2 rooting-order hazard is handled by the
//!     `RootScope` lifetime, not by manual publish-before-fill discipline).
//!
//! # Per-method Wasmtime mapping
//!
//! | Trait method | Wasmtime mapping |
//! |---|---|
//! | `begin_generation` | open a `RootScope<&mut Store>` (or allocate a `GcRootIndex` set); the returned `u32` keys it in `self.generations` |
//! | `resolve_externref` | look the durable value up by broker handle, `ExternRef::new(&mut store, value)` (or re-root an existing `Rooted<ExternRef>`), store it in the generation's root map |
//! | `transit_publish` | insert `Rooted<AnyRef>` into the generation root map (NO engine transit table) |
//! | `transit_read` | read that map entry; `Rooted::rooted` liveness IS the non-null guard |
//! | `mint_exception_tag` | `Tag::new(&mut store, &TagType::new(params))` for the activation's exception layout |
//! | `provide_unwind_transport_tag` | one process-wide `Tag::new(&mut store, TagType::new([]))`, cached |
//! | `recognize_unwind_transport` | compare the caught value's `Tag` to the transport tag via `Tag::eq` (native identity), no `Exception.is` JS hop |
//! | `release_generation` | drop the `RootScope` / clear the `GcRootIndex` set; Wasmtime GC reclaims every root atomically |
//! | `instantiate_child` (lifecycle) | `Instance::new(&mut store, &module, &imports)` sharing the parent `Module` |
//! | `spawn_thread` (lifecycle) | spawn a native `std::thread` running the child's replay over its own `Store` |
//!
//! The upshot: the trait's method set is exactly the native primitive set. The
//! Wasm backend pays the opaque-ordinal + transit-table + JS-import tax to
//! express these same eight+two operations; the native backend expresses them
//! directly. Shrinking this trait shrinks the host API surface for both —
//! `resolve_funcref` / `resolve_static_root` / `install_reference_global` were
//! removed (Phase 6 item 5): the first two are wasm `table.get`/`table.set`
//! (the injected binder, not a host call) and the third is a facet of
//! `instantiate_child`'s import-object assembly (immutable imported ref globals).

use wasm_posix_shared::Errno;

use crate::host_capabilities::{
    ForkHostCapabilities, ForkLifecycleCapabilities, HostGeneration, HostInstance, HostRef,
    HostTag, HostThread,
};

/// Sketch of the native backend's owned state.
///
/// In the real backend the placeholder fields become a `wasmtime::Store<T>`
/// handle plus `HashMap<u32, Rooted<ExternRef>>` / `HashMap<u32, Tag>` /
/// `HashMap<u32, Instance>` and a per-generation `RootScope`. Here they are inert
/// counters so the module type-checks with no `wasmtime` dependency.
#[derive(Default)]
pub struct NativeForkHost {
    /// Would key the `wasmtime::Store` generations / `RootScope`s.
    _next_generation: u32,
    /// Would key `Rooted<ExternRef>` / `Rooted<AnyRef>` / `Func` handles.
    _next_ref: u32,
    /// Would key `wasmtime::Tag` handles.
    _next_tag: u32,
}

impl NativeForkHost {
    /// A sketch constructor. The real one takes an `&mut wasmtime::Store<T>` (or
    /// the `Engine` + linker to build children from).
    pub fn new() -> Self {
        Self::default()
    }
}

// SKETCH ONLY — every body is a panic-free `ENOSYS`. See the per-method mapping
// table in the module docs for the intended Wasmtime call.
impl ForkHostCapabilities for NativeForkHost {
    fn begin_generation(&mut self, _pid: u32) -> Result<HostGeneration, Errno> {
        Err(Errno::ENOSYS) // RootScope::new(&mut store)
    }

    fn resolve_externref(
        &mut self,
        _generation: HostGeneration,
        _broker_handle: u32,
    ) -> Result<HostRef, Errno> {
        Err(Errno::ENOSYS) // ExternRef::new(&mut store, value)
    }

    fn transit_publish(
        &mut self,
        _generation: HostGeneration,
        _slot: u32,
        _value: HostRef,
    ) -> Result<(), Errno> {
        Err(Errno::ENOSYS) // insert Rooted<AnyRef> into the generation root map
    }

    fn transit_read(
        &mut self,
        _generation: HostGeneration,
        _slot: u32,
    ) -> Result<HostRef, Errno> {
        Err(Errno::ENOSYS) // read that root map entry (Rooted liveness == non-null)
    }

    fn mint_exception_tag(
        &mut self,
        _generation: HostGeneration,
        _module_activation: u32,
        _layout_id: u32,
    ) -> Result<HostTag, Errno> {
        Err(Errno::ENOSYS) // Tag::new(&mut store, &TagType::new(params))
    }

    fn provide_unwind_transport_tag(&mut self) -> Result<HostTag, Errno> {
        Err(Errno::ENOSYS) // cached process-wide Tag::new(&mut store, TagType::new([]))
    }

    fn recognize_unwind_transport(
        &mut self,
        _tag: HostTag,
        _candidate: HostRef,
    ) -> Result<bool, Errno> {
        Err(Errno::ENOSYS) // Tag::eq(caught.tag(), transport)
    }

    fn release_generation(&mut self, _generation: HostGeneration) -> Result<(), Errno> {
        Err(Errno::ENOSYS) // drop the RootScope; Wasmtime GC reclaims every root
    }
}

impl ForkLifecycleCapabilities for NativeForkHost {
    fn instantiate_child(
        &mut self,
        _generation: HostGeneration,
        _module_ordinal: u32,
        _memory_base: u64,
    ) -> Result<HostInstance, Errno> {
        Err(Errno::ENOSYS) // Instance::new(&mut store, &module, &imports)
    }

    fn spawn_thread(
        &mut self,
        _instance: HostInstance,
        _entry_ordinal: u32,
    ) -> Result<HostThread, Errno> {
        Err(Errno::ENOSYS) // std::thread::spawn(move || child.replay())
    }
}
