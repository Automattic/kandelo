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

// Exercise the package front door with the real planner: a warning-only CLI
// fallback must become a build failure before any output is replaced.
#[test]
#[cfg(unix)]
fn package_wrapper_requires_current_facts_before_writing_output() {
    use std::{fs, process::Command, time::SystemTime};
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::temp_dir().join(format!(
        "kandelo-package-facts-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&dir).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(dir.clone());
    let input = dir.join("input.wasm");
    let output = dir.join("output.wasm");
    let run = |require: bool| {
        let mut cmd = Command::new("bash");
        cmd.arg(repo.join("scripts/run-wasm-fork-instrument.sh"));
        if require {
            cmd.arg("--require-facts");
        }
        cmd.arg(&input)
            .arg("-o")
            .arg(&output)
            .args(["--post-optimize", "none"])
            .env(
                "WASM_POSIX_FORK_INSTRUMENT",
                env!("CARGO_BIN_EXE_wasm-fork-instrument"),
            );
        cmd.output().unwrap()
    };
    let (_, fresh) = linked(TYPED_DISPATCH, FACTS, None);
    fs::write(&input, &fresh).unwrap();
    let accepted = run(true);
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let log = String::from_utf8_lossy(&accepted.stderr);
    assert!(log.contains("source\tfacts"), "{log}");
    assert!(log.contains("activations 1"), "{log}");
    assert!(!has_section(&fs::read(&output).unwrap(), SECTION));

    // The normal package invocation has no remaining check_args after -o
    // is removed. Exercise Darwin's Bash 3.2 as well as the shipping optimizer.
    let shell = if cfg!(target_os = "macos") {
        "/bin/bash"
    } else {
        "bash"
    };
    let optimized = Command::new(shell)
        .arg(repo.join("scripts/run-wasm-fork-instrument.sh"))
        .arg("--require-facts")
        .arg(&input)
        .arg("-o")
        .arg(&output)
        .env(
            "WASM_POSIX_FORK_INSTRUMENT",
            env!("CARGO_BIN_EXE_wasm-fork-instrument"),
        )
        .output()
        .unwrap();
    assert!(
        optimized.status.success(),
        "{}",
        String::from_utf8_lossy(&optimized.stderr)
    );
    let sections = |bytes: &[u8]| {
        wasmparser::Parser::new(0)
            .parse_all(bytes)
            .filter_map(|p| match p.unwrap() {
                wasmparser::Payload::CustomSection(s) if s.name().starts_with("kandelo.") => {
                    Some((s.name().to_string(), s.data().to_vec()))
                }
                _ => None,
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let contracts = sections(&fs::read(&output).unwrap());
    assert!(!contracts.is_empty());
    // Erlang's final strip must retain continuation/loader metadata.
    assert!(
        Command::new("llvm-strip")
            .arg("--strip-debug")
            .arg(&output)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("llvm-objcopy")
            .arg("--remove-section=name")
            .arg(&output)
            .status()
            .unwrap()
            .success()
    );
    let stripped = fs::read(&output).unwrap();
    assert!(!has_section(&stripped, "name"));
    assert_eq!(sections(&stripped), contracts);

    // Removing names alone preserves the hash and source=facts, yet all
    // definitions become unbound. The package gate must catch that too.
    fs::write(&input, &fresh).unwrap();
    assert!(
        Command::new("llvm-objcopy")
            .arg("--remove-section=name")
            .arg(&input)
            .status()
            .unwrap()
            .success()
    );
    fs::write(&output, b"previous artifact").unwrap();
    let refused = run(true);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("did not bind any linked functions"));
    assert_eq!(fs::read(&output).unwrap(), b"previous artifact");

    for hash in [Some(Some([0; 32])), Some(None)] {
        let (_, stale) = linked(TYPED_DISPATCH, FACTS, hash);
        fs::write(&input, &stale).unwrap();
        fs::write(&output, b"previous artifact").unwrap();
        let refused = run(true);
        assert!(!refused.status.success());
        assert!(String::from_utf8_lossy(&refused.stderr).contains("expected compiler facts"));
        assert_eq!(fs::read(&input).unwrap(), stale);
        assert_eq!(fs::read(&output).unwrap(), b"previous artifact");
        // Diagnostic/non-package callers retain the sound fallback.
        assert!(run(false).status.success());
    }
    fs::write(&input, &fresh).unwrap();
    assert!(
        Command::new("wasm-strip")
            .arg(&input)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        !run(true).status.success(),
        "stripped compiler facts must fail the build"
    );

    // These modules have no facts-based plan to require.
    for wat in [
        "(module (memory 1) (func (export \"_start\")))",
        "(module (import \"kernel\" \"kernel_fork\" (func $fork (param i64) (result i32))) (memory i64 1) (func (export \"_start\") (drop (call $fork (i64.const 0)))))",
    ] {
        fs::write(&input, wat::parse_str(wat).unwrap()).unwrap();
        let accepted = run(true);
        assert!(
            accepted.status.success(),
            "{}",
            String::from_utf8_lossy(&accepted.stderr)
        );
        assert!(!String::from_utf8_lossy(&accepted.stderr).contains("expected compiler facts"));
    }
}
