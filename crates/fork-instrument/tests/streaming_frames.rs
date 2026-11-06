use fork_instrument::streaming::*;
use std::convert::Infallible;
use wasm_encoder::{
    Function, Instruction, ValType,
    reencode::{Reencode, RoundtripReencoder},
};

struct ScratchFunction {
    layout: FrameLayout,
    values: Vec<LocalKey>,
    wide: bool,
}
impl Reencode for ScratchFunction {
    type Error = Infallible;
}
impl FunctionTransform for ScratchFunction {
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, _: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        let l = &self.layout;
        let mut f = l.new_function();
        f.instruction(&Instruction::LocalGet(l.source_local_index(0)?));
        f.instruction(&Instruction::GlobalSet(1));
        l.emit_scratch_reserve(&mut f, limit)?;
        for (i, &key) in self.values.iter().enumerate() {
            f.instruction(&Instruction::I64Const(42 + i as i64));
            l.emit_set(key, &mut f, limit)?;
        }
        l.emit_scratch_save(FrameAddress::Buffer(1), &mut f, limit)?;
        for &key in &self.values {
            f.instruction(&Instruction::I64Const(0));
            l.emit_tee(key, &mut f, limit)?;
            f.instruction(&Instruction::Drop);
        }
        f.instruction(&Instruction::GlobalGet(0));
        f.instruction(&if self.wide {
            Instruction::I64Const(32)
        } else {
            Instruction::I32Const(32)
        });
        f.instruction(&if self.wide {
            Instruction::I64Sub
        } else {
            Instruction::I32Sub
        });
        f.instruction(&Instruction::GlobalSet(0));
        l.emit_scratch_reseed(&mut f, limit)?;
        l.emit_scratch_restore(FrameAddress::Buffer(1), &mut f, limit)?;
        l.emit_get(self.values[0], &mut f, limit)?;
        l.emit_scratch_release(&mut f, limit)?;
        f.instruction(&Instruction::End);
        Ok(f)
    }
}

#[test]
fn native_virtual_spills_bulk_snapshot_and_stack_discipline_execute_for_both_widths() {
    for wide in [false, true] {
        let pointer = if wide { "i64" } else { "i32" };
        let mem = if wide { "i64" } else { "" };
        let bytes = wat::parse_str(format!(
            r#"(module (memory (export "memory") {mem} 2)
          (global $__stack_pointer (export "sp") (mut {pointer}) ({pointer}.const 65536))
          (global (mut {pointer}) ({pointer}.const 0))
          (func (export "work") (param {pointer}) (result i64) i64.const 0))"#
        ))
        .unwrap();
        let scan = scan(&bytes).unwrap();
        let body = scan.body_provider(Default::default()).load(0).unwrap();
        let types = SourceTypes::new(&scan);
        let mut map = RoundtripReencoder;
        let environment = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
        let mut builder = FrameBuilder::new(
            &scan,
            &body,
            &types,
            &mut map,
            environment,
            Default::default(),
        )
        .unwrap();
        let values: Vec<_> = (0..64)
            .map(|_| builder.saved(ValType::I64).unwrap())
            .collect();
        let layout = builder.finish().unwrap();
        assert_eq!(
            layout.local_declarations().len(),
            2,
            "only scratch base and width temporary are physical"
        );
        let offset = layout.scratch.as_ref().unwrap().node_spill_start;
        assert!(layout.local_index(values[0]).is_err());
        let mut transform = ScratchFunction {
            layout,
            values,
            wide,
        };
        let mut output = Vec::new();
        emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
        wasmparser::Validator::new_with_features(features())
            .validate_all(&output)
            .unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), output).unwrap();
        let result=std::process::Command::new("node").arg("-e").arg(r#"
          const fs=require('fs'),assert=require('node:assert/strict'),wide=process.argv[2]==='1',off=Number(process.argv[3]);
          const e=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(process.argv[1]))).exports;
          const d=new DataView(e.memory.buffer);if(wide)d.setBigUint64(512,8192n,true);else d.setUint32(512,8192,true);
          for(let i=0;i<2;i++){assert.equal(e.work(wide?512n:512),42n);assert.equal(e.sp.value,wide?65536n:65536);assert.equal(d.getBigInt64(8192+off,true),42n);assert.equal(d.getBigInt64(8192+off+63*8,true),105n);}
        "#).arg(file.path()).arg(if wide{"1"}else{"0"}).arg(offset.to_string()).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn native_catch_payloads_overlay_one_region_and_reference_plans_have_a_stable_prefix() {
    let bytes =
        wat::parse_str(r#"(module (func (param externref) (local externref) local.get 1 drop))"#)
            .unwrap();
    let scan = scan(&bytes).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let types = SourceTypes::new(&scan);
    let mut map = RoundtripReencoder;
    let environment = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
    let mut builder = FrameBuilder::new(
        &scan,
        &body,
        &types,
        &mut map,
        environment,
        Default::default(),
    )
    .unwrap();
    let i32 = builder.temporary(ValType::I32).unwrap();
    let v128 = builder.temporary(ValType::V128).unwrap();
    builder.catch_arm(1, vec![i32], false).unwrap();
    builder.catch_arm(2, vec![v128, i32], false).unwrap();
    let reference = builder
        .saved(ValType::Ref(wasm_encoder::RefType::FUNCREF))
        .unwrap();
    let layout = builder.finish().unwrap();
    assert_eq!(layout.size, 36);
    assert_eq!(layout.catch[0].fields[0].offset, 16);
    assert_eq!(layout.catch[1].fields[0].offset, 16);
    let refs = layout
        .reference_plan(
            &[
                vec![LocalKey(0), reference, LocalKey(1)],
                vec![LocalKey(0), reference],
            ],
            &[vec![], vec![LocalKey(1)]],
        )
        .unwrap();
    assert_eq!(
        refs.slots.iter().map(|s| s.local).collect::<Vec<_>>(),
        [LocalKey(0), reference, LocalKey(1)]
    );
    assert_eq!(
        refs.slots
            .iter()
            .map(|s| s.universal_position)
            .collect::<Vec<_>>(),
        [Some(0), Some(1), None]
    );
    assert_eq!(refs.slots_by_call, [vec![0, 1, 2], vec![0, 1]]);
    assert_eq!(refs.null_locals_by_call[1][0].0, LocalKey(1));
    assert!(!layout.codec_shape(true, &refs).unwrap().commits);
}

#[test]
fn frame_limits_reject_partial_local_reference_and_output_plans() {
    let bytes = wat::parse_str("(module (func (param externref)))").unwrap();
    let scan = scan(&bytes).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let types = SourceTypes::new(&scan);
    let mut map = RoundtripReencoder;
    let environment = FrameEnvironment::discover(&scan, &mut map, 1024).unwrap();
    let mut builder = FrameBuilder::new(
        &scan,
        &body,
        &types,
        &mut map,
        environment,
        FrameLimits {
            locals: 1,
            reference_memberships: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(builder.saved(ValType::I32).is_err());
    let layout = builder.finish().unwrap();
    assert!(
        layout
            .reference_plan(&[vec![LocalKey(0)], vec![LocalKey(0)]], &[vec![], vec![]])
            .is_err()
    );
    assert!(
        layout
            .emit_get(LocalKey(0), &mut layout.new_function(), 0)
            .is_err()
    );
    assert!(
        FrameBuilder::new(
            &scan,
            &body,
            &types,
            &mut map,
            environment,
            FrameLimits {
                metadata_bytes: 0,
                ..Default::default()
            }
        )
        .is_err()
    );
}
