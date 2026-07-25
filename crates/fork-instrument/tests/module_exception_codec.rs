use fork_instrument::module_exception_codec::{
    FORMAT_HEADER_SIZE, FORMAT_SECTION, FORMAT_TAG_RECORD_SIZE, FORMAT_VERSION,
    IMPORT_SCRATCH_RELEASE, IMPORT_SCRATCH_RESERVE, inject,
};
use walrus::Module;

const RETIRED_STAGING_MEMORY_EXPORT: &str = "__wpk_fork_ref_exn_staging";

fn codec_fixture() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (import "env" "memory" (memory 1))
          (tag $empty)
          (tag $scalars (param i32 i64 f32 f64 v128))
          (tag $references
            (param (ref null extern) (ref null func) (ref null exn) (ref null any))))
        "#,
    )
    .expect("codec fixture WAT")
}

#[test]
fn exact_tag_codec_uses_only_the_existing_process_memory() {
    let mut module = Module::from_buffer(&codec_fixture()).expect("parse codec fixture");
    let memory = module.memories.iter().next().expect("fixture memory").id();
    let before_memories = module.memories.iter().count();
    let codec = inject(&mut module, memory).expect("inject codec");

    assert_eq!(codec.memory, memory);
    assert_eq!(module.memories.iter().count(), before_memories);
    assert!(
        module
            .exports
            .iter()
            .all(|export| export.name != RETIRED_STAGING_MEMORY_EXPORT),
        "the codec must not export or depend on a private staging memory",
    );
    for name in [IMPORT_SCRATCH_RESERVE, IMPORT_SCRATCH_RELEASE] {
        assert!(
            module
                .imports
                .iter()
                .any(|import| import.module == "env" && import.name == name),
            "missing transaction scratch import {name}",
        );
    }

    let output = module.emit_wasm();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("generated codec validates");
}

#[test]
fn descriptor_records_exact_scalar_and_reference_layouts() {
    let mut module = Module::from_buffer(&codec_fixture()).expect("parse codec fixture");
    let memory = module.memories.iter().next().expect("fixture memory").id();
    inject(&mut module, memory).expect("inject codec");
    let output = module.emit_wasm();
    let engine_module = WebAssemblyModule::new(&output);
    let section = engine_module
        .custom_section(FORMAT_SECTION)
        .expect("codec descriptor");

    assert_eq!(section[0], FORMAT_VERSION);
    assert_eq!(u32::from_le_bytes(section[4..8].try_into().unwrap()), 3,);
    assert_eq!(
        section.len(),
        FORMAT_HEADER_SIZE + 3 * FORMAT_TAG_RECORD_SIZE,
    );
    let scalar = &section[FORMAT_HEADER_SIZE + FORMAT_TAG_RECORD_SIZE
        ..FORMAT_HEADER_SIZE + 2 * FORMAT_TAG_RECORD_SIZE];
    assert_eq!(u32::from_le_bytes(scalar[8..12].try_into().unwrap()), 40);
    assert_eq!(u32::from_le_bytes(scalar[12..16].try_into().unwrap()), 0);
    let references = &section[FORMAT_HEADER_SIZE + 2 * FORMAT_TAG_RECORD_SIZE..];
    assert_eq!(u32::from_le_bytes(references[8..12].try_into().unwrap()), 0,);
    assert_eq!(
        u32::from_le_bytes(references[12..16].try_into().unwrap()),
        4,
    );
}

struct WebAssemblyModule<'a> {
    bytes: &'a [u8],
}

impl<'a> WebAssemblyModule<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn custom_section(&self, name: &str) -> Option<Vec<u8>> {
        for payload in wasmparser::Parser::new(0).parse_all(self.bytes) {
            let payload = payload.ok()?;
            if let wasmparser::Payload::CustomSection(section) = payload
                && section.name() == name
            {
                return Some(section.data().to_vec());
            }
        }
        None
    }
}
