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
use walrus::ir::BinaryOp;
use walrus::{ExportItem, FunctionBuilder, Module, RefType, ValType};

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
    let out_bytes = module.emit_wasm();
    std::fs::write(&output, &out_bytes).with_context(|| format!("writing {output}"))?;
    eprintln!(
        "fork-module-inject: {input} -> {output} ({} bytes, added {DECODE_FUNCREF_EXPORT} + \
         imported {IMPORT_MODULE}.{FUNCTION_CATALOG_IMPORT})",
        out_bytes.len()
    );
    Ok(())
}
