//! Compiler facts (`kandelo.calltypes`) in the default sink path: they are
//! used when they describe the module's code, ignored (with the analysis
//! without facts as the fallback) otherwise, and never shipped. See
//! `src/facts/` and `docs/fork-instrumentation.md`.

#[path = "support/snapshot.rs"]
mod snapshot;
use fork_instrument::facts::{CODE_HASH_SECTION, SECTION, code_sha256};
use fork_instrument::{Options, PlanSource, instrument, sink_report};

/// `main` dispatches through a table of two `(i32) -> i32` functions. The
/// facts say the call site has C type `int (int)`, which `other` has and
/// `forker` (a fork wrapper whose child returns) does not. Matching by Wasm
/// signature alone (the index comes from memory, so no refinement applies),
/// `main` may reach fork; with the facts it cannot.
const TYPED_DISPATCH: &str = include_str!("fixtures/typed_dispatch.wat");

const FACTS: &str = include_str!("fixtures/typed_dispatch.calltypes");

fn custom_section(out: &mut Vec<u8>, name: &str, data: &[u8]) {
    fn leb(out: &mut Vec<u8>, mut v: usize) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    let mut content = vec![];
    leb(&mut content, name.len());
    content.extend_from_slice(name.as_bytes());
    content.extend_from_slice(data);
    out.push(0);
    leb(out, content.len());
    out.extend_from_slice(&content);
}

/// The fixture as the SDK's link would emit it: facts plus the code hash
/// (`Some(hash)` overrides the correct one).
fn linked(wat: &str, facts: &str, hash: Option<Option<[u8; 32]>>) -> (Vec<u8>, Vec<u8>) {
    let plain = wat::parse_str(wat).expect("wat parse");
    let mut with = plain.clone();
    custom_section(&mut with, SECTION, facts.as_bytes());
    match hash {
        None => custom_section(&mut with, CODE_HASH_SECTION, &code_sha256(&plain).unwrap()),
        Some(Some(h)) => custom_section(&mut with, CODE_HASH_SECTION, &h),
        Some(None) => {}
    }
    (plain, with)
}

fn has_section(bytes: &[u8], name: &str) -> bool {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .filter_map(|p| p.ok())
        .any(|p| matches!(p, wasmparser::Payload::CustomSection(s) if s.name() == name))
}

#[test]
fn bounded_definition_binding_preserves_original_facts_coordinates() {
    let (_, input) = linked(TYPED_DISPATCH, FACTS, None);
    let scan = fork_instrument::streaming::scan(&input).unwrap();
    let actual = scan.bind_fact_definitions().unwrap();
    snapshot::check(&input, "bindings", actual);

    let (_, stale) = linked(TYPED_DISPATCH, FACTS, Some(Some([0; 32])));
    let stale = fork_instrument::streaming::scan(&stale).unwrap();
    assert!(
        stale
            .bind_fact_definitions()
            .unwrap_err()
            .to_string()
            .contains("hash mismatch")
    );
}

#[test]
fn function_local_call_facts_match_the_existing_solver_inputs_and_results() {
    compare_native_facts(TYPED_DISPATCH);
}

fn compare_native_facts(wat: &str) {
    compare_native_facts_text(wat, FACTS);
}

fn compare_native_facts_text(wat: &str, text: &str) {
    let (_, input) = linked(wat, text, None);
    let scan = fork_instrument::streaming::scan(&input).unwrap();
    for effective_types in [false, true] {
        let opts = fork_instrument::facts::FactsOptions { effective_types };
        let (mut actual, actual_report) =
            fork_instrument::facts::call_facts_from_scan(&scan, opts).unwrap();
        actual.itargets.sort();
        for (_, handlers) in &mut actual.cleanup {
            handlers.sort();
        }
        actual.cleanup.sort();
        snapshot::check(
            &input,
            if effective_types {
                "effective"
            } else {
                "untyped"
            },
            (&actual, actual_report),
        );
    }
}

#[test]
fn file_backed_target_planning_matches_casts_virtual_calls_holes_and_unions() {
    for text in [
        format!("{FACTS}Q\tforker\tA\nW\tforker\t_ZTSFiiE\n"),
        FACTS.replace("icall\t_ZTSFiiE", "vcall\tClass\t8") + "V\tother\tClass\t8\n",
        FACTS.replace("icall\t_ZTSFiiE", "opaque"),
        FACTS.replace(
            "D\tmain\t1\t1",
            "S\tmain\t1\ti32->i32\ticall\t_ZTSFiiE\nD\tmain\t2\t2",
        ),
        FACTS.replace("S\tmain\t0", "S\tmain\t2"),
        format!("{FACTS}{FACTS}"),
    ] {
        compare_native_facts_text(TYPED_DISPATCH, &text);
    }
}

#[test]
fn file_backed_registry_hubs_and_old_action_types_preserve_expected_results() {
    let same_types = FACTS
        .replace("_ZTSFlP3fooE", "_ZTSFviE")
        .replace("_ZTSFiiE", "_ZTSFviE");
    let hub = same_types.replace("/src/fixture.c", "/src/glue/channel_syscall.c");
    for registration in [
        "",
        "R\tsignal\tother\n",
        "R\tsignal\t?\n",
        "R\tsignal\t%0\tforwarder\n",
    ] {
        compare_native_facts_text(TYPED_DISPATCH, &format!("{hub}{registration}"));
    }
    // Both type IDs of one old-action call are registry-constrained, even
    // though only one has a registered target. This catches insertion-order
    // dependence when materializing several hub entries for the same site.
    let old_action = FACTS.replace("_ZTSFlP3fooE", "SecondType")
        .replace("S\tmain\t0\ti32->i32\ticall\t_ZTSFiiE", "S\tmain\t0\ti32->i32\ticall\t_ZTSFiiE\nS\tmain\t0\ti32->i32\ticall\tSecondType\nY\tmain\t0\tglobal\toldact");
    compare_native_facts_text(
        TYPED_DISPATCH,
        &format!("{old_action}O\toldact\nR\tsignal\tother\n"),
    );
}

#[test]
fn file_backed_cleanup_pairs_and_empty_hub_targets_match() {
    let wat = r#"(module (type $t (func)) (table 2 funcref) (elem (i32.const 0) $a $b)
      (func $a) (func $b)
      (func $_pthread_cleanup_pop i32.const 0 call_indirect (type $t))
      (func $caller call $_pthread_cleanup_pop))"#;
    let text = "#kandelo-calltypes\t5\nM\tunit.c\nF\ta\t0\nT\ta\tA\nD\ta\t0\t0\nF\tb\t0\nT\tb\tA\nD\tb\t0\t0\nF\t_pthread_cleanup_pop\t0\nS\t_pthread_cleanup_pop\t0\t->\ticall\tA\nD\t_pthread_cleanup_pop\t1\t1\nF\tcaller\t0\nR\tcleanup\ta\nC\tcaller\t0\t_pthread_cleanup_pop\nD\tcaller\t0\t1\n";
    compare_native_facts_text(wat, text);
}

#[test]
fn synthesized_destructor_registration_and_its_conservative_fallback_match() {
    let template = r#"(module
      (type $t (func (param i32)))
      (import "env" "__cxa_atexit" (func $__cxa_atexit (param i32 i32 i32) (result i32)))
      (table 2 funcref) (elem (i32.const 0) $.Lcall_dtors.one $other)
      (func $.Lcall_dtors.one (type $t)) (func $other (type $t))
      (func $.Lregister_call_dtors.one i32.const SLOT i32.const 0 i32.const 0 call $__cxa_atexit drop)
      (func $__funcs_on_exit i32.const 0 i32.const 0 call_indirect (type $t)))"#;
    let facts = "#kandelo-calltypes\t5\nM\t/src/exit/atexit.c\nF\tother\t1\nT\tother\t_ZTSFvPvE\nD\tother\t0\t0\nF\t__funcs_on_exit\t0\nS\t__funcs_on_exit\t0\ti32->\ticall\t_ZTSFvPvE\nD\t__funcs_on_exit\t1\t1\n";
    for slot in ["0", "1"] {
        compare_native_facts_text(&template.replace("SLOT", slot), facts);
    }
    let different_type =
        facts.replace("_ZTSFvPvE", "OtherType") + "Q\t.Lcall_dtors.one\t_ZTSFvPvE\n";
    compare_native_facts_text(&template.replace("SLOT", "0"), &different_type);
}

#[test]
fn native_facts_preserve_oracle_signature_agreement_after_terminal_operators() {
    // Walrus retains source suffixes after return_call*, but drops suffixes
    // after explicit return/unreachable. Preserve its signature-mismatch
    // fallback policy without changing the oracle dependency.
    for prefix in [
        "local.get 0 return_call $other",
        "i32.const 0 return",
        "unreachable",
    ] {
        let wat = format!(
            r#"(module
          (type $t (func (param i32) (result i32)))
          (import "kernel" "kernel_fork" (func $kernel_fork (type $t)))
          (table 2 funcref) (elem (i32.const 0) $forker $other)
          (func $forker (type $t) i32.const 0 call $kernel_fork)
          (func $other (type $t) local.get 0)
          (func $main (type $t) {prefix}
            local.get 0 local.get 0 call_indirect (type $t))
          (func $_start (export "_start") i32.const 0 call $main drop))"#
        );
        compare_native_facts(&wat);
    }
}

#[test]
fn bounded_definition_reader_discards_site_graphs_and_accepts_mixed_frames() {
    use flate2::{Compression, write::ZlibEncoder};
    use fork_instrument::facts::definitions::DefinitionIndex;
    use std::io::Write;

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(FACTS.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    let mut frame = b"KCTZ\0\0\0\x01".to_vec();
    frame.extend_from_slice(&(FACTS.len() as u64).to_le_bytes());
    frame.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
    frame.extend(compressed);
    let mixed = [frame.as_slice(), FACTS.as_bytes()].concat();
    let index = DefinitionIndex::read([mixed.as_slice(), FACTS.as_bytes()]).unwrap();
    assert_eq!(index.chunks.len(), 3);
    assert_eq!(index.chunks[0], index.chunks[1]);
    assert_eq!(index.chunks[1], index.chunks[2]);
    assert_eq!(index.chunks[0].len(), 4);
    assert_eq!(index.decoded_bytes, 3 * FACTS.len() as u64);

    for malformed in [
        "#kandelo-calltypes\t999\n",
        "#kandelo-calltypes\t5\nF\tx\t0\n",
        "#kandelo-calltypes\t5\nF\tx\t0\nD\ty\t0\t0\n",
        "#kandelo-calltypes\t5\nF\tx\t0\nF\ty\t0\n",
    ] {
        assert!(DefinitionIndex::read([malformed.as_bytes()]).is_err());
    }
}

#[test]
fn facts_narrow_the_instrumented_set() {
    let (_, with) = linked(TYPED_DISPATCH, FACTS, None);
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Facts, "{:?}", report.facts_error);
    assert_eq!(report.instrumented, vec!["forker".to_string()]);
    let facts = report.facts.unwrap();
    assert_eq!((facts.chunks, facts.defined, facts.bound), (1, 4, 4));

    let without = sink_report(
        &with,
        &Options {
            facts: false,
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(without.source, PlanSource::Builtin);
    assert!(
        without.instrumented.contains(&"main".to_string()),
        "{:?}",
        without.instrumented
    );
}

#[test]
fn compressed_facts_preserve_the_same_fork_plan() {
    use flate2::{Compression, write::ZlibEncoder};
    use std::io::Write;
    let (plain, with_plain) = linked(TYPED_DISPATCH, FACTS, None);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(FACTS.as_bytes()).unwrap();
    let payload = encoder.finish().unwrap();
    let mut frame = b"KCTZ\0\0\0\x01".to_vec();
    frame.extend_from_slice(&(FACTS.len() as u64).to_le_bytes());
    frame.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    frame.extend(payload);
    let mut packed = plain.clone();
    custom_section(&mut packed, SECTION, &frame);
    custom_section(
        &mut packed,
        CODE_HASH_SECTION,
        &code_sha256(&plain).unwrap(),
    );
    let expected = sink_report(&with_plain, &Options::default()).unwrap();
    let actual = sink_report(&packed, &Options::default()).unwrap();
    assert_eq!(actual.source, PlanSource::Facts, "{:?}", actual.facts_error);
    assert_eq!(actual.instrumented, expected.instrumented);
    let actual_facts = actual.facts.unwrap();
    let expected_facts = expected.facts.unwrap();
    assert_eq!(
        (
            actual_facts.chunks,
            actual_facts.defined,
            actual_facts.bound
        ),
        (
            expected_facts.chunks,
            expected_facts.defined,
            expected_facts.bound
        ),
    );
    let transformed = instrument(&packed, &Options::default()).unwrap();
    assert!(!has_section(&transformed, SECTION));
    assert!(!has_section(&transformed, CODE_HASH_SECTION));
}

#[test]
fn instrumented_output_carries_no_facts() {
    let (_, with) = linked(TYPED_DISPATCH, FACTS, None);
    let out = instrument(&with, &Options::default()).unwrap();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&out)
        .expect("instrumented module validates");
    assert!(!has_section(&out, SECTION));
    assert!(!has_section(&out, CODE_HASH_SECTION));
}

#[test]
fn code_changed_after_linking_ignores_the_facts() {
    // As if wasm-opt had rewritten the code and kept both custom sections.
    let (_, with) = linked(TYPED_DISPATCH, FACTS, Some(Some([0u8; 32])));
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Builtin);
    assert!(
        report
            .facts_error
            .as_deref()
            .unwrap()
            .contains("changed after linking")
    );
    assert!(report.instrumented.contains(&"main".to_string()));
    let out = instrument(&with, &Options::default()).unwrap();
    assert!(!has_section(&out, SECTION) && !has_section(&out, CODE_HASH_SECTION));
}

#[test]
fn facts_without_a_code_hash_are_ignored() {
    let (_, with) = linked(TYPED_DISPATCH, FACTS, Some(None));
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Builtin);
    assert!(
        report
            .facts_error
            .as_deref()
            .unwrap()
            .contains(CODE_HASH_SECTION)
    );
}

#[test]
fn unreadable_facts_fall_back_to_the_analysis_without_facts() {
    let (_, with) = linked(
        TYPED_DISPATCH,
        &FACTS.replace("calltypes\t5", "calltypes\t4"),
        None,
    );
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Builtin);
    assert!(report.facts_error.as_deref().unwrap().contains("format"));
}

#[test]
fn a_module_outside_fork_keeps_its_bytes_minus_the_facts() {
    let wat = r#"(module (memory 1) (func $f (export "_start")))"#;
    let (plain, with) = linked(
        wat,
        "#kandelo-calltypes\t5\nM\tx.c\nF\tf\t0\tE\t0\tf\nD\tf\t0\t0\n",
        None,
    );
    assert_eq!(instrument(&with, &Options::default()).unwrap(), plain);
}
