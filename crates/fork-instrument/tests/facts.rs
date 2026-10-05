//! Compiler facts (`kandelo.calltypes`) in the default sink path: they are
//! used when they describe the module's code, ignored (with the analysis
//! without facts as the fallback) otherwise, and never shipped. See
//! `src/facts/` and `docs/fork-instrumentation.md`.

use fork_instrument::facts::{CODE_HASH_SECTION, SECTION, code_sha256};
use fork_instrument::{Options, PlanSource, instrument, sink_report};

/// `main` dispatches through a table of two `(i32) -> i32` functions. The
/// facts say the call site has C type `int (int)`, which `other` has and
/// `forker` (a fork wrapper whose child returns) does not. Matching by Wasm
/// signature alone (the index comes from memory, so no refinement applies),
/// `main` may reach fork; with the facts it cannot.
const TYPED_DISPATCH: &str = r#"
(module
  (type $t (func (param i32) (result i32)))
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (table 2 funcref)
  (elem (i32.const 0) $forker $other)
  (func $forker (type $t) (call $kernel_fork (i32.const 0)))
  (func $other (type $t) (local.get 0))
  (func $main (param i32) (result i32)
    (call_indirect (type $t) (local.get 0) (local.get 0)))
  (func $_start (export "_start") (drop (call $main (i32.load (i32.const 0))))))
"#;

const FACTS: &str = "#kandelo-calltypes\t5
M\t/src/fixture.c
F\tforker\t1\tE\t1\tforker
T\tforker\t_ZTSFlP3fooE
C\tforker\t0\tkernel_fork
D\tforker\t0\t1
F\tother\t1\tE\t1\tother
T\tother\t_ZTSFiiE
D\tother\t0\t0
F\tmain\t1\tE\t0\tmain
S\tmain\t0\ti32->i32\ticall\t_ZTSFiiE
D\tmain\t1\t1
F\t_start\t0\tE\t0\t_start
C\t_start\t0\tmain
D\t_start\t0\t1
";

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
fn facts_narrow_the_instrumented_set() {
    let (_, with) = linked(TYPED_DISPATCH, FACTS, None);
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Facts, "{:?}", report.facts_error);
    assert_eq!(report.instrumented, vec!["forker".to_string()]);
    let facts = report.facts.unwrap();
    assert_eq!((facts.chunks, facts.defined, facts.bound), (1, 4, 4));

    let without = sink_report(&with, &Options { facts: false, ..Options::default() }).unwrap();
    assert_eq!(without.source, PlanSource::Builtin);
    assert!(without.instrumented.contains(&"main".to_string()), "{:?}", without.instrumented);
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
    assert!(report.facts_error.as_deref().unwrap().contains("changed after linking"));
    assert!(report.instrumented.contains(&"main".to_string()));
    let out = instrument(&with, &Options::default()).unwrap();
    assert!(!has_section(&out, SECTION) && !has_section(&out, CODE_HASH_SECTION));
}

#[test]
fn facts_without_a_code_hash_are_ignored() {
    let (_, with) = linked(TYPED_DISPATCH, FACTS, Some(None));
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Builtin);
    assert!(report.facts_error.as_deref().unwrap().contains(CODE_HASH_SECTION));
}

#[test]
fn unreadable_facts_fall_back_to_the_analysis_without_facts() {
    let (_, with) = linked(TYPED_DISPATCH, &FACTS.replace("calltypes\t5", "calltypes\t4"), None);
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Builtin);
    assert!(report.facts_error.as_deref().unwrap().contains("format"));
}

#[test]
fn a_module_outside_fork_keeps_its_bytes_minus_the_facts() {
    let wat = r#"(module (memory 1) (func $f (export "_start")))"#;
    let (plain, with) = linked(wat, "#kandelo-calltypes\t5\nM\tx.c\nF\tf\t0\tE\t0\tf\nD\tf\t0\t0\n", None);
    assert_eq!(instrument(&with, &Options::default()).unwrap(), plain);
}
