//! The single authority for reading a WebAssembly artifact and judging it
//! against the ABI epoch.
//!
//! # Why this crate exists
//!
//! Before it, the same question — *may this artifact run under this kernel?* —
//! had three independent answers in this repository:
//!
//! 1. `host/src/constants.ts`, a hand-rolled 3,031-line WebAssembly binary
//!    reader plus the complete fork-artifact contract, running in JavaScript on
//!    **every `exec`**;
//! 2. `tools/xtask/src/build_deps.rs`, a native partial re-implementation used
//!    at build and publish time;
//! 3. `crates/fork-instrument/src/contract_inventory.rs`, a wasmparser-based
//!    counter used by the instrumenter's own guards.
//!
//! Three readers of one format drift, and they had: the TypeScript validated
//! descriptor bytes the other two never looked at, while the native pair
//! checked memory pointer-width agreement the TypeScript reached only through a
//! different path. An artifact could therefore pass the gate that ran and fail
//! the one that did not.
//!
//! This crate is `no_std + alloc`, so the *same* judgement is available to the
//! wasm32 kernel, to `host-native`, and to the build tooling.
//!
//! # What it does not do
//!
//! It never re-decodes a `wpk_fork` descriptor byte format. Each of those has
//! exactly one decoder, in `fork-codec`, cross-checked against a committed
//! fixture emitted by the real instrumenter. This crate walks the container,
//! hands each descriptor payload to its owner, and adds only the *cross-module*
//! invariants — the ones that join a descriptor record to a module import,
//! export or memory, and which a descriptor decoder cannot see on its own.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]

extern crate alloc;

pub mod facts;
pub mod fork_contract;
pub mod policy;

pub use facts::{
    detect_pointer_width, is_wasm_module, read_artifact_facts, read_custom_section, read_heap_base,
    read_i32_const_export, ArtifactFacts, FactsError, Signature, ValueType,
};
pub use policy::{describe_artifact_policy_failures, ArtifactPolicy};

/// The custom section carrying the 32-byte ABI-contract digest.
///
/// The digest binds `hash(abi/snapshot.json + ABI_VERSION)`, so a guest built
/// against a different snapshot is caught even when the ABI *number* matches.
pub const ABI_CONTRACT_SECTION: &str = "kandelo.abi.contract";

/// The custom section carrying the 32-byte content-addressed build key a
/// locally-built artifact was produced under.
///
/// Sibling of [`ABI_CONTRACT_SECTION`]: the local-build engine appends both at
/// cache-store time (`tools/xtask/src/build_stamp.rs`), and
/// `cargo xtask verify-fresh` compares this one against the key the current
/// source tree resolves to, so a stale mirror fails loud independently of the
/// ABI version.
///
/// It is declared HERE, beside its sibling, because three realms read it and a
/// section name spelled separately in each of them is the drift this crate
/// exists to stop. An artifact that carries NEITHER stamp was staged by hand
/// rather than built by the engine -- a different fact from being stale, and
/// one a reader has to be told apart from it.
pub const BUILD_KEY_SECTION: &str = "kandelo.build.key";

/// Read an artifact's declared ABI epoch, or `None` when it predates the
/// `__abi_version` marker rollout.
pub fn read_abi_version(bytes: &[u8]) -> Option<i32> {
    facts::read_i32_const_export(bytes, "__abi_version")
}

/// Read an artifact's declared pthread slot count, or `None` when it predates
/// the declaration and should take the host default.
pub fn read_thread_slot_declaration(bytes: &[u8]) -> Option<i32> {
    facts::read_i32_const_export(
        bytes,
        wasm_posix_shared::process_memory::THREAD_SLOT_DECL_EXPORT,
    )
}
