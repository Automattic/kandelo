//! Reserve import conversions first; then freeze one declaration suffix at a
//! time. No source body or local continuation plan survives these passes.
use super::input::{reserve_boundary, validate_closure};
use super::*;
use anyhow::Context;
use wasm_encoder::{EntityType, reencode::RoundtripReencoder};

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
                .iter()
                .map(|&function| (function, boundary.expect("reserved boundary callback")))
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
    let abi_marker = AbiMarker::plan(
        scan,
        options.side_module,
        &mut module,
        &mut cursor,
        limits.metadata_bytes,
    )?;
    let entries = EntryBoundaries::plan(
        scan,
        &mut runtime,
        &mut module,
        &mut cursor,
        state.tables.reconcile,
        limits.metadata_bytes,
    )?;
    let sinks = SinkEntry::plan(
        scan,
        &mut runtime,
        &options.boundaries,
        &activations,
        &mut module,
        &mut cursor,
        limits.metadata_bytes,
    )?;
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
    parts.push(abi_marker.declarations());
    parts.push(entries.declarations());
    parts.push(sinks.declarations());
    parts.push(catalogs.roots.declarations());
    let declarations = FrozenDeclarations::concatenate(&parts, limits.metadata_bytes)?;
    Ok(Components {
        runtime,
        loader,
        loader_activation,
        entries,
        abi_marker,
        sinks,
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
