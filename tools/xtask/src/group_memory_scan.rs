pub fn run(args: &[String]) -> Result<(), String> {
    let check = match args {
        [] => false,
        [arg] if arg == "--check" => true,
        _ => return Err("usage: xtask group-memory-scan [--check]".into()),
    };
    let root = crate::repo_root();
    let stage = tempfile::tempdir().map_err(|error| error.to_string())?;
    let output = stage.path().join("group-memory-scan.wasm");
    let built = std::process::Command::new("rustc")
        .current_dir(&root)
        .args([
            "--target=wasm32-unknown-unknown",
            "--crate-type=cdylib",
            "--edition=2024",
            "-Copt-level=3",
            "-Clto",
            "-Cpanic=abort",
            "-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals",
            "-Clink-arg=--no-entry",
            "-Clink-arg=--import-memory",
            "-Clink-arg=--shared-memory",
            "-Clink-arg=--initial-memory=0",
            "-Clink-arg=-z",
            "-Clink-arg=stack-size=0",
            "-Clink-arg=--max-memory=4294967296",
            "-Clink-arg=--strip-all",
        ])
        .arg(root.join("crates/kernel/helpers/group-memory-scan.rs"))
        .arg("-o")
        .arg(&output)
        .output()
        .map_err(|error| error.to_string())?;
    if !built.status.success() {
        return Err(format!(
            "compile Group scanner primitives: {}",
            String::from_utf8_lossy(&built.stderr)
        ));
    }
    let bytes = std::fs::read(output).map_err(|error| error.to_string())?;
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&bytes)
        .map_err(|error| format!("Group scanner validation: {error}"))?;
    for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
        use wasmparser::{Payload, TypeRef};
        match payload.map_err(|error| error.to_string())? {
            Payload::StartSection { .. } | Payload::MemorySection(_) => {
                return Err(
                    "Group scanner must only import existing memory and defer execution".into(),
                );
            }
            Payload::DataSection(data) if data.count() != 0 => {
                return Err("Group scanner may not initialize foreign memory".into());
            }
            Payload::CodeSectionEntry(body) => {
                let mut operations = body
                    .get_operators_reader()
                    .map_err(|error| error.to_string())?;
                while !operations.eof() {
                    use wasmparser::Operator;
                    // Admit only control flow, local integer computation and
                    // seq-cst loads. No stores, RMWs, callbacks, mutable globals,
                    // tables, allocation or non-atomic foreign reads.
                    let operation = operations.read().map_err(|error| error.to_string())?;
                    if !matches!(
                        operation,
                        Operator::Block { .. }
                            | Operator::Loop { .. }
                            | Operator::If { .. }
                            | Operator::Else
                            | Operator::End
                            | Operator::Br { .. }
                            | Operator::BrIf { .. }
                            | Operator::Return
                            | Operator::Unreachable
                            | Operator::Drop
                            | Operator::Select
                            | Operator::LocalGet { .. }
                            | Operator::LocalSet { .. }
                            | Operator::LocalTee { .. }
                            | Operator::I32Const { .. }
                            | Operator::I64Const { .. }
                            | Operator::I32Eqz
                            | Operator::I32Eq
                            | Operator::I32Ne
                            | Operator::I32LtU
                            | Operator::I32GtU
                            | Operator::I32LeU
                            | Operator::I32GeU
                            | Operator::I32Add
                            | Operator::I32Sub
                            | Operator::I32And
                            | Operator::I32Or
                            | Operator::I32Shl
                            | Operator::I32ShrU
                            | Operator::I32WrapI64
                            | Operator::I64Eqz
                            | Operator::I64Eq
                            | Operator::I64Ne
                            | Operator::I64LtU
                            | Operator::I64GtU
                            | Operator::I64LeU
                            | Operator::I64GeU
                            | Operator::I64Add
                            | Operator::I64Sub
                            | Operator::I64And
                            | Operator::I64Or
                            | Operator::I64Shl
                            | Operator::I64ShrU
                            | Operator::I64ExtendI32U
                            | Operator::MemorySize { .. }
                            | Operator::I32AtomicLoad { .. }
                    ) {
                        return Err(format!(
                            "Group scanner is not a read-only primitive: {operation:?}"
                        ));
                    }
                }
            }
            Payload::ImportSection(imports) => {
                for entry in imports.into_imports() {
                    let entry = entry.map_err(|error| error.to_string())?;
                    match entry.ty {
                        TypeRef::Memory(memory)
                            if entry.module == "env"
                                && entry.name == "memory"
                                && memory.shared
                                && !memory.memory64
                                && memory.initial == 0
                                && memory.maximum == Some(65536) => {}
                        _ => return Err("unexpected Group scanner import".into()),
                    }
                }
            }
            _ => {}
        }
    }
    let mut source = String::from(
        "// Generated by xtask group-memory-scan from crates/kernel/helpers/group-memory-scan.rs; do not edit.\nexport const GROUP_MEMORY_SCAN_BYTES = new Uint8Array([\n",
    );
    for chunk in bytes.chunks(32) {
        source.push_str("  ");
        for byte in chunk {
            source.push_str(&format!("{byte},"));
        }
        source.push('\n');
    }
    source.push_str("]);\n");
    let path = root.join("host/src/generated/group-memory-scan.ts");
    if check {
        if std::fs::read_to_string(&path).map_err(|e| e.to_string())? != source {
            return Err("Group scanner artifact is stale".into());
        }
    } else {
        std::fs::write(path, source).map_err(|e| e.to_string())?;
    }
    Ok(())
}
