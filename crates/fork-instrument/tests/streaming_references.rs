use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    sync::{Arc, Mutex},
};

use fork_instrument::{reference_analysis as oracle, streaming::*};

fn compare(wat: &str) -> Vec<ReferenceAnalysis> {
    let bytes = wat::parse_str(wat).unwrap();
    let scan = scan(&bytes).unwrap();
    let bodies: Vec<_> = FunctionBodies::new(&bytes, IrLimits::default())
        .map(Result::unwrap)
        .collect();
    let local_counts: Vec<_> = bodies
        .iter()
        .map(|b| (b.function, b.locals.len()))
        .collect();
    let local_indices = Arc::new(Mutex::new(BTreeMap::new()));
    let capture = local_indices.clone();
    let mut config = walrus::ModuleConfig::new();
    config.on_instr_loc(|offset| walrus::ir::InstrLocId::new(*offset as u32));
    config.on_parse(move |_, indices| {
        for &(function, count) in &local_counts {
            let id = indices.get_func(function)?;
            for local in 0..count as u32 {
                capture
                    .lock()
                    .unwrap()
                    .insert((id, indices.get_local(id, local)?), local);
            }
        }
        Ok(())
    });
    let module = config.parse(&bytes).unwrap();
    let targets: BTreeSet<_> = (0..scan.functions.len() as u32).collect();
    let old_targets: HashSet<_> = module.funcs.iter().map(|f| f.id()).collect();
    let local_indices = local_indices.lock().unwrap();
    let mut analyses = Vec::new();
    for body in bodies {
        let function = module
            .funcs
            .iter()
            .find(|f| f.id().index() as u32 == body.function)
            .unwrap()
            .id();
        let old = oracle::analyze_function_references(&module, function, &old_targets).unwrap();
        let new = analyze_references(&scan, &body, &targets, ReferenceLimits::default()).unwrap();
        let indices = |set: &BTreeSet<walrus::LocalId>| {
            set.iter()
                .map(|&l| local_indices[&(function, l)])
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(
            new.locals.keys().copied().collect::<BTreeSet<_>>(),
            old.reference_locals
                .keys()
                .map(|&l| local_indices[&(function, l)])
                .collect()
        );
        // The source-preserving native decoder omits statically detached
        // landings. Walrus can retain unreachable suffix nodes in its arena;
        // compare the executable landings by original byte coordinate.
        let new_calls: Vec<_> = new.landings.iter().filter(|c| c.reachable).collect();
        let old_calls: Vec<_> = old.call_sites.iter().filter(|c| c.reachable).collect();
        assert_eq!(new_calls.len(), old_calls.len());
        for (new, old) in new_calls.into_iter().zip(old_calls) {
            let local = module.funcs.get(function).kind.unwrap_local();
            assert_eq!(
                new.point.offset,
                local.block(old.point.sequence).instrs[old.point.instruction_index]
                    .1
                    .data() as usize
            );
            assert_eq!(
                new.live_on_normal_return,
                indices(&old.live_ref_locals_on_normal_return),
                "normal at {:?}",
                new.point
            );
            assert_eq!(
                new.live_on_any_successor,
                indices(&old.live_ref_locals_on_any_successor),
                "any at {:?}",
                new.point
            );
            let null: BTreeSet<_> = old
                .local_nullability_before_call
                .iter()
                .filter_map(|(&l, &n)| {
                    (n == oracle::ReferenceNullability::DefinitelyNull)
                        .then_some(local_indices[&(function, l)])
                })
                .collect();
            assert_eq!(new.definitely_null_before, null, "null at {:?}", new.point);
            assert_eq!(new.reachable, old.reachable);
            assert_eq!(new.has_reference_callee, old.has_reference_callee);
            let native = |refs: &[TypedReference]| {
                refs.iter()
                    .map(|r| (r.index, r.ty.is_nullable()))
                    .collect::<Vec<_>>()
            };
            let expected = |refs: &[oracle::ReferenceOperand]| {
                refs.iter()
                    .map(|r| (r.index, r.ty.nullable))
                    .collect::<Vec<_>>()
            };
            assert_eq!(native(&new.arguments), expected(&old.reference_arguments));
            assert_eq!(native(&new.results), expected(&old.reference_results));
            if old.carryover_precision == oracle::CarryoverPrecision::Exact {
                assert!(new.carryovers_exact);
                assert_eq!(native(&new.carryovers), expected(&old.reference_carryovers));
            }
        }
        analyses.push(new);
    }
    analyses
}

#[test]
fn reference_values_loops_and_null_tests_match_the_original_analysis() {
    compare(
        r#"(module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func (param $value externref) (param $condition i32) (local $merged externref)
        local.get $condition if local.get $value local.set $merged end
        local.get $merged ref.is_null if call $fork drop end
        loop $again call $fork drop local.get $value ref.is_null br_if $again end)
      (func (local $x externref) ref.null extern nop local.set $x call $fork drop local.get $x drop)
      (func (param $value externref)
        block $null local.get $value br_on_null $null drop call $fork drop end)
      (func (param $value externref)
        block $nonnull (result externref) local.get $value br_on_non_null $nonnull
          call $fork drop ref.null extern end drop))"#,
    );
}

#[test]
fn modern_and_legacy_exception_liveness_match_including_handler_rethrow() {
    let analyses = compare(
        r#"(module
      (func $candidate)
      (tag $a) (tag $b)
      (func (param $value externref)
        block $done block $handler
          try_table (catch_all $handler) call $candidate br $done end
        end local.get $value drop end)
      (func (param $outer externref) (param $inner externref)
        try
          try call $candidate catch $a call $candidate rethrow 0
          catch_all local.get $inner drop end
        catch_all local.get $outer drop end)
      (func (local $scratch exnref)
        block $caught (result exnref)
          try_table (result exnref) (catch_all_ref $caught)
            call $candidate ref.null exn end
        end local.set $scratch local.get $scratch throw_ref))"#,
    );
    let call = &analyses[1].landings[0];
    assert!(call.live_on_normal_return.is_empty());
    assert_eq!(call.live_on_any_successor, BTreeSet::from([0]));
    let handler_call = &analyses[2].landings[1];
    assert_eq!(handler_call.live_on_any_successor, BTreeSet::from([0]));
}

#[test]
fn typed_reference_arguments_results_and_carryovers_match() {
    compare(
        r#"(module
      (type $pair (struct (field i32)))
      (type $holder (struct (field (ref null $pair))))
      (type $takes (func (param externref) (result externref)))
      (func $takes (type $takes) local.get 0)
      (elem declare func $takes)
      (table 1 funcref)
      (func $fork (result i32) i32.const 0)
      (func (param $holder (ref $holder))
        local.get $holder struct.get $holder 0 call $fork drop drop
        i32.const 4 struct.new $pair call $fork drop drop
        ref.null extern i32.const 0 call_indirect (type $takes) drop
        ref.null extern ref.func $takes call_ref $takes drop))"#,
    );
}

#[test]
fn unreachable_nested_code_and_tail_calls_do_not_create_landings() {
    let analyses = compare(
        r#"(module
      (func $candidate)
      (func return_call $candidate block call $candidate end call $candidate)
      (func return block call $candidate end))"#,
    );
    assert!(analyses.iter().all(|a| a.landings.is_empty()));
}

#[test]
fn liveness_uses_multiple_bitset_words_and_ignores_unused_locals() {
    let params = "(param externref)".repeat(130);
    let wat = format!(
        "(module (func $fork) (func {params} (local externref) call $fork local.get 129 drop local.get 64 drop local.get 0 drop))"
    );
    let analyses = compare(&wat);
    assert_eq!(analyses[1].locals.len(), 130);
    assert_eq!(
        analyses[1].landings[0].live_on_normal_return,
        BTreeSet::from([0, 64, 129])
    );
}

#[test]
fn reference_analysis_rejects_bounded_resources_without_unbounded_fallback() {
    let bytes = wat::parse_str(
        "(module (func $fork) (func (param externref) call $fork local.get 0 drop))",
    )
    .unwrap();
    let scan = scan(&bytes).unwrap();
    let body = FunctionBodies::new(&bytes, IrLimits::default())
        .nth(1)
        .unwrap()
        .unwrap();
    for limits in [
        ReferenceLimits {
            state_words: 0,
            ..Default::default()
        },
        ReferenceLimits {
            edges: 0,
            ..Default::default()
        },
        ReferenceLimits {
            work: 0,
            ..Default::default()
        },
        ReferenceLimits {
            landing_values: 0,
            ..Default::default()
        },
    ] {
        let error = analyze_references(&scan, &body, &BTreeSet::from([0]), limits).unwrap_err();
        assert!(error.to_string().contains("budget"), "{error:#}");
    }
}
