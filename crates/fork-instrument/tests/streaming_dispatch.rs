//! Real function-local capture/replay with a test frame store and private tag.
//! This exercises dispatch independently of unfinished production frame routing.
use fork_instrument::streaming::*;
use std::{collections::BTreeSet, convert::Infallible};
use wasm_encoder::{
    BlockType, Function, Instruction, MemArg, ValType,
    reencode::{Reencode, RoundtripReencoder},
};

struct Hooks {
    wide: bool,
}
impl Reencode for Hooks {
    type Error = Infallible;
}
impl ContinuationHooks for Hooks {
    fn emit_continuation_call(
        &mut self,
        ordinal: u32,
        call: &CallContinuation,
        source: &SourceInstruction<'_>,
        layout: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> anyhow::Result<()> {
        output.instruction(&Instruction::GlobalGet(0));
        output.instruction(&Instruction::I32Eqz);
        output.instruction(&Instruction::GlobalGet(2));
        output.instruction(&Instruction::I32Const(ordinal as i32));
        output.instruction(&Instruction::I32Eq);
        output.instruction(&Instruction::I32And);
        output.instruction(&Instruction::If(BlockType::Empty));
        for field in &layout.fields {
            output.instruction(&pointer(self.wide, 4096));
            layout.emit_get(field.local, output, limit)?;
            output.instruction(&scalar_store(field.ty, field.offset));
        }
        output.instruction(&Instruction::I32Const(ordinal as i32));
        output.instruction(&Instruction::GlobalSet(1));
        output.instruction(&Instruction::I32Const(-1));
        output.instruction(&Instruction::GlobalSet(2));
        output.instruction(&Instruction::I32Const(1));
        output.instruction(&Instruction::GlobalSet(0));
        layout.emit_scratch_release(output, limit)?;
        output.instruction(&Instruction::Throw(0));
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::I32Const(0));
        output.instruction(&Instruction::GlobalSet(0));
        if matches!(call.kind, ReferenceCallKind::Ref { .. }) {
            output.instruction(&Instruction::RefCastNonNull(
                wasm_encoder::HeapType::Concrete(call.signature),
            ));
        }
        output.instruction(&self.instruction(source.operation.clone())?);
        Ok(())
    }
}

struct Transform {
    plan: ContinuationPlan,
    wide: bool,
    limits: DispatchLimits,
    enclosing: usize,
}
impl Reencode for Transform {
    type Error = Infallible;
}
impl FunctionTransform for Transform {
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, body: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        if body.function != self.plan.function {
            return body.emit(self, limit);
        }
        let mut output = self.plan.frame.new_function();
        self.plan.frame.emit_scratch_reserve(&mut output, limit)?;
        output.instruction(&Instruction::GlobalGet(0));
        output.instruction(&Instruction::I32Const(2));
        output.instruction(&Instruction::I32GeU);
        output.instruction(&Instruction::If(BlockType::Empty));
        for field in &self.plan.frame.fields {
            output.instruction(&pointer(self.wide, 4096));
            output.instruction(&scalar_load(field.ty, field.offset));
            self.plan.frame.emit_set(field.local, &mut output, limit)?;
        }
        output.instruction(&Instruction::End);
        for _ in 0..self.enclosing {
            output.instruction(&Instruction::Block(BlockType::Result(ValType::I32)));
        }
        emit_continuation_dispatch(
            body,
            &self.plan,
            &mut Hooks { wide: self.wide },
            &mut output,
            DispatchEnvironment {
                state_global: 0,
                call_index_global: 1,
                enclosing_blocks: self.enclosing,
                function_exit_block: (self.enclosing != 0).then_some(0),
            },
            DispatchLimits {
                output_bytes: limit.min(self.limits.output_bytes),
                ..self.limits
            },
        )?;
        for _ in 0..self.enclosing {
            output.instruction(&Instruction::End);
        }
        self.plan.frame.emit_scratch_release(&mut output, limit)?;
        output.instruction(&Instruction::End);
        Ok(output)
    }
}
fn pointer(wide: bool, value: i64) -> Instruction<'static> {
    if wide {
        Instruction::I64Const(value)
    } else {
        Instruction::I32Const(value as i32)
    }
}
fn scalar_load(ty: ValType, offset: u32) -> Instruction<'static> {
    let arg = MemArg {
        offset: u64::from(offset),
        align: 0,
        memory_index: 0,
    };
    match ty {
        ValType::I32 => Instruction::I32Load(arg),
        ValType::I64 => Instruction::I64Load(arg),
        ValType::F32 => Instruction::F32Load(arg),
        ValType::F64 => Instruction::F64Load(arg),
        ValType::V128 => Instruction::V128Load(arg),
        _ => panic!("scalar test frame"),
    }
}
fn scalar_store(ty: ValType, offset: u32) -> Instruction<'static> {
    let arg = MemArg {
        offset: u64::from(offset),
        align: 0,
        memory_index: 0,
    };
    match ty {
        ValType::I32 => Instruction::I32Store(arg),
        ValType::I64 => Instruction::I64Store(arg),
        ValType::F32 => Instruction::F32Store(arg),
        ValType::F64 => Instruction::F64Store(arg),
        ValType::V128 => Instruction::V128Store(arg),
        _ => panic!("scalar test frame"),
    }
}
fn source(wide: bool, body: &str) -> Vec<u8> {
    let memory = if wide { "i64" } else { "" };
    let pointer = if wide { "i64" } else { "i32" };
    wat::parse_str(format!(
        r#"(module
      (import "h" "fork" (func $fork (param i32) (result i32)))
      (memory (export "memory") {memory} 2)
      (global (export "state") (mut i32) (i32.const 0))
      (global (export "call_index") (mut i32) (i32.const 0))
      (global (export "capture") (mut i32) (i32.const -1))
      (global $counter (export "counter") (mut i32) (i32.const 0))
      (global $__stack_pointer (export "sp") (mut {pointer}) ({pointer}.const 65536))
      (tag $capture (export "captured")) (tag $source (param i32))
      (func (export "work") (param i32) (result i32) (local i32 i64) {body}))"#
    ))
    .unwrap()
}
fn build(bytes: &[u8], wide: bool, limits: DispatchLimits) -> anyhow::Result<(Vec<u8>, usize)> {
    build_enclosed(bytes, wide, limits, 0)
}
fn build_enclosed(
    bytes: &[u8],
    wide: bool,
    limits: DispatchLimits,
    enclosing: usize,
) -> anyhow::Result<(Vec<u8>, usize)> {
    let scan = scan(bytes)?;
    let body = scan.body_provider(Default::default()).load(1)?;
    let types = SourceTypes::new(&scan);
    let mut map = RoundtripReencoder;
    let environment = FrameEnvironment::discover(&scan, &mut map, 1 << 20)?;
    let plan = plan_continuations(
        &scan,
        &body,
        &types,
        &mut map,
        environment,
        &BTreeSet::from([0]),
        Default::default(),
    )?;
    let calls = plan.calls.len();
    let mut output = Vec::new();
    emit_remapped(
        &scan,
        &mut Transform {
            plan,
            wide,
            limits,
            enclosing,
        },
        &mut output,
        Default::default(),
    )?;
    wasmparser::Validator::new_with_features(features()).validate_all(&output)?;
    Ok((output, calls))
}
fn execute(original: &[u8], rewritten: &[u8], selectors: &[usize], input: i32) {
    let old = tempfile::NamedTempFile::new().unwrap();
    let new = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(old.path(), original).unwrap();
    std::fs::write(new.path(), rewritten).unwrap();
    let result = std::process::Command::new("node").arg("-e").arg(r#"
      const fs=require('fs'),assert=require('node:assert/strict');
      const modules=process.argv.slice(1,3).map(p=>new WebAssembly.Module(fs.readFileSync(p)));
      const input=Number(process.argv[4]);
      function make(m){const trace=[];const instance=new WebAssembly.Instance(m,{h:{fork:n=>{trace.push(n);return n+10;}}});return {trace,e:instance.exports};}
      const normal=make(modules[0]),expected=normal.e.work(input);
      const pass=make(modules[1]);assert.equal(pass.e.work(input),expected);assert.deepEqual(pass.trace,normal.trace);assert.equal(Number(pass.e.sp.value),65536);
      for(const selector of process.argv[3].split(',').filter(Boolean).map(Number)){
        const {trace,e}=make(modules[1]);e.capture.value=selector;
        assert.throws(()=>e.work(input),x=>x instanceof WebAssembly.Exception&&x.is(e.captured));
        assert.equal(e.state.value,1);assert.equal(e.call_index.value,selector);assert.equal(Number(e.sp.value),65536);
        e.state.value=2;
        assert.equal(e.work(-999),expected,'restored activation result at '+selector);
        assert.deepEqual(trace,normal.trace,'source side effects at '+selector);
        assert.equal(e.counter.value,normal.e.counter.value);assert.equal(e.state.value,0);assert.equal(Number(e.sp.value),65536);
      }
      const invalid=make(modules[1]);invalid.e.state.value=2;invalid.e.call_index.value=2147483647;
      assert.throws(()=>invalid.e.work(input),WebAssembly.RuntimeError);
    "#).arg(old.path()).arg(new.path()).arg(selectors.iter().map(ToString::to_string).collect::<Vec<_>>().join(",")).arg(input.to_string()).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn generated_dispatch_captures_and_replays_nested_arms_loops_parameters_and_branch_tables() {
    let cases = [
        ("i32.const 1 call $fork i32.const 2 call $fork i32.add", 1),
        (
            "i32.const 10 local.get 0 block (param i32) (result i32) i32.const 1 call $fork i32.add end i32.add",
            3,
        ),
        (
            "local.get 0 if (result i32) i32.const 0 local.set 0 i32.const 1 call $fork else i32.const 1 local.set 0 i32.const 2 call $fork end",
            1,
        ),
        (
            "local.get 0 if (result i32) i32.const 0 local.set 0 i32.const 1 call $fork else i32.const 1 local.set 0 i32.const 2 call $fork end",
            0,
        ),
        (
            "i64.const 7 i32.const 3 local.get 0 if (param i32) (result i32) i32.const 0 local.set 0 i32.const 1 call $fork i32.add else i32.const 1 local.set 0 i32.const 2 call $fork i32.add end local.set 1 i32.wrap_i64 local.get 1 i32.add",
            1,
        ),
        (
            "i64.const 7 i32.const 3 local.get 0 if (param i32) (result i32) i32.const 0 local.set 0 i32.const 1 call $fork i32.add else i32.const 1 local.set 0 i32.const 2 call $fork i32.add end local.set 1 i32.wrap_i64 local.get 1 i32.add",
            0,
        ),
        (
            "block $exit loop $again i32.const 1 call $fork drop local.get 0 i32.const 1 i32.sub local.tee 0 br_if $again end end i32.const 17",
            3,
        ),
        (
            "block $outer i32.const 1 call $fork drop block i32.const 0 br_table $outer $outer end i32.const 2 call $fork drop end i32.const 3 call $fork",
            1,
        ),
        (
            "block $done (result i32) try_table (catch $source $done) i32.const 1 call $fork drop i32.const 42 throw $source end i32.const 0 end i32.const 3 call $fork i32.add",
            1,
        ),
        (
            "i32.const 1 call $fork drop block i32.const 2 drop end i32.const 3 call $fork",
            1,
        ),
    ];
    for wide in [false, true] {
        for (body, input) in cases {
            let bytes = source(wide, body);
            let (output, _) =
                build(&bytes, wide, Default::default()).unwrap_or_else(|e| panic!("{body}: {e:#}"));
            // These are the executed call ordinals, excluding the intentionally
            // skipped alternative arms and branch-table dead paths.
            let selectors: &[usize] = if body.contains("if (result") || body.contains("if (param") {
                if input == 0 { &[1] } else { &[0] }
            } else if body.contains("br_table") {
                &[0, 2]
            } else if body.contains("br_if") || body.contains("block (param") {
                &[0]
            } else {
                &[0, 1]
            };
            execute(&bytes, &output, selectors, input);
            assert_eq!(build(&bytes, wide, Default::default()).unwrap().0, output);
        }
    }
}

#[test]
fn deeply_nested_source_regions_emit_and_replay_without_native_recursion() {
    let depth = 1024;
    let bytes = source(
        false,
        &format!(
            "{} i32.const 1 call $fork drop {} i32.const 7",
            "block ".repeat(depth),
            "end ".repeat(depth)
        ),
    );
    let (output, _) = build(&bytes, false, Default::default()).unwrap();
    execute(&bytes, &output, &[0], 0);
}

#[test]
fn recursive_buckets_drain_boundary_results_and_keep_emitted_nesting_bounded() {
    let calls = 4097;
    let mut body = String::new();
    for index in 0..calls {
        body.push_str(&format!("global.get $counter i32.const 1 i32.add global.set $counter i32.const {index} call $fork drop "));
    }
    body.push_str("global.get $counter");
    let bytes = source(false, &body);
    let (output, planned) = build(&bytes, false, Default::default()).unwrap();
    assert_eq!(planned, calls);
    let scan = scan(&output).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let mut max_depth = 0usize;
    let mut depth = 0usize;
    for instruction in &body.instructions {
        if instruction.opens.is_some() {
            depth += 1;
            max_depth = max_depth.max(depth);
        }
        if matches!(instruction.operation, wasmparser::Operator::End) {
            depth = depth.saturating_sub(1);
        }
    }
    assert!(max_depth < 128, "bucketed nesting depth {max_depth}");
    execute(&bytes, &output, &[0, 31, 32, 1023, 1024, 4096], 0);
}

#[test]
fn dispatch_output_metadata_and_work_limits_fail_explicitly() {
    let bytes = source(false, "i32.const 1 call $fork");
    for limits in [
        DispatchLimits {
            output_bytes: 10,
            ..Default::default()
        },
        DispatchLimits {
            metadata_bytes: 1,
            ..Default::default()
        },
        DispatchLimits {
            work: 0,
            ..Default::default()
        },
    ] {
        assert!(
            build(&bytes, false, limits)
                .err()
                .expect("expected explicit resource error")
                .to_string()
                .contains("budget")
        );
    }
}

#[test]
fn source_reference_branches_and_typed_callees_survive_synthetic_labels_and_compact_locals() {
    let bytes = wat::parse_str(
        r#"(module
      (type $f (func (param i32) (result i32)))
      (import "h" "fork" (func $fork (type $f)))
      (memory (export "memory") 2)
      (global (export "state") (mut i32) (i32.const 0))
      (global (export "call_index") (mut i32) (i32.const 0))
      (global (export "capture") (mut i32) (i32.const -1))
      (global (export "counter") (mut i32) (i32.const 0))
      (global $__stack_pointer (export "sp") (mut i32) (i32.const 65536))
      (tag (export "captured"))
      (table 1 funcref) (elem (i32.const 0) $helper)
      (func (export "work") (param i32) (result i32) (local i64) (local $callee (ref null $f))
        ref.func $helper i32.const 1 call $fork drop
        block $nonnull (param (ref $f)) (result (ref $f))
          br_on_non_null $nonnull unreachable
        end local.set $callee
        i32.const 2 local.get $callee call_ref $f drop
        block $null
          ref.null func br_on_null $null drop unreachable
        end
        i32.const 3 i32.const 0 call_indirect (type $f))
      (func $helper (type $f) local.get 0 call $fork))"#,
    )
    .unwrap();
    let (output, calls) = build(&bytes, false, Default::default()).unwrap();
    assert_eq!(calls, 3);
    execute(&bytes, &output, &[], 1);
}

#[test]
fn detached_regions_and_lexically_retained_tail_suffixes_preserve_local_compaction() {
    for body in [
        "i32.const 1 call $fork drop i32.const 27 return local.get 2 drop block local.get 2 drop end",
        "i32.const 1 call $fork drop i32.const 2 return_call $fork local.get 2 drop unreachable",
    ] {
        let bytes = source(false, body);
        let (output, _) = build(&bytes, false, Default::default()).unwrap();
        execute(&bytes, &output, &[], 1);
    }
}

#[test]
fn original_function_label_branches_cross_all_capture_wrapper_blocks() {
    let bytes = source(false, "i32.const 1 call $fork drop i32.const 21 br 0");
    let (output, _) = build_enclosed(&bytes, false, Default::default(), 2).unwrap();
    execute(&bytes, &output, &[0], 3);
}

#[test]
fn dispatch_capture_replay_round_trips_virtual_scratch_spills_at_bucket_boundaries() {
    let body = format!("{} local.get 0",
        "local.get 0 global.get $counter call $fork i32.add local.set 0 global.get $counter i32.const 1 i32.add global.set $counter ".repeat(40));
    for wide in [false, true] {
        let bytes = source(wide, &body);
        let scan = scan(&bytes).unwrap();
        let source = scan.body_provider(Default::default()).load(1).unwrap();
        let types = SourceTypes::new(&scan);
        let mut map = RoundtripReencoder;
        let environment = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
        let plan = plan_continuations(
            &scan,
            &source,
            &types,
            &mut map,
            environment,
            &BTreeSet::from([0]),
            Default::default(),
        )
        .unwrap();
        assert!(plan.frame.scratch.is_some());
        let (output, _) = build(&bytes, wide, Default::default()).unwrap();
        execute(&bytes, &output, &[0, 31, 32, 39], 7);
    }
}

#[test]
fn common_typed_exit_releases_scratch_for_returns_and_conditional_function_branches() {
    let calls = "local.get 0 global.get $counter call $fork i32.add local.set 0 ".repeat(40);
    for wide in [false, true] {
        for exit in [
            "local.get 0 return",
            "local.get 0 i32.const 1 br_if 0 drop i32.const 7",
        ] {
            let bytes = source(wide, &format!("{calls} {exit}"));
            let (output, _) = build_enclosed(&bytes, wide, Default::default(), 2).unwrap();
            execute(&bytes, &output, &[0, 31, 32, 39], 7);
        }
    }
}

#[test]
fn legacy_rethrow_and_delegate_depths_cross_inserted_dispatch_labels() {
    for body in [
        "try (result i32) try (result i32) i32.const 1 call $fork drop i32.const 42 throw $source catch $source drop local.get 0 if rethrow 1 end i32.const 2 call $fork end catch $source i32.const 3 call $fork i32.add end",
        "try (result i32) try (result i32) i32.const 1 call $fork drop i32.const 42 throw $source delegate 0 i32.const 2 call $fork i32.add catch $source i32.const 3 call $fork i32.add end",
    ] {
        let bytes = source(false, body);
        let (output, _) = build(&bytes, false, Default::default()).unwrap();
        execute(&bytes, &output, &[], 1);
    }
}
