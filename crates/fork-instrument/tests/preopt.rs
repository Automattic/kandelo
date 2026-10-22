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
        ![facts::SECTION, facts::CODE_HASH_SECTION, preopt::SECTION].contains(&s.name())
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
