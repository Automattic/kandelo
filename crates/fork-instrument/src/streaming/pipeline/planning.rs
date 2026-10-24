//! Reserve import conversions first; then freeze one declaration suffix at a
//! time. No source body or local continuation plan survives these passes.
use super::*;
use anyhow::Context;
use wasm_encoder::{EntityType, FuncType, reencode::RoundtripReencoder};

// NativeRuntime's seven public controls occupy the first helper ordinals.
const CONTROLS: u32 = 7;

pub(super) fn plan<'a>(
    scan: &Scan<'a>,
    reaching: ReachingPlan,
    options: PipelineOptions,
    limits: PipelineLimits,
) -> Result<Components<'a>> {
    validate_closure(scan, &reaching, &options, limits.metadata_bytes)?;
    let source_types = SourceTypes::new(scan);
    let gc_plan =
        NativeGcPlan::discover(scan, &source_types, &mut RoundtripReencoder, limits.gc_plan)?;
    let mut inputs = RuntimeInputs::default();
    if let Some(memory) = options.staging_memory {
        ensure!(
            scan.types.as_ref().memory_count() == 0,
            "native pipeline staging memory cannot replace source memory"
        );
        inputs.staging_memory = Some(0);
        inputs.imports.push(PlannedImport {
            module: "env".into(),
            name: "memory".into(),
            ty: EntityType::Memory(memory),
        });
    }
    let loader_plan = LegacyLoaderPlan::reserve(scan, &mut inputs, CONTROLS, limits.loader)?;
    for source in loader_plan.source_functions() {
        ensure!(
            reaching.control_reachable.contains(&source),
            "native pipeline closure omits a legacy loader boundary"
        );
    }
    let boundary = reserve_boundary(scan, &mut inputs, &options)?;
    let root_imports = RootStateImports::append(scan, &mut inputs, limits.metadata_bytes)?;
    let table_imports = TableStateImports::append(scan, &mut inputs, limits.metadata_bytes)?;
    let first_constructors = CONTROLS
        .checked_add(loader_plan.helper_count())
        .context("native pipeline loader count overflow")?;
    let constructors = GcConstructorPlan::reserve(
        scan,
        &gc_plan,
        &mut inputs,
        first_constructors,
        limits.constructors,
    )?;
    let exception_imports =
        NativeExceptionImports::append(scan, &mut inputs, limits.metadata_bytes)?;
    let first_gc = first_constructors
        .checked_add(constructors.helper_count())
        .context("native pipeline constructor count overflow")?;
    let gc = GcCodecPlan::reserve(scan, &gc_plan, &mut inputs, first_gc, limits.gc_codec)?;
    inputs.helper_codecs.anyref = Some(gc.anyref_codecs());
    inputs.helper_codecs.externref = Some(gc.externref_codecs());
    let first_exception = first_gc
        .checked_add(gc.helper_count())
        .context("native pipeline GC count overflow")?;
    inputs.helper_codecs.exnref = Some(CodecPair {
        encode: first_exception,
        decode: first_exception
            .checked_add(1)
            .context("native pipeline codec index overflow")?,
    });
    inputs.helper_codecs.cleanup = Some(
        first_exception
            .checked_add(6)
            .context("native pipeline cleanup index overflow")?,
    );
    let mut runtime = NativeRuntime::plan(scan, inputs, limits.metadata_bytes)?;
    let imports = runtime.imports_plan().clone();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        scan,
        Some(&imports),
        runtime.local_declarations().clone(),
        limits.metadata_bytes,
    )?;
    let loader = loader_plan.freeze(scan, &imports, &mut module)?;
    let constructors = constructors.freeze(&imports)?;
    let gc = gc.freeze(scan, &gc_plan, &imports, runtime.indices(), &mut module)?;
    let mut cursor = Cursor::new(scan, &imports);
    for declarations in [
        runtime.function_declarations(),
        loader.declarations(),
        constructors.declarations(),
        gc.declarations(),
    ] {
        cursor.advance(declarations)?;
    }
    let references = runtime.indices().codecs;
    let exception = NativeExceptionCodec::plan(
        scan,
        &source_types,
        &mut runtime,
        &exception_imports,
        &imports,
        references,
        &mut module,
        cursor.ty,
        cursor.function,
        limits.exceptions,
    )?;
    cursor.advance(exception.declarations())?;
    let state = ModuleState::plan(
        scan,
        &mut runtime,
        &root_imports,
        &table_imports,
        &mut module,
        &mut cursor,
        limits,
    )?;
    let boundary = boundary
        .map(|ordinal| {
            imports
                .index(ordinal)
                .context("native pipeline boundary import disappeared")
        })
        .transpose()?;
    let activations = NativeActivations::plan(
        scan,
        &mut runtime,
        reaching,
        cursor.ty,
        cursor.function,
        ActivationModuleOptions {
            shared_codecs: options.shared_codecs,
            table_guards: state
                .tables
                .synchronized_tables()
                .into_iter()
                .map(|table| (table, state.tables.reconcile))
                .collect(),
            boundaries: options
                .boundaries
                .into_iter()
                .map(|function| (function, boundary.expect("reserved boundary callback")))
                .collect(),
        },
        limits.activations,
    )?;
    cursor.advance(activations.declarations())?;
    let environment = runtime.frame_environment(scan, limits.metadata_bytes)?;
    let loader_activation = loader.plan_activation(
        &runtime,
        environment,
        LoaderActivationOptions {
            function_ordinal: u32::try_from(activations.entries().count())?,
            first_type: cursor.ty,
            first_function: cursor.function,
            table_guard: Some(state.tables.reconcile),
            shared_codecs: options.shared_codecs,
        },
        limits.activations.continuation,
    )?;
    if let Some(activation) = &loader_activation {
        cursor.advance(activation.declarations())?;
    }
    let catalogs = Catalogs::plan(
        scan,
        &mut runtime,
        &state.bootstrap,
        &activations,
        loader_activation
            .as_ref()
            .map(|activation| activation.entry),
        &mut module,
        &mut cursor,
        limits,
    )?;
    let mut parts = vec![
        runtime.function_declarations(),
        loader.declarations(),
        constructors.declarations(),
        gc.declarations(),
        exception.declarations(),
    ];
    parts.extend(state.declarations());
    parts.push(activations.declarations());
    if let Some(activation) = &loader_activation {
        parts.push(activation.declarations());
    }
    parts.push(catalogs.roots.declarations());
    let declarations = FrozenDeclarations::concatenate(&parts, limits.metadata_bytes)?;
    Ok(Components {
        runtime,
        loader,
        loader_activation,
        gc_plan,
        constructors,
        gc,
        exception,
        state,
        activations,
        catalogs,
        declarations,
        module: module.freeze(),
    })
}

fn validate_closure(
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

fn reserve_boundary(
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
