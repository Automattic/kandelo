//! Wasm-import-backed backend for the engine-floor seam (Phase 6 D6, ADDITIVE).
//!
//! This is backend 1 of `fork_codec::ForkHostCapabilities` (the trait doc has
//! the full design): a ZERO-COST struct whose methods call `extern "C"` imports
//! under the `wpk_fork_host` import module. Those imports' bodies are the JS
//! engine-floor the host already owns (`fork-reference-broker.ts`,
//! `fork-anyref-transit.ts`, `fork-unwind-transport.ts`,
//! `fork-worker-import-exceptions.ts`) — the ugly-but-necessary path, because a
//! Wasm module cannot hold a live `externref` / `funcref` / `anyref` / `exnref`
//! / `Tag` / `Instance`; it can only pass a `u32` ordinal into a host-owned side
//! table.
//!
//! NOT WIRED TO THE GUEST. This slice only DECLARES the imports and proves the
//! backend compiles to wasm32 (+ wasm64) and that the `wpk_fork_host` imports
//! appear in the artifact (`wasm-objdump -x`). Actually routing the guest's
//! reference reconstruction through these imports is the D6 live-integration
//! step, left for user review. The `fm_host_capabilities_probe` export exists
//! solely so `wasm-ld` retains the (otherwise unreferenced) imports; the host
//! never calls it.
//!
//! ## Import ABI convention
//!
//! * Handle-returning imports (`-> u32`) return `0` on failure; the caller then
//!   reads [`host_last_errno`] for the real [`Errno`]. A resolve never yields
//!   `0` legitimately (it resolves a concrete identity), and a null transit slot
//!   IS the error case, so `0` is unambiguously a failure sentinel.
//! * Status imports (`-> i32`) return `0` on success or a positive `errno`.
//! * `host_recognize_unwind_transport` returns `1` (yes) / `0` (no) / negative
//!   (error → read `host_last_errno`).
//!
//! These are HOST-INTERNAL imports (they fold into ABI-44 alongside the rest of
//! the co-resident module contract); they are not part of the FROZEN guest ABI.

use fork_codec::{
    ForkHostCapabilities, ForkLifecycleCapabilities, HostGeneration, HostInstance, HostRef,
    HostTag, HostThread,
};
use wasm_posix_shared::Errno;

// The engine-floor host imports. In production Node/browser workers provide
// these; the native backend replaces the whole block with direct Wasmtime calls
// (see `fork_codec::native_sketch`).
#[link(wasm_import_module = "wpk_fork_host")]
unsafe extern "C" {
    fn host_begin_generation(pid: u32) -> u32;
    fn host_resolve_externref(generation: u32, broker_handle: u32) -> u32;
    // Phase 6 item 5: host_resolve_funcref / host_resolve_static_root /
    // host_install_reference_global were removed — funcref + static-root are wasm
    // `table.get`/`table.set` (the injected binder), and ref-global install is a
    // facet of child instantiation (immutable imported ref globals). None was an
    // engine-floor host capability.
    fn host_transit_publish(generation: u32, slot: u32, value: u32) -> i32;
    fn host_transit_read(generation: u32, slot: u32) -> u32;
    fn host_mint_exception_tag(generation: u32, module_activation: u32, layout_id: u32) -> u32;
    fn host_provide_unwind_transport_tag() -> u32;
    fn host_recognize_unwind_transport(tag: u32, candidate: u32) -> i32;
    fn host_release_generation(generation: u32) -> i32;
    // Lifecycle floor (kernel-worker in production; declared here so the whole
    // engine-floor seam is expressed in one import module for this scaffold).
    fn host_instantiate_child(generation: u32, module_ordinal: u32, memory_base: u64) -> u32;
    fn host_spawn_thread(instance: u32, entry_ordinal: u32) -> u32;
    /// Sticky errno of the most recent failing `wpk_fork_host` import.
    fn host_last_errno() -> i32;
}

/// Map a host import's sticky errno to an [`Errno`], defaulting to `EINVAL` for
/// an unrecognized code so a failure is never silently dropped.
fn last_errno() -> Errno {
    let raw = unsafe { host_last_errno() };
    if raw <= 0 {
        return Errno::EINVAL;
    }
    Errno::from_u32(raw as u32).unwrap_or(Errno::EINVAL)
}

/// Translate a handle-returning import (`0` == failure).
fn handle_or_err(value: u32) -> Result<u32, Errno> {
    if value == 0 {
        Err(last_errno())
    } else {
        Ok(value)
    }
}

/// Translate a status-returning import (`0` == success, positive == errno).
fn status(rc: i32) -> Result<(), Errno> {
    if rc == 0 {
        Ok(())
    } else if rc > 0 {
        Err(Errno::from_u32(rc as u32).unwrap_or(Errno::EINVAL))
    } else {
        Err(last_errno())
    }
}

/// The zero-cost Wasm-import backend. Holds no state — the host owns every
/// reference identity; this struct just routes the seam's `u32` ordinals across
/// the import boundary.
pub struct WpkForkHost;

impl ForkHostCapabilities for WpkForkHost {
    fn begin_generation(&mut self, pid: u32) -> Result<HostGeneration, Errno> {
        handle_or_err(unsafe { host_begin_generation(pid) }).map(HostGeneration)
    }

    fn resolve_externref(
        &mut self,
        generation: HostGeneration,
        broker_handle: u32,
    ) -> Result<HostRef, Errno> {
        handle_or_err(unsafe { host_resolve_externref(generation.0, broker_handle) }).map(HostRef)
    }

    fn transit_publish(
        &mut self,
        generation: HostGeneration,
        slot: u32,
        value: HostRef,
    ) -> Result<(), Errno> {
        status(unsafe { host_transit_publish(generation.0, slot, value.0) })
    }

    fn transit_read(&mut self, generation: HostGeneration, slot: u32) -> Result<HostRef, Errno> {
        handle_or_err(unsafe { host_transit_read(generation.0, slot) }).map(HostRef)
    }

    fn mint_exception_tag(
        &mut self,
        generation: HostGeneration,
        module_activation: u32,
        layout_id: u32,
    ) -> Result<HostTag, Errno> {
        handle_or_err(unsafe { host_mint_exception_tag(generation.0, module_activation, layout_id) })
            .map(HostTag)
    }

    fn provide_unwind_transport_tag(&mut self) -> Result<HostTag, Errno> {
        handle_or_err(unsafe { host_provide_unwind_transport_tag() }).map(HostTag)
    }

    fn recognize_unwind_transport(
        &mut self,
        tag: HostTag,
        candidate: HostRef,
    ) -> Result<bool, Errno> {
        let rc = unsafe { host_recognize_unwind_transport(tag.0, candidate.0) };
        if rc < 0 {
            Err(last_errno())
        } else {
            Ok(rc != 0)
        }
    }

    fn release_generation(&mut self, generation: HostGeneration) -> Result<(), Errno> {
        status(unsafe { host_release_generation(generation.0) })
    }
}

impl ForkLifecycleCapabilities for WpkForkHost {
    fn instantiate_child(
        &mut self,
        generation: HostGeneration,
        module_ordinal: u32,
        memory_base: u64,
    ) -> Result<HostInstance, Errno> {
        handle_or_err(unsafe { host_instantiate_child(generation.0, module_ordinal, memory_base) })
            .map(HostInstance)
    }

    fn spawn_thread(
        &mut self,
        instance: HostInstance,
        entry_ordinal: u32,
    ) -> Result<HostThread, Errno> {
        handle_or_err(unsafe { host_spawn_thread(instance.0, entry_ordinal) }).map(HostThread)
    }
}

/// Retention anchor: exercise every `WpkForkHost` method once so `wasm-ld` keeps
/// the (otherwise unreferenced) `wpk_fork_host` imports in the artifact and they
/// appear under `wasm-objdump -x`. NOT wired to the guest and NEVER called by
/// the host; the arguments are opaque and the results are folded into one `i64`
/// only so the optimizer cannot elide the calls.
#[unsafe(no_mangle)]
pub extern "C" fn fm_host_capabilities_probe(seed: u32) -> i64 {
    let mut host = WpkForkHost;
    let mut acc: i64 = 0;

    let generation = match host.begin_generation(seed | 1) {
        Ok(g) => g,
        Err(e) => return -(e as i64),
    };
    acc ^= generation.0 as i64;

    if let Ok(r) = host.resolve_externref(generation, seed | 1) {
        acc ^= (r.0 as i64) << 1;
        let _ = host.transit_publish(generation, seed, r);
    }
    if let Ok(r) = host.transit_read(generation, seed) {
        acc ^= (r.0 as i64) << 4;
    }
    if let Ok(t) = host.mint_exception_tag(generation, seed, seed) {
        acc ^= (t.0 as i64) << 5;
    }
    if let Ok(t) = host.provide_unwind_transport_tag() {
        acc ^= (t.0 as i64) << 6;
        if let Ok(hit) = host.recognize_unwind_transport(t, HostRef(seed)) {
            acc ^= hit as i64;
        }
    }
    if let Ok(instance) = host.instantiate_child(generation, seed, seed as u64) {
        acc ^= (instance.0 as i64) << 7;
        if let Ok(thread) = host.spawn_thread(instance, seed) {
            acc ^= (thread.0 as i64) << 8;
        }
    }
    let _ = host.release_generation(generation);
    acc
}
