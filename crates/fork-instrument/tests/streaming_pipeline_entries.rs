use fork_instrument::streaming::*;

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
        }
    }
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

#[test]
fn public_pthread_resume_supports_independent_memory_and_table_widths() {
    use fork_instrument::{Options, instrument};
    use wasmparser::{ExternalKind, Operator, ValType};

    for memory64 in [false, true] {
        for table64 in [false, true] {
            let pointer = if memory64 { "i64" } else { "i32" };
            let index = if table64 { "i64" } else { "i32" };
            let input = wat::parse_str(format!(
                r#"(module
                  (import "kernel" "kernel_fork" (func $fork (result i32)))
                  (type $thread_ty (func (param {pointer}) (result {pointer})))
                  (table (export "__indirect_function_table") {table_width}1 1 funcref)
                  (elem ({index}.const 0) $thread)
                  (func $thread (type $thread_ty) (param $arg {pointer}) (result {pointer})
                    call $fork drop local.get $arg)
                  (func (export "_start") call $fork drop)
                  (memory {memory_width}1))"#,
                table_width = if table64 { "i64 " } else { "" },
                memory_width = if memory64 { "i64 " } else { "" },
            ))
            .unwrap();
            let output = instrument(&input, &Options::default()).unwrap();
            fork_instrument::native::validate(&output).unwrap();
            let scan = scan(&output).unwrap();
            let wrapper = scan
                .exports
                .iter()
                .find_map(|(name, kind, index)| {
                    (name == "wpk_fork_resume_thread" && *kind == ExternalKind::Func)
                        .then_some(*index)
                })
                .expect("public pthread resume export");
            let types = scan.types.as_ref();
            let signature = types
                .get(types.core_type_at_in_module(scan.functions[wrapper as usize].ty))
                .unwrap()
                .composite_type
                .unwrap_func();
            let pointer = if memory64 { ValType::I64 } else { ValType::I32 };
            assert_eq!(signature.params(), &[ValType::I32, pointer]);
            assert_eq!(signature.results(), &[pointer]);

            // The host index ABI is always i32. Only table64 needs unsigned
            // widening; following memory width here breaks mixed-width modules.
            let body = scan
                .body_provider(Default::default())
                .load(wrapper)
                .unwrap();
            assert_eq!(
                body.instructions
                    .iter()
                    .any(|instruction| matches!(instruction.operation, Operator::I64ExtendI32U)),
                table64
            );
        }
    }
}
