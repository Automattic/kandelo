//! Engine-agnostic POSIX runtime for Kandelo.
//!
//! This crate holds every POSIX subsystem module and the `HostIO` capability
//! trait (re-exported as `HostCapabilities`). `crates/kernel` is the thin Wasm
//! FFI shell that depends on this crate; `crates/host-native` (a later phase)
//! will depend on it directly.
//!
//! Phase 1 scaffold: the modules are moved in in the following task.
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]

extern crate alloc;
extern crate wasm_posix_shared;
