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
    custom_section(&mut packed, CODE_HASH_SECTION, &code_sha256(&plain).unwrap());
    let expected = sink_report(&with_plain, &Options::default()).unwrap();
    let actual = sink_report(&packed, &Options::default()).unwrap();
    assert_eq!(actual.source, PlanSource::Facts, "{:?}", actual.facts_error);
    assert_eq!(actual.instrumented, expected.instrumented);
    let actual_facts = actual.facts.unwrap();
    let expected_facts = expected.facts.unwrap();
    assert_eq!(
        (actual_facts.chunks, actual_facts.defined, actual_facts.bound),
        (expected_facts.chunks, expected_facts.defined, expected_facts.bound),
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

/// A program that can dlopen calls a function `dlsym` returned (no function
/// in the program has the call's C type, so the call has no in-module target)
/// and then forks. Under the default dlopen contract
/// (`--side-modules traced-entries`) side-module code never returns through
/// a fork child, but it does return, so the fork after the call is reachable
/// and `main`, which the child returns through, stays instrumented. Summing
/// the empty target set to "never returns" made everything after the call
/// dead: `main` left the plan, the parent's unwind crossed an
/// uninstrumented frame, and the child trapped.
const DLSYM_CALL_THEN_FORK: &str = r#"
(module
  (type $t (func (result i32)))
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
  (memory 1)
  (table 1 funcref)
  (func $forker (result i32) (call $kernel_fork (i32.const 0)))
  (func $main (result i32)
    (drop (call_indirect (type $t) (i32.load (i32.const 0))))
    (call $forker))
  (func $_start (export "_start") (drop (call $main))))
"#;

const DLSYM_CALL_THEN_FORK_FACTS: &str = "#kandelo-calltypes\t5
M\t/src/fixture.c
F\tforker\t0\tE\t1\tforker
T\tforker\t_ZTSFlvE
C\tforker\t0\tkernel_fork
D\tforker\t0\t1
F\tmain\t0\tE\t1\tmain
T\tmain\t_ZTSFlvE
S\tmain\t0\t->i32\ticall\t_ZTSFivE
C\tmain\t1\tforker
D\tmain\t0\t2
F\t_start\t0\tE\t0\t_start
C\t_start\t0\tmain
D\t_start\t0\t1
";

#[test]
fn a_call_into_a_side_module_returns_under_the_dlopen_contract() {
    let (_, with) = linked(DLSYM_CALL_THEN_FORK, DLSYM_CALL_THEN_FORK_FACTS, None);
    let report = sink_report(&with, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Facts, "{:?}", report.facts_error);
    assert!(
        report.instrumented.contains(&"main".to_string()),
        "the fork after the side-module call vanished from the plan: {:?}",
        report.instrumented,
    );
}
