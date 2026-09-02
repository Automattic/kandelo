//! Inject the fork-module's `__wpk_fork_ref_decode_funcref` export (Phase 6
//! D6.1).
//!
//! WHY THIS TOOL EXISTS. The frozen guest import
//! `__wpk_fork_ref_decode_funcref(recipeId) -> funcref` must RETURN a real
//! `funcref`. A WebAssembly module can only produce a `funcref` by reading an
//! imported funcref `table` with `table.get` — it cannot fabricate one from an
//! integer. Rust, however, has no `funcref` type and its reference-types support
//! cannot emit a function whose result is `(ref func)` reading an imported table.
//! So the fork-module (a Rust cdylib) cannot itself export this function.
//!
//! This tool closes that gap with a single, static, hand-encoded wasm function
//! injected into the compiled fork-module via `walrus` (the same typed-wasm-IR
//! crate the fork-instrument transforms use, which preserves the module's
//! `dylink.0` PIC custom section across the round trip). The injected function
//! is pure plumbing:
//!
//! ```wat
//! (func (export "__wpk_fork_ref_decode_funcref") (param $recipe i32) (result funcref)
//!   (local $ord i32)
//!   (local.set $ord (call $fm_funcref_ordinal (local.get $recipe)))
//!   (if (result funcref) (i32.eq (local.get $ord) (i32.const -1))   ;; NULL_ORDINAL
//!     (then (ref.null func))
//!     (else (table.get $__wpk_fork_function_catalog (local.get $ord)))))
//! ```
//!
//! All the real work — decoding the reference graph, mapping a recipe id to a
//! `(activation, ordinal)`, admitting only funcref/null, trapping on corruption
//! — lives in the module's Rust `fm_funcref_ordinal` helper. This tool only adds
//! the funcref-returning wrapper Rust cannot express and the funcref table
//! import it reads.

use anyhow::{anyhow, bail, Context, Result};
use walrus::ir::{BinaryOp, Br, CallIndirect, LoadKind, Loop, MemArg, UnaryOp};
use walrus::{ExportItem, FunctionBuilder, Module, RefType, ValType};

// -- GC drive-shim injection (Phase 6 item 3b) --------------------------------
//
// The second injection this tool performs. The co-resident module cannot IMPORT
// the guest's `__wpk_fork_ref_gc_allocate`/`_gc_fill` exports (it is instantiated
// BEFORE the guest, to supply the frame-flip imports), so it drives them through
// a MUTABLE funcref table the host binds post-instantiation. Rust has no
// `call_indirect` intrinsic, so this tool injects `fm_drive_execute(plan_ptr,
// count)` — a wasm loop that strides the serialized drive PLAN
// (`fork_codec::drive_plan`), `call_indirect`s the table slot for each step, and
// `call`s the module's Rust `fm_after_alloc(recipe)` after each ALLOC step for
// the R1 transit-read assert (shim->Rust, like the funcref-decode injection).

/// The mutable funcref table the host binds guest `_gc_allocate`/`_gc_fill` into
/// and the injected `fm_drive_execute` `call_indirect`s. Imported (initial size
/// 0; the host provides a table sized to the fork's activations).
const DRIVE_TABLE_IMPORT: &str = "__wpk_fork_drive_table";
/// The injected loop export the host calls to run a serialized plan.
const DRIVE_EXECUTE_EXPORT: &str = "fm_drive_execute";
/// The Rust R1-assert helper the shim `call`s after each ALLOC step. Exported by
/// `crates/fork-module/src/lib.rs`.
const AFTER_ALLOC_EXPORT: &str = "fm_after_alloc";

// Serialized drive-step layout — MUST match `fork_codec::drive_plan`
// (`DRIVE_STEP_SIZE`, `DRIVE_STEP_OFF_*`, `DRIVE_OP_ALLOC`). Four little-endian
// u32 fields per 16-byte step.
const DRIVE_STEP_SIZE: i32 = 16;
const DRIVE_STEP_OFF_OP: u64 = 0;
const DRIVE_STEP_OFF_SLOT: u64 = 4;
const DRIVE_STEP_OFF_RECIPE: u64 = 8;
const DRIVE_STEP_OFF_ARG: u64 = 12;
const DRIVE_OP_ALLOC: i32 = 0;

/// The Rust helper the injected shim calls to map a recipe id to a catalog
/// ordinal (or the null sentinel). Exported by `crates/fork-module/src/lib.rs`.
const ORDINAL_HELPER_EXPORT: &str = "fm_funcref_ordinal";

/// The frozen guest import this tool makes the module export (see
/// `host/src/generated/abi.ts` `WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF`).
const DECODE_FUNCREF_EXPORT: &str = "__wpk_fork_ref_decode_funcref";

/// The guest's function catalog funcref table the shim reads with `table.get`.
/// Injected+exported by fork-instrument as `FUNCTION_CATALOG_EXPORT`; the host
/// supplies a matching funcref table to the fork-module import (a host-owned
/// mirror populated from the guest's catalog — identical funcref identities).
const FUNCTION_CATALOG_IMPORT: &str = "__wpk_fork_function_catalog";
const IMPORT_MODULE: &str = "env";

/// The `NULL_ORDINAL` sentinel `fm_funcref_ordinal` returns for a Null recipe;
/// must stay in sync with `crates/fork-module/src/lib.rs`.
const NULL_ORDINAL: i32 = -1;

fn inject(module: &mut Module) -> Result<()> {
    // Idempotency / sanity: never double-inject.
    if module
        .exports
        .iter()
        .any(|export| export.name == DECODE_FUNCREF_EXPORT)
    {
        bail!("module already exports {DECODE_FUNCREF_EXPORT}");
    }

    // Locate the Rust helper export the shim will call.
    let helper = module
        .exports
        .iter()
        .find(|export| export.name == ORDINAL_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {ORDINAL_HELPER_EXPORT}"))?;
    let helper_fn = match helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{ORDINAL_HELPER_EXPORT} export is not a function"),
    };

    // Import the guest's function catalog funcref table (initial size 0; the host
    // grows/populates the mirror it supplies before the shim ever reads it).
    let (catalog, _import_id) = module.add_import_table(
        IMPORT_MODULE,
        FUNCTION_CATALOG_IMPORT,
        false,
        0,
        None,
        RefType::FUNCREF,
    );

    // Build `(i32) -> funcref`.
    let funcref = ValType::Ref(RefType::FUNCREF);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[funcref]);
    let recipe = module.locals.add(ValType::I32);
    let ordinal = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        body.local_get(recipe)
            .call(helper_fn)
            .local_set(ordinal)
            .local_get(ordinal)
            .i32_const(NULL_ORDINAL)
            .binop(BinaryOp::I32Eq)
            .if_else(
                Some(funcref),
                |then| {
                    // Null recipe -> ref.null func.
                    then.ref_null(RefType::FUNCREF);
                },
                |els| {
                    // Funcref recipe -> table.get(catalog, ordinal). The helper
                    // has already bounds-checked the recipe and traps on any
                    // inconsistency, so a non-negative ordinal here is valid.
                    els.local_get(ordinal).table_get(catalog);
                },
            );
    }
    let shim = builder.finish(vec![recipe], &mut module.funcs);
    module.exports.add(DECODE_FUNCREF_EXPORT, shim);
    Ok(())
}

/// Inject `fm_drive_execute(plan_ptr, count)` (Phase 6 item 3b): a wasm loop that
/// strides a serialized drive PLAN, `call_indirect`s the host-bound
/// `__wpk_fork_drive_table` for each step, and `call`s the module's Rust
/// `fm_after_alloc(recipe)` after each ALLOC step. Rust cannot emit
/// `call_indirect`, so this static wasm loop is the mechanism the module's Rust
/// drive planner cannot express itself.
///
/// ```wat
/// (func (export "fm_drive_execute") (param $plan i32) (param $count i32)
///   (local $i i32) (local $step i32) (local $op i32)
///   (loop $lp
///     (if (i32.ge_u (local.get $i) (local.get $count))
///       (then)                                   ;; done -> fall out of the loop
///       (else
///         (local.set $step (i32.add (local.get $plan)
///                                   (i32.mul (local.get $i) (i32.const 16))))
///         (local.set $op (i32.load offset=0 (local.get $step)))
///         ;; call_indirect guest[slot](arg)
///         (call_indirect (type (i32)->())
///           (i32.load offset=12 (local.get $step))          ;; arg
///           (i32.load offset=4  (local.get $step)))          ;; slot
///         (if (i32.eqz (local.get $op))                       ;; ALLOC?
///           (then (call $fm_after_alloc (i32.load offset=8 (local.get $step)))))
///         (local.set $i (i32.add (local.get $i) (i32.const 1)))
///         (br $lp)))))
/// ```
fn inject_drive_execute(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == DRIVE_EXECUTE_EXPORT)
    {
        bail!("module already exports {DRIVE_EXECUTE_EXPORT}");
    }

    // The Rust R1-assert helper the shim calls after each ALLOC step.
    let after_alloc = module
        .exports
        .iter()
        .find(|export| export.name == AFTER_ALLOC_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {AFTER_ALLOC_EXPORT}"))?;
    let after_alloc_fn = match after_alloc.item {
        ExportItem::Function(id) => id,
        _ => bail!("{AFTER_ALLOC_EXPORT} export is not a function"),
    };

    // The guest's single (imported) linear memory the plan bytes live in.
    let memory = module
        .memories
        .iter()
        .next()
        .map(|m| m.id())
        .ok_or_else(|| anyhow!("module has no linear memory"))?;
    // A memory64 guest addresses linear memory with i64; the plan pointer and the
    // step address must then be i64, and the loop counter is i64-extended before
    // the address math. A wasm32 guest keeps everything i32.
    let is64 = module.memories.get(memory).memory64;
    let ptr_ty = if is64 { ValType::I64 } else { ValType::I32 };

    // The mutable funcref drive table (initial size 0; the host provides a table
    // sized to the fork's activations and binds the guest exports into it).
    let (drive_table, _import_id) = module.add_import_table(
        IMPORT_MODULE,
        DRIVE_TABLE_IMPORT,
        false,
        0,
        None,
        RefType::FUNCREF,
    );

    // The guest `_gc_allocate`/`_gc_fill` signature the shim `call_indirect`s:
    // `(i32) -> ()` (see `WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE` in abi.ts).
    let indirect_ty = module.types.add(&[ValType::I32], &[]);

    let mut builder =
        FunctionBuilder::new(&mut module.types, &[ptr_ty, ValType::I32], &[]);
    let plan = module.locals.add(ptr_ty);
    let count = module.locals.add(ValType::I32);
    let i = module.locals.add(ValType::I32);
    let step = module.locals.add(ptr_ty);
    let op = module.locals.add(ValType::I32);

    let mut loop_body = builder.dangling_instr_seq(None);
    let loop_id = loop_body.id();
    loop_body
        .local_get(i)
        .local_get(count)
        .binop(BinaryOp::I32GeU)
        .if_else(
            None,
            // i >= count: done — fall out of the loop (no `br`).
            |_done| {},
            // i < count: drive one step, then re-enter the loop.
            |work| {
                // step = plan + i * DRIVE_STEP_SIZE (pointer-width address math).
                if is64 {
                    work.local_get(i)
                        .unop(UnaryOp::I64ExtendUI32)
                        .i64_const(DRIVE_STEP_SIZE as i64)
                        .binop(BinaryOp::I64Mul)
                        .local_get(plan)
                        .binop(BinaryOp::I64Add)
                        .local_set(step);
                } else {
                    work.local_get(plan)
                        .local_get(i)
                        .i32_const(DRIVE_STEP_SIZE)
                        .binop(BinaryOp::I32Mul)
                        .binop(BinaryOp::I32Add)
                        .local_set(step);
                }
                // op = load[step + OFF_OP]
                work.local_get(step)
                    .load(
                        memory,
                        LoadKind::I32 { atomic: false },
                        MemArg { align: 4, offset: DRIVE_STEP_OFF_OP },
                    )
                    .local_set(op);
                // call_indirect guest[slot](arg): push arg, then slot.
                work.local_get(step)
                    .load(
                        memory,
                        LoadKind::I32 { atomic: false },
                        MemArg { align: 4, offset: DRIVE_STEP_OFF_ARG },
                    )
                    .local_get(step)
                    .load(
                        memory,
                        LoadKind::I32 { atomic: false },
                        MemArg { align: 4, offset: DRIVE_STEP_OFF_SLOT },
                    )
                    .instr(CallIndirect { ty: indirect_ty, table: drive_table });
                // if op == DRIVE_OP_ALLOC: fm_after_alloc(recipe)
                work.local_get(op).i32_const(DRIVE_OP_ALLOC).binop(BinaryOp::I32Eq);
                work.if_else(
                    None,
                    |alloc| {
                        alloc
                            .local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                            )
                            .call(after_alloc_fn);
                    },
                    |_| {},
                );
                // i += 1; br $lp
                work.local_get(i)
                    .i32_const(1)
                    .binop(BinaryOp::I32Add)
                    .local_set(i);
                work.instr(Br { block: loop_id });
            },
        );
    drop(loop_body);

    let mut body = builder.func_body();
    body.instr(Loop { seq: loop_id });
    let shim = builder.finish(vec![plan, count], &mut module.funcs);
    module.exports.add(DRIVE_EXECUTE_EXPORT, shim);
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args
        .next()
        .ok_or_else(|| anyhow!("usage: fork-module-inject <input.wasm> <output.wasm>"))?;
    let output = args
        .next()
        .ok_or_else(|| anyhow!("usage: fork-module-inject <input.wasm> <output.wasm>"))?;

    let bytes = std::fs::read(&input).with_context(|| format!("reading {input}"))?;
    let mut module = Module::from_buffer(&bytes).context("parsing fork-module wasm")?;
    inject(&mut module).context("injecting __wpk_fork_ref_decode_funcref")?;
    inject_drive_execute(&mut module).context("injecting fm_drive_execute")?;
    let out_bytes = module.emit_wasm();
    std::fs::write(&output, &out_bytes).with_context(|| format!("writing {output}"))?;
    eprintln!(
        "fork-module-inject: {input} -> {output} ({} bytes, added {DECODE_FUNCREF_EXPORT} + \
         {DRIVE_EXECUTE_EXPORT} + imported {IMPORT_MODULE}.{{{FUNCTION_CATALOG_IMPORT}, \
         {DRIVE_TABLE_IMPORT}}})",
        out_bytes.len()
    );
    Ok(())
}
