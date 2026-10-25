//! Validate original identities and reserve the optional sink callback.
use super::*;
use anyhow::Context;
use wasm_encoder::{EntityType, FuncType};

pub(super) fn validate_closure(
    scan: &Scan<'_>,
    reaching: &ReachingPlan,
    options: &PipelineOptions,
    budget: usize,
) -> Result<()> {
    let functions = scan.functions.len();
    ensure!(
        functions <= budget / 128,
        "native pipeline closure exceeds metadata budget"
    );
    for &function in reaching
        .activations
        .iter()
        .chain(&reaching.control_reachable)
    {
        ensure!(
            (function as usize) < functions,
            "native pipeline closure has unknown function"
        );
    }
    ensure!(
        reaching.tail_sites.len() <= budget / 64,
        "native pipeline tail sites exceed metadata budget"
    );
    for point in &reaching.tail_sites {
        ensure!(
            scan.functions
                .get(point.function as usize)
                .and_then(|f| f.body.as_ref())
                .is_some_and(|body| body.range.contains(&point.offset)),
            "native pipeline tail site is outside its source body"
        );
    }
    for function in &options.boundaries {
        ensure!(
            reaching.activations.contains(function)
                && scan.functions[*function as usize].body.is_some(),
            "native pipeline boundary is not a selected source body"
        );
    }
    Ok(())
}

pub(super) fn reserve_boundary(
    scan: &Scan<'_>,
    inputs: &mut RuntimeInputs,
    options: &PipelineOptions,
) -> Result<Option<u32>> {
    if options.boundaries.is_empty() {
        return Ok(None);
    }
    let ty = scan
        .types
        .as_ref()
        .core_type_count_in_module()
        .checked_add(u32::try_from(inputs.types.len())?)
        .context("native pipeline boundary type overflow")?;
    inputs.types.push(FuncType::new([], []));
    let ordinal = u32::try_from(inputs.imports.len())?;
    inputs.imports.push(PlannedImport {
        module: wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_MODULE.into(),
        name: wasm_posix_shared::abi::WPK_FORK_BOUNDARY_IMPORT.into(),
        ty: EntityType::Function(ty),
    });
    Ok(Some(ordinal))
}
