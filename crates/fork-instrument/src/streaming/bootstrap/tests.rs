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
