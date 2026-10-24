use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{module_exception_codec, module_gc_codec, runtime};
use walrus::Module;

fn fixture_module(wide: bool) -> Vec<u8> {
    let source = include_str!("fixtures/gc_codec.wat");
    let input = wat::parse_str(if wide {
        source.replace("(memory 2)", "(memory i64 2)")
    } else {
        source.into()
    })
    .expect("GC provider fixture WAT");
    let mut module = Module::from_buffer(&input).expect("GC provider fixture module");
    let memory = module.memories.iter().next().expect("provider memory").id();
    let declared = module_gc_codec::declare(&mut module, memory).expect("declare GC codec");
    module
        .exports
        .add("__test_encode_externref", declared.encode_externref);
    module
        .exports
        .add("__test_decode_externref", declared.decode_externref);
    let exception = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((declared.encode_externref, declared.decode_externref)),
        Some((declared.encode_anyref, declared.decode_anyref)),
    )
    .expect("inject exception codec");
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            funcref: Some((
                exception.references.encode_funcref,
                exception.references.decode_funcref,
            )),
            externref: Some((
                exception.references.encode_externref,
                exception.references.decode_externref,
            )),
            exnref: Some((exception.encode, exception.decode)),
            anyref: Some((declared.encode_anyref, declared.decode_anyref)),
            cleanup: Some(exception.clear),
        },
    );
    module_gc_codec::finish_declaration(&mut module, declared, exception, &runtime)
        .expect("finish GC codec");
    module.emit_wasm()
}

fn transit_provider_module() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (table (export "transit") 64 (ref null any)))
        "#,
    )
    .expect("transit provider WAT")
}

#[test]
fn fresh_node_instance_reconstructs_gc_cycle_and_identity() {
    for wide in [false, true] {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "kandelo-module-gc-codec-{}-{nonce}",
            std::process::id(),
        ));
        fs::create_dir(&directory).expect("create fixture directory");
        fs::write(directory.join("provider.wasm"), fixture_module(wide)).expect("write provider");
        fs::write(directory.join("transit.wasm"), transit_provider_module())
            .expect("write transit provider");
        fs::write(
            directory.join("test.mjs"),
            include_str!("fixtures/gc_codec_replay.mjs"),
        )
        .expect("write Node test");
        fs::write(
            directory.join("exception_recipe_host.cjs"),
            include_str!("fixtures/exception_recipe_host.cjs"),
        )
        .expect("write exception host");

        let output = Command::new("node")
            .arg(directory.join("test.mjs"))
            .args(if wide { vec!["wide"] } else { vec![] })
            .output()
            .expect("run Node");
        let _ = fs::remove_dir_all(&directory);
        assert!(
            output.status.success(),
            "Node fresh-instance GC codec test failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
