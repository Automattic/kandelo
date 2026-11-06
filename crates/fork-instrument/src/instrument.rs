//! Continuation catalog names shared by native planning and admission.

pub const RESUME_CATALOG_EXPORT: &str = "__wpk_fork_resume_catalog";

pub const RESUME_CATALOG_SECTION: &str = "kandelo.wpk_fork.resume_catalog";

pub const RESUME_START_EXPORT: &str = "wpk_fork_resume_start";

pub const RESUME_THREAD_EXPORT: &str = "wpk_fork_resume_thread";

/// Child entry for a continuation rooted at a fork boundary (a sink).
pub const RESUME_SINK_EXPORT: &str = wasm_posix_program_abi::abi::WPK_FORK_RESUME_SINK_EXPORT;

/// Lists boundary functions: (function ordinal, sink signature index).
pub const BOUNDARIES_SECTION: &str = wasm_posix_program_abi::abi::WPK_FORK_BOUNDARIES_SECTION;
