use super::*;

fn with_plan(wat: &str, check: impl FnOnce(&FunctionIr<'_>, LegacyHandlerPlan)) {
    let input = wat::parse_str(wat).unwrap();
    let scan = crate::streaming::scan(&input).unwrap_or_else(|error| panic!("{wat}: {error:#}"));
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let plan = LegacyHandlerPlan::discover(&body, Default::default()).unwrap();
    super::oracle_tests::compare(&input, &plan);
    check(&body, plan);
}

#[test]
fn nested_handler_exits_share_typed_targets_and_keep_live_ancestors() {
    with_plan(
        r#"(module
          (tag $e (param i32))
          (func (param i32)
            block $exit (result i32)
              try $outer (result i32)
                i32.const 1 throw $e
              catch $e
                drop
                block $inside (result i32)
                  try $inner (result i32)
                    i32.const 2 throw $e
                  catch $e
                    drop
                    i32.const 11 local.get 0
                    br_table $inside $outer $exit $inside
                  end
                end
              end
            end
            drop))"#,
        |body, plan| {
            assert_eq!(plan.handlers.len(), 2);
            assert_eq!(plan.handlers[0].parent, None);
            assert_eq!(plan.handlers[1].parent, Some(LegacyHandlerId(0)));
            // The repeated br_table target needs only one typed cleanup shim.
            assert_eq!(plan.exits.len(), 3);
            let exits: Vec<_> = plan.exits().collect();
            for ((owner, target), cleanup) in exits {
                assert_eq!(owner, LegacyHandlerId(1));
                let cleared: Vec<_> = plan.cleanup_handlers(cleanup).collect();
                let kind = body.regions[target.0].kind;
                if target == plan.handlers[0].region || target == RegionId(1) {
                    assert_eq!(cleared, [LegacyHandlerId(1), LegacyHandlerId(0)]);
                } else {
                    assert_eq!(kind, RegionKind::Block);
                    assert_eq!(cleared, [LegacyHandlerId(1)]);
                }
                assert_eq!(
                    body.regions[target.0].signature,
                    wasmparser::BlockType::Type(wasmparser::ValType::I32)
                );
            }
            for handler in plan.handlers() {
                assert!(matches!(
                    body.instructions[handler.source.start - 1].operation,
                    Operator::Catch { .. }
                ));
                assert!(matches!(
                    body.instructions[handler.source.end].operation,
                    Operator::End
                ));
            }
        },
    );
}

#[test]
fn rethrow_selects_its_named_exception_and_clears_inner_owners_first() {
    with_plan(
        r#"(module
          (tag $e)
          (func
            try $outer
              throw $e
            catch $e
              block
                try
                  throw $e
                catch_all
                  block
                    rethrow $outer
                  end
                end
              end
            end))"#,
        |body, plan| {
            assert_eq!(plan.handlers.len(), 2);
            assert_eq!(plan.rethrows.len(), 1);
            let rethrow = &plan.rethrows()[0];
            assert_eq!(rethrow.exception, LegacyHandlerId(0));
            assert_eq!(rethrow.point, body.instructions[rethrow.instruction].point);
            assert_eq!(
                plan.cleanup_handlers(rethrow.cleanup).collect::<Vec<_>>(),
                [LegacyHandlerId(1), LegacyHandlerId(0)]
            );
            assert!(plan.exits.is_empty());
        },
    );
}

#[test]
fn sibling_arms_do_not_inherit_each_other_and_loops_keep_their_owner() {
    with_plan(
        r#"(module
          (tag $e)
          (func (param i32)
            try
              throw $e
            catch $e
              loop $again
                local.get 0 br_if $again
              end
            catch_all
              try
                throw $e
              catch $e
                rethrow 0
              end
            end))"#,
        |_, plan| {
            assert_eq!(plan.handlers.len(), 3);
            assert_eq!(plan.handlers[0].parent, None);
            assert_eq!(plan.handlers[1].parent, None);
            assert_eq!(plan.handlers[2].parent, Some(LegacyHandlerId(1)));
            assert_eq!(plan.handlers[0].ordinal, 0);
            assert_eq!(plan.handlers[1].ordinal, 1);
            assert_eq!(
                plan.handlers[0].source.end + 1,
                plan.handlers[1].source.start
            );
            assert!(plan.exits.is_empty());
            assert_eq!(plan.rethrows[0].exception, LegacyHandlerId(2));
            assert_eq!(
                plan.cleanup_handlers(plan.rethrows[0].cleanup)
                    .collect::<Vec<_>>(),
                [LegacyHandlerId(2)]
            );
        },
    );
}

#[test]
fn delegate_and_detached_handlers_have_no_owned_exception() {
    with_plan("(module (func try nop delegate 0))", |_, plan| {
        assert!(plan.handlers.is_empty());
        assert!(plan.exits.is_empty());
        assert!(plan.rethrows.is_empty());
    });
    let input =
        wat::parse_str("(module (tag $e) (func return try throw $e catch $e rethrow 0 end))")
            .unwrap();
    let scan = crate::streaming::scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let plan = LegacyHandlerPlan::discover(&body, Default::default()).unwrap();
    assert!(plan.handlers.is_empty());
    assert!(plan.exits.is_empty());
    assert!(plan.rethrows.is_empty());
    // The unchanged Walrus parser panics on this valid detached catch. Keep
    // its failure visible, separate from the shared positive oracle checks.
    assert!(std::panic::catch_unwind(|| walrus::Module::from_buffer(&input)).is_err());
}

#[test]
fn discovery_limits_apply_before_expansion_and_charge_ancestor_walks() {
    with_plan(
        "(module (tag $e) (func try throw $e catch $e rethrow 0 end))",
        |body, _| {
            for limits in [
                LegacyHandlerLimits {
                    metadata_bytes: 0,
                    ..Default::default()
                },
                LegacyHandlerLimits {
                    work: 0,
                    ..Default::default()
                },
                LegacyHandlerLimits {
                    work: body.regions.len() + body.instructions.len(),
                    ..Default::default()
                },
            ] {
                assert!(LegacyHandlerPlan::discover(body, limits).is_err());
            }
        },
    );
}

#[test]
fn reference_branches_preserve_their_original_typed_target() {
    for (result, branch) in [
        ("", "ref.null any br_on_null $exit drop"),
        (
            "(result (ref any))",
            "ref.null any br_on_non_null $exit unreachable",
        ),
        (
            "(result (ref i31))",
            "ref.null any br_on_cast $exit (ref null any) (ref i31) drop unreachable",
        ),
        (
            "(result (ref null any))",
            "ref.null any br_on_cast_fail $exit (ref null any) (ref i31) drop unreachable",
        ),
    ] {
        let drop_result = if result.is_empty() { "" } else { "drop" };
        let source = format!(
            "(module (tag $e) (func
               block $exit {result}
                 try {result} throw $e catch_all {branch} end
               end {drop_result}))"
        );
        with_plan(&source, |_, plan| {
            assert_eq!(plan.exits.len(), 1);
            let ((owner, target), cleanup) = plan.exits().next().unwrap();
            assert_eq!(owner, LegacyHandlerId(0));
            assert_eq!(target, RegionId(1));
            assert_eq!(plan.cleanup_handlers(cleanup).collect::<Vec<_>>(), [owner]);
        });
    }
}

#[test]
fn deeply_nested_handlers_share_parent_links_with_linear_metadata() {
    const DEPTH: usize = 64;
    let mut source = String::from("(module (func ");
    for depth in 0..DEPTH {
        source.push_str(&format!("try $h{depth} nop catch_all "));
    }
    source.push_str("rethrow $h0 ");
    source.push_str(&"end ".repeat(DEPTH));
    source.push_str("))");
    with_plan(&source, |body, plan| {
        assert_eq!(plan.handlers.len(), DEPTH);
        assert_eq!(
            plan.cleanup_handlers(plan.rethrows[0].cleanup).count(),
            DEPTH
        );
        let limits = LegacyHandlerLimits {
            metadata_bytes: (body.regions.len() + DEPTH + 1) * 128,
            work: 16 * DEPTH,
        };
        assert!(LegacyHandlerPlan::discover(body, limits).is_ok());
        assert!(
            LegacyHandlerPlan::discover(
                body,
                LegacyHandlerLimits {
                    metadata_bytes: limits.metadata_bytes - 1,
                    ..limits
                }
            )
            .is_err()
        );
    });
}
