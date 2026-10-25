#![cfg(feature = "preopt-integration-tests")]

use std::{fs, path::PathBuf, process::Command};

use fork_instrument::{Options, PlanSource, facts, preopt, sink_report};

const WAT: &str = r#"(module
  (type $t (func (param i32) (result i32)))
  (import "kernel" "kernel_fork" (func $kernel_fork (type $t)))
  (memory 1) (table 2 funcref)
  (elem (i32.const 0) $forker $other)
  (func $forker (type $t) (call $kernel_fork (i32.const 0)))
  (func $other (type $t) (local.get 0))
  (func $main (type $t)
    (call_indirect (type $t) (local.get 0) (local.get 0)))
  (func $_start (export "_start")
    (drop (call $main (i32.load (i32.const 0))))))"#;

const FACTS: &str = "#kandelo-calltypes\t5\nM\tpreopt.c\n\
F\tforker\t1\nT\tforker\tother-type\nC\tforker\t0\tkernel_fork\nD\tforker\t0\t1\n\
F\tother\t1\nT\tother\tint-type\nD\tother\t0\t0\n\
F\tmain\t1\nS\tmain\t0\ti32->i32\ticall\tint-type\nD\tmain\t1\t1\n\
F\t_start\t0\nC\t_start\t0\tmain\nD\t_start\t0\t1\n";

struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("kandelo-preopt-{name}-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn linked() -> Vec<u8> {
    let bytes = wat::parse_str(WAT).unwrap();
    let mut module = walrus::ModuleConfig::new().parse(&bytes).unwrap();
    module.customs.add(walrus::RawCustomSection {
        name: facts::SECTION.into(),
        data: FACTS.as_bytes().to_vec(),
    });
    let bytes = module.emit_wasm();
    let mut module = walrus::ModuleConfig::new().parse(&bytes).unwrap();
    module.customs.add(walrus::RawCustomSection {
        name: facts::CODE_HASH_SECTION.into(),
        data: facts::code_sha256(&bytes).unwrap().to_vec(),
    });
    module.emit_wasm()
}

fn optimizer() -> std::ffi::OsString {
    std::env::var_os("WASM_OPT").expect("set WASM_OPT to the built Binaryen fork-facts prototype")
}

#[test]
fn call_targets_follow_inlining_and_function_renumbering() {
    let scratch = Scratch::new("inlining");
    let input = scratch.0.join("input.wasm");
    let output = scratch.0.join("output.wasm");
    let linked = linked();
    fs::write(
        &input,
        preopt::prepare(&linked, &Options::default()).unwrap(),
    )
    .unwrap();
    let run = Command::new(optimizer())
        .arg(&input)
        .args([
            "--kandelo-fork-facts",
            "--inlining",
            "--partial-inlining-ifs=0",
            "-g",
        ])
        .arg("-o")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let finished = preopt::finish(&fs::read(output).unwrap()).unwrap();
    wasmparser::Validator::new()
        .validate_all(&finished)
        .unwrap();
    let before = walrus::ModuleConfig::new().parse(&linked).unwrap();
    let after = walrus::ModuleConfig::new().parse(&finished).unwrap();
    assert!(
        after.funcs.iter().count() < before.funcs.iter().count(),
        "fixture must actually inline"
    );
    let report = sink_report(&finished, &Options::default()).unwrap();
    assert_eq!(report.source, PlanSource::Facts);
    assert!(!report.instrumented.iter().any(|name| name == "_start"));
    let conservative = sink_report(
        &finished,
        &Options {
            facts: false,
            ..Options::default()
        },
    )
    .unwrap();
    assert!(
        conservative
            .instrumented
            .iter()
            .any(|name| name == "_start")
    );
}

#[test]
fn unaudited_merging_passes_are_rejected_before_output() {
    let scratch = Scratch::new("reject");
    let input = scratch.0.join("input.wasm");
    let output = scratch.0.join("output.wasm");
    fs::write(
        &input,
        preopt::prepare(&linked(), &Options::default()).unwrap(),
    )
    .unwrap();
    fs::write(&output, b"old output").unwrap();
    for (args, diagnostic) in [
        (
            vec![
                "--kandelo-fork-facts",
                "-O2",
                "--partial-inlining-ifs=0",
                "--no-stack-ir",
            ],
            "unaudited pass",
        ),
        (
            vec![
                "--kandelo-fork-facts",
                "--inlining",
                "--partial-inlining-ifs=0",
                "--optimize-stack-ir",
            ],
            "StackIR",
        ),
        (
            vec![
                "--kandelo-fork-facts",
                "--inlining",
                "--partial-inlining-ifs=1",
                "--no-stack-ir",
            ],
            "partial-inlining",
        ),
    ] {
        let run = Command::new(optimizer())
            .arg(&input)
            .args(args)
            .arg("-o")
            .arg(&output)
            .output()
            .unwrap();
        assert!(!run.status.success());
        assert!(
            String::from_utf8_lossy(&run.stderr).contains(diagnostic),
            "expected {diagnostic}: {}",
            String::from_utf8_lossy(&run.stderr)
        );
        assert_eq!(fs::read(&output).unwrap(), b"old output");
    }
}

#[test]
fn cli_reports_the_same_preoptimized_plan_that_it_instruments() {
    let scratch = Scratch::new("cli");
    let input = scratch.0.join("input.wasm");
    let output = scratch.0.join("output.wasm");
    fs::write(&input, linked()).unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input)
        .args(["--pre-optimize", "inlining", "--sink-report"])
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let text = String::from_utf8(run.stdout).unwrap();
    assert!(text.starts_with("source\tfacts\n"));
    assert!(!text.lines().any(|l| l == "A\t_start"));
    let run = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input)
        .args(["--pre-optimize", "inlining", "--post-optimize", "Os"])
        .arg("-o")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let bytes = fs::read(&output).unwrap();
    wasmparser::Validator::new().validate_all(&bytes).unwrap();
    let module = walrus::ModuleConfig::new().parse(&bytes).unwrap();
    assert!(module.customs.iter().all(|(_, s)| {
        ![
            facts::SECTION,
            facts::CODE_HASH_SECTION,
            preopt::SECTION,
            preopt::REPORT_SECTION,
        ]
        .contains(&s.name())
    }));

    let wrapper =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/run-wasm-fork-instrument.sh");
    let run = Command::new(wrapper)
        .env(
            "WASM_POSIX_FORK_INSTRUMENT",
            env!("CARGO_BIN_EXE_wasm-fork-instrument"),
        )
        .arg("--require-facts")
        .arg(&input)
        .args(["--pre-optimize", "inlining", "--post-optimize", "Os"])
        .arg("-o")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    wasmparser::Validator::new()
        .validate_all(&fs::read(output).unwrap())
        .unwrap();
}

fn leb(out: &mut Vec<u8>, mut n: u32) {
    loop {
        let b = (n & 127) as u8;
        n >>= 7;
        out.push(b | if n != 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
}

// Two byte-identical calls with distinct origin restrictions. Construct the
// transport directly: the production caller/signature grouping would union
// these before transport and would not expose the optimizer's unsafe merge.
fn merging_input(unknown_else: bool) -> Vec<u8> {
    use wasmparser::{Operator, Parser, Payload};
    let bytes = wat::parse_str(
        r#"(module
      (type $t (func (param i32) (result i32)))
      (import "kernel" "kernel_fork" (func $fork (type $t)))
      (memory 1) (table 2 funcref)
      (elem (i32.const 0) $forker $other)
      (func $forker (type $t) (call $fork (i32.const 0)))
      (func $other (type $t) (local.get 0))
      (func $choose (export "choose") (type $t)
        (if (result i32) (local.get 0)
          (then (call_indirect (type $t) (i32.const 42) (local.get 0)))
          (else (call_indirect (type $t) (i32.const 42) (local.get 0))))))"#,
    )
    .unwrap();
    let mut offsets = vec![];
    let mut function = 1;
    for payload in Parser::new(0).parse_all(&bytes) {
        if let Payload::CodeSectionEntry(body) = payload.unwrap() {
            if function == 3 {
                let mut ops = body.get_operators_reader().unwrap();
                while !ops.eof() {
                    let offset = (ops.original_position() - body.range().start) as u32;
                    if matches!(ops.read().unwrap(), Operator::CallIndirect { .. }) {
                        offsets.push(offset);
                    }
                }
            }
            function += 1;
        }
    }
    assert_eq!(offsets.len(), 2);
    let mut annotations = vec![];
    leb(&mut annotations, 4);
    for f in 0..4 {
        leb(&mut annotations, f);
        let calls = if f == 3 {
            if unknown_else { 1 } else { 2 }
        } else {
            0
        };
        leb(&mut annotations, 1 + calls);
        for (offset, values) in std::iter::once((0, vec![0, f])).chain(
            offsets
                .iter()
                .take(calls as usize)
                .enumerate()
                .map(|(i, offset)| (*offset, vec![1, if i == 0 { 2 } else { 1 }])),
        ) {
            leb(&mut annotations, offset);
            let mut encoded = vec![];
            for value in values {
                leb(&mut encoded, value);
            }
            leb(&mut annotations, encoded.len() as u32);
            annotations.extend(encoded);
        }
    }
    let mut custom = vec![];
    leb(&mut custom, preopt::SECTION.len() as u32);
    custom.extend(preopt::SECTION.as_bytes());
    custom.extend(annotations);
    let mut section = vec![0];
    leb(&mut section, custom.len() as u32);
    section.extend(custom);
    let mut result = bytes[..8].to_vec();
    result.extend(section);
    result.extend_from_slice(&bytes[8..]);
    result
}

fn preserved_report(bytes: &[u8]) -> String {
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        if let wasmparser::Payload::CustomSection(section) = payload.unwrap() {
            if section.name() == preopt::REPORT_SECTION {
                return std::str::from_utf8(section.data()).unwrap().to_owned();
            }
        }
    }
    panic!("optimizer omitted its preservation report");
}

#[test]
fn supported_cleanup_keeps_origins_but_merging_and_unknown_passes_invalidate() {
    let scratch = Scratch::new("preservation");
    let input = scratch.0.join("input.wasm");
    let output = scratch.0.join("output.wasm");
    for unknown_else in [false, true] {
        fs::write(&input, merging_input(unknown_else)).unwrap();
        for (passes, retains) in [
            (vec!["--dce", "--vacuum"], true),
            (vec!["--optimize-instructions"], false),
            (vec!["-O2"], false),
            (vec!["-Oz"], false),
        ] {
            let run = Command::new(optimizer())
                .arg(&input)
                .arg("--kandelo-fork-facts-pipeline")
                .args(&passes)
                .args(["--partial-inlining-ifs=0", "--no-stack-ir", "-g"])
                .arg("-o")
                .arg(&output)
                .output()
                .unwrap();
            assert!(
                run.status.success(),
                "{}",
                String::from_utf8_lossy(&run.stderr)
            );
            let raw = fs::read(&output).unwrap();
            let report = preserved_report(&raw);
            assert!(
                report.contains(if retains { "valid\t1\n" } else { "valid\t0\n" }),
                "{report}"
            );
            if retains {
                assert!(
                    report.contains(if unknown_else {
                        "retained\t1\n"
                    } else {
                        "retained\t2\n"
                    }),
                    "{report}"
                );
            } else {
                assert!(report.contains("retained\t0\n"), "{report}");
                assert!(report.contains("invalidates-all\t"), "{report}");
            }
            let finished = preopt::finish(&raw).unwrap();
            wasmparser::Validator::new()
                .validate_all(&finished)
                .unwrap();
            let plan = sink_report(&finished, &Options::default()).unwrap();
            assert!(
                plan.instrumented.iter().any(|n| n == "choose"),
                "{passes:?}: {plan:?}"
            );
            if passes == ["--optimize-instructions"] {
                let mut calls = 0;
                for payload in wasmparser::Parser::new(0).parse_all(&raw) {
                    if let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() {
                        let mut ops = body.get_operators_reader().unwrap();
                        while !ops.eof() {
                            calls += usize::from(matches!(
                                ops.read().unwrap(),
                                wasmparser::Operator::CallIndirect { .. }
                            ));
                        }
                    }
                }
                assert_eq!(calls, 1, "fixture must actually merge the two calls");
            }
        }
    }
}

#[test]
fn broader_cli_modes_report_disposition_and_strip_build_metadata() {
    let scratch = Scratch::new("pipeline-cli");
    let input = scratch.0.join("input.wasm");
    let output = scratch.0.join("output.wasm");
    fs::write(&input, linked()).unwrap();
    for mode in ["transport", "inlining-cleanup", "O2", "Oz"] {
        let mut previous = None;
        for cores in ["1", "4", "2"] {
            let run = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
                .env("BINARYEN_CORES", cores)
                .arg(&input)
                .args(["--pre-optimize", mode, "--post-optimize", "Oz"])
                .arg("-o")
                .arg(&output)
                .output()
                .unwrap();
            assert!(
                run.status.success(),
                "{}",
                String::from_utf8_lossy(&run.stderr)
            );
            let diagnostics = String::from_utf8_lossy(&run.stderr);
            if mode == "O2" || mode == "Oz" {
                assert!(diagnostics.contains("analyzing final Wasm"));
                assert!(!diagnostics.contains("Binaryen preservation report"));
            } else {
                assert!(diagnostics.contains("Binaryen preservation report"));
            }
            let bytes = fs::read(&output).unwrap();
            wasmparser::Validator::new().validate_all(&bytes).unwrap();
            let m = walrus::ModuleConfig::new().parse(&bytes).unwrap();
            assert!(m.customs.iter().all(|(_, s)| {
                ![
                    preopt::SECTION,
                    preopt::REPORT_SECTION,
                    facts::SECTION,
                    facts::CODE_HASH_SECTION,
                ]
                .contains(&s.name())
            }));
            if let Some(previous) = &previous {
                assert_eq!(&bytes, previous, "{mode} changed with worker count");
            }
            previous = Some(bytes);
        }
    }
}
