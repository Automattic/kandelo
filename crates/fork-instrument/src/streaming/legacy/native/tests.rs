use super::*;
use crate::streaming::*;
use std::collections::BTreeSet;

#[test]
fn only_active_owned_exceptions_enter_a_calls_reference_vector() {
    let input = wat::parse_str(
        r#"(module
      (import "h" "fork" (func $fork (param i32) (result i32)))
      (memory 1) (tag $e (param i32 i64))
      (func
        try i32.const 9 i64.const 10 throw $e
        catch $e drop drop i32.const 3 call $fork drop end
        i32.const 3 call $fork drop))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let types = SourceTypes::new(&scan);
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    let environment = runtime.frame_environment(&scan, 1 << 20).unwrap();
    let mut plan = NativeActivationPlan::plan(
        &scan,
        &body,
        &types,
        &mut runtime,
        environment,
        &BTreeSet::from([0]),
        Default::default(),
    )
    .unwrap();
    let references = &plan.continuation.references;
    assert_eq!(references.slots.len(), 1);
    assert_eq!(references.slots[0].ty, wasm_encoder::RefType::EXNREF);
    assert_eq!(references.slots_by_call, [vec![0], vec![]]);
    assert!(plan.legacy.validate_emission().is_err());
    let new_support = || {
        ActivationSupportCatalog::new(
            environment,
            runtime.indices(),
            runtime.frames_start_offset(),
            scan.types.as_ref().core_type_count_in_module()
                + runtime.function_declarations().type_count(),
            runtime.imports_plan().helper_function_base() + 7,
            1 << 20,
        )
        .unwrap()
    };
    let missing = new_support().freeze().unwrap();
    assert!(plan.legacy.bind_frozen_types(&missing).is_err());
    let mut support = new_support();
    plan.legacy.bind_types(&mut support).unwrap();
    plan.legacy.validate_emission().unwrap();
    plan.legacy
        .bind_frozen_types(&support.freeze().unwrap())
        .unwrap();
    let mut no_work = 0;
    assert!(
        plan.legacy
            .owner_at(
                plan.legacy.ownership.handlers()[0].source.start,
                &mut no_work
            )
            .is_err()
    );
    for limits in [
        LegacyHandlerLimits {
            metadata_bytes: 0,
            ..Default::default()
        },
        LegacyHandlerLimits {
            work: 0,
            ..Default::default()
        },
    ] {
        assert!(NativeLegacyPlan::discover(&scan, &body, &types, &mut runtime, limits).is_err());
    }
}

#[test]
fn modern_catch_jumps_out_of_a_legacy_arm_share_typed_cleanup() {
    let input = wat::parse_str(
        r#"(module (tag $e (param i32))
      (func
        block $outside (result i32)
          try (result i32) i32.const 9 throw $e
          catch $e
            drop
            try_table (catch $e $outside) i32.const 5 throw $e end
            unreachable
          end
        end
        drop))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let plan = LegacyHandlerPlan::discover(&body, Default::default()).unwrap();
    let exits: Vec<_> = plan.exits().collect();
    assert_eq!(exits.len(), 1);
    let ((owner, target), cleanup) = exits[0];
    assert_eq!(owner, LegacyHandlerId(0));
    assert_eq!(target, RegionId(1));
    assert_eq!(plan.cleanup_handlers(cleanup).collect::<Vec<_>>(), [owner]);
}
