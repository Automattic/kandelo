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
use walrus::ir::{
    AnyConvertExtern, AtomicNotify, AtomicWait, BinaryOp, Br, CallIndirect, LoadKind, Loop, MemArg,
    UnaryOp,
};
use walrus::{
    ConstExpr, ElementItems, ElementKind, ExportItem, FunctionBuilder, FunctionId, ImportKind,
    Module, RefType, ValType,
};

// -- GC drive-shim injection (Phase 6 item 3b) --------------------------------
//
// The second injection this tool performs. The co-resident module cannot IMPORT
// the guest's `__wpk_fork_ref_gc_allocate`/`_gc_fill` exports (it is instantiated
// BEFORE the guest, to supply the frame-flip imports), so it drives them through
// a MUTABLE funcref table the host binds post-instantiation. Rust has no
// `call_indirect` intrinsic, so this tool injects `fm_drive_execute(plan_ptr,
// count)` — a wasm loop that strides the serialized drive PLAN
// (`fork_codec::drive_plan`), `call_indirect`s the table slot for each step, and
// after each ALLOC step verifies — with a wasm-level `table.get` + `ref.is_null`
// — that the guest's `_gc_allocate` published a live GC object into the shared
// Wasm-GC transit table (`env.__wpk_fork_ref_gc_transit`, an `anyref` table) at
// slot `recipe + 1`. That transit table is STORE #2: the ONE store the guest's
// `allocate` export actually publishes every struct/array/i31 into (see
// `crates/fork-instrument/src/module_gc_codec.rs` `emit_allocate_layout` /
// `emit_allocate_i31`) and the one `_gc_fill` consumes. A missing published
// object is real GC corruption, so a null slot branches to `unreachable` (a
// truthful trap). Rust has no `funcref`/`anyref` type and cannot express
// `table.get`, so this integrity guard, like the drive loop itself, must be
// injected wasm rather than a Rust export call.

/// The mutable funcref table the host binds guest `_gc_allocate`/`_gc_fill` into
/// and the injected `fm_drive_execute` `call_indirect`s. Imported (initial size
/// 0; the host provides a table sized to the fork's activations).
const DRIVE_TABLE_IMPORT: &str = "__wpk_fork_drive_table";
/// The plain `(ptr, i32) -> ()` placeholder import the module's Rust coarse
/// entries (`fm_parent_replay` / `fm_parent_abort`) call to run a serialized
/// drive plan. Rust CAN emit this import (no reference types), but it cannot
/// emit the ref-typed `call_indirect` the drive needs, so `inject_drive_thunk`
/// rewrites this import into a local thunk that forwards to the injected
/// `fm_drive_execute` shim. MUST match the `#[link(wasm_import_module = "env")]`
/// `extern` name in `crates/fork-module/src/lib.rs`.
const DRIVE_PLAN_THUNK_IMPORT: &str = "__wpk_fork_drive_plan";

/// The CAPTURE-side placeholder (F3 step 2). Rust declares it as an `env`
/// import and this tool rewrites it into a local thunk, so the emitted module
/// carries no unresolved import and a host supplies nothing new — the same
/// arrangement `DRIVE_PLAN_THUNK_IMPORT` uses.
const CAPTURE_WITNESS_THUNK_IMPORT: &str = "__wpk_fork_capture_witness";
/// Drive-table slot the host binds the guest's `__wpk_fork_ref_gc_encode_slot`
/// into. MUST equal `fork_codec::drive_plan::DRIVE_SLOT_GC_ENCODE`; the
/// injector cannot link fork-codec, so the constant is duplicated and pinned by
/// a test rather than left to drift.
const DRIVE_SLOT_GC_ENCODE: i32 = 11;
/// MUST equal `fork_codec::drive_plan::DRIVE_SLOT_GC_PROBE`.
const DRIVE_SLOT_GC_PROBE: i32 = 12;
/// The capture-side probe placeholder, rewritten like the witness one.
const CAPTURE_PROBE_THUNK_IMPORT: &str = "__wpk_fork_capture_probe";
/// Encode-from-transit placeholder: the cross-activation broker's second step.
const CAPTURE_ENCODE_THUNK_IMPORT: &str = "__wpk_fork_capture_encode";
/// MUST equal `fork_codec::drive_plan::DRIVE_SLOTS_PER_ACTIVATION`.
const DRIVE_SLOTS_PER_ACTIVATION: i32 = 13;
/// The anyref transit slot a capture encode reads its value from.
const CAPTURE_TRANSIT_SLOT: i32 = 0;
/// The injected loop export the host calls to run a serialized plan.
const DRIVE_EXECUTE_EXPORT: &str = "fm_drive_execute";
/// The Rust drive-step proof-of-use counter the injected shim `call`s once per
/// plan step it drives (Phase 6 item 3c). Exported by `crates/fork-module/src/
/// lib.rs`; Rust owns the counter, the injected loop owns the `call_indirect`.
const DRIVE_BUMP_HELPER_EXPORT: &str = "fm_drive_bump";
/// The shared Wasm-GC transit table (`(ref null any)`) the guest's
/// `_gc_allocate` publishes every reconstructed struct/array/i31 into at slot
/// `recipe + 1` (STORE #2). The injected drive loop reads it back with
/// `table.get` + `ref.is_null` after each ALLOC step to assert the guest
/// published a live object.
///
/// M1: the fork-module DEFINES this table as a local table and EXPORTS it
/// under this name — Rust cannot emit an anyref table, so the injector is
/// where the module acquires ownership of it. The guest imports the
/// fork-module's export (`crates/fork-instrument/src/module_gc_codec.rs`)
/// instead of a standalone host-provided table, so this name must still match
/// the guest's import name/element type exactly.
const TRANSIT_TABLE_IMPORT: &str = "__wpk_fork_ref_gc_transit";

/// The injected anyref-table growth primitive the Rust side calls.
const TRANSIT_GROW_EXPORT: &str = "fm_transit_grow";

/// The guest-facing fresh-GC claim.
const GC_CLAIM_EXPORT: &str = "__wpk_fork_ref_gc_claim";

/// The guest-facing GC identity probe.
const GC_LOOKUP_EXPORT: &str = "__wpk_fork_ref_gc_lookup";

/// The host import that gives a GC reference a stable integer identity, and the
/// two Rust helpers that map it. Wasm can COMPARE references but cannot HASH
/// one, so a reference cannot key a map inside the module; the host can.
const HOST_REF_IDENTITY_IMPORT: &str = "__wpk_fork_host_ref_identity";

/// The host's funcref identity oracle: a stable integer per distinct function.
///
/// Wasm cannot compare two `funcref`s -- `ref.eq` validates only on `eqref` and
/// the hierarchies are disjoint (census section 58) -- so this is the one thing
/// the scan below cannot do for itself. Both hosts can: a `WeakMap` in
/// JavaScript, `Func::to_raw` in wasmtime, which `a_native_host_can_identify_funcrefs`
/// proves is stable per function.
const HOST_FUNC_IDENTITY_IMPORT: &str = "__wpk_fork_host_func_identity";

/// Guest-facing capture entry: `(funcref) -> recipe`.
const ENCODE_FUNCREF_EXPORT: &str = "__wpk_fork_ref_encode_funcref";

/// Reads one `__indirect_function_table` slot and reports which merged
/// function-catalog slot holds the same function. See `inject_indirect_slot_catalog`.
const INDIRECT_SLOT_CATALOG_IMPORT: &str = "fm_indirect_slot_catalog_index";

/// `table.size` of the guest's indirect function table, which Rust cannot emit.
const INDIRECT_TABLE_SIZE_IMPORT: &str = "fm_indirect_table_size";

/// Rust helpers the scan calls once it has an answer.
const FUNCREF_SLOT_TO_RECIPE_HELPER: &str = "fm_funcref_slot_to_recipe";
const FUNCREF_UNCATALOGUED_HELPER: &str = "fm_funcref_uncatalogued";
const GC_IDENTITY_FIND_HELPER: &str = "fm_gc_identity_find";
const GC_IDENTITY_CLAIM_HELPER: &str = "fm_gc_identity_claim";

/// Constructor-provenance WITNESS pool. One retained instance per
/// `(layout, provenance ordinal)`, not one record per allocated object: the
/// seed replay passes to `struct.new` is overwritten by the snapshot fill, so
/// it only has to be a type-correct capturable instance of the field's type.
/// See docs/plans/2026-09-12-lane-f-census.md sections 21 and 22.
const PROVENANCE_REF_EXPORT: &str = "__wpk_fork_ref_gc_provenance_ref";
const PROVENANCE_WITNESS_SLOT_HELPER: &str = "fm_gc_provenance_witness_slot";
const PROVENANCE_WITNESS_TABLE: &str = "__wpk_fork_ref_gc_provenance_witness";
/// Must match `WITNESS_SLOTS` in `crates/fork-module/src/lib.rs`: Rust picks the
/// slot index, this table holds the reference at it.
const PROVENANCE_WITNESS_SLOTS: u64 = 256;

/// The process-owned fork-unwind transport tag.
const UNWIND_TAG_EXPORT: &str = "__wpk_fork_unwind";

/// The merged, host-owned static-root catalog (`anyref`) the injected drive shim
/// reads with `table.get` on a DRIVE_OP_STATIC_ROOT step (the static-root binder).
/// The guest's own `__wpk_fork_static_root_catalog` is a harvest EXPORT cleared
/// after instantiation, so the host supplies a growable mirror populated from the
/// child's live static roots (`decodeStaticRoot`) and bound to this import; the
/// shim `table.get`s the slot `fm_static_root_slot` returns and publishes the
/// value into the transit at `recipe + 1`. Imported (initial size 0; the host
/// grows it to the fork's merged catalog).
const STATIC_ROOT_CATALOG_IMPORT: &str = "__wpk_fork_static_root_catalog";
/// The Rust helper the shim calls to map a DRIVE_OP_STATIC_ROOT recipe to its
/// merged anyref-catalog index (per-activation base + ordinal). Exported by
/// `crates/fork-module/src/lib.rs`; traps on any inconsistency.
const STATIC_ROOT_SLOT_HELPER_EXPORT: &str = "fm_static_root_slot";

// Serialized drive-step layout — MUST match `fork_codec::drive_plan`
// (`DRIVE_STEP_SIZE`, `DRIVE_STEP_OFF_*`, `DRIVE_OP_*`). Four little-endian
// u32 fields per 16-byte step.
const DRIVE_STEP_SIZE: i32 = 16;
const DRIVE_STEP_OFF_OP: u64 = 0;
const DRIVE_STEP_OFF_SLOT: u64 = 4;
const DRIVE_STEP_OFF_RECIPE: u64 = 8;
const DRIVE_STEP_OFF_ARG: u64 = 12;
const DRIVE_OP_ALLOC: i32 = 0;
/// op == publish an immutable static root into the anyref transit (the
/// static-root binder). MUST match `fork_codec::drive_plan::DRIVE_OP_STATIC_ROOT`.
const DRIVE_OP_STATIC_ROOT: i32 = 3;
/// op == materialize + publish a GC/exnref-reachable externref into the anyref
/// transit at slot `recipe + 1` (the externref binder — M2). Like
/// DRIVE_OP_STATIC_ROOT it drives NO guest export: the injected shim resolves the
/// externref through the residual `env.resolve_externref` host import, internalizes
/// it with `any.convert_extern`, and `table.set`s it into the transit. MUST match
/// `fork_codec::drive_plan::DRIVE_OP_EXTERNREF_TRANSIT`.
const DRIVE_OP_EXTERNREF_TRANSIT: i32 = 4;
/// op == the FIRST child-install op (`fork_codec::drive_plan::DRIVE_OP_RESTORE`).
/// Every op `< DRIVE_OP_RESTORE` is a RECONSTRUCTION step (alloc/fill/exn/static-
/// root/externref-transit) whose drive the `fm_drive_steps_executed` proof
/// counts; ops `>= DRIVE_OP_RESTORE` (RESTORE / FINISH_RESTORE) are the
/// module-owned guest install-sequencing steps, which are NOT reconstruction and
/// must NOT bump that counter (it gates the "reference-free fork stays silent"
/// diagnostic). The shim still `call_indirect`s them; it just skips the bump.
const DRIVE_OP_RESTORE: i32 = 5;
/// op == run one activation's guest `wpk_fork_rewind_begin(root)` — the first
/// POINTER-argument drive op. Every op `>= DRIVE_OP_REWIND_BEGIN` drives a guest
/// export whose single parameter is the continuation `root` pointer (`i32` on
/// wasm32, `i64` on wasm64), NOT the `(i32)` activation id / recipe the RESTORE /
/// ALLOC family passes, so the shim reconstructs the pointer from the step's
/// `recipe` (high 32) / `arg` (low 32) fields and `call_indirect`s it through a
/// `(ptr) -> ()` type. MUST match `fork_codec::drive_plan::DRIVE_OP_REWIND_BEGIN`.
const DRIVE_OP_REWIND_BEGIN: i32 = 8;
/// op == the FIRST no-argument `() -> ()` guest-drive op. Every op
/// `>= DRIVE_OP_UNWIND_END` drives a NO-argument guest state flip
/// (`wpk_fork_unwind_end` capture-seal = 9, `wpk_fork_rewind_end` replay-finish =
/// 10, `wpk_fork_abort_end` abort-finish = 11), so the shim `call_indirect`s it
/// through a distinct `() -> ()` type reading neither `arg` nor `recipe`. These
/// share the `>= DRIVE_OP_RESTORE` "install/control" class (excluded from the
/// reconstruction counter), so the `>= DRIVE_OP_UNWIND_END` void check runs
/// BEFORE the `>= DRIVE_OP_REWIND_BEGIN` pointer-drive branch (their op values,
/// 11/12/13, are all also `>= DRIVE_OP_REWIND_BEGIN`). The capture-BEGIN op
/// `DRIVE_OP_UNWIND_BEGIN` (9) is a POINTER-argument drive that sits in the
/// `[DRIVE_OP_REWIND_BEGIN, DRIVE_OP_UNWIND_END)` band, so it takes the
/// pointer-drive branch (not this void one) with no dedicated injector constant.
/// MUST match `fork_codec::drive_plan::DRIVE_OP_UNWIND_END` (and its
/// REWIND_END/ABORT_END successors, which take the SAME void branch).
const DRIVE_OP_UNWIND_END: i32 = 11;

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

/// Placeholder the fork module declares for one funcref table write during a
/// reconcile. Rewritten below into a local thunk; see `inject_table_apply_thunk`.
const TABLE_APPLY_THUNK_IMPORT: &str = "__wpk_fork_table_apply";

/// Placeholders for the two shared-memory atomics Rust cannot emit. Rewritten
/// below into local thunks; see `inject_atomic_thunks`.
const ATOMIC_WAIT_THUNK_IMPORT: &str = "__wpk_fork_atomic_wait32";
const ATOMIC_NOTIFY_THUNK_IMPORT: &str = "__wpk_fork_atomic_notify";

/// Module-owned funcref table of per-activation frame/resume entry points,
/// indexed `activation * TRAMPOLINE_SLOTS + slot`.
const ACTIVATION_TRAMPOLINE_TABLE: &str = "__wpk_fork_activation_trampolines";

/// Activations the table covers. Matches `ACTIVATION_CATALOG_MAX_ACTS` in
/// `crates/fork-module`, which is the module's own cap on distinct activations,
/// so a trampoline can never be asked for an activation the module would refuse.
const TRAMPOLINE_ACTIVATIONS: u32 = 64;

/// Entries per activation, in this fixed order: frame_reserve, frame_commit,
/// frame_peek, frame_next, resume_peek.
const TRAMPOLINE_SLOTS: u32 = 6;

/// The guest's own indirect call table -- the table a reconcile writes into.
/// Named by the wasm tool convention, not by anything Kandelo chose.
const INDIRECT_FUNCTION_TABLE_IMPORT: &str = "__indirect_function_table";
const IMPORT_MODULE: &str = "env";

/// The `NULL_ORDINAL` sentinel `fm_funcref_ordinal` returns for a Null recipe;
/// must stay in sync with `crates/fork-module/src/lib.rs`.
const NULL_ORDINAL: i32 = -1;

/// The single residual externref host import (M2). `resolve_externref(handle:i32)
/// -> externref` materializes a captured broker handle into its canonical host
/// token. It is reference-RETURNING, so Rust cannot declare or call it — both the
/// injected `__wpk_fork_ref_decode_externref` export and the
/// DRIVE_OP_EXTERNREF_TRANSIT branch of `fm_drive_execute` call it from wasm. The
/// host materialize cache is idempotent, so a direct per-reference resolve yields
/// the same canonical token every time (identity at the source, not by compare).
const RESOLVE_EXTERNREF_IMPORT: &str = "resolve_externref";

/// The Rust helper the injected binder calls to map an externref recipe id to its
/// captured broker `handle` (`i32`), which it then feeds to `resolve_externref`.
/// Exported by `crates/fork-module/src/lib.rs`; traps on any inconsistency.
const EXTERNREF_HANDLE_HELPER_EXPORT: &str = "fm_externref_handle";

/// The frozen guest import this tool makes the module export (see
/// `host/src/generated/abi.ts` `WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF`). Its
/// body is a DIRECT `resolve_externref(fm_externref_handle(recipe))` — no table,
/// no null branch: a valid recipe always resolves to the canonical token and the
/// helper traps on any inconsistency.
const DECODE_EXTERNREF_EXPORT: &str = "__wpk_fork_ref_decode_externref";

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

/// Find or add the single residual externref host import
/// `env.resolve_externref(handle:i32) -> externref`. Both injection sites — the
/// `__wpk_fork_ref_decode_externref` decode export and the
/// DRIVE_OP_EXTERNREF_TRANSIT branch of `fm_drive_execute` — call it, so this
/// find-or-add (mirroring `fork-instrument/src/legacy_dlopen.rs`) keeps the two
/// passes order-independent and declares the import exactly once. Rust cannot
/// declare a reference-returning import, which is exactly why it lives here.
/// Find or add `env.__wpk_fork_host_ref_identity(anyref) -> i32`.
fn import_host_ref_identity(module: &mut Module) -> FunctionId {
    for import in module.imports.iter() {
        if import.module == IMPORT_MODULE && import.name == HOST_REF_IDENTITY_IMPORT {
            if let ImportKind::Function(id) = import.kind {
                return id;
            }
        }
    }
    let ty = module
        .types
        .add(&[ValType::Ref(RefType::ANYREF)], &[ValType::I32]);
    let (id, _) = module.add_import_func(IMPORT_MODULE, HOST_REF_IDENTITY_IMPORT, ty);
    id
}

fn import_host_func_identity(module: &mut Module) -> FunctionId {
    for import in module.imports.iter() {
        if import.module == IMPORT_MODULE && import.name == HOST_FUNC_IDENTITY_IMPORT {
            if let ImportKind::Function(id) = import.kind {
                return id;
            }
        }
    }
    let ty = module
        .types
        .add(&[ValType::Ref(RefType::FUNCREF)], &[ValType::I32]);
    let (id, _) = module.add_import_func(IMPORT_MODULE, HOST_FUNC_IDENTITY_IMPORT, ty);
    id
}

/// Emit `__wpk_fork_ref_encode_funcref(funcref) -> recipe`.
///
/// Capture's inverse of `__wpk_fork_ref_decode_funcref`: that one turns a recipe
/// into a function by indexing the merged catalog, this one turns a function
/// back into a recipe by finding WHICH catalog slot holds it.
///
/// Finding it requires comparing functions, which wasm cannot do, so the host
/// supplies an identity oracle and the SCAN is emitted here. That split matters:
/// the host answers only "are these the same function?", and every decision
/// built on the answer -- which slice of the merged catalog the slot falls in,
/// which activation owns it, what ordinal it becomes, what happens when it is
/// not found -- stays in the module.
///
/// A linear scan, deliberately. Capture is not a hot path, an identity map would
/// need invalidating on every `dlopen`, and a stale map is a recipe that decodes
/// to the wrong function -- the failure this whole design exists to avoid.
fn inject_encode_funcref(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == ENCODE_FUNCREF_EXPORT)
    {
        bail!("module already exports {ENCODE_FUNCREF_EXPORT}");
    }
    let catalog = imported_table(module, FUNCTION_CATALOG_IMPORT)?;
    let identity = import_host_func_identity(module);
    let to_recipe = exported_function(module, FUNCREF_SLOT_TO_RECIPE_HELPER)?;
    let uncatalogued = exported_function(module, FUNCREF_UNCATALOGUED_HELPER)?;
    let catalog_is_64 = module.tables.get(catalog).table64;

    let mut builder =
        FunctionBuilder::new(&mut module.types, &[ValType::Ref(RefType::FUNCREF)], &[ValType::I32]);
    let wanted = module.locals.add(ValType::Ref(RefType::FUNCREF));
    let want_id = module.locals.add(ValType::I32);
    let i = module.locals.add(ValType::I32);
    let size = module.locals.add(ValType::I32);
    let entry = module.locals.add(ValType::Ref(RefType::FUNCREF));

    let mut loop_body = builder.dangling_instr_seq(None);
    let loop_id = loop_body.id();
    loop_body
        .local_get(i)
        .local_get(size)
        .binop(BinaryOp::I32GeU)
        .if_else(
            None,
            // Scanned the whole catalog without a match.
            |done| {
                done.call(uncatalogued).return_();
            },
            |work| {
                work.local_get(i);
                if catalog_is_64 {
                    work.unop(UnaryOp::I64ExtendUI32);
                }
                work.table_get(catalog).local_set(entry);
                // A null slot cannot be the function we hold, and asking the host
                // to identify null would make it invent an answer.
                work.local_get(entry).ref_is_null().if_else(
                    None,
                    |_null| {},
                    |occupied| {
                        occupied
                            .local_get(entry)
                            .call(identity)
                            .local_get(want_id)
                            .binop(BinaryOp::I32Eq)
                            .if_else(
                                None,
                                |found| {
                                    found.local_get(i).call(to_recipe).return_();
                                },
                                |_| {},
                            );
                    },
                );
                work.local_get(i)
                    .i32_const(1)
                    .binop(BinaryOp::I32Add)
                    .local_set(i);
                work.instr(Br { block: loop_id });
            },
        );
    drop(loop_body);

    {
        let mut body = builder.func_body();
        // A null funcref is recipe 0 -- the graph's own "no reference", not a
        // lookup failure, and asking the host to identify it would be wrong.
        body.local_get(wanted).ref_is_null().if_else(
            None,
            |null| {
                null.i32_const(0).return_();
            },
            |_| {},
        );
        body.local_get(wanted).call(identity).local_set(want_id);
        body.table_size(catalog);
        if catalog_is_64 {
            body.unop(UnaryOp::I32WrapI64);
        }
        body.local_set(size);
        body.i32_const(0).local_set(i);
        body.instr(Loop { seq: loop_id });
        // Unreachable: the loop returns on both exits. Wasm still needs a value
        // of the result type to fall out with.
        body.call(uncatalogued);
    }
    let shim = builder.finish(vec![wanted], &mut module.funcs);
    module.exports.add(ENCODE_FUNCREF_EXPORT, shim);
    Ok(())
}

/// Rewrite `fm_indirect_slot_catalog_index(dest) -> i32` into a local thunk.
///
/// Publishing a guest table mutation means describing what the guest WROTE, and
/// the description is a catalog coordinate. So for each changed slot the module
/// asks the same question `encode_funcref` asks, about a function it reads out of
/// the indirect table rather than one it was handed.
///
/// Returns the merged catalog slot, or:
///   `-1` the indirect slot is null, a legitimate cleared entry;
///   `-2` the function is not in the catalog at all.
///
/// Two codes rather than one because they are not the same event: a null slot is
/// a run the patch records as `clear`, while an uncatalogued function is a
/// mutation that cannot be described and must fail the commit.
fn inject_indirect_slot_catalog(module: &mut Module) -> Result<()> {
    let Some(import_fn) = imported_func(module, INDIRECT_SLOT_CATALOG_IMPORT) else {
        return Ok(());
    };
    let catalog = imported_table(module, FUNCTION_CATALOG_IMPORT)?;
    let indirect = imported_table(module, INDIRECT_FUNCTION_TABLE_IMPORT)?;
    let identity = import_host_func_identity(module);
    let catalog_is_64 = module.tables.get(catalog).table64;
    let indirect_is_64 = module.tables.get(indirect).table64;
    let want_id = module.locals.add(ValType::I32);
    let i = module.locals.add(ValType::I32);
    let size = module.locals.add(ValType::I32);
    let held = module.locals.add(ValType::Ref(RefType::FUNCREF));
    let entry = module.locals.add(ValType::Ref(RefType::FUNCREF));

    module
        .replace_imported_func(import_fn, |(body, args)| {
            let dest = args[0];
            let mut loop_body = body.dangling_instr_seq(None);
            let loop_id = loop_body.id();
            loop_body
                .local_get(i)
                .local_get(size)
                .binop(BinaryOp::I32GeU)
                .if_else(
                    None,
                    |done| {
                        done.i32_const(-2).return_();
                    },
                    |work| {
                        work.local_get(i);
                        if catalog_is_64 {
                            work.unop(UnaryOp::I64ExtendUI32);
                        }
                        work.table_get(catalog).local_set(entry);
                        work.local_get(entry).ref_is_null().if_else(
                            None,
                            |_null| {},
                            |occupied| {
                                occupied
                                    .local_get(entry)
                                    .call(identity)
                                    .local_get(want_id)
                                    .binop(BinaryOp::I32Eq)
                                    .if_else(
                                        None,
                                        |found| {
                                            found.local_get(i).return_();
                                        },
                                        |_| {},
                                    );
                            },
                        );
                        work.local_get(i)
                            .i32_const(1)
                            .binop(BinaryOp::I32Add)
                            .local_set(i);
                        work.instr(Br { block: loop_id });
                    },
                );
            drop(loop_body);

            body.local_get(dest);
            if indirect_is_64 {
                body.unop(UnaryOp::I64ExtendUI32);
            }
            body.table_get(indirect).local_set(held);
            body.local_get(held).ref_is_null().if_else(
                None,
                |null| {
                    null.i32_const(-1).return_();
                },
                |_| {},
            );
            body.local_get(held).call(identity).local_set(want_id);
            body.table_size(catalog);
            if catalog_is_64 {
                body.unop(UnaryOp::I32WrapI64);
            }
            body.local_set(size);
            body.i32_const(0).local_set(i);
            body.instr(Loop { seq: loop_id });
            body.i32_const(-2);
        })
        .with_context(|| format!("rewriting {INDIRECT_SLOT_CATALOG_IMPORT}"))?;
    Ok(())
}

/// Rewrite `fm_indirect_table_size() -> i32` into a local thunk.
///
/// A published table patch records the table's LENGTH, and the decoder rejects a
/// patch whose range runs past it. Rust cannot emit `table.size`, so without this
/// the module would have to be TOLD a number it can read for itself -- and a host
/// that told it a stale one would publish patches the decoder refuses.
fn inject_indirect_table_size(module: &mut Module) -> Result<()> {
    let Some(import_fn) = imported_func(module, INDIRECT_TABLE_SIZE_IMPORT) else {
        return Ok(());
    };
    let indirect = imported_table(module, INDIRECT_FUNCTION_TABLE_IMPORT)?;
    let is64 = module.tables.get(indirect).table64;
    module
        .replace_imported_func(import_fn, |(body, _args)| {
            body.table_size(indirect);
            if is64 {
                body.unop(UnaryOp::I32WrapI64);
            }
        })
        .with_context(|| format!("rewriting {INDIRECT_TABLE_SIZE_IMPORT}"))?;
    Ok(())
}

fn import_resolve_externref(module: &mut Module) -> FunctionId {
    let params = [ValType::I32];
    let results = [ValType::Ref(RefType::EXTERNREF)];
    if let Some(function) = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != RESOLVE_EXTERNREF_IMPORT {
            return None;
        }
        let ImportKind::Function(function) = import.kind else {
            return None;
        };
        let signature = module.types.get(module.funcs.get(function).ty());
        (signature.params() == params && signature.results() == results).then_some(function)
    }) {
        return function;
    }
    let ty = module.types.add(&params, &results);
    module.add_import_func(IMPORT_MODULE, RESOLVE_EXTERNREF_IMPORT, ty).0
}

/// Inject the fork-module's `__wpk_fork_ref_decode_externref` export (M2).
///
/// The frozen guest import `__wpk_fork_ref_decode_externref(recipeId) ->
/// externref` must RETURN a real `externref`. A WebAssembly module can only
/// produce one by reading an imported externref `table` or by CALLING an import
/// whose result is `externref` — it cannot fabricate one from an integer. Rust
/// has no `externref` type, so the fork-module (a Rust cdylib) cannot itself
/// export this function.
///
/// This shim closes that gap. Unlike the funcref decode (which `table.get`s a
/// catalog), the externref decode is a DIRECT call chain — the design ruling
/// removed the module-owned extern table because the host materialize cache is
/// idempotent, so resolving per reference always yields the same canonical token:
///
/// ```wat
/// (func (export "__wpk_fork_ref_decode_externref") (param $recipe i32) (result externref)
///   (call $resolve_externref (call $fm_externref_handle (local.get $recipe))))
/// ```
///
/// The real work — decoding the reference graph, mapping a recipe to a captured
/// broker handle, admitting only externref/null, trapping on corruption — lives
/// in the module's Rust `fm_externref_handle` helper; this tool only adds the
/// externref-returning wrapper Rust cannot express and the residual
/// `env.resolve_externref` import it calls.
fn inject_decode_externref(module: &mut Module) -> Result<()> {
    // Idempotency / sanity: never double-inject.
    if module
        .exports
        .iter()
        .any(|export| export.name == DECODE_EXTERNREF_EXPORT)
    {
        bail!("module already exports {DECODE_EXTERNREF_EXPORT}");
    }

    // Locate the Rust helper export the shim will call to map a recipe to its
    // captured broker handle.
    let helper = module
        .exports
        .iter()
        .find(|export| export.name == EXTERNREF_HANDLE_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {EXTERNREF_HANDLE_HELPER_EXPORT}"))?;
    let helper_fn = match helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{EXTERNREF_HANDLE_HELPER_EXPORT} export is not a function"),
    };

    // The single residual externref host import (find-or-add; the drive-execute
    // pass shares it).
    let resolve_fn = import_resolve_externref(module);

    // Build `(i32) -> externref`.
    let externref = ValType::Ref(RefType::EXTERNREF);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[externref]);
    let recipe = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        // resolve_externref(fm_externref_handle(recipe)): DIRECT, no table, no
        // null branch — a valid recipe resolves to the canonical token and the
        // helper traps on any inconsistency.
        body.local_get(recipe).call(helper_fn).call(resolve_fn);
    }
    let shim = builder.finish(vec![recipe], &mut module.funcs);
    module.exports.add(DECODE_EXTERNREF_EXPORT, shim);
    Ok(())
}

/// Inject `fm_drive_execute(plan_ptr, count)` (Phase 6 item 3b/3c): a wasm loop
/// that strides a serialized drive PLAN, `call_indirect`s the host-bound
/// `__wpk_fork_drive_table` for each step, and after each ALLOC step asserts the
/// guest's `_gc_allocate` published a live GC object into the shared Wasm-GC
/// transit table (`env.__wpk_fork_ref_gc_transit`, STORE #2) at slot `recipe + 1`
/// by reading it back with `table.get` + `ref.is_null`. Rust cannot emit
/// `call_indirect`, `table.get`, or hold an `anyref`, so this static wasm loop is
/// the mechanism the module's Rust drive planner cannot express itself.
///
/// The store-#2 read replaces the earlier store-#1 read (a `call` into the Rust
/// `fm_after_alloc`, which read the HOST-externref transit the exnref/externref
/// PHASE B publishes into): a struct/array/i31 aggregate never gets a HOST
/// identity, so store #1 was always empty for exactly the recipes the drive
/// ALLOCs, and every typed drive trapped. Store #2 is the table the guest's
/// `allocate` export actually publishes into and `_gc_fill` consumes, so a live
/// slot there is the real post-allocate integrity invariant.
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
///           (then                                             ;; store-#2 R1 guard
///             (if (ref.is_null
///                   (table.get $__wpk_fork_ref_gc_transit
///                     (i32.add (i32.load offset=8 (local.get $step))
///                              (i32.const 1))))               ;; recipe + 1
///               (then (unreachable)))))                        ;; missing = GC corruption
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

    // Locate the Rust drive-step counter the shim `call`s once per driven step
    // (Phase 6 item 3c proof-of-use). Rust owns the counter; the injected loop
    // owns the `call_indirect` it counts.
    let bump = module
        .exports
        .iter()
        .find(|export| export.name == DRIVE_BUMP_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {DRIVE_BUMP_HELPER_EXPORT}"))?;
    let bump_fn = match bump.item {
        ExportItem::Function(id) => id,
        _ => bail!("{DRIVE_BUMP_HELPER_EXPORT} export is not a function"),
    };

    // Locate the Rust static-root slot helper the shim `call`s on a
    // DRIVE_OP_STATIC_ROOT step to map a recipe to its merged anyref-catalog index
    // (the static-root binder). Rust owns the recipe decode + per-activation base;
    // the injected shim owns the `table.get`/`table.set` a Rust anyref cannot hold.
    let slot_helper = module
        .exports
        .iter()
        .find(|export| export.name == STATIC_ROOT_SLOT_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {STATIC_ROOT_SLOT_HELPER_EXPORT}"))?;
    let slot_helper_fn = match slot_helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{STATIC_ROOT_SLOT_HELPER_EXPORT} export is not a function"),
    };

    // Locate the Rust externref-handle helper the shim `call`s on a
    // DRIVE_OP_EXTERNREF_TRANSIT step to map a recipe to its captured broker
    // handle. Rust owns the recipe decode; the injected shim owns the
    // `resolve_externref` call + `any.convert_extern` + `table.set` a Rust
    // externref/anyref cannot hold.
    let externref_helper = module
        .exports
        .iter()
        .find(|export| export.name == EXTERNREF_HANDLE_HELPER_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {EXTERNREF_HANDLE_HELPER_EXPORT}"))?;
    let externref_helper_fn = match externref_helper.item {
        ExportItem::Function(id) => id,
        _ => bail!("{EXTERNREF_HANDLE_HELPER_EXPORT} export is not a function"),
    };
    // The single residual externref host import (find-or-add; shared with the
    // decode-export pass).
    let resolve_externref_fn = import_resolve_externref(module);

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
    let (drive_table, _drive_import_id) = module.add_import_table(
        IMPORT_MODULE,
        DRIVE_TABLE_IMPORT,
        false,
        0,
        None,
        RefType::FUNCREF,
    );

    // The shared Wasm-GC transit table (STORE #2) the guest's `_gc_allocate`
    // publishes every reconstructed struct/array/i31 into at slot `recipe + 1`.
    // The shim reads it back after each ALLOC to assert a live object survived.
    //
    // M1: the fork-module OWNS the (ref null any) GC transit table and EXPORTS it,
    // so the guest imports the module's table (not a standalone JS provider). Rust
    // cannot emit an anyref table, so define it here in the injector.
    let transit_table = module.tables.add_local(false, 1, None, RefType::ANYREF);
    module.tables.get_mut(transit_table).name = Some(TRANSIT_TABLE_IMPORT.to_string());
    module.exports.add(TRANSIT_TABLE_IMPORT, transit_table);

    // The merged, host-owned static-root catalog (`anyref`) the shim reads with
    // `table.get` on a DRIVE_OP_STATIC_ROOT step. Initial size 0; the host grows
    // + populates it from the child's live static roots before the drive runs.
    let (static_root_catalog, _static_root_import_id) = module.add_import_table(
        IMPORT_MODULE,
        STATIC_ROOT_CATALOG_IMPORT,
        false,
        0,
        None,
        RefType::ANYREF,
    );

    // The guest `_gc_allocate`/`_gc_fill` signature the shim `call_indirect`s:
    // `(i32) -> ()` (see `WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE` in abi.ts). Also
    // the RESTORE / FINISH_RESTORE guest exports (`(i32 activation) -> ()`).
    let indirect_ty = module.types.add(&[ValType::I32], &[]);
    // The guest `wpk_fork_rewind_begin`/`wpk_fork_abort_begin` signature the shim
    // `call_indirect`s for a REWIND_BEGIN / ABORT_BEGIN step: `(ptr) -> ()`
    // (`i32` on wasm32 — identical to `indirect_ty` there — `i64` on wasm64).
    let ptr_indirect_ty = module.types.add(&[ptr_ty], &[]);
    // The guest `wpk_fork_unwind_end` signature the shim `call_indirect`s for a
    // DRIVE_OP_UNWIND_END step: `() -> ()` (no argument — the instrumenter emits
    // it with an empty signature; see `fork_instrument::runtime::emit_end_fn`).
    let void_indirect_ty = module.types.add(&[], &[]);

    let mut builder =
        FunctionBuilder::new(&mut module.types, &[ptr_ty, ValType::I32], &[]);
    let plan = module.locals.add(ptr_ty);
    let count = module.locals.add(ValType::I32);
    let i = module.locals.add(ValType::I32);
    let step = module.locals.add(ptr_ty);
    let op = module.locals.add(ValType::I32);
    // Holds the static-root `anyref` between `table.get(catalog)` and the
    // null-check / `table.set(transit)` on a DRIVE_OP_STATIC_ROOT step.
    let sr_val = module.locals.add(ValType::Ref(RefType::ANYREF));

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
                // Proof-of-use (Phase 6 item 3c): count every RECONSTRUCTION step
                // the MODULE drives. A nonzero `fm_drive_steps_executed` after a
                // flag-on fork proves the module drove the typed order, not a JS
                // fallback. The child-install steps (RESTORE / FINISH_RESTORE, op
                // `>= DRIVE_OP_RESTORE`) are NOT reconstruction, so they are excluded
                // from this counter — it gates the "reference-free fork stays
                // silent" diagnostic (a scalar-only fork drives only install steps
                // and must leave every reference proof at zero).
                //   if op < DRIVE_OP_RESTORE { fm_drive_bump() }
                work.local_get(op)
                    .i32_const(DRIVE_OP_RESTORE)
                    .binop(BinaryOp::I32LtU)
                    .if_else(
                        None,
                        |recon| {
                            recon.call(bump_fn);
                        },
                        |_install| {},
                    );
                // Branch on the step op: a DRIVE_OP_STATIC_ROOT step drives NO
                // guest export — it is the static-root binder, a pure `table.get`
                // catalog + `table.set` transit. Every other op drives a guest
                // export via `call_indirect` on the host-bound drive table.
                //   if op == DRIVE_OP_STATIC_ROOT { static-root publish }
                //   else { call_indirect; if op == ALLOC { store-#2 assert } }
                // Table indices are i32 regardless of guest pointer width, so the
                // `recipe + 1` index math stays i32 on both wasm32 and wasm64.
                work.local_get(op)
                    .i32_const(DRIVE_OP_STATIC_ROOT)
                    .binop(BinaryOp::I32Eq);
                work.if_else(
                    None,
                    // STATIC_ROOT: publish the immutable static root into the anyref
                    // transit at slot `recipe + 1`.
                    //   sr_val = table.get(catalog, fm_static_root_slot(recipe))
                    //   if (ref.is_null sr_val) unreachable   ;; missing = corruption
                    //   table.set(transit, recipe + 1, sr_val)
                    |sr| {
                        sr.local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                            )
                            .call(slot_helper_fn)
                            .table_get(static_root_catalog)
                            .local_set(sr_val);
                        // Null slot: the host mirror never held this static root —
                        // real corruption, trap truthfully rather than publish null.
                        sr.local_get(sr_val).ref_is_null().if_else(
                            None,
                            |missing| {
                                missing.unreachable();
                            },
                            |_| {},
                        );
                        // table.set(transit, recipe + 1, sr_val): push index, value.
                        sr.local_get(step)
                            .load(
                                memory,
                                LoadKind::I32 { atomic: false },
                                MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                            )
                            .i32_const(1)
                            .binop(BinaryOp::I32Add)
                            .local_get(sr_val)
                            .table_set(transit_table);
                    },
                    // Non-static-root: either a DRIVE_OP_EXTERNREF_TRANSIT publish
                    // (op 4 — the externref binder, which also drives NO guest
                    // export) or a real guest-export drive via `call_indirect`.
                    //   if op == DRIVE_OP_EXTERNREF_TRANSIT { externref publish }
                    //   else { call_indirect; if op == ALLOC { store-#2 assert } }
                    |other| {
                        other
                            .local_get(op)
                            .i32_const(DRIVE_OP_EXTERNREF_TRANSIT)
                            .binop(BinaryOp::I32Eq);
                        other.if_else(
                            None,
                            // EXTERNREF_TRANSIT: materialize the externref through the
                            // residual `resolve_externref` host import, internalize it
                            // with `any.convert_extern`, and publish it into the anyref
                            // transit at slot `recipe + 1`.
                            //   table.set(transit, recipe + 1,
                            //     any.convert_extern(
                            //       resolve_externref(fm_externref_handle(recipe))))
                            //   if (ref.is_null (table.get transit recipe+1)) unreachable
                            // Identity is guaranteed at the SOURCE (idempotent host
                            // materialize); this NON-NULL check only verifies the slot
                            // survived (the M2 R1 guard — an internalized externref is
                            // not `ref.eq`-comparable on any engine).
                            |ext| {
                                // Push the transit index (recipe + 1) first...
                                ext.local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .i32_const(1)
                                    .binop(BinaryOp::I32Add)
                                    // ...then the value: internalize the resolved
                                    // externref into an anyref for the transit table.
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .call(externref_helper_fn)
                                    .call(resolve_externref_fn)
                                    .instr(AnyConvertExtern {})
                                    .table_set(transit_table);
                                // NON-NULL structural check: read the slot back and
                                // trap if the publish did not survive.
                                ext.local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .i32_const(1)
                                    .binop(BinaryOp::I32Add)
                                    .table_get(transit_table)
                                    .ref_is_null()
                                    .if_else(
                                        None,
                                        // Empty slot: publish failed — trap truthfully.
                                        |missing| {
                                            missing.unreachable();
                                        },
                                        |_| {},
                                    );
                            },
                            // Real guest drive. Three shapes, split on the op:
                            //   op >= DRIVE_OP_UNWIND_END (UNWIND_END capture-seal,
                            //     REWIND_END replay-finish, ABORT_END abort-finish):
                            //     the guest export takes NO argument,
                            //     `call_indirect ()->()`. Checked FIRST because these
                            //     op values (10/11/12) are also `>= DRIVE_OP_REWIND_BEGIN`.
                            //   op >= DRIVE_OP_REWIND_BEGIN (REWIND_BEGIN/ABORT_BEGIN/
                            //     UNWIND_BEGIN — the capture-begin drive, op 9):
                            //     the guest export takes the continuation ROOT pointer,
                            //     `call_indirect (ptr)->()`; the root is reconstructed
                            //     from recipe (high 32) / arg (low 32).
                            //   otherwise (ALLOC/FILL/EXN/RESTORE/FINISH_RESTORE):
                            //     `call_indirect (i32)->()` with `arg`, then (if ALLOC)
                            //     the store-#2 published-object assert.
                            |drive| {
                        drive.local_get(op).i32_const(DRIVE_OP_UNWIND_END).binop(BinaryOp::I32GeU);
                        drive.if_else(
                            None,
                            // () -> () drive: call_indirect guest[slot]() — no argument
                            // (the capture-seal `wpk_fork_unwind_end` flip and the
                            // replay-finish `wpk_fork_rewind_end`/`wpk_fork_abort_end`
                            // flips, ops >= DRIVE_OP_UNWIND_END). Reads only the step's
                            // slot; `recipe`/`arg` are ignored.
                            |void_drive| {
                                void_drive
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_SLOT },
                                    )
                                    .instr(CallIndirect {
                                        ty: void_indirect_ty,
                                        table: drive_table,
                                    });
                            },
                            // Argument-bearing guest drive: pointer- or i32-argument.
                            |drive| {
                        drive
                            .local_get(op)
                            .i32_const(DRIVE_OP_REWIND_BEGIN)
                            .binop(BinaryOp::I32GeU);
                        drive.if_else(
                            None,
                            // Pointer-argument drive: call_indirect guest[slot](root).
                            |ptr_drive| {
                                if is64 {
                                    // root = (extend_u(recipe) << 32) | extend_u(arg)
                                    ptr_drive
                                        .local_get(step)
                                        .load(
                                            memory,
                                            LoadKind::I32 { atomic: false },
                                            MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                        )
                                        .unop(UnaryOp::I64ExtendUI32)
                                        .i64_const(32)
                                        .binop(BinaryOp::I64Shl)
                                        .local_get(step)
                                        .load(
                                            memory,
                                            LoadKind::I32 { atomic: false },
                                            MemArg { align: 4, offset: DRIVE_STEP_OFF_ARG },
                                        )
                                        .unop(UnaryOp::I64ExtendUI32)
                                        .binop(BinaryOp::I64Or);
                                } else {
                                    // root = arg (whole i32 pointer; recipe is 0)
                                    ptr_drive.local_get(step).load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_ARG },
                                    );
                                }
                                // slot (i32 table index) then call_indirect (ptr)->().
                                ptr_drive
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_SLOT },
                                    )
                                    .instr(CallIndirect {
                                        ty: ptr_indirect_ty,
                                        table: drive_table,
                                    });
                            },
                            // (i32)-argument drive: the existing family.
                            |drive| {
                        // call_indirect guest[slot](arg): push arg, then slot.
                        drive
                            .local_get(step)
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
                        // if op == DRIVE_OP_ALLOC: assert the guest published a live
                        // GC object into STORE #2 at slot `recipe + 1`.
                        drive.local_get(op).i32_const(DRIVE_OP_ALLOC).binop(BinaryOp::I32Eq);
                        drive.if_else(
                            None,
                            |alloc| {
                                alloc
                                    .local_get(step)
                                    .load(
                                        memory,
                                        LoadKind::I32 { atomic: false },
                                        MemArg { align: 4, offset: DRIVE_STEP_OFF_RECIPE },
                                    )
                                    .i32_const(1)
                                    .binop(BinaryOp::I32Add)
                                    .table_get(transit_table)
                                    .ref_is_null()
                                    .if_else(
                                        None,
                                        // Null slot: the guest never published this
                                        // aggregate — real GC corruption, trap.
                                        |missing| {
                                            missing.unreachable();
                                        },
                                        |_| {},
                                    );
                            },
                            |_| {},
                        );
                            },
                        );
                            },
                        );
                            },
                        );
                    },
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

/// Rewrite the `__wpk_fork_drive_plan(plan, count)` placeholder import into a
/// LOCAL thunk that forwards to the injected `fm_drive_execute` shim (control-
/// flow inversion). The module's Rust coarse entries (`fm_parent_replay` /
/// `fm_parent_abort`) sequence begin + plan-build in Rust and then call this
/// placeholder for the one step Rust cannot express — the ref-typed
/// `call_indirect` drive. `replace_imported_func` turns the import into a local
/// function whose body just re-issues the two arguments to the shim, so the
/// emitted module has NO unresolved import for it (the host provides nothing
/// new) and the coarse entry's drive reaches exactly the same `fm_drive_execute`
/// loop the host used to call directly.
///
/// MUST run AFTER `inject_drive_execute` (it needs the shim's function id). If
/// the module does not import the placeholder (e.g. a future build with no
/// coarse entry), this is a no-op — the coarse entries are the only callers.
fn inject_drive_thunk(module: &mut Module) -> Result<()> {
    // Find the placeholder import (module "env", the coarse-entry drive name).
    let import_fn = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != DRIVE_PLAN_THUNK_IMPORT {
            return None;
        }
        match import.kind {
            ImportKind::Function(function) => Some(function),
            _ => None,
        }
    });
    let Some(import_fn) = import_fn else {
        // No coarse entry references the drive placeholder; nothing to rewire.
        return Ok(());
    };

    // The injected drive shim to forward to (added by `inject_drive_execute`).
    let shim = module
        .exports
        .iter()
        .find(|export| export.name == DRIVE_EXECUTE_EXPORT)
        .ok_or_else(|| anyhow!("module does not export {DRIVE_EXECUTE_EXPORT}"))?;
    let shim_fn = match shim.item {
        ExportItem::Function(id) => id,
        _ => bail!("{DRIVE_EXECUTE_EXPORT} export is not a function"),
    };

    // Convert the import into a local function `(plan, count) -> ()` that just
    // forwards both arguments to the shim. `replace_imported_func` supplies the
    // parameter locals in declaration order.
    module
        .replace_imported_func(import_fn, |(body, args)| {
            body.local_get(args[0]).local_get(args[1]).call(shim_fn);
        })
        .with_context(|| format!("rewriting {DRIVE_PLAN_THUNK_IMPORT} import into a thunk"))?;
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
    inject_decode_externref(&mut module).context("injecting __wpk_fork_ref_decode_externref")?;
    inject_drive_execute(&mut module).context("injecting fm_drive_execute")?;
    inject_transit_grow(&mut module).context("injecting fm_transit_grow")?;
    inject_gc_claim(&mut module).context("injecting __wpk_fork_ref_gc_claim")?;
    inject_gc_lookup(&mut module).context("injecting __wpk_fork_ref_gc_lookup")?;
    inject_unwind_tag(&mut module).context("injecting __wpk_fork_unwind")?;
    inject_gc_provenance_ref(&mut module)
        .context("injecting __wpk_fork_ref_gc_provenance_ref")?;
    inject_capture_witness_thunk(&mut module)
        .context("rewriting __wpk_fork_capture_witness into a thunk")?;
    inject_capture_probe_thunk(&mut module)
        .context("rewriting __wpk_fork_capture_probe into a thunk")?;
    inject_capture_encode_thunk(&mut module)
        .context("rewriting __wpk_fork_capture_encode into a thunk")?;
    inject_table_apply_thunk(&mut module)
        .context("rewriting __wpk_fork_table_apply into a thunk")?;
    inject_atomic_thunks(&mut module).context("rewriting the shared-memory atomics")?;
    inject_activation_trampolines(&mut module)
        .context("emitting the per-activation frame trampolines")?;
    inject_encode_funcref(&mut module).context("injecting __wpk_fork_ref_encode_funcref")?;
    inject_indirect_slot_catalog(&mut module)
        .context("injecting fm_indirect_slot_catalog_index")?;
    inject_indirect_table_size(&mut module).context("injecting fm_indirect_table_size")?;
    inject_drive_thunk(&mut module).context("rewiring the coarse-entry drive thunk")?;
    let out_bytes = module.emit_wasm();
    // Validate before writing. An injected function with a bad local index or a
    // type mismatch produces bytes walrus is happy to emit and every consumer
    // rejects, and without this check the artifact is written and STAGED before
    // anything tries to instantiate it -- so the first symptom is a harness or a
    // host failing on a module that was already published. That happened while
    // adding the GC claim shim: `finish` was handed a non-parameter local, and
    // the result was "invalid local index: 1" at instantiation time, long after
    // the build reported success.
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&out_bytes)
        .with_context(|| {
            format!("injected module failed validation before writing {output}")
        })?;
    std::fs::write(&output, &out_bytes).with_context(|| format!("writing {output}"))?;
    eprintln!(
        "fork-module-inject: {input} -> {output} ({} bytes, added {DECODE_FUNCREF_EXPORT} + \
         {DECODE_EXTERNREF_EXPORT} + {DRIVE_EXECUTE_EXPORT} + exported {TRANSIT_TABLE_IMPORT} \
         (module-owned, M1) + imported {IMPORT_MODULE}.{{{FUNCTION_CATALOG_IMPORT}, \
         {DRIVE_TABLE_IMPORT}, {STATIC_ROOT_CATALOG_IMPORT}, {RESOLVE_EXTERNREF_IMPORT}}})",
        out_bytes.len()
    );
    Ok(())
}

/// Inject `fm_transit_grow(needed) -> i32`: ensure the module-owned
/// `(ref null any)` GC transit table holds at least `needed` slots, and return
/// its size afterwards (or `-1` if it could not be grown).
///
/// # Why this cannot be Rust
///
/// `table.size` and `table.grow` are the instructions, and Rust/LLVM emits
/// neither — and `table.grow` on an `anyref` table additionally needs a
/// `ref.null any` init value Rust has no type for. The module OWNS this table
/// (`inject_drive_execute` defines and exports it), so growing it is its own
/// job, not the host's.
///
/// # Why it is needed
///
/// `fork-instrument`'s GC codec publishes a captured value at `recipe + 1`:
///
/// ```wat
/// (i32.const 0) (call $claim)                       ;; -> recipe
/// (table.set $transit (i32.add (local.get $recipe) (i32.const 1)) (local.get $value))
/// ```
///
/// so `claim` must leave room for `recipe + 1` BEFORE it returns — the
/// generator states it: "claim grows the process-owned transit table through
/// recipe+1 before returning". Without this primitive the guest's very next
/// instruction traps on an out-of-bounds `table.set`.
///
/// ```wat
/// (func (export "fm_transit_grow") (param $needed i32) (result i32)
///   (if (i32.gt_s (local.get $needed) (table.size $transit))
///     (then
///       (if (i32.lt_s (table.grow $transit (ref.null any)
///                       (i32.sub (local.get $needed) (table.size $transit)))
///                     (i32.const 0))
///         (then (return (i32.const -1))))))
///   (table.size $transit))
/// ```
fn inject_transit_grow(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == TRANSIT_GROW_EXPORT)
    {
        bail!("module already exports {TRANSIT_GROW_EXPORT}");
    }

    // The transit table is module-owned and exported by `inject_drive_execute`,
    // so this pass must run after it. Resolve by export rather than by
    // threading the id through: a missing table is a loud failure here instead
    // of a shim that silently grows the wrong table.
    let transit = module
        .exports
        .iter()
        .find(|export| export.name == TRANSIT_TABLE_IMPORT)
        .ok_or_else(|| anyhow!("module does not export {TRANSIT_TABLE_IMPORT}"))?;
    let transit_table = match transit.item {
        ExportItem::Table(id) => id,
        _ => bail!("{TRANSIT_TABLE_IMPORT} export is not a table"),
    };

    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    let needed = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        body.local_get(needed)
            .table_size(transit_table)
            .binop(BinaryOp::I32GtS)
            .if_else(
                None,
                |grow| {
                    grow.ref_null(RefType::ANYREF)
                        .local_get(needed)
                        .table_size(transit_table)
                        .binop(BinaryOp::I32Sub)
                        .table_grow(transit_table)
                        .i32_const(0)
                        .binop(BinaryOp::I32LtS)
                        .if_else(
                            None,
                            |failed| {
                                failed.i32_const(-1).return_();
                            },
                            |_ok| {},
                        );
                },
                |_already| {},
            );
        body.table_size(transit_table);
    }
    let shim = builder.finish(vec![needed], &mut module.funcs);
    module.exports.add(TRANSIT_GROW_EXPORT, shim);
    Ok(())
}

/// Inject `__wpk_fork_ref_gc_claim(slot) -> recipe`: the guest-facing fresh-GC
/// claim.
///
/// # Why this is injected rather than Rust
///
/// The Rust side already has the interesting half — `fm_capture_claim_gc`
/// allocates a fresh identity in `fork_codec::ReferenceGraphBuilder`. What it
/// cannot do is the other half: `fork-instrument` publishes the claimed value
/// into the transit table at `recipe + 1` on the instruction AFTER this returns,
/// so the table has to be big enough first, and Rust emits no `table.grow`.
///
/// This is the same shape as `__wpk_fork_ref_decode_funcref`: an injected
/// wrapper doing the one wasm-only step around a Rust helper that does the
/// thinking. Rust cannot call an injected function (it does not exist when Rust
/// compiles), so the wrapper has to be the outer layer, not the inner one.
///
/// # The slot argument
///
/// The generator has exactly ONE call site and it passes `0`
/// (`module_gc_codec.rs`: `constant_i32(instrs, 0); call(claim)`), because the
/// value is sitting in transit slot 0 at that moment. Claim itself does not read
/// it — the guest publishes the value afterwards, which is what makes the
/// transit table the record and lets a later lookup find it. A non-zero slot
/// would mean the emitted shape changed, so it traps rather than quietly
/// claiming against an assumption that no longer holds.
///
/// ```wat
/// (func (export "__wpk_fork_ref_gc_claim") (param $slot i32) (result i32)
///   (local $recipe i32)
///   (if (local.get $slot) (then (unreachable)))          ;; contract violation
///   (local.set $recipe (call $fm_capture_claim_gc))
///   (if (i32.lt_s (local.get $recipe) (i32.const 0))
///     (then (return (local.get $recipe))))               ;; propagate the errno
///   (if (i32.lt_s (call $fm_transit_grow
///                   (i32.add (local.get $recipe) (i32.const 2)))
///                 (i32.const 0))
///     (then (return (i32.const -1))))                     ;; could not grow
///   (local.get $recipe))
/// ```
fn inject_gc_claim(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == GC_CLAIM_EXPORT)
    {
        bail!("module already exports {GC_CLAIM_EXPORT}");
    }
    let claim_helper = exported_function(module, GC_IDENTITY_CLAIM_HELPER)?;
    let grow = exported_function(module, TRANSIT_GROW_EXPORT)?;
    let transit_table = exported_table(module, TRANSIT_TABLE_IMPORT)?;
    let identity = import_host_ref_identity(module);

    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    let slot = module.locals.add(ValType::I32);
    let recipe = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        body.local_get(slot).if_else(
            None,
            |bad| {
                bad.unreachable();
            },
            |_ok| {},
        );
        // The value is STILL in the staging slot here -- the generator clears
        // slot 0 only after the payload is encoded -- so claim can bind the
        // identity rather than merely allocate a recipe. Binding is what makes
        // a later lookup hit, which is what terminates a cyclic graph.
        body.local_get(slot)
            .table_get(transit_table)
            .call(identity)
            .call(claim_helper)
            .local_set(recipe);
        body.local_get(recipe)
            .i32_const(0)
            .binop(BinaryOp::I32LtS)
            .if_else(
                None,
                |failed| {
                    failed.local_get(recipe).return_();
                },
                |_ok| {},
            );
        body.local_get(recipe)
            .i32_const(2)
            .binop(BinaryOp::I32Add)
            .call(grow)
            .i32_const(0)
            .binop(BinaryOp::I32LtS)
            .if_else(
                None,
                |failed| {
                    failed.i32_const(-1).return_();
                },
                |_ok| {},
            );
        body.local_get(recipe);
    }
    let shim = builder.finish(vec![slot], &mut module.funcs);
    module.exports.add(GC_CLAIM_EXPORT, shim);
    Ok(())
}

/// Inject `__wpk_fork_ref_gc_lookup(slot) -> recipe`: the recipe an equal GC
/// value was already claimed under, or 0 if this value is new.
///
/// # Why identity comes from the host
///
/// GC values ARE comparable in wasm -- `ref.eq` validates on `eqref` -- so the
/// module CAN answer this itself, and did, by scanning every value published so
/// far. What wasm cannot do is HASH a reference: there is no `ref.hash`, so a
/// reference cannot key a map, and the scan was the only in-module algorithm.
/// O(n) per lookup, O(n^2) over a capture.
///
/// `env.__wpk_fork_host_ref_identity` returns a stable integer per distinct
/// reference and Rust maps it, which is O(1) amortised. It is an OPTIMISATION,
/// not a capability floor, and `docs/fork-host-imports.md` says so. On
/// JavaScript it is a `WeakMap`; a wasmtime embedder has rooted references with
/// real identity, so it is not a JS-only mechanism.
///
/// # Why this is correctness, not deduplication for size
///
/// Without it a cyclic object graph never terminates: the generator publishes
/// identity BEFORE recursing into fields precisely so the walk back finds it.
///
/// ```wat
/// (func (export "__wpk_fork_ref_gc_lookup") (param $slot i32) (result i32)
///   (local $v anyref)
///   (local.set $v (table.get $transit (local.get $slot)))
///   (if (ref.is_null (local.get $v)) (then (return (i32.const 0))))
///   (call $fm_gc_identity_find (call $host_ref_identity (local.get $v))))
/// ```
/// `__wpk_fork_ref_gc_provenance_ref(token, ordinal, slot)`.
///
/// Stores the guest's staged constructor SEED into the witness pool. The
/// division of labour is the same one `inject_gc_claim` uses and for the same
/// reason: Rust picks the slot because Rust can hold the map, and wasm does the
/// store because only wasm can hold the reference.
///
/// Needs no reference identity and no host call at all — unlike claim/lookup,
/// the witness is keyed by `(layout, ordinal)`, both of which are plain
/// integers the guest already passes. That is what keeps this off the
/// allocation hot path.
///
/// The guest ABI returns nothing, so a rejected slot is latched in
/// `fm_last_errno` and surfaces at `__wpk_fork_ref_gc_provenance_end`, which
/// refuses a transaction whose stores did not match the declared count.
/// Rewrite the `__wpk_fork_capture_witness(activation, witness_slot)`
/// placeholder into a local thunk that encodes a constructor-provenance witness
/// through the guest's own codec.
///
/// Three operations, straight-line — no loop, because interning one witness is
/// one encode:
///
/// ```text
///   transit[0] = witness_table[witness_slot]
///   call_indirect drive_table[activation * SLOTS + DRIVE_SLOT_GC_ENCODE] (0)
/// ```
///
/// This is the first CAPTURE use of the drive table; every other slot drives
/// replay. The guest's `__wpk_fork_ref_gc_encode_slot` takes the transit slot
/// and returns the recipe id, so the module gets a recipe for a reference it
/// could never encode itself.
///
/// MUST run after `inject_gc_provenance_ref`, which creates the witness table.
/// Rewrite `__wpk_fork_capture_probe(activation, slot)` into a local thunk that
/// `call_indirect`s the guest's type-test probe.
///
/// Simpler than the witness thunk: the value is ALREADY in the transit slot
/// when the guest asks which layout it is, so there is nothing to stage — just
/// forward the slot and call through.
/// Rewrite a `(activation, slot)` placeholder into a local thunk that forwards
/// `slot` and `call_indirect`s `drive_table[activation * SLOTS + offset]`.
///
/// Shared by the probe and encode thunks, which differ only in the drive slot
/// and the callee's result type. Keeping one emitter means the index arithmetic
/// — the part that silently calls the wrong guest function when wrong — exists
/// once.
fn inject_forwarding_drive_thunk(
    module: &mut Module,
    import_name: &str,
    drive_slot: i32,
    result: ValType,
) -> Result<()> {
    let import_fn = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != import_name {
            return None;
        }
        match import.kind {
            walrus::ImportKind::Function(id) => Some(id),
            _ => None,
        }
    });
    let Some(import_fn) = import_fn else {
        return Ok(());
    };
    let drive_table = imported_table(module, DRIVE_TABLE_IMPORT)?;
    let callee_ty = module.types.add(&[ValType::I32], &[result]);
    module
        .replace_imported_func(import_fn, |(body, args)| {
            let activation = args[0];
            let slot = args[1];
            body.local_get(slot);
            body.local_get(activation)
                .i32_const(DRIVE_SLOTS_PER_ACTIVATION)
                .binop(BinaryOp::I32Mul)
                .i32_const(drive_slot)
                .binop(BinaryOp::I32Add);
            body.instr(CallIndirect {
                ty: callee_ty,
                table: drive_table,
            });
        })
        .with_context(|| format!("rewriting {import_name} import into a thunk"))?;
    Ok(())
}

fn inject_capture_probe_thunk(module: &mut Module) -> Result<()> {
    inject_forwarding_drive_thunk(
        module,
        CAPTURE_PROBE_THUNK_IMPORT,
        DRIVE_SLOT_GC_PROBE,
        ValType::I64,
    )
}

/// The broker's encode step. Same shape as the probe, different slot and result.
fn inject_capture_encode_thunk(module: &mut Module) -> Result<()> {
    inject_forwarding_drive_thunk(
        module,
        CAPTURE_ENCODE_THUNK_IMPORT,
        DRIVE_SLOT_GC_ENCODE,
        ValType::I32,
    )
}

fn inject_capture_witness_thunk(module: &mut Module) -> Result<()> {
    let import_fn = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != CAPTURE_WITNESS_THUNK_IMPORT {
            return None;
        }
        match import.kind {
            walrus::ImportKind::Function(id) => Some(id),
            _ => None,
        }
    });
    let Some(import_fn) = import_fn else {
        // A build that does not declare the placeholder needs no thunk.
        return Ok(());
    };

    let witness_table = exported_table(module, PROVENANCE_WITNESS_TABLE)?;
    let transit_table = exported_table(module, TRANSIT_TABLE_IMPORT)?;
    let drive_table = imported_table(module, DRIVE_TABLE_IMPORT)?;
    let encode_ty = module
        .types
        .add(&[ValType::I32], &[ValType::I32]);

    module
        .replace_imported_func(import_fn, |(body, args)| {
            let activation = args[0];
            let witness_slot = args[1];
            // transit[0] = witness_table[witness_slot]
            body.i32_const(CAPTURE_TRANSIT_SLOT)
                .local_get(witness_slot)
                .table_get(witness_table)
                .table_set(transit_table);
            // the guest codec's argument: which transit slot to encode
            body.i32_const(CAPTURE_TRANSIT_SLOT);
            // drive_table index = activation * SLOTS + DRIVE_SLOT_GC_ENCODE
            body.local_get(activation)
                .i32_const(DRIVE_SLOTS_PER_ACTIVATION)
                .binop(BinaryOp::I32Mul)
                .i32_const(DRIVE_SLOT_GC_ENCODE)
                .binop(BinaryOp::I32Add);
            body.instr(CallIndirect {
                ty: encode_ty,
                table: drive_table,
            });
        })
        .with_context(|| format!("rewriting {CAPTURE_WITNESS_THUNK_IMPORT} import into a thunk"))?;
    Ok(())
}

/// Emit one frame/resume entry point per activation, ahead of time.
///
/// The guest's five frame imports are frozen at `(ptr)`, while the module's
/// exports take `(activation_id, ptr)` -- one shared implementation serving
/// every activation. Something has to fold the activation id in.
///
/// That something used to be 286 lines of TypeScript SYNTHESIZING a wasm module
/// at runtime, per activation, by hand-assembling opcodes. Emitting them here
/// instead costs 320 functions of three instructions each, and reduces the host
/// to five `table.get` calls. Runtime code generation in the host is precisely
/// what this campaign exists to remove.
///
/// `resume_peek` drops the guest's argument rather than forwarding it; it is a
/// diagnostic the module does not take. That asymmetry is preserved from the
/// TypeScript it replaces, not invented here.
fn inject_activation_trampolines(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == ACTIVATION_TRAMPOLINE_TABLE)
    {
        bail!("module already exports {ACTIVATION_TRAMPOLINE_TABLE}");
    }
    let ptr_ty = if module
        .memories
        .iter()
        .next()
        .ok_or_else(|| anyhow!("module has no linear memory"))?
        .memory64
    {
        ValType::I64
    } else {
        ValType::I32
    };

    // (shared export, forwards the guest's argument)
    let targets: [(&str, bool); TRAMPOLINE_SLOTS as usize] = [
        ("fm_frame_reserve", true),
        ("fm_frame_commit", true),
        ("fm_frame_peek", true),
        ("fm_frame_next", true),
        ("fm_resume_peek", false),
        // The guest's `table_state_owned(owner)` takes its activation the same
        // way the frame imports do: folded in here. The host elects which
        // coordinate owns a physical table (a `WebAssembly.Table` identity
        // comparison wasm cannot make) and seeds the answer through
        // `fm_set_activation_table_state_owner`; the module then serves the
        // import itself.
        ("fm_module_state_table_state_owned", true),
    ];
    let mut resolved = Vec::with_capacity(targets.len());
    for (name, forwards) in targets {
        resolved.push((exported_function(module, name)?, forwards));
    }

    let slots = TRAMPOLINE_ACTIVATIONS * TRAMPOLINE_SLOTS;
    let table = module
        .tables
        .add_local(false, u64::from(slots), Some(u64::from(slots)), RefType::FUNCREF);
    module.exports.add(ACTIVATION_TRAMPOLINE_TABLE, table);

    let mut entries = Vec::with_capacity(slots as usize);
    for activation in 0..TRAMPOLINE_ACTIVATIONS {
        for (target, forwards) in &resolved {
            // Every guest-facing frame import is `(ptr) -> ptr` except
            // `frame_commit`, which returns nothing, and `resume_peek`, which is
            // `(i32) -> i32`. Building from the TARGET's own type keeps this
            // correct without restating any of those signatures here.
            let target_ty = module.types.get(module.funcs.get(*target).ty());
            let results: Vec<ValType> = target_ty.results().to_vec();
            let params: Vec<ValType> = if *forwards {
                vec![*target_ty
                    .params()
                    .get(1)
                    .ok_or_else(|| anyhow!("frame export takes no forwarded argument"))?]
            } else {
                vec![ValType::I32]
            };
            let mut builder = FunctionBuilder::new(&mut module.types, &params, &results);
            let arg = module.locals.add(params[0]);
            {
                let mut body = builder.func_body();
                body.i32_const(activation as i32);
                if *forwards {
                    body.local_get(arg);
                }
                body.call(*target);
            }
            entries.push(builder.finish(vec![arg], &mut module.funcs));
        }
    }
    let _ = ptr_ty;

    module.elements.add(
        ElementKind::Active {
            table,
            offset: ConstExpr::Value(walrus::ir::Value::I32(0)),
        },
        ElementItems::Functions(entries),
    );
    Ok(())
}

/// Rewrite the two shared-memory atomic placeholders into local thunks.
///
/// `core::sync::atomic` gives the module compare-and-swap on any guest address,
/// which is most of a lock. What it cannot give is BLOCKING: `memory.atomic
/// .wait32` and `memory.atomic.notify` have no Rust spelling, and a spin would
/// burn a worker's CPU while the archive writer does I/O.
///
/// Both take the address as the guest's pointer type, so a wasm64 build widens
/// the `u32` Rust declared -- the same widening `inject_table_apply_thunk` does
/// for table indices, and caught the same way if it is missing.
fn inject_atomic_thunks(module: &mut Module) -> Result<()> {
    let memory = module
        .memories
        .iter()
        .next()
        .map(|m| m.id())
        .ok_or_else(|| anyhow!("module has no linear memory"))?;
    let is64 = module.memories.get(memory).memory64;
    // A 4-byte atomic must be 4-byte aligned; `align` is the log2 of that.
    let arg = MemArg { align: 4, offset: 0 };

    if let Some(import_fn) = imported_func(module, ATOMIC_WAIT_THUNK_IMPORT) {
        module
            .replace_imported_func(import_fn, |(body, args)| {
                let addr = args[0];
                let expected = args[1];
                let timeout = args[2];
                body.local_get(addr);
                if is64 {
                    body.unop(UnaryOp::I64ExtendUI32);
                }
                body.local_get(expected)
                    .local_get(timeout)
                    .instr(AtomicWait { memory, arg, sixty_four: false });
            })
            .with_context(|| format!("rewriting {ATOMIC_WAIT_THUNK_IMPORT}"))?;
    }

    if let Some(import_fn) = imported_func(module, ATOMIC_NOTIFY_THUNK_IMPORT) {
        module
            .replace_imported_func(import_fn, |(body, args)| {
                let addr = args[0];
                let count = args[1];
                body.local_get(addr);
                if is64 {
                    body.unop(UnaryOp::I64ExtendUI32);
                }
                body.local_get(count).instr(AtomicNotify { memory, arg });
            })
            .with_context(|| format!("rewriting {ATOMIC_NOTIFY_THUNK_IMPORT}"))?;
    }
    Ok(())
}

/// The imported function with this name, if the build declares it.
fn imported_func(module: &Module, name: &str) -> Option<FunctionId> {
    module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != name {
            return None;
        }
        match import.kind {
            walrus::ImportKind::Function(id) => Some(id),
            _ => None,
        }
    })
}

/// Rewrite the table-write placeholder into a local thunk.
///
/// Rust cannot emit `table.set` on an imported table, so the fork module
/// declares `__wpk_fork_table_apply(dest, catalog_slot, clear)` as an import
/// and this replaces it with the three instructions it stands for. Rust keeps
/// the reconcile's striding and bounds logic, where it is testable; only the
/// write itself lives in emitted wasm.
///
/// Both bounds are wasm's own: an out-of-range `dest` or `catalog_slot` traps
/// rather than writing somewhere else.
fn inject_table_apply_thunk(module: &mut Module) -> Result<()> {
    let import_fn = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != TABLE_APPLY_THUNK_IMPORT {
            return None;
        }
        match import.kind {
            walrus::ImportKind::Function(id) => Some(id),
            _ => None,
        }
    });
    let Some(import_fn) = import_fn else {
        // A build that does not declare the placeholder needs no thunk.
        return Ok(());
    };

    let catalog = imported_table(module, FUNCTION_CATALOG_IMPORT)?;
    let indirect = imported_table(module, INDIRECT_FUNCTION_TABLE_IMPORT)?;
    let funcref = ValType::Ref(RefType::FUNCREF);
    // A 64-bit table indexes with `i64`, and Rust declared the placeholder with
    // `u32` slots because a slot ordinal is a small number on both widths. So
    // widen here, per table: on wasm64 the two tables are indexed with `i64`
    // even though the values passed are the same ordinals. Without this the
    // emitted module fails validation with "expected i64, found i32" -- which
    // is exactly how this was caught, by the injector's own validator on the
    // wasm64 build.
    let indirect_is_64 = module.tables.get(indirect).table64;
    let catalog_is_64 = module.tables.get(catalog).table64;

    module
        .replace_imported_func(import_fn, |(body, args)| {
            let dest = args[0];
            let catalog_slot = args[1];
            let clear = args[2];
            body.local_get(dest);
            if indirect_is_64 {
                body.unop(UnaryOp::I64ExtendUI32);
            }
            body.local_get(clear)
                .if_else(
                    Some(funcref),
                    |then| {
                        then.ref_null(RefType::FUNCREF);
                    },
                    |els| {
                        els.local_get(catalog_slot);
                        if catalog_is_64 {
                            els.unop(UnaryOp::I64ExtendUI32);
                        }
                        els.table_get(catalog);
                    },
                )
                .table_set(indirect);
        })
        .with_context(|| format!("rewriting {TABLE_APPLY_THUNK_IMPORT} import into a thunk"))?;
    Ok(())
}

fn inject_gc_provenance_ref(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == PROVENANCE_REF_EXPORT)
    {
        bail!("module already exports {PROVENANCE_REF_EXPORT}");
    }
    let helper = exported_function(module, PROVENANCE_WITNESS_SLOT_HELPER)?;
    let transit_table = exported_table(module, TRANSIT_TABLE_IMPORT)?;

    // Module-owned, and deliberately ROOTED: a witness the collector could take
    // would leave a later object of that layout with no type-correct seed.
    let witness_table = module.tables.add_local(
        false,
        PROVENANCE_WITNESS_SLOTS,
        Some(PROVENANCE_WITNESS_SLOTS),
        RefType::ANYREF,
    );
    module.tables.get_mut(witness_table).name = Some(PROVENANCE_WITNESS_TABLE.to_string());
    module.exports.add(PROVENANCE_WITNESS_TABLE, witness_table);

    let mut builder = FunctionBuilder::new(
        &mut module.types,
        &[ValType::I32, ValType::I32, ValType::I32],
        &[],
    );
    let token = module.locals.add(ValType::I32);
    let ordinal = module.locals.add(ValType::I32);
    let slot = module.locals.add(ValType::I32);
    let index = module.locals.add(ValType::I32);
    {
        let mut body = builder.func_body();
        body.local_get(token)
            .local_get(ordinal)
            .call(helper)
            .local_tee(index)
            .i32_const(0)
            .binop(BinaryOp::I32LtS)
            .if_else(
                None,
                |rejected| {
                    // errno is already latched by the helper.
                    rejected.return_();
                },
                |_ok| {},
            );
        body.local_get(index)
            .local_get(slot)
            .table_get(transit_table)
            .table_set(witness_table);
    }
    let shim = builder.finish(vec![token, ordinal, slot], &mut module.funcs);
    module.exports.add(PROVENANCE_REF_EXPORT, shim);
    Ok(())
}

fn inject_gc_lookup(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == GC_LOOKUP_EXPORT)
    {
        bail!("module already exports {GC_LOOKUP_EXPORT}");
    }
    let transit_table = exported_table(module, TRANSIT_TABLE_IMPORT)?;
    let find = exported_function(module, GC_IDENTITY_FIND_HELPER)?;
    let identity = import_host_ref_identity(module);

    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    let slot = module.locals.add(ValType::I32);
    let value = module.locals.add(ValType::Ref(RefType::ANYREF));
    {
        let mut body = builder.func_body();
        body.local_get(slot)
            .table_get(transit_table)
            .local_set(value);
        // A null staging slot is "new", not an error: the guest then claims,
        // which is what lets a cycle terminate rather than trap.
        body.local_get(value).ref_is_null().if_else(
            None,
            |null| {
                null.i32_const(0).return_();
            },
            |_| {},
        );
        body.local_get(value).call(identity).call(find);
    }
    let shim = builder.finish(vec![slot], &mut module.funcs);
    module.exports.add(GC_LOOKUP_EXPORT, shim);
    Ok(())
}

/// Inject the process-owned fork-unwind TAG and export it as
/// `__wpk_fork_unwind`.
///
/// The guest imports `env.__wpk_fork_unwind` as a `tag () -> ()` -- the private
/// Wasm-EH transport the instrumented capture path throws to escape a nested
/// call chain. It was minted in JavaScript, which made every host responsible
/// for creating one and handing it over.
///
/// It does not have to be. A wasm module can DEFINE a tag, export it, throw it
/// and catch it, and the export arrives in JavaScript as a real
/// `WebAssembly.Tag` -- verified against V8 before this was written. Rust cannot
/// declare a tag, which is the only reason this lives in the injector.
///
/// The type is `() -> ()`: the transport carries no payload. Taken from the
/// guest binary's own import section, not from a comment.
fn inject_unwind_tag(module: &mut Module) -> Result<()> {
    if module
        .exports
        .iter()
        .any(|export| export.name == UNWIND_TAG_EXPORT)
    {
        bail!("module already exports {UNWIND_TAG_EXPORT}");
    }
    let ty = module.types.add(&[], &[]);
    let tag = module.tags.add(ty);
    module.exports.add(UNWIND_TAG_EXPORT, tag);
    Ok(())
}

/// Resolve an exported table by name.
/// Resolve an IMPORTED table by name.
///
/// The drive table is created by an earlier pass with `add_import_table`, whose
/// id is local to that pass. A later pass that needs it must look it up rather
/// than thread the id through, and failing loud here beats emitting a
/// `call_indirect` against the wrong table.
fn imported_table(module: &Module, name: &str) -> Result<walrus::TableId> {
    module
        .imports
        .iter()
        .find_map(|import| match import.kind {
            walrus::ImportKind::Table(id)
                if import.module == IMPORT_MODULE && import.name == name =>
            {
                Some(id)
            }
            _ => None,
        })
        .ok_or_else(|| anyhow!("module does not import table {name}"))
}

fn exported_table(module: &Module, name: &str) -> Result<walrus::TableId> {
    let export = module
        .exports
        .iter()
        .find(|export| export.name == name)
        .ok_or_else(|| anyhow!("module does not export {name}"))?;
    match export.item {
        ExportItem::Table(id) => Ok(id),
        _ => bail!("{name} export is not a table"),
    }
}

/// Resolve an exported function by name, failing loud rather than letting a
/// later pass wire up a shim that calls nothing.
fn exported_function(module: &Module, name: &str) -> Result<FunctionId> {
    let export = module
        .exports
        .iter()
        .find(|export| export.name == name)
        .ok_or_else(|| anyhow!("module does not export {name}"))?;
    match export.item {
        ExportItem::Function(id) => Ok(id),
        _ => bail!("{name} export is not a function"),
    }
}

#[cfg(test)]
mod tests {
    //! M1 task 2: the injector must make the fork-module OWN + EXPORT the
    //! `(ref null any)` GC transit table (`__wpk_fork_ref_gc_transit`) rather
    //! than import it from a standalone JS-supplied table. This test builds a
    //! minimal fixture module exposing just the Rust helper exports the two
    //! `inject*` passes look up (`fm_funcref_ordinal`, `fm_drive_bump`,
    //! `fm_static_root_slot`) plus a linear memory, runs both injection passes
    //! against it exactly as `main` does, and re-parses the emitted bytes to
    //! assert on the resulting import/export sections. A real compiled
    //! `fork_module.wasm` isn't needed: the fixture only has to satisfy the
    //! lookups `inject`/`inject_drive_execute` perform.

    use super::*;

    /// Add a stub export `name: (params) -> results` whose body pushes a zero
    /// constant per result type. The injector never calls into these bodies in
    /// this test (it only needs the export *shape* to resolve `call`/
    /// `call_indirect` targets it wires up), so the bodies are placeholders.
    fn add_stub_export(
        module: &mut Module,
        name: &str,
        params: &[ValType],
        results: &[ValType],
    ) {
        let mut builder = FunctionBuilder::new(&mut module.types, params, results);
        let args: Vec<_> = params.iter().map(|ty| module.locals.add(*ty)).collect();
        {
            let mut body = builder.func_body();
            for result_ty in results {
                match result_ty {
                    ValType::I32 => {
                        body.i32_const(0);
                    }
                    other => panic!("add_stub_export: unsupported result type {other:?}"),
                }
            }
        }
        let f = builder.finish(args, &mut module.funcs);
        module.exports.add(name, f);
    }

    /// A minimal module exposing exactly the surface `inject` and
    /// `inject_drive_execute` require: the three Rust helper exports they look
    /// up by name, and a linear memory for `fm_drive_execute`'s address math.
    fn fixture_module() -> Module {
        let mut module = Module::default();
        module.memories.add_local(false, false, 1, None, None);

        add_stub_export(&mut module, ORDINAL_HELPER_EXPORT, &[ValType::I32], &[ValType::I32]);
        add_stub_export(&mut module, DRIVE_BUMP_HELPER_EXPORT, &[], &[]);
        add_stub_export(
            &mut module,
            STATIC_ROOT_SLOT_HELPER_EXPORT,
            &[ValType::I32],
            &[ValType::I32],
        );
        // M2: the externref decode export + the DRIVE_OP_EXTERNREF_TRANSIT branch
        // both look up the guest `fm_externref_handle(recipe) -> handle` helper.
        add_stub_export(
            &mut module,
            EXTERNREF_HANDLE_HELPER_EXPORT,
            &[ValType::I32],
            &[ValType::I32],
        );

        module
    }

    /// The five shared frame/resume exports the trampoline pass folds an
    /// activation id into, with the module's real argument order.
    fn add_frame_exports(module: &mut Module) {
        for name in ["fm_frame_reserve", "fm_frame_peek", "fm_frame_next"] {
            add_stub_export(module, name, &[ValType::I32, ValType::I32], &[ValType::I32]);
        }
        add_stub_export(module, "fm_frame_commit", &[ValType::I32, ValType::I32], &[]);
        add_stub_export(module, "fm_resume_peek", &[ValType::I32], &[ValType::I32]);
    }

    /// The `i32.const` an emitted trampoline body folds in, and the function it
    /// then calls.
    fn folded_activation(module: &Module, func: FunctionId) -> (i32, FunctionId) {
        let local = match &module.funcs.get(func).kind {
            walrus::FunctionKind::Local(local) => local,
            _ => panic!("trampoline is not a local function"),
        };
        let instrs = local.block(local.entry_block());
        let mut folded = None;
        let mut called = None;
        for (instr, _) in &instrs.instrs {
            match instr {
                walrus::ir::Instr::Const(c) => {
                    if let walrus::ir::Value::I32(v) = c.value {
                        folded = Some(v);
                    }
                }
                walrus::ir::Instr::Call(call) => called = Some(call.func),
                _ => {}
            }
        }
        (
            folded.expect("trampoline folds a constant"),
            called.expect("trampoline calls a shared export"),
        )
    }

    #[test]
    fn every_trampoline_folds_the_activation_it_is_indexed_by() {
        let mut module = fixture_module();
        add_frame_exports(&mut module);
        inject_activation_trampolines(&mut module).expect("trampolines inject");

        let table = module
            .exports
            .iter()
            .find(|e| e.name == ACTIVATION_TRAMPOLINE_TABLE)
            .map(|e| match e.item {
                ExportItem::Table(id) => id,
                _ => panic!("{ACTIVATION_TRAMPOLINE_TABLE} is not a table"),
            })
            .expect("the table is exported");

        let elements: Vec<FunctionId> = module
            .elements
            .iter()
            .filter(|e| matches!(e.kind, ElementKind::Active { table: t, .. } if t == table))
            .flat_map(|e| match &e.items {
                ElementItems::Functions(ids) => ids.clone(),
                _ => panic!("trampoline element is not a function list"),
            })
            .collect();
        assert_eq!(
            elements.len() as u32,
            TRAMPOLINE_ACTIVATIONS * TRAMPOLINE_SLOTS,
            "one entry per activation slot",
        );

        let targets = [
            "fm_frame_reserve",
            "fm_frame_commit",
            "fm_frame_peek",
            "fm_frame_next",
            "fm_resume_peek",
            "fm_module_state_table_state_owned",
        ];
        // Exhaustive, not spot-checked. An off-by-one in the index math, or a
        // body that folded a fresh counter instead of its own index, routes one
        // activation's frames into another's arena -- silent corruption that a
        // single sampled entry would not catch.
        for activation in 0..TRAMPOLINE_ACTIVATIONS {
            for (slot, target) in targets.iter().enumerate() {
                let index = (activation * TRAMPOLINE_SLOTS) as usize + slot;
                let (folded, called) = folded_activation(&module, elements[index]);
                assert_eq!(
                    folded, activation as i32,
                    "slot {index} must fold activation {activation}",
                );
                assert_eq!(
                    called,
                    exported_function(&module, target).unwrap(),
                    "slot {index} must call {target}",
                );
            }
        }
    }

    #[test]
    fn only_resume_peek_drops_the_guest_argument() {
        let mut module = fixture_module();
        add_frame_exports(&mut module);
        inject_activation_trampolines(&mut module).expect("trampolines inject");
        // The asymmetry is inherited from the TypeScript this replaced, so it is
        // pinned rather than left to be re-derived: four entries forward the
        // guest's argument, `resume_peek` drops it as a diagnostic the module
        // does not take. Forwarding it would make the call arity wrong.
        let frame_ty = module.types.get(
            module
                .funcs
                .get(exported_function(&module, "fm_frame_reserve").unwrap())
                .ty(),
        );
        assert_eq!(frame_ty.params().len(), 2, "frame exports take (act, arg)");
        let resume_ty = module.types.get(
            module
                .funcs
                .get(exported_function(&module, "fm_resume_peek").unwrap())
                .ty(),
        );
        assert_eq!(resume_ty.params().len(), 1, "resume_peek takes (act) only");
    }

    /// Count every `any.convert_extern` instruction in a local function body.
    /// The externref-transit drive branch is the only place the injector emits
    /// one (the funcref/externref decode exports never do), so a nonzero count in
    /// `fm_drive_execute` is proof the DRIVE_OP_EXTERNREF_TRANSIT path was built.
    #[derive(Default)]
    struct AnyConvertExternCounter {
        count: usize,
    }
    impl<'instr> walrus::ir::Visitor<'instr> for AnyConvertExternCounter {
        fn visit_instr(
            &mut self,
            instr: &'instr walrus::ir::Instr,
            _loc: &'instr walrus::InstrLocId,
        ) {
            if matches!(instr, walrus::ir::Instr::AnyConvertExtern(_)) {
                self.count += 1;
            }
        }
    }

    fn any_convert_extern_count(module: &Module, export_name: &str) -> usize {
        let export = module
            .exports
            .iter()
            .find(|export| export.name == export_name)
            .expect("export present");
        let ExportItem::Function(id) = export.item else {
            panic!("{export_name} is not a function export");
        };
        let local = module.funcs.get(id).kind.unwrap_local();
        let mut counter = AnyConvertExternCounter::default();
        walrus::ir::dfs_in_order(&mut counter, local, local.entry_block());
        counter.count
    }

    #[test]
    fn injects_externref_decode_export_and_resolve_import() {
        let mut module = fixture_module();
        inject(&mut module).expect("inject __wpk_fork_ref_decode_funcref");
        inject_decode_externref(&mut module).expect("inject __wpk_fork_ref_decode_externref");
        inject_drive_execute(&mut module).expect("inject fm_drive_execute");

        let out_bytes = module.emit_wasm();
        let reparsed = Module::from_buffer(&out_bytes).expect("reparse injected module");

        // (a) The output IMPORTS env.resolve_externref : (i32) -> externref.
        let resolve_import = reparsed
            .imports
            .iter()
            .find(|import| {
                import.module == IMPORT_MODULE && import.name == RESOLVE_EXTERNREF_IMPORT
            })
            .expect("resolve_externref must be imported after injection");
        let ImportKind::Function(resolve_fn) = resolve_import.kind else {
            panic!("resolve_externref import must be a function");
        };
        let resolve_sig = reparsed.types.get(reparsed.funcs.get(resolve_fn).ty());
        assert_eq!(resolve_sig.params(), &[ValType::I32]);
        assert_eq!(
            resolve_sig.results(),
            &[ValType::Ref(RefType::EXTERNREF)],
            "resolve_externref must return an externref"
        );
        // find-or-add must never double-declare the import.
        assert_eq!(
            reparsed
                .imports
                .iter()
                .filter(|import| import.module == IMPORT_MODULE
                    && import.name == RESOLVE_EXTERNREF_IMPORT)
                .count(),
            1,
            "resolve_externref must be imported exactly once"
        );

        // (b) The output EXPORTS __wpk_fork_ref_decode_externref : (i32) -> externref.
        let decode = reparsed
            .exports
            .iter()
            .find(|export| export.name == DECODE_EXTERNREF_EXPORT)
            .expect("must export the externref decode shim");
        let ExportItem::Function(decode_fn) = decode.item else {
            panic!("{DECODE_EXTERNREF_EXPORT} export must be a function");
        };
        let decode_sig = reparsed.types.get(reparsed.funcs.get(decode_fn).ty());
        assert_eq!(decode_sig.params(), &[ValType::I32]);
        assert_eq!(
            decode_sig.results(),
            &[ValType::Ref(RefType::EXTERNREF)],
            "the decode export must return an externref"
        );

        // (c) The fm_drive_execute body contains the op-4 externref-transit path:
        // exactly one `any.convert_extern` (extern -> any) lives in the drive loop;
        // the decode export never emits one. Re-parse above already re-validated the
        // whole module, so a live count here proves the branch encodes correctly.
        assert!(
            reparsed
                .exports
                .iter()
                .any(|export| export.name == DRIVE_EXECUTE_EXPORT),
            "fm_drive_execute must still be exported"
        );
        assert_eq!(
            any_convert_extern_count(&reparsed, DRIVE_EXECUTE_EXPORT),
            1,
            "fm_drive_execute must contain exactly one any.convert_extern (the op-4 branch)"
        );
        assert_eq!(
            any_convert_extern_count(&reparsed, DECODE_EXTERNREF_EXPORT),
            0,
            "the externref decode shim must be a direct resolve call, no any.convert_extern"
        );
    }

    #[test]
    fn transit_table_is_module_owned_export_not_import() {
        let mut module = fixture_module();
        inject(&mut module).expect("inject __wpk_fork_ref_decode_funcref");
        inject_drive_execute(&mut module).expect("inject fm_drive_execute");

        // Round-trip through bytes and re-parse with a fresh walrus `Module`,
        // so the assertion reflects what actually lands in the wasm binary's
        // import/export sections, not just in-memory IR state.
        let out_bytes = module.emit_wasm();
        let reparsed = Module::from_buffer(&out_bytes).expect("reparse injected module");

        let still_imported = reparsed
            .imports
            .iter()
            .any(|import| import.name == TRANSIT_TABLE_IMPORT);
        assert!(
            !still_imported,
            "{TRANSIT_TABLE_IMPORT} must no longer be an import after injection (M1)"
        );

        let exported_as_table = reparsed.exports.iter().any(|export| {
            export.name == TRANSIT_TABLE_IMPORT && matches!(export.item, ExportItem::Table(_))
        });
        assert!(
            exported_as_table,
            "{TRANSIT_TABLE_IMPORT} must be exported as a table after injection (M1)"
        );

        // The other imported tables (function catalog, drive table, static-root
        // catalog) are unaffected by this change and must still be imports.
        for still_import_name in [
            FUNCTION_CATALOG_IMPORT,
            DRIVE_TABLE_IMPORT,
            STATIC_ROOT_CATALOG_IMPORT,
        ] {
            assert!(
                reparsed
                    .imports
                    .iter()
                    .any(|import| import.name == still_import_name),
                "{still_import_name} should remain imported"
            );
        }
    }
}
