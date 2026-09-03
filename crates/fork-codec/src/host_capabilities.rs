//! The engine-floor seam: `ForkHostCapabilities` (Phase 6 D6, ADDITIVE).
//!
//! # What this is
//!
//! The fork continuation logic already lives in this portable `no_std`
//! `fork-codec` crate: the wire decoders, the linked-frame writer, the replay
//! journal, and the rewind driver. All of that is pure `&[u8] -> struct` /
//! integer arithmetic — it needs no host reference identity.
//!
//! The parts Wasm genuinely CANNOT do are a small, sharply bounded set:
//!
//!   * hold / root a live `externref` (a JavaScript object or a native
//!     `Rooted<ExternRef>`) so a garbage collector cannot free it mid-replay,
//!   * resolve a `funcref` / static-root identity out of an engine
//!     `WebAssembly.Table`,
//!   * publish a reconstructed reference into the Wasm-GC anyref transit
//!     `(ref null any)` table and read it back to verify it is non-null,
//!   * mint / recognize a `WebAssembly.Tag` (for an activation's exceptions and
//!     for the process-owned fork unwind transport),
//!   * install a reference value into a reference-typed instance global,
//!   * release every host root minted for one fork generation.
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
    /// Establish a fresh host root scope for one child process image and return
    /// its opaque [`HostGeneration`].
    ///
    /// WHY Wasm can't: the generation owns host-side GC roots (a strong `Map`
    /// of externrefs, the anyref transit table, minted `Tag`s) whose lifetimes
    /// only the host can manage; the module holds only the ordinal.
    ///
    /// When: at the start of a fork's replay, before any reference is resolved.
    /// In production the host mints this at process spawn (mirroring
    /// `ForkExternrefBroker.createGeneration(pid)`) and may seed the ordinal
    /// into the module; exposing it here lets a table-owning backend (native /
    /// mock) create it directly. `pid` is the child PID (`1..=0xffff_ffff`).
    fn begin_generation(&mut self, pid: u32) -> Result<HostGeneration, Errno>;

    /// Re-root the durable host `externref` named by `broker_handle` under
    /// `generation` and return an opaque [`HostRef`] the module can publish into
    /// the transit table.
    ///
    /// WHY Wasm can't: the value is a host-owned opaque identity (a JavaScript
    /// object, or a native `Rooted<ExternRef>`); Wasm has no representation for
    /// it beyond the integer handle the recipe carries. Backs
    /// `ForkExternrefBroker.authorize` / `acquireFork` (the D6 plan's
    /// `host_decode_externref`).
    ///
    /// When: REPLAY, once per externref node. `broker_handle` is the recipe's
    /// `1..=0xffff_ffff` handle (see `reference_recipes::ReferenceRecipeNode`).
    fn resolve_externref(
        &mut self,
        generation: HostGeneration,
        broker_handle: u32,
    ) -> Result<HostRef, Errno>;

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
    // Removing them shrinks the host contract every host (Node/browser/native)
    // must implement — the campaign's north star.

    /// Publish the reconstructed reference `value` into the Wasm-GC anyref
    /// transit table at `slot` (the canonical `recipe_id + 1`), so the guest
    /// codec's `_fill` / `any.convert_extern` can consume it.
    ///
    /// WHY Wasm can't: the transit table is `(ref null any)`, which WebKit's
    /// `WebAssembly.Table` constructor refuses to build (hence the fixed Wasm
    /// provider in `fork-anyref-transit.ts`); and the module holds only an
    /// ordinal, not the `anyref`. Backs `ForkAnyrefTransitTable.set` /
    /// `ensureRecipeSlot` (the D6 plan's `host_gc_transit_publish`).
    ///
    /// When: REPLAY. ORDER IS LOAD-BEARING (rooting hazard R1/R2): the slot MUST
    /// be published BEFORE the guest `_fill` that consumes it, so the GC cannot
    /// collect the value between reconstruction and use.
    fn transit_publish(
        &mut self,
        generation: HostGeneration,
        slot: u32,
        value: HostRef,
    ) -> Result<(), Errno>;

    /// Read back the transit `slot` and verify it is non-null, returning its
    /// opaque [`HostRef`].
    ///
    /// WHY Wasm can't: reading a `(ref null any)` slot and checking it is
    /// non-null is a host table op over a value the module cannot name directly.
    /// This is the assert-non-null-before-fill guard (mirror
    /// `fork-early-reference-provider.ts:1344-1349`). Backs
    /// `ForkAnyrefTransitTable.get` (the D6 plan's `host_gc_transit_read`).
    ///
    /// When: REPLAY, immediately before driving a `_fill` that consumes `slot`.
    /// A null (unpublished) slot is a truthful `EINVAL`, never a guessed value.
    fn transit_read(
        &mut self,
        generation: HostGeneration,
        slot: u32,
    ) -> Result<HostRef, Errno>;

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

    /// Release EVERY host root minted under `generation` — drop all per-fork
    /// [`HostRef`]/[`HostTag`] handles and clear the anyref transit table
    /// (`table.fill(null)`), in REVERSE activation order.
    ///
    /// WHY Wasm can't: releasing host GC roots (broker `Map` entries, transit
    /// slots, minted `Tag`s) is host lifetime management; the module cannot free
    /// a host root, and leaving one rooted is a leak that pins a whole process
    /// image. Backs `ForkExternrefBroker.releaseGeneration` +
    /// `ForkAnyrefTransitTable.clear` (the D6 plan's `host_release_ordinals`).
    ///
    /// When: on BOTH successful fork completion AND abort. After release the
    /// generation is inactive: any further op on it is a truthful `EINVAL`.
    fn release_generation(&mut self, generation: HostGeneration) -> Result<(), Errno>;
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
// Test/mock backend — a `std` `HashMap`-backed fake that proves the seam is
// real (not speculative). Compiled only for host `cargo test` (where `std` is
// available; the crate is `no_std` only under wasm). It owns a handle table
// exactly as the native backend will own its `handle -> Rooted<ExternRef>` map,
// so a unit test can drive a full mint -> publish -> read-back -> release cycle
// through the trait and assert the bookkeeping.
// ---------------------------------------------------------------------------
#[cfg(test)]
pub mod mock {
    use super::*;
    use std::collections::HashMap;

    /// One rooted reference in the fake host table. Records enough to prove the
    /// right identity was reconstructed, standing in for the real JS object /
    /// native `Rooted<ExternRef>`.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum MockValue {
        Externref { broker_handle: u32 },
    }

    #[derive(Default)]
    struct GenState {
        refs: HashMap<u32, MockValue>,
        next_ref: u32,
        transit: HashMap<u32, u32>,
        tags: HashMap<u32, (u32, u32)>,
        next_tag: u32,
        active: bool,
    }

    /// A `HashMap`-backed [`ForkHostCapabilities`] fake for tests. Owns the host
    /// identity table the Wasm module cannot; the same `u32` seam the native
    /// backend uses.
    #[derive(Default)]
    pub struct MockForkHost {
        generations: HashMap<u32, GenState>,
        next_generation: u32,
        unwind_tag: Option<u32>,
        /// When set, `transit_read` returns a DIFFERENT ordinal than was
        /// published — an adversarial engine that lost the anyref slot's
        /// identity. Drives the R1 non-null/identity guard in
        /// `ReferenceReplayDriver::drive_reconstruction` to a truthful `EINVAL`.
        corrupt_transit: bool,
        /// Records the recipe handles passed to `resolve_externref`, in call
        /// order (test inspector: proves the module drove the seam per node).
        resolved_externref_handles: Vec<u32>,
        /// Count of `mint_exception_tag` calls (test inspector). D6.3a asserts
        /// this stays 0 across an exnref drive: the drive's Exnref arm is inert
        /// (the guest export mints/throws its own module-local tag), so the drive
        /// must never mint a tag.
        mint_exception_tag_calls: u32,
    }

    impl MockForkHost {
        pub fn new() -> Self {
            Self::default()
        }

        /// Make every `transit_read` hand back a corrupted (non-matching)
        /// ordinal, so a publish→read identity check fails (test inspector).
        pub fn corrupt_transit_reads(&mut self) {
            self.corrupt_transit = true;
        }

        /// The externref broker handles `resolve_externref` was called with, in
        /// order (test inspector: proof the drive resolved each externref node).
        pub fn resolved_externref_handles(&self) -> &[u32] {
            &self.resolved_externref_handles
        }

        /// Number of times `mint_exception_tag` was called (test inspector).
        pub fn mint_exception_tag_calls(&self) -> u32 {
            self.mint_exception_tag_calls
        }

        /// Number of live rooted references in `generation` (test inspector).
        pub fn live_ref_count(&self, generation: HostGeneration) -> usize {
            self.generations
                .get(&generation.0)
                .filter(|g| g.active)
                .map(|g| g.refs.len())
                .unwrap_or(0)
        }

        /// Number of published (non-null) transit slots (test inspector).
        pub fn transit_slot_count(&self, generation: HostGeneration) -> usize {
            self.generations
                .get(&generation.0)
                .filter(|g| g.active)
                .map(|g| g.transit.len())
                .unwrap_or(0)
        }

        /// Whether `generation` is still active (test inspector).
        pub fn is_active(&self, generation: HostGeneration) -> bool {
            self.generations
                .get(&generation.0)
                .map(|g| g.active)
                .unwrap_or(false)
        }

        fn active_gen_mut(&mut self, generation: HostGeneration) -> Result<&mut GenState, Errno> {
            match self.generations.get_mut(&generation.0) {
                Some(g) if g.active => Ok(g),
                _ => Err(Errno::EINVAL), // unknown or released generation
            }
        }

        fn mint_ref(&mut self, generation: HostGeneration, value: MockValue) -> Result<HostRef, Errno> {
            let g = self.active_gen_mut(generation)?;
            g.next_ref = g.next_ref.checked_add(1).ok_or(Errno::ENOSPC)?;
            let id = g.next_ref;
            g.refs.insert(id, value);
            Ok(HostRef(id))
        }
    }

    impl ForkHostCapabilities for MockForkHost {
        fn begin_generation(&mut self, pid: u32) -> Result<HostGeneration, Errno> {
            if pid == 0 {
                return Err(Errno::EINVAL);
            }
            self.next_generation = self.next_generation.checked_add(1).ok_or(Errno::ENOSPC)?;
            let id = self.next_generation;
            self.generations.insert(
                id,
                GenState {
                    active: true,
                    ..GenState::default()
                },
            );
            Ok(HostGeneration(id))
        }

        fn resolve_externref(
            &mut self,
            generation: HostGeneration,
            broker_handle: u32,
        ) -> Result<HostRef, Errno> {
            if broker_handle == 0 {
                return Err(Errno::EINVAL); // externref handles are 1..=0xffff_ffff
            }
            let host_ref = self.mint_ref(generation, MockValue::Externref { broker_handle })?;
            self.resolved_externref_handles.push(broker_handle);
            Ok(host_ref)
        }

        fn transit_publish(
            &mut self,
            generation: HostGeneration,
            slot: u32,
            value: HostRef,
        ) -> Result<(), Errno> {
            let g = self.active_gen_mut(generation)?;
            if !g.refs.contains_key(&value.0) {
                return Err(Errno::EINVAL); // value not rooted in this generation
            }
            g.transit.insert(slot, value.0);
            Ok(())
        }

        fn transit_read(
            &mut self,
            generation: HostGeneration,
            slot: u32,
        ) -> Result<HostRef, Errno> {
            let corrupt = self.corrupt_transit;
            let g = self.active_gen_mut(generation)?;
            // Non-null guard: an unpublished slot is a truthful EINVAL.
            let published = g.transit.get(&slot).copied().ok_or(Errno::EINVAL)?;
            // Adversarial mode: return an ordinal that is non-null but does NOT
            // match what was published, so the drive's identity assert fires.
            let value = if corrupt {
                published.wrapping_add(1).max(1)
            } else {
                published
            };
            Ok(HostRef(value))
        }

        fn mint_exception_tag(
            &mut self,
            generation: HostGeneration,
            module_activation: u32,
            layout_id: u32,
        ) -> Result<HostTag, Errno> {
            self.mint_exception_tag_calls =
                self.mint_exception_tag_calls.saturating_add(1);
            let g = self.active_gen_mut(generation)?;
            g.next_tag = g.next_tag.checked_add(1).ok_or(Errno::ENOSPC)?;
            let id = g.next_tag;
            g.tags.insert(id, (module_activation, layout_id));
            Ok(HostTag(id))
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

        fn release_generation(&mut self, generation: HostGeneration) -> Result<(), Errno> {
            let g = self.active_gen_mut(generation)?;
            // Clear the transit table (table.fill(null)) and drop every rooted
            // handle + tag, then retire the generation.
            g.transit.clear();
            g.refs.clear();
            g.tags.clear();
            g.active = false;
            Ok(())
        }
    }

    impl MockForkHost {
    }
}

#[cfg(test)]
mod tests {
    use super::mock::MockForkHost;
    use super::*;

    // A trivial reference-reconstruction sequence driven THROUGH the trait:
    // mint (resolve a durable externref) -> publish into the GC transit ->
    // read it back (the non-null guard) -> release the generation. Asserts the
    // handle bookkeeping and the generation-release lifecycle behave, proving
    // the seam is usable rather than speculative.
    #[test]
    fn reference_reconstruction_mint_publish_read_release_cycle() {
        let mut host = MockForkHost::new();
        let generation = host.begin_generation(42).expect("begin generation");
        assert!(host.is_active(generation));
        assert_eq!(host.live_ref_count(generation), 0);

        // Mint / hold: re-root the durable externref named by broker handle 7.
        let value = host
            .resolve_externref(generation, 7)
            .expect("resolve externref");
        assert_eq!(host.live_ref_count(generation), 1);

        // Publish into the GC anyref transit at the canonical recipe slot.
        host.transit_publish(generation, 1, value)
            .expect("publish into transit");
        assert_eq!(host.transit_slot_count(generation), 1);

        // Read it back — the assert-non-null-before-fill guard — and confirm it
        // is the SAME opaque ordinal (identity preserved across the seam).
        let read_back = host.transit_read(generation, 1).expect("read back slot");
        assert_eq!(read_back, value);

        // An unpublished slot is a truthful failure, never a guessed value.
        assert_eq!(host.transit_read(generation, 2), Err(Errno::EINVAL));

        // Release drops every root and clears the transit; the generation is
        // then inactive and every further op fails truthfully.
        host.release_generation(generation).expect("release generation");
        assert!(!host.is_active(generation));
        assert_eq!(host.live_ref_count(generation), 0);
        assert_eq!(host.transit_slot_count(generation), 0);
        assert_eq!(host.transit_read(generation, 1), Err(Errno::EINVAL));
        assert_eq!(
            host.resolve_externref(generation, 7),
            Err(Errno::EINVAL),
            "a released generation roots no new references"
        );
        assert_eq!(
            host.release_generation(generation),
            Err(Errno::EINVAL),
            "double release is a truthful failure"
        );
    }

    #[test]
    fn publishing_an_unrooted_handle_is_rejected() {
        let mut host = MockForkHost::new();
        let generation = host.begin_generation(1).expect("begin generation");
        // A handle never minted in this generation cannot be published: the
        // transit table must only ever root values the host actually holds.
        assert_eq!(
            host.transit_publish(generation, 1, HostRef(999)),
            Err(Errno::EINVAL)
        );
    }

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
