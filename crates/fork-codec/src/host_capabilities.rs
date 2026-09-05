//! The engine-floor seam: `ForkHostCapabilities` (Phase 6 D6, ADDITIVE).
//!
//! # What this is
//!
//! The fork continuation logic already lives in this portable `no_std`
//! `fork-codec` crate: the wire decoders, the linked-frame writer, the replay
//! journal, and the rewind driver. All of that is pure `&[u8] -> struct` /
//! integer arithmetic — it needs no host reference identity.
//!
//! The parts Wasm genuinely CANNOT do have shrunk to a sharply bounded set as
//! each has been pushed into the injected binder (which, unlike this `no_std`
//! Rust core, CAN hold a reference value). What REMAINS on this trait:
//!
//!   * mint / recognize a `WebAssembly.Tag` (for an activation's exceptions and
//!     for the process-owned fork unwind transport).
//!
//! What was REMOVED (now injected wasm, see the removal NOTEs on the trait):
//!
//!   * resolve a `funcref` / static-root identity out of an engine
//!     `WebAssembly.Table` (item 5: a wasm `table.get`),
//!   * install a reference value into a reference-typed instance global (item 5:
//!     a facet of child instantiation),
//!   * hold / root a live `externref`, publish it into the Wasm-GC anyref
//!     transit `(ref null any)` table, read it back to verify non-null, and
//!     begin / release the per-fork host root generation (M2: the injected
//!     `__wpk_fork_ref_decode_externref` import + a `DRIVE_OP_EXTERNREF_TRANSIT`
//!     drive step; the single residual host externref import returns an
//!     `externref`, not a `u32` ordinal — M2 Task 4).
//!
//! Today those live behind JavaScript closures on the host
//! (`host/src/fork-reference-broker.ts`, `host/src/fork-anyref-transit.ts`,
//! `host/src/fork-unwind-transport.ts`,
//! `host/src/fork-worker-import-exceptions.ts`). This trait makes that floor a
//! SMALL TYPED RUST SEAM so the SAME portable core has two backends:
//!
//!   1. a Wasm-import-backed impl for the browser / Node process workers
//!      (`crates/fork-module`; the import bodies are JS — the ugly-but-necessary
//!      path), and
//!   2. a future NATIVE Wasmtime impl (`native_sketch`) that calls
//!      `ExternRef::new` / `Rooted<ExternRef>` / `Tag` / `Instance::new` /
//!      native threads directly — the clean path, where the co-resident-module
//!      ceremony, the opaque-ordinal indirection, and the WebKit anyref-transit
//!      workaround all collapse.
//!
//! The trait IS the minimal host API surface we want to shrink and port.
//!
//! # The opaque-handle model (why every reference is a `u32`, never a value)
//!
//! No method takes or returns a real reference value. Every host-owned
//! reference is addressed by an OPAQUE `u32` newtype:
//!
//!   * [`HostRef`]   — one reconstructed reference value (externref, funcref,
//!     static-root, GC struct/array, or exnref) rooted in a host-owned table,
//!   * [`HostTag`]   — a host-owned `WebAssembly.Tag`,
//!   * [`HostGeneration`] — one exact process-image execution lifetime (the
//!     scope that owns all of the above and is released atomically),
//!   * [`HostInstance`] / [`HostThread`] — a child instance / worker (lifecycle;
//!     see [`ForkLifecycleCapabilities`]).
//!
//! WHY a handle and not the value: the Wasm module (backend 1) LITERALLY cannot
//! hold an `externref` / `funcref` / `anyref` / `exnref` / `Tag` / `Instance` —
//! Wasm has no linear-memory representation for a reference; it can only pass an
//! `i32`. So the host keeps the real identity in a side table and hands the
//! module an ordinal into it. The native backend (backend 2) keeps its own
//! cheap `handle -> Rooted<ExternRef>` (or `Tag` / `Instance`) map — the SAME
//! `u32` seam, no indirection tax. `0` is the reserved "none / null" ordinal;
//! the resolve methods never return it (they resolve a concrete identity), so a
//! `0` return from a Wasm import is unambiguously an error.
//!
//! # Capture vs replay
//!
//! Every method here is a REPLAY-phase operation (reconstructing the child's
//! references) EXCEPT [`ForkHostCapabilities::provide_unwind_transport_tag`],
//! which is process-lifetime (the transport tag is minted once per worker and
//! used during both capture-unwind and replay). The CAPTURE of externref
//! identity is NOT the module's job: live host-import adapters register values
//! into the broker as they are minted during ordinary execution, long before a
//! fork, and the reference recipe carries the resulting `u32` broker handle. So
//! no live reference ever has to cross INTO the module — the recipe is integers,
//! and these callbacks re-establish host identity from those integers during
//! replay. Each is called ONCE PER VALUE (not per frame).
//!
//! # Contract
//!
//! `no_std`, panic-free. Every method returns `Result<_, Errno>` and reports a
//! truthful failure (`EINVAL` for a stale/unknown generation or handle,
//! `ENOSYS` for a not-yet-implemented slice, etc.) rather than a guessed value.

use wasm_posix_shared::Errno;

/// An opaque ordinal for one host-rooted reference value (externref, funcref,
/// static-root, GC struct/array, or exnref). Never the value itself. `0` is the
/// reserved "none / null" ordinal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct HostRef(pub u32);

/// An opaque ordinal for a host-owned `WebAssembly.Tag` (an activation's
/// exception tag, or the process-owned fork unwind transport tag).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct HostTag(pub u32);

/// An opaque ordinal for one exact process-image execution lifetime — the scope
/// that owns every [`HostRef`]/[`HostTag`] minted for a fork and is released
/// atomically. Mirrors `ForkExternrefGeneration` in
/// `host/src/fork-reference-broker.ts`: a PID survives `exec`, so it is not
/// sufficient authority; a fresh generation is minted per execution image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct HostGeneration(pub u32);

/// An opaque ordinal for a child Wasm instance (see
/// [`ForkLifecycleCapabilities`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct HostInstance(pub u32);

/// An opaque ordinal for a spawned child worker / native thread (see
/// [`ForkLifecycleCapabilities`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct HostThread(pub u32);

/// The engine-floor: the irreducible host primitives the portable fork core
/// cannot perform itself, expressed as an opaque-handle seam.
///
/// See the module documentation for the handle model and the capture-vs-replay
/// split. Backend 1 is `crates/fork-module`'s `WpkForkHost` (Wasm imports whose
/// bodies are JS); backend 2 is [`native_sketch`](crate::native_sketch) (direct
/// Wasmtime calls). The reference-reconstruction methods here are called ONCE
/// PER VALUE during replay; the lifecycle methods (instantiate a child, spawn a
/// thread) are a DIFFERENT phase, a DIFFERENT caller (the kernel worker, not the
/// process worker), and a DIFFERENT frequency (once per fork), so they live in
/// the sibling [`ForkLifecycleCapabilities`] trait a host may implement
/// independently.
pub trait ForkHostCapabilities {
    // NOTE (Phase 6 item 5 — minimize host surface): `resolve_funcref`,
    // `resolve_static_root`, and `install_reference_global` were REMOVED from
    // this trait. None is an engine-floor host capability, and the production
    // drive (`ReferenceReplayDriver::drive_reconstruction`) never called them:
    //  - funcref resolution is a wasm `table.get` done by the injected guest
    //    export `__wpk_fork_ref_decode_funcref` (the binder), not a host call.
    //  - static-root resolution is likewise `table.get` on the guest's
    //    static-root catalog + `table.set` into the anyref transit — both wasm
    //    (binder-expressible). Until a binder drives it, static-root graphs stay
    //    on the JS reference path (never admitted to the module).
    //  - reference-global install happens at child INSTANTIATION (an immutable
    //    imported ref global is fixed from the import object; there is no
    //    `global.set` hook), so it is a facet of `instantiate_child`, not a
    //    separate capability.
    //
    // NOTE (M2 — minimize host surface): `begin_generation`, `resolve_externref`,
    // `transit_publish`, `transit_read`, and `release_generation` were REMOVED
    // from this trait, mirroring item 5. The externref seam existed ONLY because
    // this `no_std` Rust core cannot HOLD an `externref`, so it addressed every
    // externref by an opaque `u32` ordinal and drove a host `resolve -> publish
    // -> read-back` round trip. Injected wasm CAN hold an `externref`, so — like
    // item 3c moved GC struct/array reconstruction into `fm_drive_execute` — that
    // work moves into the module and the host calls disappear:
    //  - externref decode is the injected guest import
    //    `__wpk_fork_ref_decode_externref`, whose bound body resolves the handle
    //    directly (the single residual host externref import returns an
    //    `externref`, not a `u32` ordinal — see M2 Task 4), so no ordinal seam.
    //  - transit publish + the R1 read-back become a
    //    `DRIVE_OP_EXTERNREF_TRANSIT` drive step: `table.set(anyref_transit,
    //    recipe + 1, any.convert_extern(resolve))` + a `ref.is_null` non-null
    //    check, all wasm (binder-expressible).
    //  - the per-fork host generation (begin/release) and its side-map of rooted
    //    ordinals are no longer needed: identity is guaranteed at the source by
    //    the host token cache's idempotent `materialize`, and the transit slots
    //    are cleared with the module's own `table.fill(null)`.
    // Removing them shrinks the host contract every host (Node/browser/native)
    // must implement — the campaign's north star.

    /// Mint (or resolve) the `WebAssembly.Tag` for `module_activation`'s
    /// exception `layout_id`, returning an opaque [`HostTag`] the module routes
    /// to the guest codec's `throw`/`exn_throw_slot`.
    ///
    /// WHY Wasm can't: `WebAssembly.Tag` is Store-local host state; a module
    /// cannot construct a `Tag`, only refer to one. Backs the exception tag mint
    /// in `fork-worker-import-exceptions.ts` (the D6 plan's `host_mint_tag`).
    ///
    /// STAYS INERT on the Wasm/exnref path (D6.3a). A program exception tag is
    /// GUEST-MODULE-LOCAL, so the guest export `__wpk_fork_exception_materialize`
    /// throws/`catch_ref`s against its own tag; the co-resident module neither
    /// mints a tag nor throws, so it NEVER calls this during an exnref drive.
    /// This method exists for the NATIVE backend (`native_sketch`), where the
    /// host owns tag identity via `Tag::new`. When it becomes live in the Wasm
    /// backend it would be called once per distinct exception tag before
    /// materializing any exnref that uses it.
    fn mint_exception_tag(
        &mut self,
        generation: HostGeneration,
        module_activation: u32,
        layout_id: u32,
    ) -> Result<HostTag, Errno>;

    /// Provide the single process-owned fork unwind-transport `WebAssembly.Tag`.
    ///
    /// WHY Wasm can't: minting a `Tag` is host-only. This tag is process-owned
    /// and shared by the main instance and every co-resident side module in the
    /// worker; instrumented catch-all clauses rethrow it while each activation
    /// commits its frame. Backs `createForkUnwindTag`
    /// (`host/src/fork-unwind-transport.ts`).
    ///
    /// When: worker lifetime (both capture-unwind and replay). Idempotent: the
    /// same [`HostTag`] is returned for the life of the worker.
    fn provide_unwind_transport_tag(&mut self) -> Result<HostTag, Errno>;

    /// Recognize whether the caught value `candidate` is an exception carrying
    /// the fork unwind-transport `tag`.
    ///
    /// WHY Wasm can't: `WebAssembly.Exception.is(tag)` is a host identity check
    /// over an opaque exception object the module cannot inspect. Backs
    /// `isForkUnwindException` (`host/src/fork-unwind-transport.ts`).
    ///
    /// When: distinguishing the transport from a genuine program exception
    /// during unwind/abort. STAYS INERT through D6.3a: admitting exnref forks
    /// (D6.3a) needs no new engine-floor callback, and this identity check is an
    /// unwind/exec-catch concern, not part of the exnref reference drive. In
    /// today's JS floor the check runs INLINE at the guest/worker-entry catch
    /// site; the module-facing form addresses the caught value by ordinal, which
    /// requires the host to have first bound the caught exception to a
    /// [`HostRef`]. The signature is the intended shape; the caller wiring is
    /// deferred to the later unwind/exec slice (it does NOT land with D6.3a).
    fn recognize_unwind_transport(
        &mut self,
        tag: HostTag,
        candidate: HostRef,
    ) -> Result<bool, Errno>;
}

/// The fork LIFECYCLE floor: instantiate a child Wasm instance and launch the
/// child worker / thread that runs its replay.
///
/// This is a SIBLING trait, not part of [`ForkHostCapabilities`], because it is
/// a different seam in every dimension that matters for the backends:
///
///   * FREQUENCY: once per fork, not once per value.
///   * PHASE: after the child address space exists, not during reference
///     reconstruction.
///   * CALLER: the KERNEL worker (`kernel-worker.ts` `handleFork` / `onFork`),
///     not the process worker that owns the broker / transit / tags.
///   * HOST OBJECT: `WebAssembly.Module` / `Instance` and `Worker` / thread, not
///     the reference-identity tables.
///
/// Splitting them lets a host implement the reference floor without the spawn
/// floor (and vice versa), and keeps each backend impl cohesive. Both methods
/// are `TODO(D7)`: the signatures are the intended shape; the child-instance and
/// worker-launch wiring is a later slice.
pub trait ForkLifecycleCapabilities {
    /// Instantiate a fresh child Wasm instance for `generation`, sharing the
    /// parent's compiled module (`module_ordinal`, an opaque host-table ordinal
    /// for a `WebAssembly.Module`) placed at `memory_base` in the child address
    /// space, and return an opaque [`HostInstance`].
    ///
    /// WHY Wasm can't: `WebAssembly.Instance` / `Module` construction is
    /// host-only. Backs the compile/instantiate floor in `worker-main.ts` +
    /// `dylink.ts`.
    ///
    /// TODO(D7): descriptor is intentionally opaque-ordinal-only for now; the
    /// full placement descriptor (import object, table/memory bases) lands with
    /// the child-instance slice.
    fn instantiate_child(
        &mut self,
        generation: HostGeneration,
        module_ordinal: u32,
        memory_base: u64,
    ) -> Result<HostInstance, Errno>;

    /// Launch the child process worker / native thread that runs `instance`'s
    /// replay, entering at `entry_ordinal`, and return an opaque [`HostThread`].
    ///
    /// WHY Wasm can't: worker / thread creation is host-only. Backs
    /// `kernel-worker.ts` `handleFork` / `onFork` (the KERNEL worker only).
    ///
    /// TODO(D7): entry descriptor is opaque-ordinal-only for now.
    fn spawn_thread(
        &mut self,
        instance: HostInstance,
        entry_ordinal: u32,
    ) -> Result<HostThread, Errno>;
}

// ---------------------------------------------------------------------------
// Test/mock backend. Since M2 the externref / anyref-transit / per-fork
// generation seam is GONE (it moved into injected wasm), so the fake now backs
// only the residual tag primitives: minting a per-activation exception tag and
// providing / recognizing the process-owned unwind transport tag. It owns the
// small `u32` tag table the Wasm module cannot, exactly as the native backend
// will own its `handle -> Tag` map. Compiled only for host `cargo test`.
// ---------------------------------------------------------------------------
#[cfg(test)]
pub mod mock {
    use super::*;

    /// A minimal [`ForkHostCapabilities`] fake for tests, backing the residual
    /// tag primitives (exception tag mint + unwind transport tag).
    #[derive(Default)]
    pub struct MockForkHost {
        /// Monotonic id source for minted exception tags.
        next_tag: u32,
        /// The process-lifetime unwind transport tag, once provided.
        unwind_tag: Option<u32>,
    }

    impl MockForkHost {
        pub fn new() -> Self {
            Self::default()
        }
    }

    impl ForkHostCapabilities for MockForkHost {
        fn mint_exception_tag(
            &mut self,
            _generation: HostGeneration,
            _module_activation: u32,
            _layout_id: u32,
        ) -> Result<HostTag, Errno> {
            self.next_tag = self.next_tag.checked_add(1).ok_or(Errno::ENOSPC)?;
            Ok(HostTag(self.next_tag))
        }

        fn provide_unwind_transport_tag(&mut self) -> Result<HostTag, Errno> {
            // Process-lifetime + idempotent: the same tag for the worker's life.
            let id = *self.unwind_tag.get_or_insert(0xffff_ffff);
            Ok(HostTag(id))
        }

        fn recognize_unwind_transport(
            &mut self,
            tag: HostTag,
            _candidate: HostRef,
        ) -> Result<bool, Errno> {
            match self.unwind_tag {
                Some(t) => Ok(t == tag.0),
                None => Err(Errno::EINVAL), // transport tag never provided
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mock::MockForkHost;
    use super::*;

    // NOTE (M2): the externref mint -> transit publish -> read-back -> release
    // cycle test was REMOVED with those trait methods (they moved into injected
    // wasm; end-to-end externref identity is validated at the wasm level in M2
    // Tasks 3/6, and the transit-step PLAN emission in the `reference_replay` /
    // `drive_plan` unit tests). What remains here is the residual tag seam.

    #[test]
    fn unwind_transport_tag_is_stable_and_recognized() {
        let mut host = MockForkHost::new();
        let tag = host
            .provide_unwind_transport_tag()
            .expect("provide transport tag");
        let again = host
            .provide_unwind_transport_tag()
            .expect("provide transport tag again");
        assert_eq!(tag, again, "the transport tag is process-lifetime stable");
        assert_eq!(host.recognize_unwind_transport(tag, HostRef(0)), Ok(true));
        assert_eq!(
            host.recognize_unwind_transport(HostTag(1234), HostRef(0)),
            Ok(false)
        );
    }
}
