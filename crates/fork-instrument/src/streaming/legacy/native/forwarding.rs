//! Delegates forward exception references to a landing in the target arm.
//! Rethrowing there resumes handler search at the original lexical scope.
use super::*;

pub(super) fn discover<T: Reencode>(
    scan: &Scan<'_>,
    body: &FunctionIr<'_>,
    types: &SourceTypes,
    map: &mut T,
    budget: &mut Budget,
) -> Result<BTreeMap<(RegionId, usize), NativeLegacyForward>>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let mut targets = std::collections::BTreeSet::new();
    for region in &body.regions {
        budget.work(1)?;
        if let Some(target) = region.delegate
            && body.instructions[region.opener.unwrap()].retained
        {
            budget.metadata(1)?;
            targets.insert(target);
        }
    }
    let mut forwards = BTreeMap::new();
    for target in targets {
        let source = &body.regions[target.0];
        let (parameters, results) = planning::signature(scan, body, target)?;
        let parameters = if target == RegionId(0) {
            &[][..]
        } else {
            parameters
        };
        insert(
            &mut forwards,
            (target, 0),
            parameters,
            results,
            types,
            map,
            budget,
        )?;
        if source.alternative.is_some() {
            insert(
                &mut forwards,
                (target, 1),
                parameters,
                results,
                types,
                map,
                budget,
            )?;
        }
        if source.kind == RegionKind::LegacyTry {
            for handler in &source.handlers {
                let payload = handler
                    .tag
                    .map(|tag| {
                        scan.types
                            .as_ref()
                            .get(scan.types.as_ref().tag_at(tag))
                            .unwrap()
                            .composite_type
                            .unwrap_func()
                            .params()
                    })
                    .unwrap_or(&[]);
                insert(
                    &mut forwards,
                    (target, handler.ordinal + 1),
                    payload,
                    results,
                    types,
                    map,
                    budget,
                )?;
            }
        }
    }
    Ok(forwards)
}
#[allow(clippy::too_many_arguments)]
fn insert<T: Reencode>(
    forwards: &mut BTreeMap<(RegionId, usize), NativeLegacyForward>,
    key: (RegionId, usize),
    parameters: &[wasmparser::ValType],
    results: &[wasmparser::ValType],
    types: &SourceTypes,
    map: &mut T,
    budget: &mut Budget,
) -> Result<()>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    budget.work(1)?;
    budget.metadata(4)?;
    forwards.insert(
        key,
        NativeLegacyForward {
            parameters: planning::values(parameters, types, map, budget)?,
            results: planning::values(results, types, map, budget)?,
            normal_type: None,
            exception_type: None,
        },
    );
    Ok(())
}
