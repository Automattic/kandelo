//! Bounded scanning, analysis, planning and function-local code generation.
//!
//! Module summaries retain original byte coordinates; function bodies are
//! decoded on demand and released after analysis or emission. The complete
//! orchestration and admission policy live in [`crate::native`].

mod activation;
mod bootstrap;
mod catalogs;
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
mod legacy;
mod loader;
mod memory;
mod module_state;
mod pipeline;
mod reference;
mod retention;
mod roots;
mod runtime;
mod scan;
pub mod sink;
mod state;
mod tables;
mod types;

pub use activation::*;
pub use bootstrap::*;
pub use catalogs::*;
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
pub use legacy::*;
pub use loader::*;
pub use module_state::*;
pub use pipeline::*;
pub use reference::*;
pub(crate) use retention::LexicalRetention;
pub use roots::*;
pub use runtime::*;
pub use scan::*;
pub use state::*;
pub use tables::*;
pub use types::*;
