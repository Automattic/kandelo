use super::*;
use std::collections::BTreeSet;
use wasm_encoder::ValType;

#[allow(clippy::too_many_arguments)]
pub(super) fn plan<'a>(
    scan: &Scan<'a>,
    runtime: &mut NativeRuntime,
    reaching: ReachingPlan,
    first_type: u32,
    first_function: u32,
    options: ActivationModuleOptions,
    limits: ActivationModuleLimits,
) -> Result<NativeActivations<'a>> {
    runtime.imports_plan().validate_source(scan)?;
    let count = reaching
        .activations
        .len()
        .checked_add(reaching.control_reachable.len())
        .and_then(|n| n.checked_add(reaching.tail_sites.len()))
        .and_then(|n| n.checked_add(options.table_guards.len()))
        .and_then(|n| n.checked_add(options.boundaries.len()))
        .context("activation catalog size overflow")?;
    ensure!(
        count <= limits.metadata_bytes / 256,
        "activation catalog exceeds metadata budget"
    );
    ensure!(
        reaching
            .activations
            .iter()
            .chain(&reaching.control_reachable)
            .all(|&function| (function as usize) < scan.functions.len()),
        "activation closure has an unknown function"
    );
    ensure!(
        reaching.activations.is_subset(&reaching.control_reachable),
        "activation closure is not control reachable"
    );
    ensure!(
        reaching.tail_sites.iter().all(|point| scan
            .functions
            .get(point.function as usize)
            .is_some_and(|function| function.body.is_some())),
        "tail point has no original local function"
    );
    let kinds = FrozenReferenceKinds::new(scan, runtime, limits.metadata_bytes)?;
    let types = SourceTypes::new(scan);
    let environment = runtime.frame_environment(scan, limits.metadata_bytes)?;
    let indices = runtime.indices();
    let mut support = ActivationSupportCatalog::new(
        environment,
        indices,
        runtime.frames_start_offset(),
        first_type,
        first_function,
        limits.metadata_bytes,
    )?;
    for (&table, &guard) in &options.table_guards {
        ensure!(
            table < scan.types.as_ref().table_count(),
            "unknown transport source table"
        );
        support.reconcile_table(runtime.table_index(table)?, guard)?;
    }
    let functions: BTreeSet<_> = reaching
        .activations
        .iter()
        .copied()
        .chain(reaching.tail_sites.iter().map(|point| point.function))
        .collect();
    let mut bodies = scan.body_provider(limits.ir);
    let mut work = limits.work;
    let mut entries = BTreeMap::new();
    for &function in &functions {
        let summary = scan
            .functions
            .get(function as usize)
            .context("unknown tail source function")?;
        if summary.body.is_none() {
            continue;
        }
        charge(
            &mut work,
            usize::try_from(summary.body.as_ref().unwrap().operators)?,
        )?;
        let body = bodies.load(function)?;
        TailTransferPlan::plan(
            scan,
            &body,
            &types,
            runtime,
            &reaching.tail_sites,
            &mut support,
            limits.tails,
        )?;
        if !reaching.activations.contains(&function) {
            continue;
        }
        let mut plan = NativeActivationPlan::plan(
            scan,
            &body,
            &types,
            runtime,
            environment,
            &reaching.control_reachable,
            limits.continuation,
        )?;
        plan.catches.bind_types(&mut support)?;
        support.result_block(&plan.results)?;
        for call in &plan.continuation.calls {
            let (target, source_type) = target(scan, runtime, call.kind)?;
            let (params, results) =
                signature(scan, &types, runtime, source_type, limits.metadata_bytes)?;
            support.transport(target, &params, &results)?;
        }
        let (params, _) = signature(
            scan,
            &types,
            runtime,
            body.type_index,
            limits.metadata_bytes,
        )?;
        let resume = support.resume_thunk_with_references(
            runtime.function_index(function)?,
            &params,
            &plan.results,
            &plan.continuation.frame,
            &plan.continuation.references,
            &kinds,
        )?;
        entries.insert(
            function,
            NativeActivationEntry {
                ordinal: u32::try_from(entries.len())?,
                resume,
            },
        );
    }
    ensure!(
        options
            .boundaries
            .keys()
            .all(|function| entries.contains_key(function)),
        "sink boundary has no native activation"
    );
    let support = support.freeze()?;
    let mut codecs = FrameCodecCatalog::new(
        environment,
        indices,
        first_type
            .checked_add(support.declarations().type_count())
            .context("activation codec type overflow")?,
        first_function
            .checked_add(support.declarations().function_count())
            .context("activation codec function overflow")?,
        limits.metadata_bytes,
    )?;
    if options.shared_codecs {
        // Support declarations must be final before assigning codec indices.
        // Reload one body instead of retaining every activation layout.
        for &function in entries.keys() {
            charge(
                &mut work,
                usize::try_from(
                    scan.functions[function as usize]
                        .body
                        .as_ref()
                        .unwrap()
                        .operators,
                )?,
            )?;
            let body = bodies.load(function)?;
            let plan = NativeActivationPlan::plan(
                scan,
                &body,
                &types,
                runtime,
                environment,
                &reaching.control_reachable,
                limits.continuation,
            )?;
            if let Some(shape) = plan.continuation.frame.codec_shape(
                plan.catches.selector.is_some(),
                &plan.continuation.references,
            ) {
                codecs.request(&shape)?;
            }
        }
    }
    let codecs = codecs.freeze()?;
    let declarations = FrozenDeclarations::concatenate(
        &[support.declarations(), codecs.declarations()],
        limits.metadata_bytes,
    )?;
    Ok(NativeActivations {
        source: scan.input(),
        types,
        kinds,
        reaching,
        environment,
        entries,
        support,
        codecs,
        declarations,
        options,
        limits,
        runtime: indices,
    })
}
fn charge(work: &mut usize, instructions: usize) -> Result<()> {
    *work = work
        .checked_sub(instructions)
        .context("activation module exceeds work budget")?;
    Ok(())
}
pub(super) fn target<T: Reencode>(
    scan: &Scan<'_>,
    map: &mut T,
    call: ReferenceCallKind,
) -> Result<(ActivationCallTarget, u32)>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    Ok(match call {
        ReferenceCallKind::Direct(function) => (
            ActivationCallTarget::Direct(map.function_index(function)?),
            scan.functions
                .get(function as usize)
                .context("unknown activation callee")?
                .ty,
        ),
        ReferenceCallKind::Indirect { table, ty } => (
            ActivationCallTarget::Indirect {
                table: map.table_index(table)?,
                signature: map.type_index(ty)?,
                table64: scan.types.as_ref().table_at(table).table64,
            },
            ty,
        ),
        ReferenceCallKind::Ref { ty } => (
            ActivationCallTarget::Reference {
                signature: map.type_index(ty)?,
            },
            ty,
        ),
    })
}
pub(super) fn signature<T: Reencode>(
    scan: &Scan<'_>,
    source: &SourceTypes,
    map: &mut T,
    index: u32,
    budget: usize,
) -> Result<(Vec<ValType>, Vec<ValType>)>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let types = scan.types.as_ref();
    let signature = types
        .get(types.core_type_at_in_module(index))
        .context("unknown activation signature")?
        .composite_type
        .unwrap_func();
    ensure!(
        signature
            .params()
            .len()
            .checked_add(signature.results().len())
            .is_some_and(|n| n <= budget / 128),
        "activation signature exceeds metadata budget"
    );
    let mut values = |values: &[wasmparser::ValType]| {
        values
            .iter()
            .map(|&ty| source.value_type(map, ty))
            .collect::<Result<Vec<_>>>()
    };
    Ok((values(signature.params())?, values(signature.results())?))
}
