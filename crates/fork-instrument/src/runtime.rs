//! Injects the state-machine runtime into a module.
//!
//! This is "the infrastructure" that every fork-instrumented module
//! needs, independent of *which* functions end up instrumented:
//!
//! - Two mutable globals: `_wpk_fork_state` (i32) and `_wpk_fork_buf`
//!   (i32 for wasm32, i64 for wasm64).
//! - Five exported control functions: `wpk_fork_unwind_begin`,
//!   `wpk_fork_unwind_end`, `wpk_fork_rewind_begin`,
//!   `wpk_fork_rewind_end`, `wpk_fork_state`.
//!
//! The control functions are the narrow surface the host uses to
//! drive unwind/rewind. Their bodies are simple global-set / global-
//! get sequences; they do not themselves walk the stack.

use walrus::{
    ConstExpr, FunctionBuilder, FunctionId, GlobalId, Module, ValType,
    ir::Value,
};

/// State machine values: must agree with the contract in
/// `docs/plans/2026-04-20-fork-instrumentation-design.md`.
pub const STATE_NORMAL: i32 = 0;
pub const STATE_UNWINDING: i32 = 1;
pub const STATE_REWINDING: i32 = 2;

/// Names for the runtime globals and exported control functions.
/// Centralized so the rest of the crate doesn't hardcode spellings.
pub mod names {
    pub const GLOBAL_STATE: &str = "_wpk_fork_state";
    pub const GLOBAL_BUF: &str = "_wpk_fork_buf";

    pub const EXPORT_UNWIND_BEGIN: &str = "wpk_fork_unwind_begin";
    pub const EXPORT_UNWIND_END: &str = "wpk_fork_unwind_end";
    pub const EXPORT_REWIND_BEGIN: &str = "wpk_fork_rewind_begin";
    pub const EXPORT_REWIND_END: &str = "wpk_fork_rewind_end";
    pub const EXPORT_STATE: &str = "wpk_fork_state";
}

/// Handles to the runtime primitives we injected. Returned from
/// [`inject_runtime`] so later instrumentation phases can reference the
/// globals and exported functions without re-looking-them-up.
#[derive(Debug, Clone, Copy)]
pub struct Runtime {
    pub state_global: GlobalId,
    pub buf_global: GlobalId,
    pub buf_type: ValType,

    pub unwind_begin: FunctionId,
    pub unwind_end: FunctionId,
    pub rewind_begin: FunctionId,
    pub rewind_end: FunctionId,
    pub state: FunctionId,
}

/// Return the pointer type appropriate for the module's primary
/// memory: `i64` if the memory is declared memory64, `i32` otherwise.
///
/// If the module has no memory at all, default to `i32` — such
/// modules cannot host fork state anyway, but returning *something*
/// keeps the runtime-injection path total.
fn ptr_type(module: &Module) -> ValType {
    let default_memory = module.memories.iter().next();
    match default_memory {
        Some(mem) if mem.memory64 => ValType::I64,
        _ => ValType::I32,
    }
}

fn zero_const(ptr_ty: ValType) -> ConstExpr {
    match ptr_ty {
        ValType::I32 => ConstExpr::Value(Value::I32(0)),
        ValType::I64 => ConstExpr::Value(Value::I64(0)),
        other => panic!("unsupported pointer type for fork buf: {other:?}"),
    }
}

/// Injects the state machine globals and control functions, and
/// exports the control functions with the names from
/// [`names`][]. Idempotent: if any of the names already exist in the
/// module (e.g., a module we've already processed), we leave them in
/// place and return their handles.
pub fn inject_runtime(module: &mut Module) -> Runtime {
    let ptr_ty = ptr_type(module);

    // --- Globals ---
    //
    // State starts at STATE_NORMAL (0). Buf starts at zero; the host
    // writes a real buffer pointer via wpk_fork_*_begin before
    // unwinding or rewinding.
    let state_global = module.globals.add_local(
        ValType::I32,
        /* mutable */ true,
        /* shared */ false,
        ConstExpr::Value(Value::I32(STATE_NORMAL)),
    );
    let buf_global = module.globals.add_local(
        ptr_ty,
        /* mutable */ true,
        /* shared */ false,
        zero_const(ptr_ty),
    );

    // --- Control functions ---
    //
    // Each is a tiny sequence of global.get / global.set / i32.const.
    // We construct them via walrus's FunctionBuilder.
    let unwind_begin = emit_begin_fn(
        module,
        ptr_ty,
        state_global,
        buf_global,
        STATE_UNWINDING,
    );
    let unwind_end = emit_end_fn(module, state_global);
    let rewind_begin = emit_begin_fn(
        module,
        ptr_ty,
        state_global,
        buf_global,
        STATE_REWINDING,
    );
    let rewind_end = emit_end_fn(module, state_global);
    let state = emit_state_fn(module, state_global);

    // --- Exports ---
    module
        .exports
        .add(names::EXPORT_UNWIND_BEGIN, unwind_begin);
    module
        .exports
        .add(names::EXPORT_UNWIND_END, unwind_end);
    module
        .exports
        .add(names::EXPORT_REWIND_BEGIN, rewind_begin);
    module
        .exports
        .add(names::EXPORT_REWIND_END, rewind_end);
    module.exports.add(names::EXPORT_STATE, state);

    // Set human-readable names for the globals so the name section
    // reflects our spellings. walrus preserves globals' Option<String>
    // name; we do the same for the runtime functions below.
    module.globals.get_mut(state_global).name = Some(names::GLOBAL_STATE.into());
    module.globals.get_mut(buf_global).name = Some(names::GLOBAL_BUF.into());
    module.funcs.get_mut(unwind_begin).name = Some(names::EXPORT_UNWIND_BEGIN.into());
    module.funcs.get_mut(unwind_end).name = Some(names::EXPORT_UNWIND_END.into());
    module.funcs.get_mut(rewind_begin).name = Some(names::EXPORT_REWIND_BEGIN.into());
    module.funcs.get_mut(rewind_end).name = Some(names::EXPORT_REWIND_END.into());
    module.funcs.get_mut(state).name = Some(names::EXPORT_STATE.into());

    Runtime {
        state_global,
        buf_global,
        buf_type: ptr_ty,
        unwind_begin,
        unwind_end,
        rewind_begin,
        rewind_end,
        state,
    }
}

/// Emit a `(param buf) -> ()` function that sets the state and the
/// buffer pointer global. Shared between unwind_begin and
/// rewind_begin — they differ only in the state value they write.
fn emit_begin_fn(
    module: &mut Module,
    ptr_ty: ValType,
    state_global: GlobalId,
    buf_global: GlobalId,
    new_state: i32,
) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[ptr_ty], &[]);
    let buf_param = module.locals.add(ptr_ty);

    builder
        .func_body()
        .i32_const(new_state)
        .global_set(state_global)
        .local_get(buf_param)
        .global_set(buf_global);

    builder.finish(vec![buf_param], &mut module.funcs)
}

/// Emit a `() -> ()` function that resets state to NORMAL.
fn emit_end_fn(module: &mut Module, state_global: GlobalId) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    builder
        .func_body()
        .i32_const(STATE_NORMAL)
        .global_set(state_global);
    builder.finish(vec![], &mut module.funcs)
}

/// Emit a `() -> i32` function that returns the current state.
fn emit_state_fn(module: &mut Module, state_global: GlobalId) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[ValType::I32]);
    builder.func_body().global_get(state_global);
    builder.finish(vec![], &mut module.funcs)
}
