use fork_instrument::streaming::*;
use std::convert::Infallible;
use wasm_encoder::{Instruction, reencode::Reencode};
use wasmparser::{Operator, Parser, Payload};

struct Helpers {
    declarations: FrozenDeclarations,
    target: u32,
    generated: Vec<u32>,
}

impl Reencode for Helpers {
    type Error = Infallible;
}
impl FunctionTransform for Helpers {
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn transform_operator(
        &mut self,
        _: ProgramPoint,
        op: Operator<'_>,
        body: &mut wasm_encoder::Function,
    ) -> anyhow::Result<()> {
        if matches!(op, Operator::I32Const { value: 7 }) {
            body.instruction(&Instruction::Call(self.target));
        } else {
            body.instruction(&self.instruction(op)?);
        }
        Ok(())
    }
    fn emit_helper(&mut self, helper: u32, _: usize) -> anyhow::Result<wasm_encoder::Function> {
        self.generated.push(helper);
        let mut body = wasm_encoder::Function::new([]);
        body.instruction(&Instruction::I32Const(42))
            .instruction(&Instruction::End);
        Ok(body)
    }
}

fn emit(input: &[u8]) -> (Vec<u8>, EmitReport) {
    let scan = scan(input).unwrap();
    let ty = scan.types.as_ref().core_type_count_in_module();
    let declarations = FrozenDeclarations::new(
        vec![wasm_encoder::FuncType::new(
            [],
            [wasm_encoder::ValType::I32],
        )],
        vec![ty],
        1024,
    )
    .unwrap();
    let mut transform = Helpers {
        declarations,
        target: scan.functions.len() as u32,
        generated: vec![],
    };
    let mut bytes = Vec::new();
    let report = emit_remapped(&scan, &mut transform, &mut bytes, EmitLimits::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&bytes)
        .unwrap();
    assert_eq!(transform.generated, [0]);
    assert_eq!(report.helper_functions, 1);
    (bytes, report)
}

#[test]
fn frozen_helpers_append_types_declarations_and_spooled_bodies() {
    let input = wat::parse_str("(module (func (export \"f\") (result i32) i32.const 7))").unwrap();
    let (bytes, report) = emit(&input);
    assert_eq!(report.functions, 1);
    assert_eq!(scan(&bytes).unwrap().functions.len(), 2);
    assert_eq!(emit(&input).0, bytes);
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), bytes).unwrap();
    let result = std::process::Command::new("node").arg("-e").arg(
        "const fs=require('fs'); const m=new WebAssembly.Module(fs.readFileSync(process.argv[1])); const i=new WebAssembly.Instance(m); if(i.exports.f()!==42)process.exit(1);"
    ).arg(file.path()).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn missing_sections_are_inserted_in_order_after_leading_dylink() {
    for input in [
        wat::parse_str("(module)").unwrap(),
        wat::parse_str("(module (memory 1) (data (i32.const 0) \"x\"))").unwrap(),
        wat::parse_str("(module (type (func)) (import \"h\" \"f\" (func)))").unwrap(),
    ] {
        let mut original = input[..8].to_vec();
        use wasm_encoder::{Encode, Section};
        let dylink = wasm_encoder::CustomSection {
            name: "dylink.0".into(),
            data: vec![].into(),
        };
        original.push(dylink.id());
        dylink.encode(&mut original);
        original.extend_from_slice(&input[8..]);
        let (bytes, report) = emit(&original);
        assert_eq!(report.functions, 0);
        let ids: Vec<_> = Parser::new(0)
            .parse_all(&bytes)
            .filter_map(|p| match p.unwrap() {
                Payload::CustomSection(s) if s.name() == "dylink.0" => Some(0),
                Payload::TypeSection(_) => Some(1),
                Payload::FunctionSection(_) => Some(3),
                Payload::CodeSectionStart { .. } => Some(10),
                _ => None,
            })
            .collect();
        assert_eq!(ids, [0, 1, 3, 10]);
    }
}

#[test]
fn zero_source_code_count_still_emits_frozen_helpers_once() {
    use wasm_encoder::{CodeSection, FunctionSection, Module, TypeSection};
    let mut original = Module::new();
    let mut types = TypeSection::new();
    types.ty().function([], []);
    original
        .section(&types)
        .section(&FunctionSection::new())
        .section(&CodeSection::new());
    let (_, report) = emit(&original.finish());
    assert_eq!(report.functions, 0);
}

#[test]
fn frozen_declarations_and_helper_bodies_obey_output_budgets() {
    assert!(
        FrozenDeclarations::new(
            vec![wasm_encoder::FuncType::new(
                [wasm_encoder::ValType::I64; 10],
                []
            )],
            vec![0],
            1
        )
        .is_err()
    );
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let declarations = FrozenDeclarations::new(
        vec![wasm_encoder::FuncType::new(
            [],
            [wasm_encoder::ValType::I32],
        )],
        vec![0],
        1024,
    )
    .unwrap();
    let mut transform = Helpers {
        declarations,
        target: 0,
        generated: vec![],
    };
    let error = emit_remapped(
        &scan,
        &mut transform,
        &mut Vec::new(),
        EmitLimits {
            max_function_bytes: 1,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("budget"), "{error:#}");
}
