use fork_instrument::streaming::*;
use std::collections::BTreeSet;
use wasm_encoder::{
    Function, Instruction, ValType,
    reencode::{Reencode, RoundtripReencoder},
};

struct MaterializedCalls {
    plan: ContinuationPlan,
}
impl Reencode for MaterializedCalls {
    type Error = std::convert::Infallible;
}
impl FunctionTransform for MaterializedCalls {
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, body: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        if body.function != self.plan.function {
            return body.emit(self, limit);
        }
        let plan = &self.plan;
        let root = &plan.sequences[0];
        let layout = &plan.frame;
        let mut output = layout.new_function();
        layout.emit_scratch_reserve(&mut output, limit)?;
        let mut map = RoundtripReencoder;
        for (index, chunk) in root.chunks.iter().enumerate() {
            for source in &body.instructions[chunk.clone()] {
                match source.operation {
                    wasmparser::Operator::LocalGet { local_index } => {
                        layout.emit_get(LocalKey(local_index), &mut output, limit)?
                    }
                    wasmparser::Operator::LocalSet { local_index } => {
                        layout.emit_set(LocalKey(local_index), &mut output, limit)?
                    }
                    wasmparser::Operator::LocalTee { local_index } => {
                        layout.emit_tee(LocalKey(local_index), &mut output, limit)?
                    }
                    _ => {
                        output.instruction(&map.instruction(source.operation.clone())?);
                    }
                }
            }
            let Some(landing) = root.landings.get(index) else {
                break;
            };
            let ContinuationLandingKind::Call(call) = landing.kind else {
                panic!("straight-line execution fixture")
            };
            let call = &plan.calls[call as usize];
            call.arguments.emit_capture(layout, &mut output, limit)?;
            for &key in call.carryovers.iter().rev() {
                layout.emit_set(key, &mut output, limit)?;
            }
            for &key in &call.carryovers {
                layout.emit_get(key, &mut output, limit)?;
            }
            call.arguments
                .emit_restore(body, layout, &mut map, &mut output, limit)?;
            output.instruction(
                &map.instruction(body.instructions[call.instruction].operation.clone())?,
            );
        }
        layout.emit_scratch_release(&mut output, limit)?;
        output.instruction(&Instruction::End);
        Ok(output)
    }
}

#[test]
fn planned_call_argument_and_carryover_storage_executes_with_compaction_references_and_scratch() {
    for wide in [false, true] {
        for count in [2, 40] {
            let pointer = if wide { "i64" } else { "i32" };
            let memory = if wide { "i64" } else { "" };
            let bytes = wat::parse_str(format!(
                r#"(module
              (import "h" "fork" (func $fork (param i32 externref) (result i32)))
              (memory {memory} 2)
              (global $__stack_pointer (export "sp") (mut {pointer}) ({pointer}.const 65536))
              (global (export "value") (mut i32) (i32.const 3))
              (func (export "work") (param i32 externref) (result i32) (local i64 i32)
                {}
                local.get 0 i32.const 5 i32.add local.tee 3)
              )"#,
                "local.get 0 global.get 1 local.get 1 call $fork i32.add local.set 0 "
                    .repeat(count)
            ))
            .unwrap();
            let scan = scan(&bytes).unwrap();
            let body = scan.body_provider(Default::default()).load(1).unwrap();
            let types = SourceTypes::new(&scan);
            let mut map = RoundtripReencoder;
            let env = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
            let plan = plan_continuations(
                &scan,
                &body,
                &types,
                &mut map,
                env,
                &BTreeSet::from([0]),
                Default::default(),
            )
            .unwrap();
            assert_eq!(plan.frame.scratch.is_some(), count == 40);
            assert!(
                plan.frame.source_local_index(2).is_err(),
                "unused original local was compacted"
            );
            assert!(
                plan.calls
                    .iter()
                    .all(|c| matches!(c.arguments, OperandMaterialization::Spill(_)))
            );
            let mut output = Vec::new();
            emit_remapped(
                &scan,
                &mut MaterializedCalls { plan },
                &mut output,
                Default::default(),
            )
            .unwrap();
            wasmparser::Validator::new_with_features(features())
                .validate_all(&output)
                .unwrap();
            let input = tempfile::NamedTempFile::new().unwrap();
            let transformed = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(input.path(), &bytes).unwrap();
            std::fs::write(transformed.path(), &output).unwrap();
            let result = std::process::Command::new("node").arg("-e").arg(r#"
              const fs=require('fs'),assert=require('node:assert/strict'),count=Number(process.argv[3]);
              const run=path=>{let calls=0,instance;const value={activation:42};
                instance=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path)),{h:{fork:(n,r)=>{
                  assert.equal(r,value);assert.equal(n,calls+3);calls++;instance.exports.value.value=n+1;return n;
                }}});
                const result=instance.exports.work(7,value);assert.equal(calls,count);
                assert.equal(result,12+count*(count+5)/2);assert.equal(Number(instance.exports.sp.value),65536);
                return [result,calls,instance.exports.value.value];};
              assert.deepEqual(run(process.argv[1]),run(process.argv[2]));
            "#).arg(input.path()).arg(transformed.path()).arg(count.to_string()).output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}

fn plan(source: &str, function: u32) -> ContinuationPlan {
    let bytes = wat::parse_str(source).unwrap();
    let scan = scan(&bytes).unwrap();
    let body = scan
        .body_provider(Default::default())
        .load(function)
        .unwrap();
    let types = SourceTypes::new(&scan);
    let mut map = RoundtripReencoder;
    let env = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
    plan_continuations(
        &scan,
        &body,
        &types,
        &mut map,
        env,
        &BTreeSet::from([0]),
        Default::default(),
    )
    .unwrap()
}

#[test]
fn nested_landing_ownership_separates_parent_carryovers_and_body_parameters() {
    let plan = plan(
        r#"(module
      (import "h" "fork" (func $fork (param i32) (result i32)))
      (global i64 (i64.const 99))
      (func (param i32) (result i64)
        global.get 0 local.get 0
        block (param i32) (result i64)
          local.get 0 call $fork drop drop i64.const 3
        end i64.add))"#,
        1,
    );
    assert_eq!(plan.calls.len(), 1);
    assert!(matches!(
        plan.calls[0].arguments,
        OperandMaterialization::Replay(_)
    ));
    assert_eq!(plan.calls[0].carryovers.len(), 1);
    assert_eq!(
        plan.frame.local(plan.calls[0].carryovers[0]).unwrap().ty,
        ValType::I32
    );
    assert_eq!(plan.sequences[0].calls, Some(0..1));
    let ContinuationLandingKind::Region {
        inputs: OperandMaterialization::Spill(inputs),
        ..
    } = &plan.sequences[0].landings[0].kind
    else {
        panic!("expected captured region inputs")
    };
    assert_eq!(
        inputs
            .iter()
            .map(|&k| plan.frame.local(k).unwrap().ty)
            .collect::<Vec<_>>(),
        [ValType::I64, ValType::I32]
    );
    assert_eq!(plan.sequences[1].input_parameters.len(), 1);
    let temporary = plan.sequences[1].input_parameters[0];
    assert!(!plan.frame.fields.iter().any(|f| f.local == temporary));
    assert_eq!(plan.frame.size, 16 + 4 + 4 + 8 + 4);
}

#[test]
fn if_arms_and_nonfork_regions_have_distinct_ranges_and_exact_chunks() {
    let plan = plan(
        r#"(module (import "h" "fork" (func $fork))
      (func (param i32)
        block i32.const 7 drop end
        local.get 0 if
          call $fork
          block call $fork end
        else call $fork end
        call $fork))"#,
        1,
    );
    assert_eq!(plan.calls.len(), 4);
    let root = &plan.sequences[0];
    assert_eq!(root.calls, Some(0..4));
    assert_eq!(root.landings.len(), 2);
    assert_eq!(root.chunks.len(), 3);
    let ContinuationLandingKind::Region { arms, inputs, .. } = &root.landings[0].kind else {
        panic!()
    };
    assert_eq!(arms.len(), 2);
    assert_eq!(plan.sequences[arms[0].0].calls, Some(0..2));
    assert_eq!(plan.sequences[arms[1].0].calls, Some(2..3));
    assert!(matches!(inputs, OperandMaterialization::Replay(_)));
    assert_eq!(root.landings[0].calls, 0..3);
    assert!(
        root.chunks[0].end > root.chunks[0].start,
        "nonfork block remains in the chunk"
    );
    assert!(matches!(
        root.landings[1].kind,
        ContinuationLandingKind::Call(3)
    ));
}

#[test]
fn references_include_replayed_arguments_ancestor_inputs_parameters_and_null_restores() {
    let plan = plan(
        r#"(module
      (import "h" "fork" (func $fork (param externref)))
      (global externref (ref.null extern))
      (func (param externref) (local externref externref)
        local.get 0 local.set 1
        global.get 0
        block (param externref)
          drop local.get 1 call $fork
          local.get 2 drop
        end))"#,
        1,
    );
    let call = &plan.calls[0];
    assert!(matches!(call.arguments, OperandMaterialization::Replay(_)));
    let slots: BTreeSet<_> = plan.references.slots.iter().map(|s| s.local).collect();
    assert!(
        slots.contains(&LocalKey(0)),
        "resume parameter must be in the universal prefix"
    );
    assert!(
        slots.contains(&LocalKey(1)),
        "pure argument local is activation owned"
    );
    let ContinuationLandingKind::Region {
        inputs: OperandMaterialization::Spill(inputs),
        ..
    } = &plan.sequences[0].landings[0].kind
    else {
        panic!()
    };
    assert!(
        slots.contains(&inputs[0]),
        "ancestor reference must survive an inner call"
    );
    assert_eq!(
        plan.references.null_locals_by_call[0]
            .iter()
            .map(|(k, _)| *k)
            .collect::<Vec<_>>(),
        [LocalKey(2)]
    );
    assert!(
        plan.references
            .slots
            .iter()
            .all(|s| s.universal_position.is_some())
    );
}

#[test]
fn replayed_ancestor_reference_input_is_saved_even_when_dead_at_the_inner_call() {
    let plan = plan(
        r#"(module (import "h" "fork" (func $fork))
      (func (param externref) (local externref)
        local.get 0 local.set 1
        local.get 1 block (param externref) drop call $fork end))"#,
        1,
    );
    let ContinuationLandingKind::Region { inputs, .. } = &plan.sequences[0].landings[0].kind else {
        panic!()
    };
    assert!(matches!(inputs, OperandMaterialization::Replay(_)));
    assert!(
        plan.references.slots.iter().any(|s| s.local == LocalKey(1)),
        "the original CFG sees no use after the inner call, but replay reissues local.get 1"
    );
}

#[test]
fn modern_exception_edges_and_legacy_handler_entry_parameters_are_planned() {
    let modern = plan(
        r#"(module (import "h" "fork" (func $fork))
      (tag $t) (func (param externref) (local externref)
        local.get 0 local.set 1
        block $caught
          try_table (catch $t $caught) call $fork end
          return
        end local.get 1 drop))"#,
        1,
    );
    assert!(
        modern
            .references
            .slots
            .iter()
            .any(|s| s.local == LocalKey(1)),
        "exception successor needs live local"
    );
    let legacy = plan(
        r#"(module (import "h" "fork" (func $fork))
      (tag $t (param i64))
      (func try i64.const 42 throw $t catch $t call $fork drop catch_all call $fork end))"#,
        1,
    );
    let arms: Vec<_> = legacy
        .sequences
        .iter()
        .filter(|s| s.region == RegionId(1))
        .collect();
    assert_eq!(arms.len(), 3);
    assert_eq!(arms[0].calls, None);
    assert_eq!(arms[1].calls, Some(0..1));
    assert_eq!(arms[2].calls, Some(1..2));
    assert_eq!(arms[1].input_parameters.len(), 1);
    assert_eq!(
        legacy.frame.local(arms[1].input_parameters[0]).unwrap().ty,
        ValType::I64
    );
    assert!(arms[2].input_parameters.is_empty());
}

#[test]
fn indirect_reference_calls_and_pure_tail_barriers_preserve_signature_inputs() {
    let plan = plan(
        r#"(module
      (type $f (func (param i32))) (import "h" "fork" (func $fork (type $f)))
      (memory 1) (table 1 funcref) (elem (i32.const 0) $fork)
      (func (param (ref $f))
        i32.const 1 i32.const 2 i32.add i32.const 0 call_indirect (type $f)
        i32.const 3 local.get 0 call_ref $f
        i32.const 0 i32.load call $fork))"#,
        1,
    );
    assert_eq!(plan.calls.len(), 3);
    assert!(matches!(
        plan.calls[0].arguments,
        OperandMaterialization::Replay(_)
    ));
    assert!(
        matches!(plan.calls[1].arguments, OperandMaterialization::Spill(_)),
        "typed ref is not exact generic funcref suffix output"
    );
    assert!(
        matches!(plan.calls[2].arguments, OperandMaterialization::Spill(_)),
        "loads must not replay"
    );
}

#[test]
fn planning_limits_reject_incomplete_work_and_deep_regions_do_not_recurse() {
    let bytes = wat::parse_str(
        r#"(module (import "h" "fork" (func $fork (param i32))) (func i32.const 1 call $fork))"#,
    )
    .unwrap();
    let scan = scan(&bytes).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let types = SourceTypes::new(&scan);
    for limits in [
        ContinuationLimits {
            metadata_bytes: 100,
            ..Default::default()
        },
        ContinuationLimits {
            values: 0,
            ..Default::default()
        },
        ContinuationLimits {
            work: 0,
            ..Default::default()
        },
    ] {
        let mut map = RoundtripReencoder;
        let environment = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
        assert!(
            plan_continuations(
                &scan,
                &body,
                &types,
                &mut map,
                environment,
                &BTreeSet::from([0]),
                limits
            )
            .err()
            .expect("expected budget error")
            .to_string()
            .contains("budget")
        );
    }
    let depth = 1024;
    let source = format!(
        "(module (import \"h\" \"fork\" (func $fork)) (func {} call $fork {}))",
        "block ".repeat(depth),
        "end ".repeat(depth)
    );
    let plan = plan(&source, 1);
    assert_eq!(plan.sequences.len(), depth + 1);
    assert!(plan.sequences.iter().all(|s| s.calls == Some(0..1)));
}
