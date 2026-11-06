//! Reuse canonical scalar signatures and staged imports before freezing.
use super::planning::spend;
use super::*;

pub(super) fn function(
    scan: &Scan<'_>,
    inputs: &mut RuntimeInputs,
    name: &str,
    parameters: &[ValType],
    work: &mut usize,
    metadata: &mut usize,
) -> Result<Binding> {
    let signature = ty(scan, inputs, parameters, &[ValType::I32], work, metadata)?;
    spend(
        work,
        scan.imported_functions as usize + inputs.imports.len(),
    )?;
    for (source, function) in scan.functions[..scan.imported_functions as usize]
        .iter()
        .enumerate()
    {
        let composite = &scan
            .types
            .as_ref()
            .get(scan.types.as_ref().core_type_at_in_module(function.ty))
            .unwrap()
            .composite_type;
        let existing = composite.unwrap_func();
        if !composite.shared
            && equal(existing.params(), parameters)
            && equal(existing.results(), &[ValType::I32])
            && function
                .import
                .as_ref()
                .is_some_and(|(module, field)| module == "env" && field == name)
        {
            return Ok(Binding::Source(source.try_into()?));
        }
    }
    if let Some((ordinal, _)) = inputs.imports.iter().enumerate().find(|(_, import)| {
        import.module == "env"
            && import.name == name
            && matches!(import.ty, EntityType::Function(index) if index == signature)
    }) {
        return Ok(Binding::Planned(ordinal.try_into()?));
    }
    spend(metadata, name.len() + 256)?;
    let ordinal = u32::try_from(inputs.imports.len())?;
    inputs.imports.push(PlannedImport {
        module: "env".into(),
        name: name.into(),
        ty: EntityType::Function(signature),
    });
    Ok(Binding::Planned(ordinal))
}
pub(super) fn ty(
    scan: &Scan<'_>,
    inputs: &mut RuntimeInputs,
    parameters: &[ValType],
    results: &[ValType],
    work: &mut usize,
    metadata: &mut usize,
) -> Result<u32> {
    let source = scan.types.as_ref();
    spend(
        work,
        source.core_type_count_in_module() as usize + inputs.types.len(),
    )?;
    for index in 0..source.core_type_count_in_module() {
        let composite = &source
            .get(source.core_type_at_in_module(index))
            .unwrap()
            .composite_type;
        if composite.shared {
            continue;
        }
        if let wasmparser::CompositeInnerType::Func(signature) = &composite.inner {
            if equal(signature.params(), parameters) && equal(signature.results(), results) {
                return Ok(index);
            }
        }
    }
    if let Some(index) = inputs
        .types
        .iter()
        .position(|ty| ty.params() == parameters && ty.results() == results)
    {
        return source
            .core_type_count_in_module()
            .checked_add(index.try_into()?)
            .context("loader type index overflow");
    }
    spend(metadata, 256 + (parameters.len() + results.len()) * 8)?;
    let index = source
        .core_type_count_in_module()
        .checked_add(inputs.types.len().try_into()?)
        .context("loader type index overflow")?;
    inputs.types.push(FuncType::new(
        parameters.iter().copied(),
        results.iter().copied(),
    ));
    Ok(index)
}

fn equal(source: &[wasmparser::ValType], planned: &[ValType]) -> bool {
    source.len() == planned.len()
        && source.iter().zip(planned).all(|(source, planned)| {
            matches!(
                (source, planned),
                (wasmparser::ValType::I32, ValType::I32) | (wasmparser::ValType::I64, ValType::I64)
            )
        })
}
