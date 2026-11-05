use super::*;
use wasm_encoder::reencode::{Error, Reencode};
struct Source<'a>(&'a mut NativeRuntime);
macro_rules! index {
    ($name:ident) => {
        fn $name(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
            self.0.$name(index)
        }
    };
}
impl Reencode for Source<'_> {
    type Error = ImportIndexError;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
}
impl NativeSourceHooks for Source<'_> {}
fn input() -> Vec<u8> {
    wat::parse_str(
        r#"(module
        (import "h" "fork" (func (param i32) (result i32))) (memory 1)
        (func (param i32) (result i32) local.get 0 call 0)
        (func i32.const 7 call 1 drop))"#,
    )
    .unwrap()
}
fn plan<'a>(
    scan: &Scan<'a>,
    runtime: &mut NativeRuntime,
    options: ActivationModuleOptions,
    limits: ActivationModuleLimits,
) -> Result<NativeActivations<'a>> {
    NativeActivations::plan(
        scan,
        runtime,
        scan.reaching_from_seeds([0], false)?,
        scan.types.as_ref().core_type_count_in_module()
            + runtime.function_declarations().type_count(),
        runtime.imports_plan().helper_function_base() + 7,
        options,
        limits,
    )
}
#[test]
fn serial_activation_planning_rejects_limits_and_unbound_roles() {
    let input = input();
    let scan = scan(&input).unwrap();
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    for limits in [
        ActivationModuleLimits {
            metadata_bytes: 0,
            ..Default::default()
        },
        ActivationModuleLimits {
            work: 0,
            ..Default::default()
        },
    ] {
        assert!(plan(&scan, &mut runtime, Default::default(), limits).is_err());
    }
    for options in [
        ActivationModuleOptions {
            table_guards: BTreeMap::from([(0, 0)]),
            ..Default::default()
        },
        ActivationModuleOptions {
            boundaries: BTreeMap::from([(0, 0)]),
            ..Default::default()
        },
    ] {
        assert!(plan(&scan, &mut runtime, options, Default::default()).is_err());
    }
    let mut reaching = scan.reaching_from_seeds([0], false).unwrap();
    reaching.tail_sites.insert(ProgramPoint {
        function: 0,
        offset: 0,
    });
    assert!(
        NativeActivations::plan(
            &scan,
            &mut runtime,
            reaching,
            0,
            0,
            Default::default(),
            Default::default()
        )
        .is_err()
    );
}
#[test]
fn emission_rebuilds_local_plans_from_exact_original_bytes_and_frozen_shapes() {
    let input = input();
    let scan = scan(&input).unwrap();
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    let catalog = plan(
        &scan,
        &mut runtime,
        ActivationModuleOptions {
            shared_codecs: true,
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    assert_eq!(
        catalog
            .entries()
            .map(|(function, entry)| (function, entry.ordinal))
            .collect::<Vec<_>>(),
        [(1, 0), (2, 1)]
    );
    assert!(catalog.entry(0).is_none());
    assert!(catalog.emit_helper(u32::MAX, 1 << 20).is_err());
    assert!(catalog.emit_helper(0, 1).is_err());
    let mut bodies = scan.body_provider(Default::default());
    for function in [1, 2] {
        let body = bodies.load(function).unwrap();
        let first = catalog
            .emit_function(&scan, &body, &mut Source(&mut runtime), 1 << 20)
            .unwrap();
        let second = catalog
            .emit_function(&scan, &body, &mut Source(&mut runtime), 1 << 20)
            .unwrap();
        let encode = |body: Function| {
            let mut bytes = Vec::new();
            wasm_encoder::Encode::encode(&body, &mut bytes);
            bytes
        };
        assert_eq!(encode(first), encode(second));
        assert!(
            catalog
                .emit_function(&scan, &body, &mut Source(&mut runtime), 1)
                .is_err()
        );
    }
    let copy = input.clone();
    let other = self::scan(&copy).unwrap();
    let body = other.body_provider(Default::default()).load(1).unwrap();
    assert!(
        catalog
            .emit_function(&other, &body, &mut Source(&mut runtime), 1 << 20)
            .is_err()
    );
    let mut body = bodies.load(1).unwrap();
    body.function = 2;
    assert!(
        catalog
            .emit_function(&scan, &body, &mut Source(&mut runtime), 1 << 20)
            .is_err()
    );
}
