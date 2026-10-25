//! Normal entry points must select native without a backend override.
use fork_instrument::{Options, instrument, native};
use std::process::Command;

#[test]
fn library_and_cli_use_the_function_local_transform() {
    let input = wat::parse_str(
        r#"(module
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (memory 1)
      (func (export "root") (result i32) i32.const 0 call $fork))"#,
    )
    .unwrap();
    let options = Options::default();
    let expected = native::instrument(&input, &options, Default::default()).unwrap();
    assert_eq!(
        instrument(&input, &options).unwrap(),
        expected.bytes.bytes()
    );
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("original.wasm");
    std::fs::write(&source, input).unwrap();
    for (name, bytes) in [("default", expected.bytes.bytes())] {
        let destination = directory.path().join(format!("{name}.wasm"));
        let mut command = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"));
        command
            .arg(&source)
            .arg("--post-optimize")
            .arg("none")
            .arg("-o")
            .arg(&destination);
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(std::fs::read(destination).unwrap(), bytes, "{name}");
    }
}
