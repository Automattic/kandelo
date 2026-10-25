#[path = "support/streaming_gc.rs"]
mod native;
#[path = "support/snapshot.rs"]
mod snapshot;

fn input(memory_wide: bool, table_wide: bool, shared: bool, source_memory: bool) -> Vec<u8> {
    let source = include_str!("fixtures/streaming_tables.wat")
        .lines()
        .filter(|line| source_memory || !line.contains("(import \"env\" \"memory\""))
        .collect::<Vec<_>>()
        .join("\n");
    wat::parse_str(
        source
            .replace("@MEMORY_WIDTH@", if memory_wide { "i64" } else { "" })
            .replace("@TABLE_WIDTH@", if table_wide { "i64" } else { "" })
            .replace("@INDEX@", if table_wide { "i64" } else { "i32" })
            .replace("@SHARED@", if shared { "shared" } else { "" }),
    )
    .unwrap()
}
fn descriptor(bytes: &[u8]) -> Vec<u8> {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .find_map(|payload| {
            if let wasmparser::Payload::CustomSection(section) = payload.unwrap() {
                (section.name() == wasm_posix_shared::abi::WPK_FORK_IMPORTED_TABLES_SECTION)
                    .then(|| section.data().to_vec())
            } else {
                None
            }
        })
        .unwrap()
}
#[test]
fn sparse_tables_replay_aliases_growth_and_typed_roots_with_exact_generation_guards() {
    for memory_wide in [false, true] {
        for table_wide in [false, true] {
            for shared in [false, true] {
                let input = input(memory_wide, table_wide, shared, true);
                let native = native::emit_tables(&input);
                assert_eq!(native::emit_tables(&input), native);
                snapshot::check(&input, "table-descriptor", descriptor(&native));
                for (backend, output) in [("native", native)] {
                    replay(&output, backend, memory_wide, table_wide, shared);
                }
            }
        }
    }
}

fn replay(output: &[u8], backend: &str, memory_wide: bool, table_wide: bool, shared: bool) {
    replay_script(
        output,
        backend,
        memory_wide,
        table_wide,
        shared,
        include_str!("fixtures/streaming_tables.mjs"),
    );
}
fn replay_script(
    output: &[u8],
    backend: &str,
    memory_wide: bool,
    table_wide: bool,
    shared: bool,
    script: &str,
) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
    std::fs::write(
        directory.path().join("transit.wasm"),
        wat::parse_str("(module (table (export \"transit\") 128 anyref))").unwrap(),
    )
    .unwrap();
    for (name, contents) in [
        ("test.mjs", script),
        (
            "table_record_host.cjs",
            include_str!("fixtures/table_record_host.cjs"),
        ),
        (
            "gc_recipe_host.mjs",
            include_str!("fixtures/gc_recipe_host.mjs"),
        ),
        (
            "exception_recipe_host.cjs",
            include_str!("fixtures/exception_recipe_host.cjs"),
        ),
    ] {
        std::fs::write(directory.path().join(name), contents).unwrap();
    }
    let result = std::process::Command::new("node")
        .arg(directory.path().join("test.mjs"))
        .args([memory_wide, table_wide, shared].map(|value| if value { "1" } else { "0" }))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{backend}, memory64={memory_wide}, table64={table_wide}, shared={shared}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
fn memoryless_tables_use_the_reserved_process_memory_on_both_widths() {
    for memory_wide in [false, true] {
        for table_wide in [false, true] {
            let input = input(memory_wide, table_wide, true, false);
            let output = native::emit_staged_tables(&input, memory_wide);
            assert_eq!(native::emit_staged_tables(&input, memory_wide), output);
            replay(&output, "native memoryless", memory_wide, table_wide, true);
        }
    }
}

#[test]
fn mixed_table_widths_share_one_snapshot_local_tuple() {
    let input = wat::parse_str(include_str!("fixtures/streaming_tables_mixed.wat")).unwrap();
    let native = native::emit_tables(&input);
    assert_eq!(native::emit_tables(&input), native);
    for (backend, output) in [("native", native)] {
        replay_script(
            &output,
            backend,
            false,
            false,
            false,
            include_str!("fixtures/streaming_tables_mixed.mjs"),
        );
    }
}
