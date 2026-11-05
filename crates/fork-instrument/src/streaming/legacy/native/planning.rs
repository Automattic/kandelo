use super::*;

pub(super) fn discover<T: Reencode>(
    scan: &Scan<'_>,
    body: &FunctionIr<'_>,
    source_types: &SourceTypes,
    map: &mut T,
    limits: LegacyHandlerLimits,
) -> Result<NativeLegacyPlan>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let ownership = LegacyHandlerPlan::discover(body, limits)?;
    let mut budget = Budget {
        metadata: limits.metadata_bytes,
        work: limits.work,
    };
    let mut regions = BTreeMap::new();
    let mut handlers = Vec::new();
    budget.work(body.regions.len())?;
    for handler in ownership.handlers() {
        budget.work(1)?;
        if !regions.contains_key(&handler.region) {
            budget.metadata(4)?;
            let (parameters, results) = signature(scan, body, handler.region)?;
            let parameters = values(parameters, source_types, map, &mut budget)?;
            let results = values(results, source_types, map, &mut budget)?;
            regions.insert(
                handler.region,
                NativeLegacyRegion {
                    parameters,
                    results,
                    handlers: Vec::new(),
                    body_type: None,
                    private_type: None,
                },
            );
        }
        let source = &body.regions[handler.region.0].handlers[handler.ordinal];
        let payload = source
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
        let payload = values(payload, source_types, map, &mut budget)?;
        budget.metadata(4)?;
        regions
            .get_mut(&handler.region)
            .unwrap()
            .handlers
            .push(LegacyHandlerId(handlers.len()));
        handlers.push(NativeLegacyHandler {
            payload,
            tag: source.tag.map(|tag| map.tag_index(tag)).transpose()?,
            exception: None,
            capture_type: None,
            private_type: None,
            exception_type: None,
        });
    }
    let mut exits = BTreeMap::new();
    for (key @ (_, target), _) in ownership.exits() {
        budget.work(1)?;
        budget.metadata(4)?;
        let (parameters, results) = signature(scan, body, target)?;
        let branch = if body.regions[target.0].kind == RegionKind::Loop {
            parameters
        } else {
            results
        };
        exits.insert(
            key,
            NativeLegacyExit {
                values: values(branch, source_types, map, &mut budget)?,
                block_type: None,
            },
        );
    }
    let forwards = super::forwarding::discover(scan, body, source_types, map, &mut budget)?;
    let mut delegates = BTreeMap::new();
    for (index, region) in body.regions.iter().enumerate() {
        budget.work(1)?;
        if region.delegate.is_none() || !body.instructions[region.opener.unwrap()].retained {
            continue;
        }
        budget.metadata(4)?;
        let (parameters, results) = signature(scan, body, RegionId(index))?;
        delegates.insert(
            RegionId(index),
            NativeLegacyDelegate {
                parameters: values(parameters, source_types, map, &mut budget)?,
                results: values(results, source_types, map, &mut budget)?,
                body_type: None,
                private_type: None,
                exception_type: None,
            },
        );
    }
    Ok(NativeLegacyPlan {
        ownership,
        regions,
        handlers,
        exits,
        forwards,
        delegates,
        limits,
        allocated: false,
    })
}

pub(super) fn signature<'s>(
    scan: &'s Scan<'_>,
    body: &'s FunctionIr<'_>,
    region: RegionId,
) -> Result<(&'s [wasmparser::ValType], &'s [wasmparser::ValType])> {
    let index = if region == RegionId(0) {
        body.type_index
    } else {
        match &body.regions[region.0].signature {
            wasmparser::BlockType::Empty => return Ok((&[], &[])),
            wasmparser::BlockType::Type(ty) => return Ok((&[], std::slice::from_ref(ty))),
            wasmparser::BlockType::FuncType(index) => *index,
        }
    };
    let ty = scan
        .types
        .as_ref()
        .get(scan.types.as_ref().core_type_at_in_module(index))
        .context("unknown legacy control signature")?
        .composite_type
        .unwrap_func();
    Ok((ty.params(), ty.results()))
}
pub(super) fn values<T: Reencode>(
    input: &[wasmparser::ValType],
    types: &SourceTypes,
    map: &mut T,
    budget: &mut Budget,
) -> Result<Vec<ValType>>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    budget.work(input.len())?;
    budget.metadata(input.len())?;
    input.iter().map(|&ty| types.value_type(map, ty)).collect()
}
