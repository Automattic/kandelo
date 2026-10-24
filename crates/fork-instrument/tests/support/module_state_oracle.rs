use fork_instrument::{module_exception_codec, module_gc_codec, module_state, runtime};

#[allow(dead_code)]
pub fn emit(input: &[u8]) -> Vec<u8> {
    emit_mode(input, false)
}
#[allow(dead_code)]
pub fn emit_activations(input: &[u8]) -> Vec<u8> {
    emit_mode(input, true)
}
fn emit_mode(input: &[u8], activations: bool) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(input).unwrap();
    if activations {
        fork_instrument::legacy_dlopen::lower(&mut module).unwrap();
    }
    let activation = activations.then(|| {
        use fork_instrument::{call_graph, instrument};
        let fork = call_graph::find_import_func(&module, "h.fork").unwrap();
        let initial = call_graph::analyze_reaching_closure(&module, fork);
        fork_instrument::legacy_eh::normalize_fork_path(&mut module, &initial.activations).unwrap();
        let reaching = call_graph::analyze_reaching_closure(&module, fork);
        let mut locals: Vec<_> = reaching
            .activations
            .iter()
            .copied()
            .filter(|id| matches!(module.funcs.get(*id).kind, walrus::FunctionKind::Local(_)))
            .collect();
        locals.sort();
        let catches = instrument::plan_plain_catches(&module, &locals);
        let exports: Vec<_> = module
            .exports
            .iter()
            .filter_map(|export| {
                if let walrus::ExportItem::Function(function) = export.item {
                    locals
                        .iter()
                        .position(|&id| id == function)
                        .map(|ordinal| (export.name.clone(), ordinal))
                } else {
                    None
                }
            })
            .collect();
        (reaching, catches, exports)
    });
    let state = module_state::plan(&mut module);
    let memory = module.memories.iter().next().unwrap().id();
    let gc = module_gc_codec::declare(&mut module, memory).unwrap();
    let exn = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((gc.encode_externref, gc.decode_externref)),
        Some((gc.encode_anyref, gc.decode_anyref)),
    )
    .unwrap();
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            anyref: Some((gc.encode_anyref, gc.decode_anyref)),
            externref: Some((gc.encode_externref, gc.decode_externref)),
            exnref: Some((exn.encode, exn.decode)),
            cleanup: Some(exn.clear),
            ..Default::default()
        },
    );
    module_gc_codec::finish_declaration(&mut module, gc, exn, &runtime).unwrap();
    if let Some((reaching, catches, exports)) = activation {
        fork_instrument::instrument::instrument_functions_with_targets_and_tail_sites(
            &mut module,
            &runtime,
            &reaching.activations,
            &reaching.control_reachable,
            &reaching.tail_call_landings,
            &catches,
            None,
            &Default::default(),
        );
        module
            .exports
            .add("unwind_tag", runtime.unwind_tag.unwrap());
        for (name, ordinal) in exports {
            let expected = format!("__wpk_fork_resume_{ordinal}");
            let resume = module
                .funcs
                .iter()
                .find(|function| function.name.as_deref() == Some(&expected))
                .unwrap()
                .id();
            module.exports.add(&format!("resume_{name}"), resume);
        }
    }
    module_state::inject(&mut module, &runtime, state).unwrap();
    for (alias, original) in [
        ("save_roots", "wpk_fork_module_state_save"),
        ("save_tables", "wpk_fork_module_table_state_save"),
        ("restore_tables", "wpk_fork_module_table_state_restore"),
        ("restore_roots", "wpk_fork_module_state_restore"),
        ("finish_roots", "wpk_fork_module_state_finish_restore"),
    ] {
        let function = module
            .exports
            .iter()
            .find(|export| export.name == original)
            .unwrap()
            .item;
        module.exports.add(alias, function);
    }
    module.emit_wasm()
}
