use fork_instrument::streaming::*;

#[test]
fn sink_selectors_preserve_result_shapes_guest_traps_and_unexpected_returns() {
    let input = wat::parse_str(
        r#"(module
        (import "h" "fork" (func $fork))
        (memory 2)
        (func (result i32) call $fork i32.const 1)
        (func (result i64 i32) call $fork i64.const 2 i32.const 3)
        (func (result exnref) call $fork ref.null exn)
        (func (result i32) call $fork i32.const 4))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let reaching = scan.reaching_from_seeds([0], false).unwrap();
    let mut pipeline = NativePipeline::plan(
        scan,
        reaching,
        PipelineOptions {
            boundaries: [1, 2, 3, 4].into_iter().collect(),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let mut output = Vec::new();
    pipeline.emit(&mut output).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
    for (name, source) in [
        (
            "transit.wasm",
            "(module (table (export \"transit\") 128 anyref))",
        ),
        (
            "thunks.wasm",
            r#"(module
            (func (export "scalar") (result i32) i32.const 17)
            (func (export "tuple") (result i64 i32) i64.const 8 i32.const 9)
            (func (export "reference") (result exnref) ref.null exn)
            (func (export "trap") (result i32) unreachable))"#,
        ),
    ] {
        std::fs::write(directory.path().join(name), wat::parse_str(source).unwrap()).unwrap();
    }
    for (name, source) in [
        (
            "test.mjs",
            include_str!("fixtures/streaming_sink_entry.mjs"),
        ),
        (
            "gc_recipe_host.mjs",
            include_str!("fixtures/gc_recipe_host.mjs"),
        ),
        (
            "exception_recipe_host.cjs",
            include_str!("fixtures/exception_recipe_host.cjs"),
        ),
    ] {
        std::fs::write(directory.path().join(name), source).unwrap();
    }
    let result = std::process::Command::new("node")
        .arg(directory.path().join("test.mjs"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
