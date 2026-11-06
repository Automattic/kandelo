use std::convert::Infallible;

use fork_instrument::streaming::*;
use wasm_encoder::reencode::Reencode;
use wasmparser::Operator;

#[test]
fn typed_ir_resolves_labels_and_landing_stacks_without_walrus() {
    let input = wat::parse_str(
        r#"(module
      (type $call (func (param i32) (result i32)))
      (import "host" "call" (func $call (type $call)))
      (func $f (param i32) (result i32)
        block $out (result i32)
          loop $again
            i32.const 4 local.get 0 call $call i32.add
            br $out
          end
          unreachable
        end)
    )"#,
    )
    .unwrap();
    let mut bodies = FunctionBodies::new(&input, IrLimits::default());
    let body = bodies.next().unwrap().unwrap();
    assert_eq!(body.function, 1);
    assert_eq!(body.locals, vec![wasmparser::ValType::I32]);
    assert_eq!(body.regions.len(), 3);
    assert_eq!(body.regions[2].kind, RegionKind::Loop);
    assert_eq!(body.regions[2].parent, Some(RegionId(1)));
    assert_eq!(body.transfers[0].targets, vec![RegionId(1)]);
    assert_eq!(
        body.calls[0].operand_stack,
        vec![Some(wasmparser::ValType::I32); 2]
    );
    let call = &body.instructions[body.calls[0].instruction];
    assert!(matches!(
        call.operation,
        Operator::Call { function_index: 0 }
    ));
    assert_eq!(input[call.point.offset], 0x10);
    assert!(bodies.next().is_none());
}

#[test]
fn region_input_stacks_and_call_floors_keep_enclosing_values_separate() {
    let input = wat::parse_str(
        r#"(module
      (type $block (func (param i32) (result i32)))
      (import "h" "f" (func $f (param i32) (result i32)))
      (func i64.const 5 i32.const 7 block (type $block) call $f end drop drop))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    assert_eq!(body.regions[1].operand_base, 1);
    assert_eq!(
        body.regions[1].input_stack,
        [
            Some(wasmparser::ValType::I64),
            Some(wasmparser::ValType::I32)
        ]
    );
    assert_eq!(body.calls[0].operand_base, 1);
    assert_eq!(
        body.calls[0].operand_stack,
        [
            Some(wasmparser::ValType::I64),
            Some(wasmparser::ValType::I32)
        ]
    );
    let too_small = IrLimits {
        landing_stack_values: 1,
        ..Default::default()
    };
    assert!(
        scan.body_provider(too_small)
            .load(1)
            .unwrap_err()
            .to_string()
            .contains("landing-stack budget")
    );
}

#[test]
fn exact_exception_arm_order_and_legacy_context_are_retained() {
    let input = wat::parse_str(
        r#"(module
      (tag $tag)
      (func $modern
        block $target
          try_table (catch $tag $target) (catch_all $target)
            throw $tag
          end
        end)
      (func $legacy
        try throw $tag
        catch $tag rethrow 0
        catch_all nop end)
    )"#,
    )
    .unwrap();
    let mut bodies = FunctionBodies::new(&input, IrLimits::default());
    let modern = bodies.next().unwrap().unwrap();
    let handlers = &modern.regions[2].handlers;
    assert_eq!(handlers[0].ordinal, 0);
    assert_eq!(handlers[0].kind, HandlerKind::Catch);
    assert_eq!(handlers[0].tag, Some(0));
    assert_eq!(handlers[1].ordinal, 1);
    assert_eq!(handlers[1].kind, HandlerKind::CatchAll);
    assert_eq!(handlers[1].target, Some(RegionId(1)));
    drop(modern);
    let legacy = bodies.next().unwrap().unwrap();
    assert_eq!(legacy.regions[1].kind, RegionKind::LegacyTry);
    assert_eq!(legacy.regions[1].handlers.len(), 2);
    assert_eq!(legacy.transfers[0].kind, TransferKind::Rethrow);
    assert_eq!(legacy.transfers[0].targets, vec![RegionId(1)]);
}

#[test]
fn typed_ir_is_consumed_one_function_at_a_time_by_the_spooled_emitter() {
    struct Rewrite {
        functions: Vec<u32>,
    }
    impl Reencode for Rewrite {
        type Error = Infallible;
    }
    impl FunctionTransform for Rewrite {
        fn function_ir_limits(&self) -> Option<IrLimits> {
            Some(IrLimits::default())
        }
        fn transform_ir(
            &mut self,
            function: &FunctionIr<'_>,
            limit: usize,
        ) -> anyhow::Result<wasm_encoder::Function> {
            self.functions.push(function.function);
            function.emit(self, limit)
        }
    }
    let input = wat::parse_str(
        r#"(module
      (func (export "f") (result i32) i32.const 1 return i32.const 2)
      (func block $target loop $again i32.const 0 br_if $again br $target end end)
    )"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let mut transform = Rewrite { functions: vec![] };
    let mut output = Vec::new();
    emit_remapped(&scanned, &mut transform, &mut output, EmitLimits::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    assert_eq!(transform.functions, vec![0, 1]);
    assert_eq!(scan(&output).unwrap().operators, scanned.operators);
}

#[test]
fn body_locals_instruction_and_snapshot_limits_are_enforced() {
    let input = wat::parse_str(
        r#"(module
      (import "h" "f" (func $f))
      (func (local i32 i64) i32.const 7 call $f drop nop)
    )"#,
    )
    .unwrap();
    for limits in [
        IrLimits {
            body_bytes: 2,
            ..Default::default()
        },
        IrLimits {
            locals: 1,
            ..Default::default()
        },
        IrLimits {
            instructions: 2,
            ..Default::default()
        },
        IrLimits {
            landing_stack_values: 0,
            ..Default::default()
        },
    ] {
        let error = FunctionBodies::new(&input, limits)
            .next()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("budget"), "{error:#}");
    }
}

#[test]
fn detached_nested_code_is_preserved_and_marked_unreachable() {
    let input = wat::parse_str("(module (func return block nop end nop))").unwrap();
    let body = FunctionBodies::new(&input, IrLimits::default())
        .next()
        .unwrap()
        .unwrap();
    assert!(body.instructions[0].reachable);
    assert!(
        body.instructions[1..body.instructions.len() - 1]
            .iter()
            .all(|i| !i.reachable)
    );
}

#[test]
fn canonical_gc_stack_types_resolve_to_source_indices_before_remapping() {
    let input = wat::parse_str(
        r#"(module
      (type $void (func)) (type $duplicate (func))
      (type $pair (struct (field i32)))
      (type $holder (struct (field (ref null $pair))))
      (func $call (type $void))
      (func (param (ref $holder)) local.get 0 struct.get $holder 0 call $call drop))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = FunctionBodies::new(&input, IrLimits::default())
        .nth(1)
        .unwrap()
        .unwrap();
    let ty = body.calls[0].operand_stack[0].unwrap();
    let wasmparser::ValType::Ref(reference) = ty else {
        panic!("reference carryover")
    };
    let wasmparser::HeapType::Concrete(index) = reference.heap_type() else {
        panic!("concrete struct type")
    };
    assert!(
        index.as_module_index().is_none(),
        "validator annotations are canonical, not binary indices"
    );
    let catalog = SourceTypes::new(&scan);
    assert_eq!(catalog.source_index(index).unwrap(), 2);
    struct Shift;
    impl Reencode for Shift {
        type Error = Infallible;
        fn type_index(
            &mut self,
            index: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(index + 5)
        }
    }
    assert_eq!(
        catalog.value_type(&mut Shift, ty).unwrap(),
        wasm_encoder::ValType::Ref(wasm_encoder::RefType {
            nullable: true,
            heap_type: wasm_encoder::HeapType::Concrete(7),
        })
    );
}

#[test]
fn body_provider_revisits_arbitrary_bodies_without_decoding_preceding_functions() {
    let input=wat::parse_str(format!("(module (import \"h\" \"f\" (func)) (func (result i32) {} i32.const 1) (func (result i32) i32.const 42))","nop ".repeat(100))).unwrap();
    let scan = scan(&input).unwrap();
    let mut provider = scan.body_provider(IrLimits {
        instructions: 2,
        ..Default::default()
    });
    let last = provider.load(2).unwrap();
    assert_eq!(last.function, 2);
    assert!(matches!(
        last.instructions[0].operation,
        Operator::I32Const { value: 42 }
    ));
    let point = last.instructions[0].point;
    drop(last);
    assert!(
        provider
            .load(1)
            .unwrap_err()
            .to_string()
            .contains("instruction budget")
    );
    // A failed decode returns its scratch allocations safely; later bodies
    // can still be validated with the same shared source resources.
    assert_eq!(provider.load(2).unwrap().instructions[0].point, point);
    assert!(
        provider
            .load(0)
            .unwrap_err()
            .to_string()
            .contains("imported function")
    );
    assert!(provider.load(99).is_err());
}

#[test]
fn shared_body_resources_cover_forward_functions_concrete_types_exceptions_and_data() {
    let input = wat::parse_str(
        r#"(module
      (type $node (struct (field i32))) (memory 1) (data $payload "x") (tag $tag)
      (func (param (ref null $node)) call $last data.drop $payload)
      (func $last block $caught try_table (catch_all $caught) throw $tag end end))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut provider = scan.body_provider(IrLimits::default());
    let last = provider.load(1).unwrap();
    assert_eq!(last.regions[2].handlers[0].target, Some(RegionId(1)));
    drop(last);
    let first = provider.load(0).unwrap();
    assert!(matches!(
        first.instructions[0].operation,
        Operator::Call { function_index: 1 }
    ));
    let ty = SourceTypes::new(&scan)
        .value_type(
            &mut wasm_encoder::reencode::RoundtripReencoder,
            first.locals[0],
        )
        .unwrap();
    assert_eq!(
        ty,
        wasm_encoder::ValType::Ref(wasm_encoder::RefType {
            nullable: true,
            heap_type: wasm_encoder::HeapType::Concrete(0)
        })
    );
}
