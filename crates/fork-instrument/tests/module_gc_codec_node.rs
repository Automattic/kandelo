use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[path = "support/streaming_gc.rs"]
mod native;

fn fixture_module(wide: bool) -> Vec<u8> {
    let source = include_str!("fixtures/gc_codec.wat");
    let input = wat::parse_str(if wide {
        source.replace("(memory 2)", "(memory i64 2)")
    } else {
        source.into()
    })
    .expect("GC provider fixture WAT");
    native::emit(&input)
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
        fs::write(
            directory.join("gc_recipe_host.mjs"),
            include_str!("fixtures/gc_recipe_host.mjs"),
        )
        .expect("write GC host");

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
