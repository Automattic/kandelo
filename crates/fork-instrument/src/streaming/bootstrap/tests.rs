use super::*;
use crate::streaming::scan;
use wasm_encoder::reencode::RoundtripReencoder;

#[test]
fn bootstrap_rejects_resource_exhaustion_and_wrong_source() {
    let input = wat::parse_str("(module (memory 1) (data (i32.const 0) \"x\"))").unwrap();
    let scan = scan(&input).unwrap();
    for (limits, expected) in [
        (
            BootstrapLimits {
                metadata_bytes: 0,
                ..Default::default()
            },
            "metadata budget",
        ),
        (
            BootstrapLimits {
                work: 0,
                ..Default::default()
            },
            "work budget",
        ),
    ] {
        let error = ModuleBootstrapPlan::discover(&scan, limits).err().unwrap();
        assert!(error.to_string().contains(expected), "{error}");
    }
    let other_input = wat::parse_str("(module (memory 1) (data (i32.const 0) \"y\"))").unwrap();
    let other_scan = self::scan(&other_input).unwrap();
    let plan = ModuleBootstrapPlan::discover(&scan, Default::default()).unwrap();
    let mut module = ModuleDeclarationBuilder::new(&other_scan, None, 1 << 20).unwrap();
    let error = plan
        .freeze(
            &other_scan,
            None,
            &mut RoundtripReencoder,
            &mut module,
            0,
            0,
        )
        .err()
        .unwrap();
    assert!(error.to_string().contains("another source module"));

    let plan = ModuleBootstrapPlan::discover(&scan, Default::default()).unwrap();
    let mut module = ModuleDeclarationBuilder::new(&scan, None, 1 << 20).unwrap();
    let plan = plan
        .freeze(&scan, None, &mut RoundtripReencoder, &mut module, 0, 0)
        .unwrap();
    assert_eq!(plan.initially_dropped_data(), [true]);
    assert!(
        plan.emit_helper(0, 1)
            .err()
            .unwrap()
            .to_string()
            .contains("output budget")
    );
    assert!(
        plan.emit_helper(3, 1024)
            .err()
            .unwrap()
            .to_string()
            .contains("unknown bootstrap helper")
    );
}

#[test]
fn source_declared_and_active_segments_start_logically_dropped() {
    let input = wat::parse_str(
        r#"(module
      (memory 1) (table 1 funcref)
      (elem (i32.const 0) func $target)
      (elem declare func $target) (elem func $target)
      (data (i32.const 0) "x") (data "y") (func $target))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let plan = ModuleBootstrapPlan::discover(&scan, Default::default()).unwrap();
    let mut module = ModuleDeclarationBuilder::new(&scan, None, 1 << 20).unwrap();
    let plan = plan
        .freeze(
            &scan,
            None,
            &mut RoundtripReencoder,
            &mut module,
            scan.types.as_ref().core_type_count_in_module(),
            scan.functions.len() as u32,
        )
        .unwrap();
    assert_eq!(plan.initially_dropped_elements(), [true, true, false]);
    assert_eq!(plan.initially_dropped_data(), [true, false]);
}

#[test]
fn pthread_address_initializer_rejects_other_start_effects() {
    for (body, accepted) in [
        (
            "global.get $base i32.const 8 i32.add global.set $local",
            true,
        ),
        ("global.get $base global.set $local", true),
        ("i32.const 8 global.set $local", false),
        (
            "global.get $local i32.const 8 i32.add global.set $local",
            false,
        ),
        (
            "global.get $base i32.const 8 i32.add global.set $imported",
            false,
        ),
        (
            "global.get $base i32.const 8 i32.add global.set $local i32.const 0 i32.const 9 i32.store",
            false,
        ),
        (
            "call $other global.get $base i32.const 8 i32.add global.set $local",
            false,
        ),
        (
            "global.get $base i32.const 8 i32.add global.set $local loop end",
            false,
        ),
    ] {
        let input = wat::parse_str(format!(
            r#"(module
          (import "env" "__memory_base" (global $base i32))
          (import "env" "other" (global $imported (mut i32)))
          (memory 1) (global $local (mut i32) (i32.const 8))
          (func $other)
          (func $init {body})
          (func $start call $init) (start $start))"#
        ))
        .unwrap();
        let scan = scan(&input).unwrap();
        let plan = ModuleBootstrapPlan::discover(&scan, Default::default()).unwrap();
        assert_eq!(plan.thread_globals.is_some(), accepted, "{body}");
    }
}
