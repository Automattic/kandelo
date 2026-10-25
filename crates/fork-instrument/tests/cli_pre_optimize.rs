//! The shipping optimize-first path uses unmodified wasm-opt and final-Wasm analysis.
use fork_instrument::{Options, facts, instrument};
use std::{fs, path::PathBuf, process::Command};

const MAIN: &str = r#"(module
  (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
  (memory 1)
  (func $helper (result i32) (call $fork (i32.const 0)))
  (func (export "_start") (drop (call $helper))))"#;
struct Scratch(PathBuf);
impl Scratch {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kandelo-stock-preopt-{label}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn stock_optimizer_discards_absent_or_stale_facts_before_reanalysis() {
    let scratch = Scratch::new("facts");
    let input = scratch.0.join("in.wasm");
    let output = scratch.0.join("out.wasm");
    for stale in [false, true] {
        let mut module = walrus::Module::from_buffer(&wat::parse_str(MAIN).unwrap()).unwrap();
        if stale {
            for name in [facts::SECTION, facts::CODE_HASH_SECTION] {
                module.customs.add(walrus::RawCustomSection {
                    name: name.into(),
                    data: b"stale and unreadable".to_vec(),
                });
            }
        }
        fs::write(&input, module.emit_wasm()).unwrap();
        for mode in ["O2", "Oz"] {
            let run = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
                .env_remove("WASM_OPT")
                .arg(&input)
                .args(["--pre-optimize", mode, "--sink-report"])
                .output()
                .unwrap();
            assert!(
                run.status.success(),
                "{}",
                String::from_utf8_lossy(&run.stderr)
            );
            assert!(String::from_utf8_lossy(&run.stdout).contains("source\tbuiltin"));
            assert!(!String::from_utf8_lossy(&run.stderr).contains("compiler facts not used"));
            let run = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
                .env_remove("WASM_OPT")
                .arg(&input)
                .args(["--pre-optimize", mode, "--post-optimize", "none"])
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
            wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
                .validate_all(&bytes)
                .unwrap();
            let module = walrus::Module::from_buffer(&bytes).unwrap();
            assert!(
                module
                    .exports
                    .iter()
                    .any(|e| e.name == "wpk_fork_resume_start")
            );
            for name in [
                facts::SECTION,
                facts::CODE_HASH_SECTION,
                fork_instrument::preopt::SECTION,
                fork_instrument::preopt::REPORT_SECTION,
            ] {
                assert!(module.customs.iter().all(|(_, s)| s.name() != name));
            }
        }
    }
}

#[test]
fn incompatible_inputs_are_rejected_before_output_is_replaced() {
    let scratch = Scratch::new("reject");
    let input = scratch.0.join("in.wasm");
    let output = scratch.0.join("out.wasm");
    let raw = wat::parse_str(MAIN).unwrap();
    let mut side = walrus::Module::from_buffer(&raw).unwrap();
    side.customs.add(walrus::RawCustomSection {
        name: "dylink.0".into(),
        data: vec![],
    });
    for bytes in [
        instrument(&raw, &Options::default()).unwrap(),
        side.emit_wasm(),
        wat::parse_str(MAIN.replace("(memory 1)", "(memory i64 1)")).unwrap(),
    ] {
        fs::write(&input, bytes).unwrap();
        fs::write(&output, b"keep existing output").unwrap();
        let run = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&input)
            .args(["--pre-optimize", "Oz"])
            .arg("-o")
            .arg(&output)
            .output()
            .unwrap();
        assert!(!run.status.success());
        assert_eq!(fs::read(&output).unwrap(), b"keep existing output");
    }
}

#[test]
#[cfg(unix)]
fn sealed_installer_uses_resolver_pre_optimization_policy() {
    let scratch = Scratch::new("install");
    let root = fs::canonicalize(&scratch.0).unwrap();
    let input = root.join("input.wasm");
    let out = root.join("out");
    fs::create_dir_all(&out).unwrap();
    let raw = wat::parse_str(MAIN).unwrap();
    fs::write(&input, &raw).unwrap();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let run = |mode: &str, post: &str| {
        Command::new("bash")
        .arg("-xc")
        .arg("set -euo pipefail; source \"$1/scripts/install-local-binary.sh\"; install_local_binary fixture \"$2\" fixture.wasm")
        .arg("_").arg(&repo).arg(&input)
        .env("WASM_POSIX_INSTALL_LOCAL_MIRROR", "0")
        .env("WASM_POSIX_INSTALL_FORK_INSTRUMENTATION", "auto")
        .env("WASM_POSIX_DEP_OUT_DIR", &out)
        .env("WASM_POSIX_DEP_FORK_PRE_OPTIMIZE", mode)
        .env("WASM_POSIX_DEP_FORK_POST_OPTIMIZE", post)
        .env("WASM_POSIX_FORK_INSTRUMENT", env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .env_remove("WASM_OPT")
        .output().unwrap()
    };
    let bad = run("invalid", "Os");
    assert!(!bad.status.success());
    assert_eq!(fs::read(&input).unwrap(), raw);
    assert!(!out.join("fixture.wasm").exists());
    let bad = run("Oz", "invalid");
    assert!(!bad.status.success());
    assert_eq!(fs::read(&input).unwrap(), raw);
    assert!(!out.join("fixture.wasm").exists());
    // Selecting a final optimizer must still enforce the default facts guard.
    let guarded = run("none", "Oz");
    assert!(!guarded.status.success());
    assert_eq!(fs::read(&input).unwrap(), raw);
    assert!(!out.join("fixture.wasm").exists());
    let result = run("Oz", "Oz");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("analyzing final Wasm"));
    assert!(String::from_utf8_lossy(&result.stderr).contains("--post-optimize Oz"));
    let bytes = fs::read(out.join("fixture.wasm")).unwrap();
    assert_ne!(bytes, raw);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    assert!(
        module
            .exports
            .iter()
            .any(|e| e.name == "wpk_fork_resume_start")
    );
}
