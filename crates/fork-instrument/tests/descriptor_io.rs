#![cfg(unix)]
use fork_instrument::original_artifact::{original_reference, reference_for_original};
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            fs::{FileExt, MetadataExt, PermissionsExt},
            process::CommandExt,
        },
    },
    process::{Command, Output},
};

fn original() -> Vec<u8> {
    wat::parse_str(
        r#"(module
        (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
        (memory 2) (func (export "_start") i32.const 0 call $fork drop))"#,
    )
    .unwrap()
}

fn readonly(bytes: &[u8]) -> File {
    let temporary = tempfile::NamedTempFile::new().unwrap();
    fs::write(temporary.path(), bytes).unwrap();
    File::open(temporary.path()).unwrap()
}

fn command(input: Option<&File>, output: Option<&File>) -> Command {
    let copies: Vec<_> = [(input, 3), (output, 4)]
        .into_iter()
        .filter_map(|(file, target)| {
            file.map(|file| {
                let descriptor =
                    unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
                assert!(descriptor >= 64);
                (unsafe { File::from_raw_fd(descriptor) }, target)
            })
        })
        .collect();
    let mut command = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"));
    command.env_remove("WASM_POSIX_BUILD_ORIGINAL_STORE");
    unsafe {
        command.pre_exec(move || {
            for (file, target) in &copies {
                if libc::dup2(file.as_raw_fd(), *target) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    command
}

fn run(input: &File, output: &File, extra: &[&str]) -> Output {
    command(Some(input), Some(output))
        .args([
            "--input-fd",
            "3",
            "--output-fd",
            "4",
            "--post-optimize",
            "none",
        ])
        .args(extra)
        .output()
        .unwrap()
}

fn bytes(file: &File) -> Vec<u8> {
    let mut bytes = vec![0; file.metadata().unwrap().len() as usize];
    file.read_exact_at(&mut bytes, 0).unwrap();
    bytes
}

fn success(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn private_descriptors_match_path_output_and_preserve_offsets_modes_and_source() {
    let raw = original();
    let mut input = readonly(&raw);
    let mut output = tempfile::tempfile().unwrap();
    input.seek(SeekFrom::Start(17)).unwrap();
    output.seek(SeekFrom::Start(9)).unwrap();
    let input_mode = input.metadata().unwrap().mode();
    let output_mode = output.metadata().unwrap().mode();
    success(run(&input, &output, &["--bind-original"]));
    assert_eq!(input.stream_position().unwrap(), 17);
    assert_eq!(output.stream_position().unwrap(), 9);
    assert_eq!(input.metadata().unwrap().mode(), input_mode);
    assert_eq!(output.metadata().unwrap().mode(), output_mode);
    assert_eq!(output.metadata().unwrap().nlink(), 0);
    assert_eq!(bytes(&input), raw);
    let prepared = bytes(&output);
    assert_eq!(
        original_reference(&prepared).unwrap(),
        Some(reference_for_original(&raw).unwrap())
    );
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.wasm");
    let destination = directory.path().join("output.wasm");
    fs::write(&source, &raw).unwrap();
    success(
        command(None, None)
            .arg(source)
            .arg("-o")
            .arg(&destination)
            .args(["--bind-original", "--post-optimize", "none"])
            .output()
            .unwrap(),
    );
    assert_eq!(fs::read(destination).unwrap(), prepared);
}

#[test]
fn descriptor_and_path_targets_can_be_mixed_and_inspection_accepts_input_fd() {
    let raw = original();
    let input = readonly(&raw);
    let output = tempfile::tempfile().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.wasm");
    let destination = directory.path().join("output.wasm");
    fs::write(&source, &raw).unwrap();
    success(
        command(None, Some(&output))
            .arg(&source)
            .args(["--output-fd", "4", "--post-optimize", "none"])
            .output()
            .unwrap(),
    );
    success(
        command(Some(&input), None)
            .args(["--input-fd", "3", "-o"])
            .arg(&destination)
            .args(["--post-optimize", "none"])
            .output()
            .unwrap(),
    );
    assert_eq!(bytes(&output), fs::read(destination).unwrap());
    let inspected = command(Some(&input), None)
        .args(["--input-fd", "3", "--original-reference"])
        .output()
        .unwrap();
    assert_eq!(inspected.stdout, b"none\n");
    success(inspected);
}

#[test]
fn storeless_binding_does_not_touch_the_ambient_store() {
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("must-not-exist");
    let input = readonly(&original());
    let output = tempfile::tempfile().unwrap();
    success(
        command(Some(&input), Some(&output))
            .args([
                "--input-fd",
                "3",
                "--output-fd",
                "4",
                "--bind-original",
                "--post-optimize",
                "none",
            ])
            .env("WASM_POSIX_BUILD_ORIGINAL_STORE", &store)
            .output()
            .unwrap(),
    );
    assert!(!store.exists());
    assert!(original_reference(&bytes(&output)).unwrap().is_some());
}

#[test]
fn malformed_inputs_and_budget_refusals_leave_staging_empty() {
    for (source, arguments) in [
        (b"invalid".to_vec(), vec![]),
        (original(), vec!["--max-input-bytes", "1"]),
        (original(), vec!["--max-output-bytes", "1"]),
        (
            original(),
            vec!["--max-output-bytes", "300", "--bind-original"],
        ),
    ] {
        let input = readonly(&source);
        let output = tempfile::tempfile().unwrap();
        let result = run(&input, &output, &arguments);
        assert!(!result.status.success(), "expected refusal: {arguments:?}");
        assert!(bytes(&output).is_empty());
        assert_eq!(bytes(&input), source);
    }
}

#[test]
fn rejects_named_populated_readonly_append_and_nonregular_output() {
    let input = readonly(&original());
    let named = tempfile::NamedTempFile::new().unwrap();
    let mut populated = tempfile::tempfile().unwrap();
    populated.write_all(b"private existing bytes").unwrap();
    let readonly = readonly(b"");
    let append = tempfile::NamedTempFile::new().unwrap();
    let appending = OpenOptions::new()
        .write(true)
        .append(true)
        .open(append.path())
        .unwrap();
    fs::remove_file(append.path()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let directory_file = File::open(directory.path()).unwrap();
    let mut pipe = [0; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let pipe_reader = unsafe { File::from_raw_fd(pipe[0]) };
    let pipe_writer = unsafe { File::from_raw_fd(pipe[1]) };
    for output in [
        named.as_file(),
        &populated,
        &readonly,
        &appending,
        &directory_file,
        &pipe_writer,
    ] {
        assert!(!run(&input, output, &[]).status.success());
    }
    assert_eq!(bytes(&populated), b"private existing bytes");
    assert_eq!(named.as_file().metadata().unwrap().len(), 0);
    drop(pipe_reader);
}

#[test]
fn rejects_writable_nonregular_and_aliased_inputs() {
    let output = tempfile::tempfile().unwrap();
    let writable = tempfile::tempfile().unwrap();
    writable.write_all_at(&original(), 0).unwrap();
    assert!(!run(&writable, &output, &[]).status.success());
    let directory = tempfile::tempdir().unwrap();
    let input = File::open(directory.path()).unwrap();
    assert!(!run(&input, &output, &[]).status.success());
    let mut pipe = [0; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let reader = unsafe { File::from_raw_fd(pipe[0]) };
    let writer = unsafe { File::from_raw_fd(pipe[1]) };
    assert!(!run(&reader, &output, &[]).status.success());
    drop(writer);
    let named = tempfile::NamedTempFile::new().unwrap();
    let source = File::open(named.path()).unwrap();
    let destination = OpenOptions::new().write(true).open(named.path()).unwrap();
    fs::remove_file(named.path()).unwrap();
    let result = run(&source, &destination, &[]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("must not alias"));
    assert!(bytes(&output).is_empty());
}

#[test]
fn invalid_descriptors_cannot_be_filled_by_internal_clones_or_spools() {
    let input = readonly(&original());
    let result = command(Some(&input), None)
        .args(["--input-fd", "3", "--output-fd", "1000000"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    let output = tempfile::tempfile().unwrap();
    let result = command(None, Some(&output))
        .args(["--input-fd", "1000000", "--output-fd", "4"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(bytes(&output).is_empty());
}

#[test]
fn rejects_ambiguous_sources_targets_and_inspection_mutations() {
    let input = readonly(&original());
    let output = tempfile::tempfile().unwrap();
    for arguments in [
        vec!["--input-fd", "0", "--original-reference"],
        vec!["--input-fd", "-1", "--original-reference"],
        vec!["--input-fd", "3", "other.wasm", "--original-reference"],
        vec!["--input-fd", "3", "--output-fd", "4", "-o", "other.wasm"],
        vec!["--input-fd", "3", "--bind-original"],
        vec![
            "--input-fd",
            "3",
            "--output-fd",
            "4",
            "--bind-original",
            "--original-store",
            "store",
        ],
        vec![
            "--input-fd",
            "3",
            "--output-fd",
            "4",
            "--bind-original",
            "--retain-uninstrumented",
        ],
        vec![
            "--input-fd",
            "3",
            "--output-fd",
            "4",
            "--bind-original",
            "--reprepare-from-original",
        ],
    ] {
        let result = command(Some(&input), Some(&output))
            .args(&arguments)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{arguments:?}");
        assert!(bytes(&output).is_empty());
    }
    for mode in [
        "--original-reference",
        "--verify-original",
        "--discover-only",
        "--sink-report",
        "--streaming-scan",
        "--contract-inventory",
        "--artifact-identity",
        "--fork-capability-hex",
        "--linked-frame-descriptor-hex",
        "--reserved-env-imports",
        "--legacy-asyncify-exports",
    ] {
        for mutation in ["--output-fd", "--bind-original"] {
            let mut arguments = vec!["--input-fd", "3", mode, mutation];
            if mutation == "--output-fd" {
                arguments.push("4");
            }
            if mode == "--verify-original" {
                arguments.insert(3, "original.wasm");
            }
            let result = command(Some(&input), Some(&output))
                .args(&arguments)
                .output()
                .unwrap();
            assert!(!result.status.success(), "{arguments:?}");
            assert_eq!(
                result.status.code(),
                Some(2),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}

#[test]
fn optimizer_cannot_inherit_private_descriptors_and_failure_keeps_staging_empty() {
    let directory = tempfile::tempdir().unwrap();
    let optimizer = directory.path().join("optimizer.sh");
    fs::write(&optimizer, b"#!/bin/sh\nset -eu\nif ( : <&3 ) 2>/dev/null; then exit 91; fi\nif ( : >&4 ) 2>/dev/null; then exit 92; fi\nsource=$1\nwhile [ \"$1\" != -o ]; do shift; done\nshift\nif [ \"$MODE\" = fail ]; then printf bad > \"$1\"; exit 23; fi\ncp \"$source\" \"$1\"\n").unwrap();
    fs::set_permissions(&optimizer, fs::Permissions::from_mode(0o700)).unwrap();
    for mode in ["copy", "fail"] {
        let mut input = readonly(&original());
        let mut output = tempfile::tempfile().unwrap();
        input.seek(SeekFrom::Start(17)).unwrap();
        output.seek(SeekFrom::Start(9)).unwrap();
        let result = command(Some(&input), Some(&output))
            .args(["--input-fd", "3", "--output-fd", "4", "--bind-original"])
            .env("WASM_OPT", &optimizer)
            .env("MODE", mode)
            .output()
            .unwrap();
        if mode == "copy" {
            success(result);
            assert!(original_reference(&bytes(&output)).unwrap().is_some());
        } else {
            assert!(!result.status.success());
            assert!(bytes(&output).is_empty());
        }
        assert_eq!(input.stream_position().unwrap(), 17);
        assert_eq!(output.stream_position().unwrap(), 9);
    }
}
