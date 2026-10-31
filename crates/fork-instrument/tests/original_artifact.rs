use fork_instrument::{
    artifact_io::MappedArtifact,
    original_artifact::{
        ORIGINAL_REFERENCE_SECTION, OriginalReference, attach_original_reference, load_original,
        original_reference, retain_original, verify_original,
    },
};
use std::{fs, io::Cursor, process::Command};

fn original() -> Vec<u8> {
    wat::parse_str(
        r#"(module
        (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
        (memory 2) (func (export "_start") i32.const 0 call $fork drop))"#,
    )
    .unwrap()
}

#[test]
fn original_store_retains_exact_bytes_and_rejects_replaced_content() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    let mut bytes = original();
    let mut section = Vec::new();
    wasm_encoder::Encode::encode(
        &wasm_encoder::CustomSection {
            name: "compiler-metadata".into(),
            data: b"must survive preparation".as_slice().into(),
        },
        &mut section,
    );
    bytes.push(0);
    bytes.extend(section);
    fs::write(&input, &bytes).unwrap();
    let (snapshot, permissions) = MappedArtifact::read(&input, 4096).unwrap();
    let reference = retain_original(&snapshot, directory.path(), permissions.clone()).unwrap();
    assert_eq!(
        retain_original(&snapshot, directory.path(), permissions).unwrap(),
        reference
    );
    assert_eq!(fs::read(reference.path(directory.path())).unwrap(), bytes);
    fs::remove_file(&input).unwrap();
    assert_eq!(
        load_original(directory.path(), &reference, 4096)
            .unwrap()
            .bytes(),
        bytes
    );
    assert!(load_original(directory.path(), &reference, reference.length - 1).is_err());
    fs::remove_file(reference.path(directory.path())).unwrap();
    fs::write(reference.path(directory.path()), vec![0; bytes.len()]).unwrap();
    assert!(load_original(directory.path(), &reference, 4096).is_err());
    let permissions = fs::metadata(reference.path(directory.path()))
        .unwrap()
        .permissions();
    assert!(retain_original(&snapshot, directory.path(), permissions).is_err());
    assert_eq!(
        fs::read(reference.path(directory.path())).unwrap(),
        vec![0; bytes.len()]
    );
}

#[test]
fn associated_original_verification_uses_content_and_raw_program_admission() {
    use sha2::{Digest, Sha256};
    let bytes = original();
    let reference = OriginalReference {
        length: bytes.len() as u64,
        sha256: Sha256::digest(&bytes).into(),
    };
    verify_original(&bytes, &reference, reference.length).unwrap();
    assert!(verify_original(&bytes, &reference, reference.length - 1).is_err());
    assert!(verify_original(&bytes[..bytes.len() - 1], &reference, 4096).is_err());
    let mut wrong_digest = reference.clone();
    wrong_digest.sha256[0] ^= 1;
    assert!(verify_original(&bytes, &wrong_digest, 4096).is_err());
    let snapshot = MappedArtifact::snapshot(Cursor::new(&bytes), 4096).unwrap();
    let prepared = attach_original_reference(&snapshot, &reference, 4096).unwrap();
    let prepared_reference = OriginalReference {
        length: prepared.bytes().len() as u64,
        sha256: Sha256::digest(prepared.bytes()).into(),
    };
    assert!(verify_original(prepared.bytes(), &prepared_reference, 4096).is_err());
    let invalid = b"not a WebAssembly program";
    let reference = OriginalReference {
        length: invalid.len() as u64,
        sha256: Sha256::digest(invalid).into(),
    };
    assert!(verify_original(invalid, &reference, 4096).is_err());
}

#[cfg(unix)]
#[test]
fn retained_original_reuse_refuses_unsafe_modes_and_symlinks_without_repair() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let bytes = original();
    let snapshot = MappedArtifact::snapshot(Cursor::new(&bytes), 4096).unwrap();
    let reference = retain_original(&snapshot, directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let path = reference.path(directory.path());
    for mode in [0o555, 0o644] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o7777, mode);
        assert!(load_original(directory.path(), &reference, 4096).is_err(), "{mode:o}");
        assert!(retain_original(&snapshot, directory.path(), fs::Permissions::from_mode(0o755)).is_err(), "{mode:o}");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o7777, mode);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::remove_file(&path).unwrap();
    let outside = directory.path().join("outside.wasm");
    fs::write(&outside, &bytes).unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o444)).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(load_original(directory.path(), &reference, 4096).is_err());
    assert!(retain_original(&snapshot, directory.path(), fs::Permissions::from_mode(0o755)).is_err());
    assert!(path.is_symlink());
}

#[test]
fn cli_retains_raw_nonfork_programs_and_verifies_associated_bytes_without_writes() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("raw.wasm");
    let output = directory.path().join("bound.wasm");
    let store = directory.path().join("store");
    let bytes = wat::parse_str("(module (func (export \"_start\")))").unwrap();
    fs::write(&input, &bytes).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input).arg("-o").arg(&output).arg("--original-store").arg(&store)
        .arg("--retain-uninstrumented").output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let prepared = fs::read(&output).unwrap();
    let reference = original_reference(&prepared).unwrap().unwrap();
    assert!(prepared.starts_with(&bytes));
    assert_eq!(fs::read(reference.path(&store)).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(reference.path(&store)).unwrap().permissions().mode() & 0o7111, 0);
    }
    let verify = |original: &std::path::Path, budget: u64| {
        Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&output).arg("--verify-original").arg(original)
            .arg("--max-input-bytes").arg(budget.to_string()).output().unwrap()
    };
    let result = verify(&reference.path(&store), 4096);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(result.stdout.is_empty());
    assert!(!verify(&input, 1).status.success());
    fs::write(&input, b"wrong raw bytes").unwrap();
    assert!(!verify(&input, 4096).status.success());
    assert_eq!(fs::read(&output).unwrap(), prepared);
    let repeat = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&output).arg("-o").arg(&input).arg("--original-store").arg(&store)
        .arg("--retain-uninstrumented").output().unwrap();
    assert!(!repeat.status.success());
    assert_eq!(fs::read(&input).unwrap(), b"wrong raw bytes");
}

#[test]
fn cli_recipe_original_store_is_used_only_for_transformation_and_explicit_store_wins() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    let output = directory.path().join("prepared.wasm");
    let ambient_store = directory.path().join("ambient");
    let explicit_store = directory.path().join("explicit");
    fs::write(&input, original()).unwrap();
    for mode in ["--original-reference", "--discover-only", "--sink-report", "--contract-inventory",
        "--artifact-identity", "--fork-capability-hex", "--linked-frame-descriptor-hex",
        "--reserved-env-imports", "--streaming-scan", "--legacy-asyncify-exports"] {
        let expected = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .env_remove("WASM_POSIX_BUILD_ORIGINAL_STORE")
            .arg(&input).arg(mode).output().unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .env("WASM_POSIX_BUILD_ORIGINAL_STORE", &ambient_store)
            .arg(&input).arg(mode).output().unwrap();
        assert_eq!(result.status.code(), expected.status.code(), "{mode}");
        assert_eq!(result.stdout, expected.stdout, "{mode}");
        assert_eq!(result.stderr, expected.stderr, "{mode}");
        assert!(!ambient_store.exists(), "{mode}");
    }
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .env("WASM_POSIX_BUILD_ORIGINAL_STORE", &ambient_store)
        .arg(&input).arg("-o").arg(&output).args(["--post-optimize", "none"])
        .output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let reference = original_reference(&fs::read(&output).unwrap()).unwrap().unwrap();
    assert_eq!(fs::read(reference.path(&ambient_store)).unwrap(), original());
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .env("WASM_POSIX_BUILD_ORIGINAL_STORE", directory.path().join("must-not-exist"))
        .arg(&input).arg("-o").arg(&output).arg("--original-store").arg(&explicit_store)
        .args(["--post-optimize", "none"]).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(!directory.path().join("must-not-exist").exists());
    assert_eq!(fs::read(reference.path(&explicit_store)).unwrap(), original());
}

#[test]
fn reference_inspection_is_read_only_and_unambiguous() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    let prepared = directory.path().join("prepared.wasm");
    let bytes = original();
    fs::write(&input, &bytes).unwrap();
    let (snapshot, _) = MappedArtifact::read(&input, 4096).unwrap();
    let reference = OriginalReference { length: bytes.len() as u64, sha256: [42; 32] };
    fs::write(&prepared, attach_original_reference(&snapshot, &reference, 4096).unwrap().bytes()).unwrap();
    let inspect = |path: &std::path::Path| Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(path).arg("--original-reference").output().unwrap();
    let missing = inspect(&input);
    assert!(missing.status.success());
    assert_eq!(missing.stdout, b"none\n");
    let found = inspect(&prepared);
    assert!(found.status.success());
    assert_eq!(String::from_utf8(found.stdout).unwrap(), format!("{}\t{}\n", reference.length, "2a".repeat(32)));
    assert_eq!(fs::read(&input).unwrap(), bytes);
    let previous = fs::read(&prepared).unwrap();
    let conflicting = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input).arg("--original-reference").arg("-o").arg(&prepared).output().unwrap();
    assert!(!conflicting.status.success());
    assert_eq!(fs::read(&prepared).unwrap(), previous);
    for option in [
        "--legacy-asyncify-exports", "--artifact-identity", "--contract-inventory",
        "--fork-capability-hex", "--linked-frame-descriptor-hex", "--reserved-env-imports",
        "--streaming-scan", "--sink-report", "--discover-only",
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&input).arg("--original-reference").arg(option).output().unwrap();
        assert!(!result.status.success(), "inspection accepted conflicting mode {option}");
    }
}

#[test]
fn reference_is_versioned_bounded_and_cannot_be_mistaken_for_an_original() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = original();
    let snapshot = MappedArtifact::snapshot(Cursor::new(&bytes), 4096).unwrap();
    let reference = OriginalReference {
        length: bytes.len() as u64,
        sha256: [42; 32],
    };
    let prepared = attach_original_reference(&snapshot, &reference, 4096).unwrap();
    fork_instrument::native::validate(prepared.bytes()).unwrap();
    assert_eq!(
        original_reference(prepared.bytes()).unwrap(),
        Some(reference.clone())
    );
    assert!(attach_original_reference(&snapshot, &reference, bytes.len() as u64).is_err());
    assert!(attach_original_reference(&prepared, &reference, 4096).is_err());
    let permissions = fs::metadata(directory.path()).unwrap().permissions();
    assert!(retain_original(&prepared, directory.path(), permissions).is_err());
    for (version, length, copies) in [(2u32, 44usize, 1), (1, 43, 1), (1, 44, 2)] {
        let mut malformed = bytes.clone();
        let mut payload = vec![0; length];
        payload[..4].copy_from_slice(&version.to_le_bytes());
        for _copy in 0..copies {
            let mut section = Vec::new();
            wasm_encoder::Encode::encode(
                &wasm_encoder::CustomSection {
                    name: ORIGINAL_REFERENCE_SECTION.into(),
                    data: payload.as_slice().into(),
                },
                &mut section,
            );
            malformed.push(0);
            malformed.extend(section);
        }
        assert!(original_reference(&malformed).is_err());
    }
}

#[test]
fn original_retention_uses_the_normal_raw_program_admission_policy() {
    let directory = tempfile::tempdir().unwrap();
    for module in [
        wat::parse_str("(module (func (export \"wpk_fork_resume_start\")))").unwrap(),
        {
            let mut module = original();
            let mut section = Vec::new();
            wasm_encoder::Encode::encode(
                &wasm_encoder::CustomSection {
                    name: "kandelo.wpk_fork.module_state".into(),
                    data: [].as_slice().into(),
                },
                &mut section,
            );
            module.push(0);
            module.extend(section);
            module
        },
    ] {
        let snapshot = MappedArtifact::snapshot(Cursor::new(&module), 4096).unwrap();
        let permissions = fs::metadata(directory.path()).unwrap().permissions();
        assert!(retain_original(&snapshot, directory.path(), permissions).is_err());
        assert!(!directory.path().join("originals").exists());
        assert!(
            fork_instrument::native::instrument(&module, &Default::default(), Default::default())
                .is_err()
        );
    }
}

#[test]
fn cli_can_prepare_again_from_a_retained_original_without_old_runtime_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    let output = directory.path().join("prepared.wasm");
    let store = directory.path().join("programs");
    let bytes = original();
    fs::write(&input, &bytes).unwrap();
    let run = |input: &std::path::Path| {
        Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(input)
            .arg("-o")
            .arg(&output)
            .arg("--original-store")
            .arg(&store)
            .args(["--post-optimize", "none"])
            .output()
            .unwrap()
    };
    let result = run(&input);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let prepared = fs::read(&output).unwrap();
    let reference = original_reference(&prepared).unwrap().unwrap();
    assert_eq!(fs::read(reference.path(&store)).unwrap(), bytes);
    let bounded = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input)
        .arg("-o")
        .arg(&output)
        .arg("--original-store")
        .arg(&store)
        .arg("--max-output-bytes")
        .arg((prepared.len() - 1).to_string())
        .args(["--post-optimize", "none"])
        .output()
        .unwrap();
    assert!(!bounded.status.success());
    assert_eq!(fs::read(&output).unwrap(), prepared);
    let refused = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input)
        .arg("-o")
        .arg(reference.path(&store))
        .arg("--original-store")
        .arg(&store)
        .args(["--post-optimize", "none"])
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert_eq!(fs::read(reference.path(&store)).unwrap(), bytes);
    let nested = store.join("originals/nested");
    fs::create_dir(&nested).unwrap();
    let nested_output = nested.join("existing.wasm");
    fs::write(&nested_output, b"preserve nested output").unwrap();
    let refused = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&input)
        .arg("-o")
        .arg(&nested_output)
        .arg("--original-store")
        .arg(&store)
        .args(["--post-optimize", "none"])
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert_eq!(fs::read(nested_output).unwrap(), b"preserve nested output");
    fs::remove_file(input).unwrap();
    let result = run(&reference.path(&store));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        original_reference(&fs::read(&output).unwrap()).unwrap(),
        Some(reference)
    );
    let result = run(&output);
    assert!(!result.status.success());
    assert_eq!(fs::read(&output).unwrap(), prepared);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output, fs::Permissions::from_mode(0o751)).unwrap();
    }
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&output)
        .arg("-o")
        .arg(&output)
        .arg("--original-store")
        .arg(&store)
        .args([
            "--reprepare-from-original",
            "--post-optimize",
            "none",
            "--no-sinks",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let regenerated = fs::read(&output).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o7777,
            0o751
        );
    }
    fork_instrument::native::validate(&regenerated).unwrap();
    let regenerated_reference = original_reference(&regenerated).unwrap().unwrap();
    assert_eq!(fs::read(regenerated_reference.path(&store)).unwrap(), bytes);
    assert!(regenerated_reference.path(&store).is_file());
    fs::remove_file(regenerated_reference.path(&store)).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(&output)
        .arg("-o")
        .arg(&output)
        .arg("--original-store")
        .arg(&store)
        .args(["--reprepare-from-original", "--post-optimize", "none"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(fs::read(output).unwrap(), regenerated);
}
