use fork_instrument::{Options, instrument, streaming::*};

#[test]
fn fixed_start_and_thread_entries_resume_without_repeating_source_entry_effects() {
    for wide in [false, true] {
        for table64 in [false, true] {
            let input = wat::parse_str(
                include_str!("fixtures/streaming_entry_boundaries.wat")
                    .replace("@MEMORY_WIDTH@", if wide { "i64" } else { "" })
                    .replace("@POINTER@", if wide { "i64" } else { "i32" })
                    .replace("@EXTEND@", if wide { "i64.extend_i32_s" } else { "" })
                    .replace("@TABLE_WIDTH@", if table64 { "i64" } else { "" })
                    .replace("@TABLE_POINTER@", if table64 { "i64" } else { "i32" }),
            )
            .unwrap();
            for shared_codecs in [false, true] {
                let scan = scan(&input).unwrap();
                let reaching = scan.reaching_from_seeds([0], false).unwrap();
                let mut plan = NativePipeline::plan(
                    scan,
                    reaching,
                    PipelineOptions {
                        shared_codecs,
                        ..Default::default()
                    },
                    Default::default(),
                )
                .unwrap();
                plan.export(
                    "unwind_tag",
                    wasm_encoder::ExportKind::Tag,
                    plan.runtime().indices().unwind_tag,
                )
                .unwrap();
                let mut output = Vec::new();
                plan.emit(&mut output).unwrap();
                wasmparser::Validator::new_with_features(features())
                    .validate_all(&output)
                    .unwrap();
                run(&output, wide, table64, true).unwrap_or_else(|error| {
                    panic!(
                        "native memory64={wide}, table64={table64}, shared={shared_codecs}: {error}"
                    )
                });
            }
            let mut output = instrument(
                &input,
                &Options {
                    entry_import: "h.fork".into(),
                    sinks: false,
                    facts: false,
                    ..Default::default()
                },
            )
            .unwrap();
            // The oracle owns its private tag import but does not export it.
            let tag = private_unwind_tag(&output);
            add_tag_export(&mut output, tag);
            let result = run(&output, wide, table64, false);
            if table64 {
                let error = result.unwrap_err();
                assert!(
                    error.contains("wpk_fork_resume_thread")
                        && error.contains("expected type i64")
                        && error.contains("type i32"),
                    "{error}"
                );
            } else {
                result.unwrap_or_else(|error| panic!("oracle memory64={wide}: {error}"));
            }
        }
    }
}

fn private_unwind_tag(output: &[u8]) -> u32 {
    let mut tag = 0;
    for payload in wasmparser::Parser::new(0).parse_all(output) {
        if let wasmparser::Payload::ImportSection(section) = payload.unwrap() {
            for import in section.into_imports() {
                let import = import.unwrap();
                if matches!(import.ty, wasmparser::TypeRef::Tag(_)) {
                    if import.module == "env" && import.name == "__wpk_fork_unwind" {
                        return tag;
                    }
                    tag += 1;
                }
            }
        }
    }
    panic!("missing private unwind tag")
}

fn add_tag_export(output: &mut Vec<u8>, tag: u32) {
    use wasm_encoder::reencode::Reencode;
    struct ExportTag(u32);
    impl Reencode for ExportTag {
        type Error = std::convert::Infallible;
        fn parse_export_section(
            &mut self,
            output: &mut wasm_encoder::ExportSection,
            reader: wasmparser::ExportSectionReader<'_>,
        ) -> Result<(), wasm_encoder::reencode::Error<Self::Error>> {
            wasm_encoder::reencode::utils::parse_export_section(self, output, reader)?;
            output.export("unwind_tag", wasm_encoder::ExportKind::Tag, self.0);
            Ok(())
        }
    }
    let mut module = wasm_encoder::Module::new();
    ExportTag(tag)
        .parse_core_module(&mut module, wasmparser::Parser::new(0), output)
        .unwrap();
    *output = module.finish();
}

fn run(output: &[u8], wide: bool, table64: bool, native: bool) -> Result<(), String> {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
    std::fs::write(
        directory.path().join("transit.wasm"),
        wat::parse_str("(module (table (export \"transit\") 128 anyref))").unwrap(),
    )
    .unwrap();
    for (name, source) in [
        (
            "test.mjs",
            include_str!("fixtures/streaming_entry_boundaries.mjs"),
        ),
        (
            "gc_recipe_host.mjs",
            include_str!("fixtures/gc_recipe_host.mjs"),
        ),
        (
            "exception_recipe_host.cjs",
            include_str!("fixtures/exception_recipe_host.cjs"),
        ),
        (
            "table_record_host.cjs",
            include_str!("fixtures/table_record_host.cjs"),
        ),
        (
            "activation_frame_host.cjs",
            include_str!("fixtures/activation_frame_host.cjs"),
        ),
    ] {
        std::fs::write(directory.path().join(name), source).unwrap();
    }
    let result = std::process::Command::new("node")
        .arg(directory.path().join("test.mjs"))
        .args([wide, table64, native].map(|value| if value { "1" } else { "0" }))
        .output()
        .unwrap();
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).into_owned())
    }
}
