use super::bindings::{function, ty};
use super::*;

pub(super) fn reserve(
    scan: &Scan<'_>,
    inputs: &mut RuntimeInputs,
    first_helper: u32,
    limits: LoaderLimits,
) -> Result<LegacyLoaderPlan> {
    let mut work = limits.work;
    let mut metadata = limits.metadata_bytes;
    spend(&mut work, scan.functions.len())?;
    let mut adapters = Vec::new();
    for (source, function) in scan.functions.iter().enumerate() {
        if !function
            .import
            .as_ref()
            .is_some_and(|(module, name)| module == "env" && name == "__wasm_dlopen")
        {
            continue;
        }
        let signature = scan
            .types
            .as_ref()
            .get(scan.types.as_ref().core_type_at_in_module(function.ty))
            .unwrap()
            .composite_type
            .unwrap_func();
        let parameters = signature.params();
        ensure!(
            matches!(parameters.len(), 2 | 4 | 5)
                && signature.results() == [wasmparser::ValType::I32]
                && matches!(
                    parameters[0],
                    wasmparser::ValType::I32 | wasmparser::ValType::I64
                )
                && matches!(
                    parameters[1],
                    wasmparser::ValType::I32 | wasmparser::ValType::I64
                )
                && (parameters.len() == 2 || parameters[2] == parameters[0])
                && (parameters.len() == 2
                    || matches!(
                        parameters[3],
                        wasmparser::ValType::I32 | wasmparser::ValType::I64
                    ))
                && (parameters.len() != 5 || parameters[4] == wasmparser::ValType::I32),
            "reserved env.__wasm_dlopen must have (pointer, integer[, pointer, integer[, i32]]) -> i32"
        );
        spend(&mut metadata, 512)?;
        adapters.push(Adapter {
            source: u32::try_from(source)?,
            ty: function.ty,
            parameters: parameters
                .iter()
                .map(|ty| {
                    if *ty == wasmparser::ValType::I64 {
                        ValType::I64
                    } else {
                        ValType::I32
                    }
                })
                .collect(),
            prepare: Binding::Planned(0),
        });
    }
    let mut output = LegacyLoaderPlan {
        source: scan.source_fingerprint(),
        first_helper,
        adapters,
        protocol: None,
        limits,
    };
    if output.adapters.is_empty() {
        return Ok(output);
    }
    for adapter in &output.adapters {
        spend(&mut work, inputs.function_adapters.len())?;
        ensure!(
            !inputs
                .function_adapters
                .iter()
                .any(|existing| existing.source_function == adapter.source),
            "legacy loader import already has an adapter"
        );
    }
    first_helper
        .checked_add(u32::try_from(output.adapters.len())?)
        .context("loader helper ordinal overflow")?;
    let main = function(
        scan,
        inputs,
        "__wasm_dlopen_main",
        &[],
        &mut work,
        &mut metadata,
    )?;
    let next = function(
        scan,
        inputs,
        "__wasm_dlopen_next",
        &[ValType::I32],
        &mut work,
        &mut metadata,
    )?;
    let commit = function(
        scan,
        inputs,
        "__wasm_dlopen_commit",
        &[ValType::I32],
        &mut work,
        &mut metadata,
    )?;
    for (index, adapter) in output.adapters.iter_mut().enumerate() {
        let parameters = match adapter.parameters.as_slice() {
            [pointer, length] => vec![*pointer, *length, *pointer, *length, ValType::I32],
            four if four.len() == 4 => four.iter().copied().chain([ValType::I32]).collect(),
            five => five.to_vec(),
        };
        adapter.prepare = function(
            scan,
            inputs,
            "__wasm_dlopen_prepare",
            &parameters,
            &mut work,
            &mut metadata,
        )?;
        spend(&mut metadata, 256)?;
        inputs.function_adapters.push(FunctionAdapter {
            source_function: adapter.source,
            helper_ordinal: first_helper + 1 + index as u32,
        });
    }
    spend(&mut work, inputs.function_adapters.len().saturating_mul(32))?;
    inputs
        .function_adapters
        .sort_by_key(|adapter| adapter.source_function);
    let driver_type = ty(
        scan,
        inputs,
        &[ValType::I32],
        &[ValType::I32],
        &mut work,
        &mut metadata,
    )?;
    let initializer_type = ty(scan, inputs, &[], &[], &mut work, &mut metadata)?;
    spend(&mut work, scan.exports.len())?;
    let table = scan.exports.iter().find_map(|(name, kind, index)| {
        if name == "__indirect_function_table" && *kind == wasmparser::ExternalKind::Table {
            let table = scan.types.as_ref().table_at(*index);
            (table.element_type == wasmparser::RefType::FUNCREF).then_some((*index, table.table64))
        } else {
            None
        }
    });
    let checkpoint = scan.exports.iter().find_map(|(name, kind, index)| {
        if name != "__wasm_posix_signal_checkpoint" || *kind != wasmparser::ExternalKind::Func {
            return None;
        }
        let signature = scan
            .types
            .as_ref()
            .get(
                scan.types
                    .as_ref()
                    .core_type_at_in_module(scan.functions[*index as usize].ty),
            )
            .unwrap()
            .composite_type
            .unwrap_func();
        (signature.params().is_empty() && signature.results().is_empty()).then_some(*index)
    });
    output.protocol = Some(Protocol {
        main,
        next,
        commit,
        driver_type,
        initializer_type,
        table,
        checkpoint,
    });
    Ok(output)
}

pub(super) fn spend(remaining: &mut usize, cost: usize) -> Result<()> {
    *remaining = remaining
        .checked_sub(cost)
        .context("loader plan exceeds resource budget")?;
    Ok(())
}
