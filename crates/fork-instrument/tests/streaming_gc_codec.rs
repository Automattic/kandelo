#[path = "support/streaming_gc.rs"]
mod native;

#[test]
fn fresh_instances_reconstruct_gc_graphs_and_recapture_constructor_provenance() {
    for wide in [false, true] {
        let source = include_str!("fixtures/gc_codec.wat");
        let input = wat::parse_str(if wide {
            source.replace("(memory 2)", "(memory i64 2)")
        } else {
            source.into()
        })
        .unwrap();
        let output = native::emit(&input);
        assert_eq!(native::emit(&input), output, "deterministic native output");
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
        std::fs::write(
            directory.path().join("transit.wasm"),
            wat::parse_str("(module (table (export \"transit\") 64 anyref))").unwrap(),
        )
        .unwrap();
        let script = directory.path().join("test.mjs");
        std::fs::write(&script, include_str!("fixtures/gc_codec_replay.mjs")).unwrap();
        std::fs::write(
            directory.path().join("exception_recipe_host.cjs"),
            include_str!("fixtures/exception_recipe_host.cjs"),
        )
        .unwrap();
        let result = std::process::Command::new("node")
            .arg(script)
            .args(if wide { vec!["wide"] } else { vec![] })
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "memory64={wide}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
