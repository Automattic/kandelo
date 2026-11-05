use fork_instrument::{module_gc_codec, streaming::*};

use wasm_encoder::{
    Function,
    reencode::{Error, Reencode, RoundtripReencoder},
};

struct Constructors {
    imports: FrozenImports,
    declarations: FrozenDeclarations,
    plan: NativeGcPlan,
    constructors: FrozenGcConstructors,
}

macro_rules! remap {
    ($name:ident) => {
        fn $name(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            self.imports.$name(source)
        }
    };
}

impl Reencode for Constructors {
    type Error = ImportIndexError;
    remap!(function_index);
    remap!(table_index);
    remap!(global_index);
    remap!(tag_index);
    remap!(memory_index);
}

impl FunctionTransform for Constructors {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(&self.imports)
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, source: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        self.constructors
            .emit_function(&self.plan, source, &mut self.imports, limit)
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        self.constructors.emit_helper(ordinal, &self.plan, limit)
    }
}

fn fixture(wide: bool) -> Vec<u8> {
    wat::parse_str(
        include_str!("fixtures/streaming_gc_constructors.wat")
            .replace("@MEMORY_TYPE@", if wide { "i64" } else { "" }),
    )
    .unwrap()
}

fn native(input: &[u8]) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let plan = NativeGcPlan::discover(
        &scan,
        &SourceTypes::new(&scan),
        &mut RoundtripReencoder,
        Default::default(),
    )
    .unwrap();
    let mut inputs = RuntimeInputs::default();
    let reserved =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default()).unwrap();
    let imports = FrozenImports::new(&scan, inputs.imports, 1 << 20).unwrap();
    let constructors = reserved.freeze(&imports).unwrap();
    let types = FrozenDeclarations::new(inputs.types, vec![], 1 << 20).unwrap();
    let declarations =
        FrozenDeclarations::concatenate(&[&types, constructors.declarations()], 1 << 20).unwrap();
    let descriptor = plan.descriptor().unwrap();
    let mut transform = Constructors {
        imports,
        declarations,
        plan,
        constructors,
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    let mut metadata = wasm_encoder::Module::new();
    metadata.section(&wasm_encoder::CustomSection {
        name: module_gc_codec::FORMAT_SECTION.into(),
        data: descriptor.into(),
    });
    output.extend_from_slice(&metadata.finish()[8..]);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn native_gc_constructors_register_exact_scalars_and_reference_seeds_after_allocation() {
    let transit = wat::parse_str("(module (table (export \"transit\") 64 anyref))").unwrap();
    for wide in [false, true] {
        let input = fixture(wide);
        let native = native(&input);
        assert_eq!(self::native(&input), native);
        for (backend, output) in [("native", native)] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
            std::fs::write(directory.path().join("transit.wasm"), &transit).unwrap();
            let script = directory.path().join("test.cjs");
            std::fs::write(
                &script,
                include_str!("fixtures/streaming_gc_constructor_host.cjs"),
            )
            .unwrap();
            let result = std::process::Command::new("node")
                .arg(script)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{backend}, memory64={wide}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}
