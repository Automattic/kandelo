//! Fork runtime state values and private import/export names.

/// State machine values: must agree with the contract in
/// `docs/plans/2026-04-20-fork-instrumentation-design.md`.
pub const STATE_NORMAL: i32 = 0;

pub const STATE_UNWINDING: i32 = 1;

pub const STATE_REWINDING: i32 = 2;

pub const STATE_ABORT_UNWINDING: i32 = 3;

pub const ABORT_SELECTOR_SIZE: u32 = 16;

/// Names for the runtime globals and exported control functions.
/// Centralized so the rest of the crate doesn't hardcode spellings.
pub mod names {
    pub const GLOBAL_STATE: &str = "_wpk_fork_state";
    pub const GLOBAL_BUF: &str = "_wpk_fork_buf";
    pub const GLOBAL_CALL_INDEX: &str = "_wpk_fork_call_index";
    pub const GLOBAL_FRAME: &str = "_wpk_fork_frame";

    pub const EXPORT_UNWIND_BEGIN: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_UNWIND_BEGIN;
    pub const EXPORT_UNWIND_END: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_UNWIND_END;
    pub const EXPORT_REWIND_BEGIN: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_REWIND_BEGIN;
    pub const EXPORT_REWIND_END: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_REWIND_END;
    pub const EXPORT_ABORT_BEGIN: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_ABORT_BEGIN;
    pub const EXPORT_ABORT_END: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_ABORT_END;
    pub const EXPORT_STATE: &str = wasm_posix_program_abi::abi::WPK_FORK_EXPORT_STATE;

    pub const IMPORT_FRAME_RESERVE: &str = wasm_posix_program_abi::abi::WPK_FORK_FRAME_IMPORT_RESERVE;
    pub const IMPORT_FRAME_COMMIT: &str = wasm_posix_program_abi::abi::WPK_FORK_FRAME_IMPORT_COMMIT;
    pub const IMPORT_FRAME_NEXT: &str = wasm_posix_program_abi::abi::WPK_FORK_FRAME_IMPORT_NEXT;
    pub const IMPORT_FRAME_PEEK: &str = wasm_posix_program_abi::abi::WPK_FORK_FRAME_IMPORT_PEEK;
    pub const IMPORT_RESUME_PEEK: &str = wasm_posix_program_abi::abi::WPK_FORK_RESUME_IMPORT_PEEK;
    pub const IMPORT_RESUME_TABLE: &str = wasm_posix_program_abi::abi::WPK_FORK_RESUME_IMPORT_TABLE;
    pub const IMPORT_REFERENCE_VECTOR_BEGIN: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN;
    pub const IMPORT_REFERENCE_VECTOR_APPEND: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND;
    pub const IMPORT_REFERENCE_VECTOR_FINISH: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH;
    pub const IMPORT_REFERENCE_VECTOR_GET: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_GET;

    /// Process-owned zero-payload tag used only to transport the internal
    /// unwind across arbitrary Wasm result types.
    pub const IMPORT_UNWIND_TAG_MODULE: &str = "env";
    pub const IMPORT_UNWIND_TAG: &str = "__wpk_fork_unwind";

    /// Activation-owned reference recipe codecs. Encoders return a numeric
    /// recipe ID that can be stored in linear memory; decoders resolve that ID
    /// against the fresh child's reconstruction arena.
    pub const IMPORT_REFERENCE_CODEC_MODULE: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE;
    pub const IMPORT_REF_ENCODE_FUNCREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF;
    pub const IMPORT_REF_DECODE_FUNCREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF;
    pub const IMPORT_REF_ENCODE_EXTERNREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF;
    pub const IMPORT_REF_DECODE_EXTERNREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF;
    pub const IMPORT_REF_ENCODE_EXNREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_EXNREF;
    pub const IMPORT_REF_DECODE_EXNREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_EXNREF;
    pub const IMPORT_REF_ENCODE_ANYREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_ANYREF;
    pub const IMPORT_REF_DECODE_ANYREF: &str =
        wasm_posix_program_abi::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_ANYREF;
}
