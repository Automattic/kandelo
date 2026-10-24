use fork_instrument::{module_exception_codec, module_gc_codec, module_state, runtime};

pub fn emit(input: &[u8]) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(input).unwrap();
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
