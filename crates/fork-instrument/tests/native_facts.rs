#[path = "support/snapshot.rs"]
mod snapshot;
use fork_instrument::{Options, PlanSource, facts, native};
use wasm_encoder::{CustomSection, Encode};

fn linked(text: &str, hash: Option<[u8; 32]>) -> Vec<u8> {
    let mut bytes = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    append(&mut bytes, facts::SECTION, text.as_bytes());
    if let Some(hash) = hash {
        append(&mut bytes, facts::CODE_HASH_SECTION, &hash);
    }
    bytes
}
fn append(bytes: &mut Vec<u8>, name: &str, data: &[u8]) {
    bytes.push(0);
    CustomSection {
        name: name.into(),
        data: data.into(),
    }
    .encode(bytes);
}
fn compare(input: &[u8], options: &Options) -> native::Decision {
    let native = native::analyze(input, options, Default::default()).unwrap();
    let names = |set: &std::collections::BTreeSet<u32>| {
        let mut names: Vec<_> = set
            .iter()
            .filter_map(|&function| {
                let source = &native.scan.functions[function as usize];
                source.body.as_ref().map(|_| source.name.clone().unwrap())
            })
            .collect();
        names.sort();
        names
    };
    snapshot::check(
        input,
        &format!(
            "sinks-{}-facts-{}-effective-{}",
            options.sinks, options.facts, options.effective_types
        ),
        (
            names(&native.reaching.activations),
            names(&native.boundaries),
            native.decision.source,
            &native.decision.facts,
            native.decision.facts_error.is_some(),
        ),
    );
    native.decision
}

#[test]
fn production_facts_options_and_selected_sets_preserve_expected_results() {
    let text = include_str!("fixtures/typed_dispatch.calltypes");
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let input = linked(text, Some(facts::code_sha256(&plain).unwrap()));
    for options in [
        Options::default(),
        Options {
            facts: false,
            ..Default::default()
        },
        Options {
            sinks: false,
            ..Default::default()
        },
        Options {
            effective_types: false,
            ..Default::default()
        },
    ] {
        compare(&input, &options);
    }
    assert_eq!(
        compare(&input, &Options::default()).source,
        PlanSource::Facts
    );
}

#[test]
fn unsupported_or_stale_facts_use_native_baselines_and_can_be_ignored() {
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let text = include_str!("fixtures/typed_dispatch.calltypes");
    for input in [linked(text, None), linked(text, Some([0; 32]))] {
        let decision = compare(&input, &Options::default());
        assert_eq!(decision.source, PlanSource::Builtin);
        assert!(decision.facts_error.is_some());
        let ignored = compare(
            &input,
            &Options {
                facts: false,
                ..Default::default()
            },
        );
        assert!(ignored.facts_error.is_none());
    }
    let unsupported = linked(
        "#kandelo-calltypes\t0\n",
        Some(facts::code_sha256(&plain).unwrap()),
    );
    let analysis = native::analyze(&unsupported, &Options::default(), Default::default()).unwrap();
    assert_eq!(analysis.decision.source, PlanSource::Builtin);
    assert_eq!(
        analysis.decision.facts_error.as_deref(),
        Some("unsupported facts format")
    );
}

#[test]
fn dynamic_facts_preserve_the_explicit_side_module_contract() {
    let source = include_str!("fixtures/typed_dispatch.wat").replace("  (memory 1)",
        "  (import \"env\" \"__wasm_dlsym\" (func $lookup (param i32 i32 i32) (result i32)))\n  (memory 1)");
    let plain = wat::parse_str(source).unwrap();
    let mut input = plain.clone();
    append(
        &mut input,
        facts::SECTION,
        include_str!("fixtures/typed_dispatch.calltypes").as_bytes(),
    );
    append(
        &mut input,
        facts::CODE_HASH_SECTION,
        &facts::code_sha256(&plain).unwrap(),
    );
    let native = native::analyze(&input, &Options::default(), Default::default()).unwrap();
    assert_eq!(
        native.decision.source,
        PlanSource::Facts,
        "{:?}",
        native.decision.facts_error
    );
    // A returning address-taken function forces the full-entry contract.
    assert!(
        native
            .decision
            .dlopen_contract
            .as_ref()
            .unwrap()
            .contains("mode\tassume-all-entries-fork-returning")
    );
    compare(&input, &Options::default());
}

#[test]
fn malformed_bound_facts_and_storage_exhaustion_are_errors() {
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let hash = Some(facts::code_sha256(&plain).unwrap());
    let malformed = linked("malformed facts", hash);
    let err = native::analyze(&malformed, &Options::default(), Default::default())
        .err()
        .unwrap();
    assert!(format!("{err:#}").contains("does not start with a chunk header"));

    let input = linked(include_str!("fixtures/typed_dispatch.calltypes"), hash);
    let mut limits = native::AnalysisLimits::default();
    limits.storage.disk_bytes = 4096;
    let err = native::analyze(&input, &Options::default(), limits)
        .err()
        .unwrap();
    assert!(format!("{err:#}").contains("database or disk is full"));
}

#[cfg(unix)]
#[test]
fn cli_fails_if_writes_to_the_facts_database_fail() {
    use std::{fmt::Write as _, os::unix::process::CommandExt, process::Command};

    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.wasm");
    let output = dir.path().join("output.wasm");
    let plain = wat::parse_str(include_str!("fixtures/typed_dispatch.wat")).unwrap();
    let mut text = include_str!("fixtures/typed_dispatch.calltypes").to_owned();
    for i in 0..10_000 {
        writeln!(text, "Q\tfunction_{i}\ttype_{i}").unwrap();
    }
    let bytes = linked(&text, Some(facts::code_sha256(&plain).unwrap()));
    std::fs::write(&input, &bytes).unwrap();
    std::fs::write(&output, b"previous output").unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"));
    command
        .arg(&input)
        .arg("-o")
        .arg(&output)
        .args(["--post-optimize", "none"])
        .env("TMPDIR", dir.path());
    // Allow the input snapshot and builtin DB to fit. Interning thousands
    // of names and indexing their relations exceeds the per-file limit.
    let size = 512 * 1024;
    assert!(bytes.len() < size);
    unsafe {
        command.pre_exec(move || {
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            let limit = libc::rlimit {
                rlim_cur: size as libc::rlim_t,
                rlim_max: size as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let result = command.output().unwrap();
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(!result.status.success(), "{stderr}");
    assert!(stderr.contains("analyzing compiler facts"), "{stderr}");
    assert!(stderr.contains(dir.path().to_str().unwrap()), "{stderr}");
    assert!(
        stderr.contains("disk I/O error") || stderr.contains("database or disk is full"),
        "{stderr}"
    );
    assert_eq!(std::fs::read(&output).unwrap(), b"previous output");
}

/// Facts-planned activations of a fixture, with the contract mode it chose.
fn facts_activations(wat: &str, calltypes: &str, options: &Options) -> (Vec<String>, String) {
    let plain = wat::parse_str(wat).unwrap();
    let mut input = plain.clone();
    append(&mut input, facts::SECTION, calltypes.as_bytes());
    append(
        &mut input,
        facts::CODE_HASH_SECTION,
        &facts::code_sha256(&plain).unwrap(),
    );
    let native = native::analyze(&input, options, Default::default()).unwrap();
    assert_eq!(
        native.decision.source,
        PlanSource::Facts,
        "{:?}",
        native.decision.facts_error
    );
    let activations = native
        .reaching
        .activations
        .iter()
        .filter_map(|&function| native.scan.functions[function as usize].name.clone())
        .collect();
    let contract = native.decision.dlopen_contract.unwrap_or_default();
    (activations, contract)
}

#[test]
fn dlsym_installable_exports_are_indirect_targets_in_traced_entries() {
    // WHY: dlsym(RTLD_DEFAULT, name) appends a main-program function export to
    // __indirect_function_table at run time, so an export is a possible
    // target of the program's own indirect calls even with no element
    // segment. Without that, a call through the pointer has no targets, is
    // treated as never returning, and the frames above a later fork are
    // dropped from the plan.
    let (activations, _) = facts_activations(
        include_str!("fixtures/dlsym_dispatch.wat"),
        include_str!("fixtures/dlsym_dispatch.calltypes"),
        &Options::default(),
    );
    for name in ["direct", "through", "_start"] {
        assert!(
            activations.iter().any(|activation| activation == name),
            "{name} must stay instrumented: {activations:?}"
        );
    }
}

#[test]
fn traced_entries_side_module_calls_return_without_fork_returning() {
    // WHY: under traced-entries a side module never returns through a fork
    // child into main-program frames, but it does return normally. A call
    // that can only reach a side module must not be treated as never
    // returning (that drops the frames above a later fork), and must not
    // make its caller fork-returning either (that is the full-entry mode).
    let wat = include_str!("fixtures/side_dispatch.wat");
    let calltypes = include_str!("fixtures/side_dispatch.calltypes");
    let (activations, contract) = facts_activations(wat, calltypes, &Options::default());
    assert!(contract.contains("mode\ttraced-entries"), "{contract}");
    for name in ["direct", "_start"] {
        assert!(
            activations.iter().any(|activation| activation == name),
            "{name} must stay instrumented: {activations:?}"
        );
    }
    assert!(
        !activations.iter().any(|activation| activation == "plugin"),
        "a side-module call off the fork path stays uninstrumented: {activations:?}"
    );
    let (activations, contract) = facts_activations(
        wat,
        calltypes,
        &Options {
            side_modules: fork_instrument::SideModules::AssumeAllEntriesForkReturning,
            ..Default::default()
        },
    );
    assert!(
        contract.contains("mode\tassume-all-entries-fork-returning"),
        "{contract}"
    );
    assert!(
        activations.iter().any(|activation| activation == "plugin"),
        "full-entry mode instruments every side-module call: {activations:?}"
    );
}
