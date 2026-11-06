#[path = "support/streaming_root_scalar.rs"]
mod native;
#[path = "support/streaming_gc.rs"]
mod recipes;

#[test]
fn memoryless_modules_use_the_planned_process_memory_for_controls_and_roots() {
    let input = wat::parse_str(
        r#"(module
      (import "env" "__channel_base" (global $channel (mut i32)))
      (global $starts (export "starts") (mut i32) (i32.const 0))
      (global $counter (mut i32) (i32.const 123))
      (global $wide (mut i64) (i64.const 0x102030405060708))
      (func $start global.get $starts i32.const 1 i32.add global.set $starts) (start $start)
      (func (export "verify") (result i32)
        global.get $starts i32.const 1 i32.eq
        global.get $counter i32.const 123 i32.eq i32.and
        global.get $wide i64.const 0x102030405060708 i64.eq i32.and)
      (func (export "channel") (result i32) global.get $channel)
      (func (export "mutate")
        i32.const 3 global.set $starts i32.const -5 global.set $counter
        i64.const -5 global.set $wide i32.const 11 global.set $channel))"#,
    )
    .unwrap();
    for wide in [false, true] {
        let output = native::emit(&input, wide);
        assert_eq!(native::emit(&input, wide), output);
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
        let script = directory.path().join("test.cjs");
        std::fs::write(&script, include_str!("fixtures/streaming_root_memory.cjs")).unwrap();
        let result = std::process::Command::new("node")
            .arg(script)
            .arg(if wide { "1" } else { "0" })
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "planned memory64={wide}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn memoryless_gc_and_exception_roots_use_the_same_planned_staging_view() {
    let input = wat::parse_str(include_str!("fixtures/streaming_root_memory_gc.wat")).unwrap();
    for wide in [false, true] {
        let output = recipes::emit_staged_roots(&input, wide);
        assert_eq!(recipes::emit_staged_roots(&input, wide), output);
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
        std::fs::write(
            directory.path().join("transit.wasm"),
            wat::parse_str("(module (table (export \"transit\") 64 anyref))").unwrap(),
        )
        .unwrap();
        for (name, source) in [
            (
                "test.mjs",
                include_str!("fixtures/streaming_root_memory_gc.mjs"),
            ),
            (
                "root_record_host.cjs",
                include_str!("fixtures/root_record_host.cjs"),
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
            .arg(if wide { "wide" } else { "narrow" })
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "planned GC memory64={wide}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
