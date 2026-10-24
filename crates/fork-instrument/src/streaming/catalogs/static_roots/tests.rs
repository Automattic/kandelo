use super::*;
use wasm_encoder::reencode::RoundtripReencoder;
fn input() -> Vec<u8> {
    wat::parse_str(
        r#"(module
      (type $pair (struct (field i32)))
      (global $root (ref $pair) (struct.new $pair (i32.const 7)))
      (global $alias (ref $pair) (global.get $root))
      (global $alias2 (ref $pair) (global.get $alias))
      (table 2 (ref $pair) (struct.new $pair (i32.const 9)))
      (table 0 (ref $pair) (struct.new $pair (i32.const 11)))
      (elem (ref $pair) (global.get $alias2) (struct.new $pair (i32.const 13))))"#,
    )
    .unwrap()
}
#[test]
fn source_discovery_coalesces_aliases_and_rejects_limits() {
    let input = input();
    let scan = scan(&input).unwrap();
    let plan = StaticRootPlan::discover(&scan, Default::default()).unwrap();
    assert_eq!(plan.root_count(), 3);
    assert!(matches!(plan.roots[0], Root::Global(0)));
    assert!(matches!(plan.roots[1], Root::Table { index: 0, .. }));
    assert!(matches!(
        plan.roots[2],
        Root::Element {
            segment: 0,
            item: 1
        }
    ));
    assert!(
        StaticRootPlan::discover(
            &scan,
            StaticRootLimits {
                metadata_bytes: 1,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        StaticRootPlan::discover(
            &scan,
            StaticRootLimits {
                work: 0,
                ..Default::default()
            }
        )
        .is_err()
    );
    let mut module = ModuleDeclarationBuilder::new(&scan, None, 1 << 20).unwrap();
    let other = wat::parse_str("(module)").unwrap();
    let other = self::scan(&other).unwrap();
    assert!(
        plan.freeze(&other, None, &mut RoundtripReencoder, &mut module, 1, 0)
            .is_err()
    );
    for (first_type, first_function) in [(u32::MAX, 0), (1, u32::MAX)] {
        let plan = StaticRootPlan::discover(&scan, Default::default()).unwrap();
        assert!(
            plan.freeze(
                &scan,
                None,
                &mut RoundtripReencoder,
                &mut module,
                first_type,
                first_function
            )
            .is_err()
        );
    }
    let plan = StaticRootPlan::discover(&scan, Default::default()).unwrap();
    let roots = plan
        .freeze(&scan, None, &mut RoundtripReencoder, &mut module, 1, 0)
        .unwrap();
    assert_eq!(roots.descriptor().len(), 12);
    assert!(roots.emit_helper(1, 1 << 20).is_err());
    assert!(roots.emit_helper(0, 1).is_err());
    let simple = wat::parse_str("(module (type $pair (struct (field i32))) (global (ref $pair) (struct.new $pair (i32.const 7))))").unwrap();
    let simple = self::scan(&simple).unwrap();
    let plan = StaticRootPlan::discover(
        &simple,
        StaticRootLimits {
            work: 4,
            ..Default::default()
        },
    )
    .unwrap();
    let mut module = ModuleDeclarationBuilder::new(&simple, None, 1 << 20).unwrap();
    let roots = plan
        .freeze(&simple, None, &mut RoundtripReencoder, &mut module, 1, 0)
        .unwrap();
    assert!(
        roots
            .emit_helper(0, 1 << 20)
            .unwrap_err()
            .to_string()
            .contains("work budget")
    );
}
#[test]
fn declared_dead_roots_are_not_harvested_and_large_data_is_not_retained() {
    let input = wat::parse_str(
        r#"(module
      (type $pair (struct (field i32)))
      (elem declare (ref $pair) (struct.new $pair (i32.const 7))))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    assert_eq!(
        StaticRootPlan::discover(&scan, Default::default())
            .unwrap()
            .root_count(),
        0
    );
    let input = wat::parse_str(format!("(module (data \"{}\"))", "a".repeat(8192))).unwrap();
    let scan = self::scan(&input).unwrap();
    assert_eq!(
        StaticRootPlan::discover(
            &scan,
            StaticRootLimits {
                metadata_bytes: 512,
                ..Default::default()
            }
        )
        .unwrap()
        .root_count(),
        0
    );
}
#[test]
fn resume_and_function_catalogs_preflight_metadata_and_ordinal_order() {
    let input = wat::parse_str("(module (func))").unwrap();
    let scan = scan(&input).unwrap();
    let mut module = ModuleDeclarationBuilder::new(&scan, None, 1 << 20).unwrap();
    assert!(declare_function_catalog(&scan, &mut RoundtripReencoder, &mut module, 0, 1).is_err());
    assert!(NativeResumeCatalog::declare([(2, 0), (2, 0)], &mut module, 1 << 20).is_err());
    assert!(NativeResumeCatalog::declare([(3, 0), (1, 0)], &mut module, 1 << 20).is_err());
    assert!(NativeResumeCatalog::declare([(0, 0)], &mut module, 1).is_err());
    assert!(NativeResumeCatalog::declare([], &mut module, 1).is_err());
    let resume = NativeResumeCatalog::declare([(3, 0), (9, 0)], &mut module, 1 << 20).unwrap();
    let bytes = resume.descriptor();
    assert_eq!(
        &bytes[12..],
        &[3, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 1, 0, 0, 0]
    );
    let mut module = ModuleDeclarationBuilder::new(&scan, None, 1 << 20).unwrap();
    let empty = NativeResumeCatalog::declare([], &mut module, 1 << 20).unwrap();
    assert_eq!(empty.descriptor().len(), 12);
    assert_eq!(module.freeze().element_count(), 0);
}
