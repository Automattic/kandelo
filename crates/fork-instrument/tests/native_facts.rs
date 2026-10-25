use fork_instrument::{Options, PlanSource, facts, native, sink_report_walrus as sink_report};
use wasm_encoder::{CustomSection, Encode};

fn linked(text: &str, hash: Option<[u8; 32]>) -> Vec<u8> {
    let mut bytes = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    append(&mut bytes, facts::SECTION, text.as_bytes());
    if let Some(hash) = hash {
        append(&mut bytes, facts::CODE_HASH_SECTION, &hash);
    }
    bytes
}
fn append(bytes: &mut Vec<u8>, name: &str, data: &[u8]) {
    bytes.push(0);
    CustomSection {
        name: name.into(),
        data: data.into(),
    }
    .encode(bytes);
}
fn compare(input: &[u8], options: &Options) -> native::Decision {
    let native = native::analyze(input, options, Default::default()).unwrap();
    let old = sink_report(input, options).unwrap();
    let names = |set: &std::collections::BTreeSet<u32>| {
        let mut names: Vec<_> = set
            .iter()
            .filter_map(|&function| {
                let source = &native.scan.functions[function as usize];
                source.body.as_ref().map(|_| source.name.clone().unwrap())
            })
            .collect();
        names.sort();
        names
    };
    assert_eq!(names(&native.reaching.activations), old.instrumented);
    assert_eq!(names(&native.boundaries), old.boundaries);
    assert_eq!(native.decision.source, old.source);
    assert_eq!(native.decision.facts, old.facts);
    assert_eq!(
        native.decision.facts_error.is_some(),
        old.facts_error.is_some()
    );
    native.decision
}

#[test]
fn production_facts_options_and_selected_sets_match_the_oracle() {
    let text = include_str!("fixtures/typed_dispatch.calltypes");
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let input = linked(text, Some(facts::code_sha256(&plain).unwrap()));
    for options in [
        Options::default(),
        Options {
            facts: false,
            ..Default::default()
        },
        Options {
            sinks: false,
            ..Default::default()
        },
        Options {
            effective_types: false,
            ..Default::default()
        },
    ] {
        compare(&input, &options);
    }
    assert_eq!(
        compare(&input, &Options::default()).source,
        PlanSource::Facts
    );
}

#[test]
fn unreadable_or_stale_facts_use_native_baselines_and_can_be_ignored() {
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let text = include_str!("fixtures/typed_dispatch.calltypes");
    for input in [
        linked(text, None),
        linked(text, Some([0; 32])),
        linked("malformed facts", Some(facts::code_sha256(&plain).unwrap())),
    ] {
        let decision = compare(&input, &Options::default());
        assert_eq!(decision.source, PlanSource::Builtin);
        assert!(decision.facts_error.is_some());
        let ignored = compare(
            &input,
            &Options {
                facts: false,
                ..Default::default()
            },
        );
        assert!(ignored.facts_error.is_none());
    }
}

#[test]
fn dynamic_facts_preserve_the_explicit_side_module_contract() {
    let source = include_str!("fixtures/typed_dispatch.wat").replace("  (memory 1)",
        "  (import \"env\" \"__wasm_dlsym\" (func $lookup (param i32 i32 i32) (result i32)))\n  (memory 1)");
    let plain = wat::parse_str(source).unwrap();
    let mut input = plain.clone();
    append(
        &mut input,
        facts::SECTION,
        include_str!("fixtures/typed_dispatch.calltypes").as_bytes(),
    );
    append(
        &mut input,
        facts::CODE_HASH_SECTION,
        &facts::code_sha256(&plain).unwrap(),
    );
    let native = native::analyze(&input, &Options::default(), Default::default()).unwrap();
    assert_eq!(
        native.decision.source,
        PlanSource::Facts,
        "{:?}",
        native.decision.facts_error
    );
    // A returning address-taken function forces the full-entry contract.
    assert!(
        native
            .decision
            .dlopen_contract
            .as_ref()
            .unwrap()
            .contains("mode\tassume-all-entries-fork-returning")
    );
    compare(&input, &Options::default());
}
