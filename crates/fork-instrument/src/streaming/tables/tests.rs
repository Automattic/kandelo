use super::*;
fn plan(input: &[u8], limits: TableStateLimits) -> Result<NativeTableState> {
    let scan = scan(input)?;
    let mut inputs = RuntimeInputs::default();
    let records = RootStateImports::append(&scan, &mut inputs, 1 << 20)?;
    let host = TableStateImports::append(&scan, &mut inputs, 1 << 20)?;
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20)?;
    let imports = runtime.imports_plan().clone();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&imports),
        runtime.local_declarations().clone(),
        1 << 20,
    )?;
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    NativeTableState::plan(
        &scan,
        &mut runtime,
        &records,
        &host,
        &mut module,
        first_type,
        imports.helper_function_base() + 7,
        limits,
    )
}
#[test]
fn source_catalog_skips_read_only_tables_but_keeps_imported_alias_owners() {
    let input = wat::parse_str(
        r#"(module
        (import "h" "same" (table 2 funcref))
        (import "h" "same" (table 2 funcref))
        (table 3 funcref)
        (table 4 anyref)
        (func i32.const 0 ref.null any table.set 3))"#,
    )
    .unwrap();
    let plan = plan(&input, Default::default()).unwrap();
    assert_eq!(
        plan.tables.iter().map(|t| t.owner).collect::<Vec<_>>(),
        [1, 2, 4]
    );
    assert_eq!(plan.synchronized_tables(), BTreeSet::from([0, 1, 3]));
    assert_eq!(
        u32::from_le_bytes(plan.imported_tables[8..12].try_into().unwrap()),
        2
    );
}
#[test]
fn sparse_helpers_reuse_nine_locals_and_reject_limits() {
    for count in [1, 100] {
        let tables = "(import \"h\" \"same\" (table 2 funcref))".repeat(count);
        let input = wat::parse_str(format!("(module {tables})")).unwrap();
        let plan = plan(&input, Default::default()).unwrap();
        for ordinal in [0, 1] {
            let function = plan.emit_helper(ordinal, 1 << 20).unwrap();
            let mut bytes = Vec::new();
            wasm_encoder::Encode::encode(&function, &mut bytes);
            let mut reader = wasmparser::BinaryReader::new(&bytes, 0);
            let size = reader.read_var_u32().unwrap() as usize;
            let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(
                &bytes[reader.original_position()..][..size],
                0,
            ));
            let locals: u32 = body
                .get_locals_reader()
                .unwrap()
                .into_iter()
                .map(|local| local.unwrap().0)
                .sum();
            assert_eq!(locals, 9);
        }
        assert!(plan.emit_helper(0, 1).is_err());
        assert!(plan.emit_helper(u32::MAX, 1 << 20).is_err());
        assert!(
            self::plan(
                &input,
                TableStateLimits {
                    metadata_bytes: 1,
                    work: usize::MAX
                }
            )
            .is_err()
        );
        assert!(
            self::plan(
                &input,
                TableStateLimits {
                    metadata_bytes: 1 << 20,
                    work: 0
                }
            )
            .is_err()
        );
    }
}

#[test]
fn linker_roles_and_resume_imports_preserve_original_ownership() {
    for dynamic in [false, true] {
        let import = if dynamic {
            "(import \"env\" \"__wasm_dlsym\" (func))"
        } else {
            ""
        };
        let input = wat::parse_str(format!(
            "(module {import} (table (export \"__indirect_function_table\") 1 funcref))"
        ))
        .unwrap();
        let plan = plan(&input, Default::default()).unwrap();
        assert_eq!(plan.tables.len(), usize::from(dynamic));
    }
    let input = wat::parse_str(
        r#"(module
        (import "env" "__wpk_fork_resume_table" (table 1 funcref))
        (import "h" "ordinary" (table 1 externref)))"#,
    )
    .unwrap();
    let plan = plan(&input, Default::default()).unwrap();
    assert_eq!(
        plan.tables
            .iter()
            .map(|table| table.owner)
            .collect::<Vec<_>>(),
        [2]
    );
    assert_eq!(
        u32::from_le_bytes(plan.imported_tables[8..12].try_into().unwrap()),
        1
    );
}
#[test]
fn table_reservations_reject_changed_memory_and_unknown_sources() {
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let mut inputs = RuntimeInputs::default();
    let records = RootStateImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    let tables = TableStateImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    let ordinal = inputs.staging_memory.unwrap();
    let mut duplicate = inputs.imports[ordinal as usize].clone();
    duplicate.name = "other_memory".into();
    inputs.staging_memory = Some(inputs.imports.len() as u32);
    inputs.imports.push(duplicate);
    let runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    assert!(records.validate_memory(&runtime).is_err());
    assert_ne!(
        tables.memory.resolve(runtime.imports_plan()).unwrap(),
        runtime.process_memory().unwrap()
    );
    let other = wat::parse_str("(module (memory 1))").unwrap();
    let other = self::scan(&other).unwrap();
    let frozen = FrozenImports::new(&other, vec![], 1 << 20).unwrap();
    assert!(tables.freeze(&frozen).is_err());
    assert!(TableStateImports::append(&scan, &mut RuntimeInputs::default(), 0).is_err());
    let input = wat::parse_str("(module (import \"h\" \"table\" (table 1 funcref)))").unwrap();
    let plan = plan(
        &input,
        TableStateLimits {
            metadata_bytes: 1 << 20,
            work: 5,
        },
    )
    .unwrap();
    assert!(
        plan.emit_helper(0, 1 << 20)
            .unwrap_err()
            .to_string()
            .contains("work budget")
    );
    assert!(
        plan.emit_helper(2, 1 << 20)
            .unwrap_err()
            .to_string()
            .contains("work budget")
    );
}
