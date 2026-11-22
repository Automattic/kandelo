//! Private host code-generation fixtures; these are not guest-loader artifacts.
use kandelo_ffi_adapter::{Scalar, Signature, call, callback, reservation};
use std::{fs, path::PathBuf};
use wasm_encoder::*;
fn callee(args: &[Scalar], result: Scalar, sum: bool) -> Vec<u8> {
    let mut m = Module::new();
    let mut types = TypeSection::new();
    types
        .ty()
        .function(args.iter().map(|t| t.wasm().unwrap()), result.wasm());
    m.section(&types);
    let mut funcs = FunctionSection::new();
    funcs.function(0);
    m.section(&funcs);
    let mut exports = ExportSection::new();
    exports.export("entry", ExportKind::Func, 0);
    m.section(&exports);
    let mut f = Function::new([]);
    if sum {
        f.instruction(&Instruction::F64Const(0.0.into()));
        for (i, t) in args.iter().enumerate() {
            f.instruction(&Instruction::LocalGet(i as u32));
            match t {
                Scalar::U8 | Scalar::U16 | Scalar::U32 | Scalar::Pointer => {
                    f.instruction(&Instruction::F64ConvertI32U);
                }
                Scalar::S8 | Scalar::S16 | Scalar::S32 => {
                    f.instruction(&Instruction::F64ConvertI32S);
                }
                Scalar::U64 => {
                    f.instruction(&Instruction::F64ConvertI64U);
                }
                Scalar::S64 => {
                    f.instruction(&Instruction::F64ConvertI64S);
                }
                Scalar::F32 => {
                    f.instruction(&Instruction::F64PromoteF32);
                }
                Scalar::F64 => {}
                Scalar::Void => unreachable!(),
            }
            f.instruction(&Instruction::F64Add);
        }
    } else {
        f.instruction(&Instruction::LocalGet(0));
    }
    f.instruction(&Instruction::End);
    let mut code = CodeSection::new();
    code.function(&f);
    m.section(&code);
    m.finish()
}
fn main() {
    let output = PathBuf::from(std::env::args_os().nth(1).expect("output directory"));
    fs::create_dir_all(&output).unwrap();
    let cases = [
        ("u8", Scalar::U8, 5),
        ("s8", Scalar::S8, 6),
        ("u16", Scalar::U16, 7),
        ("s16", Scalar::S16, 8),
        ("u32", Scalar::U32, 9),
        ("s32", Scalar::S32, 10),
        ("u64", Scalar::U64, 11),
        ("s64", Scalar::S64, 12),
        ("f32", Scalar::F32, 2),
        ("f64", Scalar::F64, 3),
        ("pointer", Scalar::Pointer, 14),
    ];
    for (name, kind, code) in cases {
        let signature = Signature {
            result: kind,
            arguments: vec![kind],
        };
        fs::write(
            output.join(format!("{name}-call.wasm")),
            call(&signature, 1024 * 1024).unwrap(),
        )
        .unwrap();
        fs::write(
            output.join(format!("{name}-callback.wasm")),
            callback(&signature, 4096 + code, 1024 * 1024).unwrap(),
        )
        .unwrap();
        fs::write(
            output.join(format!("{name}-callee.wasm")),
            callee(&[kind], kind, false),
        )
        .unwrap();
    }
    fs::write(
        output.join("reserve.wasm"),
        reservation(1024 * 1024).unwrap(),
    )
    .unwrap();
    for (name, args) in [
        ("triple", vec![Scalar::F64; 3]),
        (
            "mixed",
            cases
                .iter()
                .map(|(_, t, _)| *t)
                .chain([Scalar::F64, Scalar::F64])
                .collect(),
        ),
        ("wide", vec![Scalar::F64; 64]),
    ] {
        let signature = Signature {
            result: Scalar::F64,
            arguments: args.clone(),
        };
        fs::write(
            output.join(format!("{name}-call.wasm")),
            call(&signature, 1024 * 1024).unwrap(),
        )
        .unwrap();
        fs::write(
            output.join(format!("{name}-callback.wasm")),
            callback(&signature, 8192, 1024 * 1024).unwrap(),
        )
        .unwrap();
        fs::write(
            output.join(format!("{name}-callee.wasm")),
            callee(&args, Scalar::F64, true),
        )
        .unwrap();
    }
}
