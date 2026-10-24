use super::*;

pub(super) fn discover(
    body: &FunctionIr<'_>,
    limits: LegacyHandlerLimits,
) -> Result<LegacyHandlerPlan> {
    let mut budget = Budget {
        metadata: limits.metadata_bytes,
        work: limits.work,
    };
    budget.work(body.regions.len())?;
    let mut plan = LegacyHandlerPlan::default();
    if !body.regions.iter().any(|region| {
        region.kind == RegionKind::LegacyTry
            && !region.handlers.is_empty()
            && body.instructions[region.opener.unwrap()].retained
    }) {
        return Ok(plan);
    }
    budget.metadata(body.regions.len())?;
    let mut inherited = vec![None; body.regions.len()];
    let mut caught = vec![None; body.regions.len()];
    let mut active = None;
    let mut transfers = body.transfers.iter().peekable();
    for (index, source) in body.instructions.iter().enumerate() {
        budget.work(1)?;
        if let Some(region) = source.opens {
            inherited[region.0] = active;
        }
        match source.operation {
            Operator::Catch { .. } | Operator::CatchAll => {
                active = inherited[source.region.0];
                caught[source.region.0] = None;
                let region = &body.regions[source.region.0];
                // The marker follows the previous arm's reachability. A
                // throwing try body still has attached catch bodies.
                if body.instructions[region.opener.unwrap()].retained {
                    // Catch markers are source ordered. No per-arm subtree
                    // sets or repeated scans of the region's handler list.
                    budget
                        .work((usize::BITS - region.handlers.len().leading_zeros()) as usize + 1)?;
                    let ordinal = region
                        .handlers
                        .binary_search_by_key(&index, |handler| handler.instruction)
                        .ok()
                        .context("legacy catch is missing from its source region")?;
                    budget.metadata(1)?;
                    let id = LegacyHandlerId(plan.handlers.len());
                    plan.handlers.push(LegacyHandler {
                        region: source.region,
                        ordinal,
                        source: index + 1
                            ..region
                                .handlers
                                .get(ordinal + 1)
                                .map_or(region.end, |handler| handler.instruction),
                        parent: active,
                    });
                    active = Some(id);
                    caught[source.region.0] = active;
                }
            }
            Operator::End | Operator::Delegate { .. } => {
                active = inherited[source.region.0];
                caught[source.region.0] = None;
            }
            _ => {}
        }
        if transfers
            .peek()
            .is_none_or(|transfer| transfer.instruction != index)
        {
            continue;
        }
        let transfer = transfers.next().unwrap();
        if !source.retained {
            continue;
        }
        if transfer.kind == TransferKind::Rethrow {
            budget.work(1)?;
            let exception = caught[transfer.targets[0].0]
                .context("legacy rethrow does not target an active handler")?;
            let first = active.context("legacy rethrow has no owned exception")?;
            let cleanup = LegacyCleanup {
                first,
                keep: plan.handlers[exception.0].parent,
            };
            validate_cleanup(&plan, cleanup, &mut budget)?;
            budget.metadata(1)?;
            plan.rethrows.push(LegacyRethrow {
                instruction: index,
                point: source.point,
                exception,
                cleanup,
            });
        } else if matches!(
            transfer.kind,
            TransferKind::Branch | TransferKind::Conditional | TransferKind::Table
        ) {
            for &target in &transfer.targets {
                budget.work(1)?;
                let keep = inherited[target.0];
                if active == keep {
                    continue;
                }
                let first = active.context("branch enters a legacy handler")?;
                let key = (first, target);
                if plan.exits.contains_key(&key) {
                    continue;
                }
                let cleanup = LegacyCleanup { first, keep };
                validate_cleanup(&plan, cleanup, &mut budget)?;
                budget.metadata(1)?;
                plan.exits.insert(key, cleanup);
            }
        }
    }
    ensure!(active.is_none(), "unclosed legacy handler ownership");
    Ok(plan)
}

fn validate_cleanup(
    plan: &LegacyHandlerPlan,
    cleanup: LegacyCleanup,
    budget: &mut Budget,
) -> Result<()> {
    let mut next = Some(cleanup.first);
    while next != cleanup.keep {
        budget.work(1)?;
        let id = next.context("legacy cleanup stop is not an ancestor")?;
        next = plan.handlers[id.0].parent;
    }
    Ok(())
}
