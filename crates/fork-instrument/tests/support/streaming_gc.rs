//! Full native GC and exception providers, composed with frozen runtime
//! controls and source constructor rewriting. No JavaScript reference codec.
use fork_instrument::{module_exception_codec, module_gc_codec, streaming::*};
use wasm_encoder::reencode::RoundtripReencoder;
#[path = "streaming_catalogs.rs"]
mod catalogs;
#[path = "streaming_roots.rs"]
mod roots;
#[path = "streaming_tables.rs"]
mod tables;

#[path = "streaming_gc_emit.rs"]
mod emission;
use emission::Provider;

#[allow(dead_code)] // Root-state targets use emit_roots instead.
pub fn emit(input: &[u8]) -> Vec<u8> {
    emit_mode(input, State::None, false)
}
#[allow(dead_code)] // The plain provider target does not use root-state mode.
pub fn emit_roots(input: &[u8]) -> Vec<u8> {
    emit_mode(input, State::Roots, false)
}
#[allow(dead_code)]
pub fn emit_staged_roots(input: &[u8], wide: bool) -> Vec<u8> {
    emit_mode(input, State::Roots, wide)
}
#[allow(dead_code)]
pub fn emit_tables(input: &[u8]) -> Vec<u8> {
    emit_mode(input, State::Tables, false)
}
#[allow(dead_code)]
pub fn emit_staged_tables(input: &[u8], wide: bool) -> Vec<u8> {
    emit_mode(input, State::Tables, wide)
}
#[allow(dead_code)]
pub fn emit_activations(input: &[u8], shared: bool) -> Vec<u8> {
    emit_mode(input, State::Activations { shared }, false)
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    None,
    Roots,
    Tables,
    Activations { shared: bool },
}
fn emit_mode(input: &[u8], state: State, staging_wide: bool) -> Vec<u8> {
    let with_roots = state != State::None;
    let with_tables = matches!(state, State::Tables | State::Activations { .. });
    let scan = scan(input).unwrap();
    let source_types = SourceTypes::new(&scan);
    let plan = NativeGcPlan::discover(
        &scan,
        &source_types,
        &mut RoundtripReencoder,
        Default::default(),
    )
    .unwrap();
    let mut inputs = RuntimeInputs::default();
    if staging_wide {
        assert_eq!(scan.types.as_ref().memory_count(), 0);
        inputs.imports.push(PlannedImport {
            module: "env".into(),
            name: "memory".into(),
            ty: wasm_encoder::EntityType::Memory(wasm_encoder::MemoryType {
                minimum: 0,
                maximum: Some(65536),
                memory64: true,
                shared: true,
                page_size_log2: None,
            }),
        });
        inputs.staging_memory = Some(0);
    }
    let root_imports =
        with_roots.then(|| RootStateImports::append(&scan, &mut inputs, 1 << 20).unwrap());
    let table_imports =
        with_tables.then(|| TableStateImports::append(&scan, &mut inputs, 1 << 20).unwrap());
    let constructors =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 7, Default::default()).unwrap();
    let exception_imports = NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    let first_gc = 7 + constructors.helper_count();
    let gc = GcCodecPlan::reserve(&scan, &plan, &mut inputs, first_gc, Default::default()).unwrap();
    inputs.helper_codecs.anyref = Some(gc.anyref_codecs());
    inputs.helper_codecs.externref = Some(gc.externref_codecs());
    let first_exception = first_gc + gc.helper_count();
    inputs.helper_codecs.exnref = Some(CodecPair {
        encode: first_exception,
        decode: first_exception + 1,
    });
    inputs.helper_codecs.cleanup = Some(first_exception + 6);
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    let imports = runtime.imports_plan().clone();
    let constructors = constructors.freeze(&imports).unwrap();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&imports),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    let gc = gc
        .freeze(&scan, &plan, &imports, runtime.indices(), &mut module)
        .unwrap();
    let references = runtime.indices().codecs;
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let exception = NativeExceptionCodec::plan(
        &scan,
        &source_types,
        &mut runtime,
        &exception_imports,
        &imports,
        references,
        &mut module,
        first_type,
        imports.helper_function_base() + first_exception,
        Default::default(),
    )
    .unwrap();
    module
        .export(
            "__test_encode_externref",
            wasm_encoder::ExportKind::Func,
            gc.indices().encode_externref,
        )
        .unwrap();
    module
        .export(
            "__test_decode_externref",
            wasm_encoder::ExportKind::Func,
            gc.indices().decode_externref,
        )
        .unwrap();
    let roots = root_imports.as_ref().map(|host| {
        roots::Components::plan(
            &scan,
            &mut runtime,
            host,
            &mut module,
            first_type + exception.declarations().type_count(),
            imports.helper_function_base()
                + first_exception
                + exception.declarations().function_count(),
        )
    });
    let tables = table_imports.as_ref().map(|host| {
        let roots = roots.as_ref().unwrap();
        tables::Components::plan(
            &scan,
            &mut runtime,
            root_imports.as_ref().unwrap(),
            host,
            &roots.roots,
            &roots.bootstrap,
            &mut module,
            first_type + exception.declarations().type_count() + roots.declarations.type_count(),
            imports.helper_function_base()
                + first_exception
                + exception.declarations().function_count()
                + roots.declarations.function_count(),
        )
    });
    let activations = if let State::Activations { shared } = state {
        assert_eq!(
            scan.functions[0].import.as_ref().unwrap(),
            &("h".into(), "fork".into())
        );
        let roots = roots.as_ref().unwrap();
        let tables = tables.as_ref().unwrap();
        let options = ActivationModuleOptions {
            shared_codecs: shared,
            table_guards: tables
                .tables
                .synchronized_tables()
                .into_iter()
                .map(|table| (table, tables.tables.reconcile))
                .collect(),
            ..Default::default()
        };
        let activations = NativeActivations::plan(
            &scan,
            &mut runtime,
            scan.reaching_from_seeds([0], false).unwrap(),
            first_type
                + exception.declarations().type_count()
                + roots.declarations.type_count()
                + tables.declarations.type_count(),
            imports.helper_function_base()
                + first_exception
                + exception.declarations().function_count()
                + roots.declarations.function_count()
                + tables.declarations.function_count(),
            options,
            Default::default(),
        )
        .unwrap();
        for (name, kind, function) in &scan.exports {
            if *kind == wasmparser::ExternalKind::Func {
                if let Some(entry) = activations.entry(*function) {
                    module
                        .export(
                            &format!("resume_{name}"),
                            wasm_encoder::ExportKind::Func,
                            entry.resume,
                        )
                        .unwrap();
                }
            }
        }
        module
            .export(
                "unwind_tag",
                wasm_encoder::ExportKind::Tag,
                runtime.indices().unwind_tag,
            )
            .unwrap();
        Some(activations)
    } else {
        None
    };
    let identities = roots.as_ref().map(|roots| {
        let table_types = tables
            .as_ref()
            .map_or(0, |tables| tables.declarations.type_count());
        let table_functions = tables
            .as_ref()
            .map_or(0, |tables| tables.declarations.function_count());
        let activation_types = activations
            .as_ref()
            .map_or(0, |activations| activations.declarations().type_count());
        let activation_functions = activations
            .as_ref()
            .map_or(0, |activations| activations.declarations().function_count());
        catalogs::Components::plan(
            &scan,
            &mut runtime,
            &roots.bootstrap,
            activations.as_ref(),
            &mut module,
            first_type
                + exception.declarations().type_count()
                + roots.declarations.type_count()
                + table_types
                + activation_types,
            imports.helper_function_base()
                + first_exception
                + exception.declarations().function_count()
                + roots.declarations.function_count()
                + table_functions
                + activation_functions,
        )
    });
    let mut parts = vec![
        runtime.function_declarations(),
        constructors.declarations(),
        gc.declarations(),
        exception.declarations(),
    ];
    if let Some(roots) = &roots {
        parts.push(&roots.declarations);
    }
    if let Some(tables) = &tables {
        parts.push(&tables.declarations);
    }
    if let Some(activations) = &activations {
        parts.push(activations.declarations());
    }
    if let Some(identities) = &identities {
        parts.push(identities.declarations());
    }
    let declarations = FrozenDeclarations::concatenate(&parts, 1 << 20).unwrap();
    let mut descriptors = vec![
        (module_gc_codec::FORMAT_SECTION, plan.descriptor().unwrap()),
        (
            module_exception_codec::FORMAT_SECTION,
            exception.descriptor().unwrap(),
        ),
    ];
    if let Some(roots) = &roots {
        descriptors.push((
            wasm_posix_shared::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
            roots.roots.imported_globals_descriptor().to_vec(),
        ));
    }
    if let Some(tables) = &tables {
        descriptors.push((
            wasm_posix_shared::abi::WPK_FORK_IMPORTED_TABLES_SECTION,
            tables.tables.imported_tables_descriptor().to_vec(),
        ));
    }
    if let Some(identities) = &identities {
        descriptors.extend(identities.descriptors());
    }
    let mut transform = Provider {
        identities,
        scan: &scan,
        activations,
        runtime,
        plan,
        constructors,
        gc,
        exception,
        first_gc,
        first_exception,
        roots,
        tables,
        declarations,
        module: module.freeze(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    let mut metadata = wasm_encoder::Module::new();
    for (name, data) in descriptors {
        metadata.section(&wasm_encoder::CustomSection {
            name: name.into(),
            data: data.into(),
        });
    }
    output.extend_from_slice(&metadata.finish()[8..]);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}
