//! Bounded building blocks for the replacement instrumenter.
//!
//! This module never builds a Walrus module. The production fork rewrite is
//! still [`crate::instrument`]; these APIs deliberately do not certify a
//! remapped module as fork-instrumented. See the migration dependency map in
//! `docs/plans/2026-10-22-streaming-fork-instrumentation.md`.

mod activation;
mod bootstrap;
mod continuation;
mod declarations;
mod definitions;
mod emit;
mod exceptions;
mod frame;
mod gc;
mod graph;
mod imports;
mod ir;
mod reference;
mod retention;
mod runtime;
mod scan;
pub mod sink;
mod state;
mod types;

pub use activation::*;
pub use bootstrap::*;
pub use continuation::*;
pub use declarations::*;
pub use definitions::*;
pub use emit::*;
pub use exceptions::*;
pub use frame::*;
pub use gc::*;
pub use graph::*;
pub use imports::*;
pub use ir::*;
pub use reference::*;
pub(crate) use retention::LexicalRetention;
pub use runtime::*;
pub use scan::*;
pub use state::*;
pub use types::*;
