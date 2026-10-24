#[path = "support/streaming_gc.rs"]
mod native;
#[path = "support/module_state_oracle.rs"]
mod oracle;

#[test]
fn staged_initializers_capture_the_generated_driver_without_dead_adapter_pointers() {
    for wide in [false, true] {
        for table64 in [false, true] {
            for shape in [2, 4, 5] {
                let pointer = if wide { "i64" } else { "i32" };
                let parameters = (0..shape)
                    .map(|index| if index == 4 { "i32" } else { pointer })
                    .collect::<Vec<_>>()
                    .join(" ");
                let arguments = [64, 32, 128, 16, 7]
                    .into_iter()
                    .take(shape)
                    .enumerate()
                    .map(|(index, value)| {
                        format!("{}.const {value}", if index == 4 { "i32" } else { pointer })
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let input = wat::parse_str(
                    include_str!("fixtures/streaming_loader_activation.wat")
                        .replace("@PARAMETERS@", &parameters)
                        .replace("@ARGUMENTS@", &arguments)
                        .replace("@WIDTH@", if wide { "i64" } else { "" })
                        .replace("@TABLE_WIDTH@", if table64 { "i64" } else { "" })
                        .replace("@TABLE_POINTER@", if table64 { "i64" } else { "i32" }),
                )
                .unwrap();
                for shared in [false, true] {
                    let output = native::emit_activations(&input, shared);
                    assert_eq!(output, native::emit_activations(&input, shared));
                    run(
                        &output,
                        wide,
                        table64,
                        shape,
                    ).unwrap_or_else(|error| panic!("native, memory64={wide}, table64={table64}, shape={shape}, shared={shared}: {error}"));
                }
                let result = run(&oracle::emit_activations(&input), wide, table64, shape);
                if table64 && result.is_err() {
                    let error = result.unwrap_err();
                    assert!(
                        error.contains("wpk_fork_resume_thread")
                            && error.contains("expected type i64")
                            && error.contains("type i32"),
                        "unexpected oracle error: {error}"
                    );
                } else {
                    result.unwrap_or_else(|error| {
                        panic!("Walrus, memory64={wide}, table64={table64}, shape={shape}: {error}")
                    });
                }
            }
        }
    }
}
fn run(output: &[u8], wide: bool, table64: bool, shape: usize) -> Result<(), String> {
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
            include_str!("fixtures/streaming_loader_activation.mjs"),
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
        .args([wide, table64].map(|value| if value { "1" } else { "0" }))
        .arg(shape.to_string())
        .output()
        .unwrap();
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).into_owned())
    }
}
