//! Lower the historical monolithic dynamic-loader import to ABI 43's staged
//! non-reentrant protocol.
//!
//! `env.__wasm_dlopen` used to compile, instantiate, and synchronously call
//! side-module initialization code before its host import returned. A fork
//! below that callback leaves a JavaScript activation in the middle of the
//! Wasm stack, and that activation has no deterministic fresh-child recipe.
//! The staged imports return one initializer table entry at a time so the
//! initializer instead runs as an ordinary Wasm-to-Wasm call.

use anyhow::{Result, ensure};
use walrus::ir::{
    BinaryOp, Binop, Br, Call, CallIndirect, Const, LocalGet, LocalSet, Return, ReturnCall,
    UnaryOp, Unop, Unreachable, Value,
};
use walrus::{
    ExportItem, FunctionBuilder, FunctionId, FunctionKind, ImportKind, LocalId, Module, RefType,
    TableId, TypeId, ValType,
};

const IMPORT_MODULE: &str = "env";
const LEGACY_IMPORT: &str = "__wasm_dlopen";
const MAIN_IMPORT: &str = "__wasm_dlopen_main";
const PREPARE_IMPORT: &str = "__wasm_dlopen_prepare";
const NEXT_IMPORT: &str = "__wasm_dlopen_next";
const COMMIT_IMPORT: &str = "__wasm_dlopen_commit";
const SIGNAL_CHECKPOINT_EXPORT: &str = "__wasm_posix_signal_checkpoint";
const DEFAULT_RTLD_GLOBAL: i32 = 0x100;

#[derive(Clone)]
struct LegacyImport {
    function: FunctionId,
    import: walrus::ImportId,
    ty: TypeId,
    params: Vec<ValType>,
}

/// Replace every canonical legacy loader import with a local staged adapter.
///
/// The original `FunctionId` is retained. That is important beyond direct
/// calls: exports, active/passive element segments, constant expressions, and
/// `ref.func` instructions all continue to name the now-local adapter without
/// an incomplete graph-wide reference rewrite.
pub fn lower(module: &mut Module) -> Result<usize> {
    let legacy = collect_legacy_imports(module);
    if legacy.is_empty() {
        return Ok(0);
    }

    for import in &legacy {
        validate_signature(module, import)?;
    }

    let table = process_function_table(module);
    let checkpoint = exported_signal_checkpoint(module);
    let main = import_function(module, MAIN_IMPORT, &[], &[ValType::I32]);
    let next = import_function(
        module,
        NEXT_IMPORT,
        &[ValType::I32],
        &[ValType::I32],
    );
    let commit = import_function(
        module,
        COMMIT_IMPORT,
        &[ValType::I32],
        &[ValType::I32],
    );
    let driver = add_staged_driver(module, table, next, commit, checkpoint);

    for import in &legacy {
        let prepare_params = match import.params.as_slice() {
            [pointer, length] => vec![*pointer, *length, *pointer, *length, ValType::I32],
            [_, _, _, _] => {
                let mut params = import.params.clone();
                params.push(ValType::I32);
                params
            }
            _ => import.params.clone(),
        };
        let prepare = import_function(
            module,
            PREPARE_IMPORT,
            &prepare_params,
            &[ValType::I32],
        );
        replace_import_with_adapter(module, import, main, prepare, driver)?;
    }

    Ok(legacy.len())
}

fn collect_legacy_imports(module: &Module) -> Vec<LegacyImport> {
    module
        .imports
        .iter()
        .filter_map(|import| {
            if import.module != IMPORT_MODULE || import.name != LEGACY_IMPORT {
                return None;
            }
            let ImportKind::Function(function) = import.kind else {
                return None;
            };
            let ty = module.funcs.get(function).ty();
            Some(LegacyImport {
                function,
                import: import.id(),
                ty,
                params: module.types.get(ty).params().to_vec(),
            })
        })
        .collect()
}

fn validate_signature(module: &Module, import: &LegacyImport) -> Result<()> {
    let signature = module.types.get(import.ty);
    ensure!(
        matches!(import.params.len(), 2 | 4 | 5)
            && signature.results() == [ValType::I32]
            && matches!(import.params[0], ValType::I32 | ValType::I64)
            && matches!(import.params[1], ValType::I32 | ValType::I64)
            && (import.params.len() == 2 || import.params[2] == import.params[0])
            && (import.params.len() == 2
                || matches!(import.params[3], ValType::I32 | ValType::I64))
            && (import.params.len() != 5 || import.params[4] == ValType::I32),
        "fork-instrument: reserved env.__wasm_dlopen import has signature \
         {:?} -> {:?}; expected (pointer, integer[, pointer, integer[, i32]]) -> i32",
        signature.params(),
        signature.results(),
    );
    Ok(())
}

fn process_function_table(module: &mut Module) -> TableId {
    let exported = module.exports.iter().find_map(|export| {
        if export.name != "__indirect_function_table" {
            return None;
        }
        match export.item {
            ExportItem::Table(table) if module.tables.get(table).element_ty == RefType::FUNCREF => {
                Some(table)
            }
            _ => None,
        }
    });
    exported.unwrap_or_else(|| {
        // A successful Kandelo side-module load already requires the canonical
        // exported table and stack pointer. Keep malformed/dead legacy imports
        // valid after lowering without inventing a second observable process
        // function-pointer table; `prepare` will report the missing host
        // linker contract before this private fallback can be reached.
        module.tables.add_local(false, 1, None, RefType::FUNCREF)
    })
}

fn exported_signal_checkpoint(module: &Module) -> Option<FunctionId> {
    module.exports.iter().find_map(|export| {
        if export.name != SIGNAL_CHECKPOINT_EXPORT {
            return None;
        }
        let ExportItem::Function(function) = export.item else {
            return None;
        };
        let signature = module.types.get(module.funcs.get(function).ty());
        (signature.params().is_empty() && signature.results().is_empty()).then_some(function)
    })
}

fn import_function(
    module: &mut Module,
    name: &str,
    params: &[ValType],
    results: &[ValType],
) -> FunctionId {
    if let Some(function) = module.imports.iter().find_map(|import| {
        if import.module != IMPORT_MODULE || import.name != name {
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
    let ty = module.types.add(params, results);
    module.add_import_func(IMPORT_MODULE, name, ty).0
}

fn add_staged_driver(
    module: &mut Module,
    table: TableId,
    next: FunctionId,
    commit: FunctionId,
    checkpoint: Option<FunctionId>,
) -> FunctionId {
    let token = module.locals.add(ValType::I32);
    let entry = module.locals.add(ValType::I32);
    let call_ty = module.types.add(&[], &[]);
    let mut builder =
        FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    builder.name("__wpk_fork_legacy_dlopen_driver".into());

    let mut loop_body = builder.dangling_instr_seq(None);
    let loop_id = loop_body.id();

    // A prepare call can issue loader-owned channel requests. Checkpoint only
    // after the adapter's tail call has removed its dead pointer parameters,
    // keeping those values out of a continuation captured by a signal handler.
    call_optional(&mut loop_body, checkpoint);

    local_get(&mut loop_body, token);
    call(&mut loop_body, next);
    local_set(&mut loop_body, entry);
    call_optional(&mut loop_body, checkpoint);

    local_get(&mut loop_body, entry);
    i32_const(&mut loop_body, 0);
    binop(&mut loop_body, BinaryOp::I32LtS);
    loop_body.if_else(
        None,
        |failed| {
            i32_const(failed, 0);
            ret(failed);
        },
        |_| {},
    );

    local_get(&mut loop_body, entry);
    unop(&mut loop_body, UnaryOp::I32Eqz);
    loop_body.if_else(
        None,
        |finished| {
            local_get(finished, token);
            call(finished, commit);
            local_set(finished, entry);
            call_optional(finished, checkpoint);
            local_get(finished, entry);
            ret(finished);
        },
        |_| {},
    );

    local_get(&mut loop_body, entry);
    if module.tables.get(table).table64 {
        unop(&mut loop_body, UnaryOp::I64ExtendUI32);
    }
    loop_body.instr(CallIndirect { ty: call_ty, table });
    loop_body.instr(Br { block: loop_id });
    drop(loop_body);

    let mut body = builder.func_body();
    body.instr(walrus::ir::Loop { seq: loop_id });
    body.instr(Unreachable {});
    builder.finish(vec![token], &mut module.funcs)
}

fn replace_import_with_adapter(
    module: &mut Module,
    import: &LegacyImport,
    main: FunctionId,
    prepare: FunctionId,
    driver: FunctionId,
) -> Result<()> {
    let args: Vec<LocalId> = import
        .params
        .iter()
        .copied()
        .map(|ty| module.locals.add(ty))
        .collect();
    let mut builder =
        FunctionBuilder::new(&mut module.types, &import.params, &[ValType::I32]);
    builder.name("__wpk_fork_legacy_dlopen_adapter".into());

    let body = &mut builder.func_body();
    if args.len() >= 4 {
        local_get(body, args[1]);
        integer_eqz(body, import.params[1]);
        local_get(body, args[3]);
        integer_eqz(body, import.params[3]);
        binop(body, BinaryOp::I32And);
        body.if_else(
            None,
            |main_program| {
                call(main_program, main);
                ret(main_program);
            },
            |_| {},
        );
    }

    local_get(body, args[0]);
    local_get(body, args[1]);
    if args.len() == 2 {
        // The original Kandelo loader ABI supplied no pathname. Preserve its
        // deterministic `dlopen:<buffer>:<length>` naming rule by passing an
        // empty name range; the process Worker derives the historical name
        // after validating both ranges.
        integer_const_zero(body, import.params[0]);
        integer_const_zero(body, import.params[1]);
    } else {
        local_get(body, args[2]);
        local_get(body, args[3]);
    }
    if args.len() == 5 {
        local_get(body, args[4]);
    } else {
        i32_const(body, DEFAULT_RTLD_GLOBAL);
    }
    call(body, prepare);
    // WHY: no guest code ran during prepare, so this true tail call removes
    // the adapter's byte/name pointer parameters before a constructor or
    // signal handler can fork. Only the driver's two i32 values can then add
    // to the continuation payload, regardless of pointer width.
    body.instr(ReturnCall { func: driver });

    let local = builder.local_func(args);
    ensure!(
        local.ty() == import.ty,
        "fork-instrument: legacy dlopen adapter did not retain its canonical function type",
    );
    let function = module.funcs.get_mut(import.function);
    function.kind = FunctionKind::Local(local);
    function.name = Some("__wpk_fork_legacy_dlopen_adapter".into());
    module.imports.delete(import.import);
    Ok(())
}

fn integer_eqz(body: &mut walrus::InstrSeqBuilder<'_>, ty: ValType) {
    unop(
        body,
        match ty {
            ValType::I32 => UnaryOp::I32Eqz,
            ValType::I64 => UnaryOp::I64Eqz,
            _ => unreachable!("validated legacy dlopen integer"),
        },
    );
}

fn integer_const_zero(body: &mut walrus::InstrSeqBuilder<'_>, ty: ValType) {
    body.instr(Const {
        value: match ty {
            ValType::I32 => Value::I32(0),
            ValType::I64 => Value::I64(0),
            _ => unreachable!("validated legacy dlopen integer"),
        },
    });
}

fn local_get(body: &mut walrus::InstrSeqBuilder<'_>, local: LocalId) {
    body.instr(LocalGet { local });
}

fn local_set(body: &mut walrus::InstrSeqBuilder<'_>, local: LocalId) {
    body.instr(LocalSet { local });
}

fn call(body: &mut walrus::InstrSeqBuilder<'_>, function: FunctionId) {
    body.instr(Call { func: function });
}

fn call_optional(body: &mut walrus::InstrSeqBuilder<'_>, function: Option<FunctionId>) {
    if let Some(function) = function {
        call(body, function);
    }
}

fn i32_const(body: &mut walrus::InstrSeqBuilder<'_>, value: i32) {
    body.instr(Const {
        value: Value::I32(value),
    });
}

fn binop(body: &mut walrus::InstrSeqBuilder<'_>, op: BinaryOp) {
    body.instr(Binop { op });
}

fn unop(body: &mut walrus::InstrSeqBuilder<'_>, op: UnaryOp) {
    body.instr(Unop { op });
}

fn ret(body: &mut walrus::InstrSeqBuilder<'_>) {
    body.instr(Return {});
}
