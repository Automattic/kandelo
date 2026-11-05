use fork_instrument::streaming::*;
use std::convert::Infallible;
use wasm_encoder::{
    BlockType, Function, Instruction, ValType,
    reencode::{Reencode, RoundtripReencoder},
};

struct CatchFrameFunction {
    layout: FrameLayout,
    small: LocalKey,
    large: LocalKey,
}
impl Reencode for CatchFrameFunction {
    type Error = Infallible;
}
impl FunctionTransform for CatchFrameFunction {
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, _: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        let layout = &self.layout;
        let mut output = layout.new_function();
        output.instruction(&Instruction::I32Const(111));
        layout.emit_set(self.small, &mut output, limit)?;
        output.instruction(&Instruction::I64Const(222));
        layout.emit_set(self.large, &mut output, limit)?;
        layout.emit_catch_scalars(
            FrameAddress::Global(0),
            LocalKey(0),
            CatchFrameIo::Save,
            &mut output,
            limit,
        )?;
        output.instruction(&Instruction::I32Const(0));
        layout.emit_set(self.small, &mut output, limit)?;
        output.instruction(&Instruction::I64Const(0));
        layout.emit_set(self.large, &mut output, limit)?;
        layout.emit_catch_scalars(
            FrameAddress::Global(0),
            LocalKey(0),
            CatchFrameIo::Restore,
            &mut output,
            limit,
        )?;
        layout.emit_get(LocalKey(0), &mut output, limit)?;
        output.instruction(&Instruction::I32Const(2));
        output.instruction(&Instruction::I32Eq);
        output.instruction(&Instruction::If(BlockType::Result(ValType::I64)));
        layout.emit_get(self.large, &mut output, limit)?;
        output.instruction(&Instruction::Else);
        layout.emit_get(self.small, &mut output, limit)?;
        output.instruction(&Instruction::I64ExtendI32U);
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::End);
        Ok(output)
    }
}

#[test]
fn selected_catch_payload_round_trips_without_overwriting_inactive_overlays() {
    for wide in [false, true] {
        let pointer = if wide { "i64" } else { "i32" };
        let memory = if wide { "i64" } else { "" };
        let input = wat::parse_str(format!(
            r#"(module
          (memory (export "memory") {memory} 1)
          (global (mut {pointer}) ({pointer}.const 8192))
          (func (export "io") (param i32) (result i64) i64.const 0))"#
        ))
        .unwrap();
        let scan = scan(&input).unwrap();
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
        let small = builder.temporary(ValType::I32).unwrap();
        let large = builder.temporary(ValType::I64).unwrap();
        builder.catch_arm(1, vec![small], false).unwrap();
        builder.catch_arm(2, vec![large, small], false).unwrap();
        assert!(builder.catch_arm(1, vec![], false).is_err());
        let layout = builder.finish().unwrap();
        assert_eq!(layout.size, 32);
        let mut short = layout.new_function();
        assert!(
            layout
                .emit_catch_scalars(
                    FrameAddress::Global(0),
                    LocalKey(0),
                    CatchFrameIo::Save,
                    &mut short,
                    1
                )
                .is_err()
        );
        let mut transform = CatchFrameFunction {
            layout,
            small,
            large,
        };
        let mut output = Vec::new();
        emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
        wasmparser::Validator::new_with_features(features())
            .validate_all(&output)
            .unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), output).unwrap();
        let result = std::process::Command::new("node")
            .arg("-e")
            .arg(
                r#"
          const fs = require('node:fs');
          const assert = require('node:assert/strict');
          const module = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
          const { memory, io } = new WebAssembly.Instance(module).exports;
          const bytes = new Uint8Array(memory.buffer);
          const view = new DataView(memory.buffer);
          function reset() { bytes.fill(0xaa, 8192, 8224); }
          reset();
          assert.equal(io(1), 111n);
          assert.equal(view.getUint32(8212, true), 111);
          assert(bytes.slice(8216, 8224).every(value => value === 0xaa));
          reset();
          assert.equal(io(2), 222n);
          assert.equal(view.getBigUint64(8212, true), 222n);
          assert.equal(view.getUint32(8220, true), 111);
          reset();
          assert.equal(io(0), 0n);
          assert(bytes.slice(8192, 8224).every(value => value === 0xaa));
          assert.throws(() => io(3), WebAssembly.RuntimeError);
          assert(bytes.slice(8192, 8224).every(value => value === 0xaa));
        "#,
            )
            .arg(file.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
