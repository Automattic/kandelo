#[path = "support/snapshot.rs"]
mod snapshot;
use fork_instrument::{Options, PlanSource, facts, native};
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
    snapshot::check(
        input,
        &format!(
            "sinks-{}-facts-{}-effective-{}",
            options.sinks, options.facts, options.effective_types
        ),
        (
            names(&native.reaching.activations),
            names(&native.boundaries),
            native.decision.source,
            &native.decision.facts,
            native.decision.facts_error.is_some(),
        ),
    );
    native.decision
}

#[test]
fn production_facts_options_and_selected_sets_preserve_expected_results() {
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
fn unreadable_facts_use_native_baselines_and_can_be_ignored() {
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let input = linked("malformed facts", Some(facts::code_sha256(&plain).unwrap()));
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

#[test]
fn facts_not_bound_to_the_code_are_an_error_unless_ignored() {
    let text = include_str!("fixtures/typed_dispatch.calltypes");
    for (input, expected) in [
        (linked(text, None), "no kandelo.calltypes.code-sha256 section"),
        (linked(text, Some([0; 32])), "changed after linking"),
    ] {
        let error = native::analyze(&input, &Options::default(), Default::default())
            .err()
            .expect("facts that do not match the code are an error");
        let message = format!("{error:#}");
        assert!(message.contains(expected), "{message}");
        assert!(
            message.contains("before") && message.contains("optimiz"),
            "the error says how to fix the build: {message}"
        );
        // Diagnosis can still compare against the analysis without facts.
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
fn stale_facts_are_not_an_error_when_no_own_code_reaches_fork() {
    // The fork import is present but nothing the module defines calls it, so
    // no plan depends on the facts.
    let source = r#"(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (func $_start (export "_start")))"#;
    let mut input = wat::parse_str(source).unwrap();
    append(
        &mut input,
        facts::SECTION,
        b"#kandelo-calltypes\t5\nM\tx.c\nF\t_start\t0\tE\t0\t_start\nD\t_start\t0\t0\n",
    );
    append(&mut input, facts::CODE_HASH_SECTION, &[0; 32]);
    let native = native::analyze(&input, &Options::default(), Default::default()).unwrap();
    assert!(native.decision.participates);
    assert!(native.decision.facts_error.is_some());
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
