use fork_instrument::facts::{definitions::DefinitionIndex, storage::*};

fn linked(text: &str, plain: Vec<u8>) -> Vec<u8> {
    use wasm_encoder::{CustomSection, Encode};
    let hash = fork_instrument::facts::code_sha256(&plain).unwrap();
    let mut out = plain;
    for (name, data) in [
        (fork_instrument::facts::SECTION, text.as_bytes()),
        (fork_instrument::facts::CODE_HASH_SECTION, hash.as_slice()),
    ] {
        out.push(0);
        CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut out);
    }
    out
}

const FACTS: &str = "#kandelo-calltypes\t5\nM\tunit.c\nF\tfirst\t1\nT\tfirst\tA\nS\tfirst\t0\ti32->i32\ticall\tB\nD\tfirst\t1\t1\nSE\t@fn:first\tp:first:0\nSF\tp:first:0\tB\nQ\tfirst\tA\nW\tfirst\tB\nZ\tB\tC\n";

#[test]
fn facts_are_interned_on_disk_and_binding_metadata_matches_the_line_reader() {
    let first = FactsStore::read_sections([FACTS.as_bytes()], StorageLimits::default()).unwrap();
    let bytes = [FACTS.as_bytes(), FACTS.as_bytes()].concat();
    let store = FactsStore::read_sections(
        bytes.chunks(1),
        StorageLimits {
            atom_cache_bytes: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let definitions = store.definitions().unwrap();
    let expected = DefinitionIndex::read([bytes.as_slice()]).unwrap();
    assert_eq!(definitions.chunks, expected.chunks);
    assert_eq!(definitions.decoded_bytes, expected.decoded_bytes);
    let report = store.report().unwrap();
    let original = first.report().unwrap();
    assert_eq!(report.atoms, original.atoms);
    assert_eq!(report.relations, original.relations);
    assert_eq!(report.definitions, 2 * original.definitions);
    assert_eq!(report.chunks, 2);
    assert!(report.database_bytes > 0);
}

#[test]
fn sparse_site_numbers_do_not_expand_an_in_memory_site_vector() {
    let input =
        "#kandelo-calltypes\t5\nF\tf\t0\nS\tf\t1000000000\t->\tuntyped\nD\tf\t1\t1000000001\n";
    let store = FactsStore::read_sections(
        [input.as_bytes()],
        StorageLimits {
            page_cache_bytes: 64 * 1024,
            atom_cache_bytes: 0,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(store.definitions().unwrap().chunks[0][0].name, "f");
    assert!(store.report().unwrap().database_bytes < 1024 * 1024);
}

#[test]
fn malicious_nested_origin_names_do_not_control_rust_recursion_depth() {
    let name = format!("{}f", "@fn:".repeat(10_000));
    let text = format!("#kandelo-calltypes\t5\nSE\t{name}\tp:f:0\n");
    let store = FactsStore::read_sections([text.as_bytes()], StorageLimits::default()).unwrap();
    assert!(store.report().unwrap().atoms < 10);
}

#[test]
fn storage_disk_work_and_resident_binding_budgets_fail_explicitly() {
    assert!(
        FactsStore::read_sections(
            [FACTS.as_bytes()],
            StorageLimits {
                disk_bytes: 4096,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        FactsStore::read_sections(
            [FACTS.as_bytes()],
            StorageLimits {
                work_steps: 0,
                ..Default::default()
            }
        )
        .is_err()
    );
    let store = FactsStore::read_sections(
        [FACTS.as_bytes()],
        StorageLimits {
            metadata_bytes: 0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        store
            .definitions()
            .unwrap_err()
            .to_string()
            .contains("metadata budget")
    );
}

#[test]
fn incomplete_or_malformed_facts_never_return_a_partially_usable_store() {
    for text in [
        "#kandelo-calltypes\t5\nF\tf\t0\n",
        "#kandelo-calltypes\t5\nS\tf\t0\t->\tuntyped\n",
        "#kandelo-calltypes\t5\nF\tf\t0\nD\tg\t0\t0\n",
        "#kandelo-calltypes\t5\nR\texit\t%bad\tx\n",
    ] {
        assert!(
            FactsStore::read_sections([text.as_bytes()], StorageLimits::default()).is_err(),
            "{text}"
        );
    }
}

#[test]
fn sqlite_work_exhaustion_does_not_publish_partial_conversion_results() {
    let mut facts = String::from("#kandelo-calltypes\t5\nW\tf\tT0\n");
    for i in 0..1000 {
        facts.push_str(&format!("Z\tT{i}\tT{}\n", i + 1));
    }
    let complete = FactsStore::read_sections([facts.as_bytes()], Default::default()).unwrap();
    let loaded = complete.report().unwrap().estimated_work_steps;
    complete.solve_conversions(false, false).unwrap();
    let solved = complete.report().unwrap().estimated_work_steps;
    assert!(solved > loaded + 1000);

    // Admit the same input but exhaust the VM counter during the SQL solve.
    let limited = FactsStore::read_sections(
        [facts.as_bytes()],
        StorageLimits {
            work_steps: loaded + (solved - loaded) / 2,
            ..Default::default()
        },
    )
    .unwrap();
    let error = limited.solve_conversions(false, false).unwrap_err();
    assert!(format!("{error:#}").contains("interrupt"), "{error:#}");
    assert!(
        limited
            .visit_conversion_reach(|_, _| Ok(()))
            .unwrap_err()
            .to_string()
            .contains("not completed")
    );
}

#[test]
fn return_walks_do_not_rescan_unrelated_module_call_sites() {
    let mut facts = String::from("#kandelo-calltypes\t5\nW\tobserved\tStart\nZ\tStart\tFinish\n");
    for i in 0..200 {
        facts.push_str(&format!(
            "SL\tSignature\tret\tid{i}\nSE\tp:id{i}:0\tl:id{i}:0\n"
        ));
        for local in 0..4 {
            facts.push_str(&format!("SE\tl:id{i}:{local}\tl:id{i}:{}\n", local + 1));
        }
        facts.push_str(&format!("SE\tl:id{i}:4\tr:id{i}\n"));
    }
    for i in 0..2000 {
        facts.push_str(&format!(
            "SC\tl:unrelated:{i}\tunknown{i}\tunrelated\n\
             SE\tl:unrelated:{i}\tr:unrelated\n"
        ));
    }
    let loaded = FactsStore::read_sections([facts.as_bytes()], Default::default())
        .unwrap()
        .report()
        .unwrap()
        .estimated_work_steps;
    let store = FactsStore::read_sections(
        [facts.as_bytes()],
        StorageLimits {
            work_steps: loaded + 25_000_000,
            ..Default::default()
        },
    )
    .unwrap();
    store.solve_conversions(false, true).unwrap();
    let mut reached = Vec::new();
    store
        .visit_conversion_reach(|name, ty| {
            reached.push((name.to_owned(), ty.to_owned()));
            Ok(())
        })
        .unwrap();
    assert_eq!(
        reached,
        vec![
            ("observed".to_owned(), "Finish".to_owned()),
            ("observed".to_owned(), "Start".to_owned()),
        ]
    );
}

#[test]
fn dense_binding_and_target_relations_stay_queryable_without_collecting_the_matrix() {
    use wasm_encoder::*;
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function([], []);
    module.section(&types);
    let mut functions = FunctionSection::new();
    for _ in 0..80 {
        functions.function(0);
    }
    module.section(&functions);
    let mut tables = TableSection::new();
    tables.table(TableType {
        element_type: RefType::FUNCREF,
        minimum: 40,
        maximum: None,
        table64: false,
        shared: false,
    });
    module.section(&tables);
    let mut elements = ElementSection::new();
    elements.active(
        None,
        &ConstExpr::i32_const(0),
        Elements::Functions((0..40).collect::<Vec<_>>().into()),
    );
    module.section(&elements);
    let mut code = CodeSection::new();
    for index in 0..80 {
        let mut function = Function::new([]);
        if index >= 40 {
            function.instruction(&Instruction::I32Const(0)).instruction(
                &Instruction::CallIndirect {
                    type_index: 0,
                    table_index: 0,
                },
            );
        }
        function.instruction(&Instruction::End);
        code.function(&function);
    }
    module.section(&code);
    let mut names = NameSection::new();
    let mut name_map = NameMap::new();
    for index in 0..80 {
        name_map.append(index, if index < 40 { "target" } else { "caller" });
    }
    names.functions(&name_map);
    module.section(&names);
    let mut text = String::from("#kandelo-calltypes\t5\n");
    for _ in 0..40 {
        text.push_str("F\ttarget\t0\nD\ttarget\t0\t0\n");
    }
    for _ in 0..40 {
        text.push_str("F\tcaller\t0\nS\tcaller\t0\t->\tuntyped\nD\tcaller\t1\t1\n");
    }
    let input = linked(&text, module.finish());
    let scan = fork_instrument::streaming::scan(&input).unwrap();
    let store = FactsStore::from_scan(
        &scan,
        StorageLimits {
            metadata_bytes: 4096,
            page_cache_bytes: 64 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let report = store.resolve_calls(&scan, Default::default()).unwrap();
    assert_eq!(report.bound_to_union, 80);
    assert_eq!(
        store.targets_for(40, "->").unwrap().unwrap(),
        (0..40).collect::<Vec<_>>()
    );
    assert!(store.targets_for(0, "->").unwrap().is_none());
    assert!(
        store
            .collect_call_facts()
            .unwrap_err()
            .to_string()
            .contains("metadata budget")
    );
}

#[test]
fn resolved_plans_are_bound_to_the_exact_original_module_and_invalidated_on_reanalysis() {
    let input = linked(
        "#kandelo-calltypes\t5\nF\tf\t0\nD\tf\t0\t0\n",
        wat::parse_str("(module (func $f))").unwrap(),
    );
    let scan = fork_instrument::streaming::scan(&input).unwrap();
    let store = FactsStore::from_scan(&scan, StorageLimits::default()).unwrap();
    assert!(store.targets_for(0, "->").is_err());
    store.resolve_calls(&scan, Default::default()).unwrap();
    assert!(store.targets_for(0, "->").unwrap().is_none());
    store.solve_conversions(true, true).unwrap();
    assert!(store.targets_for(0, "->").is_err());
    let different = wat::parse_str("(module (func $other))").unwrap();
    let different = fork_instrument::streaming::scan(&different).unwrap();
    assert!(
        store
            .resolve_calls(&different, Default::default())
            .unwrap_err()
            .to_string()
            .contains("exact original")
    );
    let unbound = FactsStore::read_sections([FACTS.as_bytes()], StorageLimits::default()).unwrap();
    assert!(unbound.resolve_calls(&scan, Default::default()).is_err());
}
