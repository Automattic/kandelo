use super::*;
use model::{Inputs, Observation};
use tempfile::TempDir;

fn fixture(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/test-baselines")
            .join(format!("{name}.txt")),
    )
    .unwrap()
}

fn historical() -> Evidence {
    Evidence {
        capture_id: None,
        suite: "sortix".into(),
        host: "node".into(),
        main_commit: "old-main".into(),
        recorded_at: "2026-10-30 (exact time unknown)".into(),
        command: vec!["runner".into()],
        versions: BTreeMap::new(),
        load_samples: vec![],
        load_threshold: 18.0,
        log_sha256: sha(b"fixture"),
        exit_code: Some(1),
        inputs: None,
        reads: None,
        historical: true,
        full_suite: true,
        notes: vec!["fixture".into()],
    }
}

fn spec(policy: Policy) -> InputSpec {
    InputSpec {
        kernel: "artifacts/kernel.wasm".into(),
        sysroots: vec!["sysroot".into()],
        projection: "artifacts/.kandelo/source-only-program-projection-v1.json".into(),
        program_index: "artifacts/program-packages.json".into(),
        extra_artifacts: vec![],
        policy,
        context: BTreeMap::new(),
        read_paths: vec!["host/src/runtime.ts".into()],
    }
}

fn verified() -> Evidence {
    let mut e = historical();
    e.capture_id = Some("synthetic-capture".into());
    e.historical = false;
    e.load_samples = vec![1.0, 2.0];
    e.versions = BTreeMap::from([
        ("node".into(), "v24.0.0".into()),
        ("os".into(), "test-os".into()),
    ]);
    let spec = spec(Policy::default());
    let components = BTreeMap::from([
        ("environment:node".into(), "v24.0.0".into()),
        ("environment:os".into(), "test-os".into()),
    ]);
    e.inputs = Some(Inputs {
        digest: sha(&serde_json::to_vec(&components).unwrap()),
        tree: "tree".into(),
        components,
        spec,
    });
    e.reads = Some(ReadSet {
        capture_id: "synthetic-capture".into(),
        suite: e.suite.clone(),
        host: e.host.clone(),
        command: e.command.clone(),
        method: "synthetic unit-test trace".into(),
        complete: true,
        trace_sha256: sha(b"trace"),
        paths: vec!["host/src/runtime.ts".into()],
    });
    e
}

#[test]
fn parses_real_vitest_failure_blocks_and_totals() {
    let p = parse::parse("vitest", "node", &fixture("vitest")).unwrap();
    assert_eq!(p.totals["pass"], 5291);
    assert_eq!(p.totals["fail"], 30);
    assert_eq!(p.totals["skip"], 21);
    assert!(p.tests.keys().all(|s| s.starts_with("scripts/")));
    assert!(
        p.tests
            .values()
            .all(|v| v.reason.contains("Error:") && v.attempts == 1)
    );
}

#[test]
fn parses_real_conformance_excerpts_without_accepting_mismatches() {
    let p = parse::parse("sortix", "node", &fixture("sortix-node")).unwrap();
    assert_eq!(p.totals["timeout"], 1357);
    assert_eq!(p.totals["fail"], 19);
    let mismatch = parse::parse("sortix", "node", &fixture("xfail-mismatch")).unwrap();
    assert!(
        mismatch.tests["basic/pthread/pthread_getcpuclockid"]
            .reason
            .contains("XFAIL-MISMATCH")
    );
    assert_eq!(
        mismatch.tests["basic/pthread/pthread_getcpuclockid"].outcome,
        "fail"
    );
    let text = "XFAIL-MISMATCH basic/pthread/getclock (expected to fail by output, failed by timeout: exit: 124)\n  FAIL basic/pthread/getclock\nPASS: 0\nFAIL: 1\nTOTAL: 1\n";
    let p = parse::parse("sortix", "node", text).unwrap();
    let v = &p.tests["basic/pthread/getclock"];
    assert_eq!(v.outcome, "fail");
    assert!(v.reason.contains("XFAIL-MISMATCH"));
    assert_eq!(v.attempts, 1);
    for (suite, name, pass) in [
        ("sortix", "sortix-chromium", 5028),
        ("posix", "posix-chromium", 173),
        ("libc", "libc-chromium", 306),
    ] {
        let p = parse::parse(suite, "chromium", &fixture(name)).unwrap();
        assert_eq!(p.totals["pass"], pass);
    }
}

#[test]
fn parses_real_runner_never_started_errors_and_deduplicates_summary() {
    let p = parse::parse("sortix", "chromium", &fixture("runner-error")).unwrap();
    assert_eq!(p.totals["error"], 3);
    assert_eq!(p.tests.len(), 3);
    for (id, v) in p.tests {
        assert!(!id.ends_with(':'));
        assert_eq!(v.outcome, "error");
        assert_eq!(v.attempts, 1);
        assert!(v.reason.contains("before reporting result"));
    }
}

#[test]
fn parses_real_playwright_skips_and_failure_totals() {
    let p = parse::parse("playwright", "webkit", &fixture("playwright-webkit")).unwrap();
    assert_eq!(p.totals["fail"], 21);
    assert_eq!(p.totals["skip"], 15);
    assert_eq!(p.totals["pass"], 19);
    assert!(p.tests.values().any(|v| v.outcome == "skip"));
    let p = parse::parse("playwright", "chromium", &fixture("playwright-chromium")).unwrap();
    assert_eq!(p.totals["fail"], 27);
}

#[test]
fn playwright_retry_pass_is_intermediate_evidence_never_plain_pass() {
    // The archived runs explicitly used retries=0. This synthetic extension
    // exercises the same list-reporter grammar without inventing history.
    let log = "  ✘  1 [chromium] › test/a.spec.ts:1:2 › flaky case (1s)\n  ✓  2 [chromium] › test/a.spec.ts:1:2 › flaky case (retry #1) (2s)\n  1 flaky\n";
    let p = parse::parse("playwright", "chromium", log).unwrap();
    assert_eq!(p.tests.len(), 1);
    let v = &p.tests["test/a.spec.ts > flaky case"];
    assert_eq!(v.outcome, "intermittent");
    assert_eq!(v.attempts, 2);
    assert_eq!(v.adverse, 1);
    assert!(parse::parse("playwright", "webkit", log).is_err());
}

#[test]
fn truncated_or_unrecognized_logs_cannot_be_recorded() {
    for text in ["", "PASS a/test", "Error: process died"] {
        assert!(parse::parse("sortix", "node", text).is_err());
    }
}

#[test]
fn vitest_verbose_output_names_passing_targets_and_preserves_retry_rates() {
    let text = " ✓ test/a.test.ts:12 > suite > passing target 2ms\n ✓ test/a.test.ts:15 > suite > flaky target 3ms (retry x2)\n ↓ test/a.test.ts:16 > suite > unselected\n      Tests  2 passed | 1 skipped (3)\n";
    let parsed = parse::parse("vitest", "node", text).unwrap();
    assert_eq!(
        parsed.tests["host/test/a.test.ts > suite > passing target"].outcome,
        "pass"
    );
    let flaky = &parsed.tests["host/test/a.test.ts > suite > flaky target"];
    assert_eq!(flaky.outcome, "intermittent");
    assert_eq!(flaky.attempts, 3);
    assert_eq!(flaky.adverse, 2);
    let mut evidence = verified();
    evidence.suite = "vitest".into();
    evidence.reads.as_mut().unwrap().suite = "vitest".into();
    let initial = model::Parsed {
        tests: BTreeMap::from([(
            "host/test/a.test.ts > suite > passing target".into(),
            Observation::new("fail", "initial failure"),
        )]),
        ..Default::default()
    };
    let mut baseline = Baseline::from_run(evidence.clone(), initial);
    evidence.capture_id = Some("rerun".into());
    evidence.reads.as_mut().unwrap().capture_id = "rerun".into();
    baseline.append(evidence, parsed).unwrap();
    assert_eq!(
        baseline.tests["host/test/a.test.ts > suite > passing target"].outcome,
        "intermittent"
    );
    assert!(
        !baseline
            .tests
            .contains_key("host/test/a.test.ts > suite > unselected")
    );
}

#[test]
fn vitest_multiple_summaries_sum_counts_without_counting_totals_twice() {
    let p = parse::parse(
        "vitest",
        "node",
        "      Tests  2 passed (2)\n      Tests  3 passed (3)\n",
    )
    .unwrap();
    assert_eq!(p.totals["pass"], 5);
    assert_eq!(p.totals["total"], 5);
}

#[test]
fn historical_or_busy_evidence_is_never_current_and_stale_never_classifies() {
    let e = historical();
    assert!(reliability(&e).unwrap().contains("historical"));
    let b = Baseline::from_run(
        e,
        parse::parse("sortix", "node", &fixture("sortix-node")).unwrap(),
    );
    assert!(freshness(Path::new("/not-a-worktree"), &b).is_err());
    let v = Observation::new("fail", "same");
    assert_eq!(
        classify(&b, "missing-test", &v, Some("stale")),
        "baseline-stale"
    );
    let mut e = verified();
    e.load_samples.push(60.0);
    assert!(reliability(&e).unwrap().contains("unreliable"));
    e.load_samples.clear();
    assert!(reliability(&e).is_some());
}

#[test]
fn targeted_rerun_retains_failure_and_observed_rate() {
    let e = verified();
    validate_evidence(&e).unwrap();
    let p = model::Parsed {
        tests: BTreeMap::from([("a".into(), Observation::new("fail", "error"))]),
        ..Default::default()
    };
    let mut b = Baseline::from_run(e.clone(), p);
    let p = model::Parsed {
        tests: BTreeMap::from([("a".into(), Observation::new("pass", "pass"))]),
        ..Default::default()
    };
    let mut rerun = e.clone();
    rerun.recorded_at = "later".into();
    rerun.capture_id = Some("later-capture".into());
    rerun.reads.as_mut().unwrap().capture_id = "later-capture".into();
    b.append(rerun.clone(), p).unwrap();
    assert!(b.append(rerun, model::Parsed::default()).is_err());
    assert_eq!(b.tests["a"].outcome, "intermittent");
    assert_eq!(b.tests["a"].attempts, 2);
    assert_eq!(b.tests["a"].adverse, 1);
    let mut other = e;
    other.inputs.as_mut().unwrap().digest = sha(b"different");
    assert!(b.append(other, model::Parsed::default()).is_err());
}

#[test]
fn sorted_inline_exception_rows_roundtrip_and_omit_plain_passes() {
    let p = model::Parsed {
        totals: BTreeMap::from([
            ("pass".into(), 9),
            ("total".into(), 10),
            ("fail".into(), 1),
            ("error".into(), 0),
        ]),
        tests: BTreeMap::from([
            (
                "z\"name".into(),
                Observation::new("fail", "quote \" and slash \\"),
            ),
            ("a".into(), Observation::new("pass", "pass")),
        ]),
        ..Default::default()
    };
    let summary = p.clone().anomalies();
    assert_eq!(summary.totals, BTreeMap::from([("fail".into(), 1)]));
    assert!(!summary.tests.contains_key("a"));
    let b = Baseline::from_run(historical(), p);
    let text = render(&b).unwrap();
    assert!(!text.contains("outcome = \"pass\""));
    let reread: Baseline = toml::from_str(&text).unwrap();
    assert_eq!(reread.tests, b.tests);
    assert_eq!(reread.totals, summary.totals);
}

#[test]
fn read_guard_rejects_new_excluded_reads_and_incomplete_or_misbound_traces() {
    let e = verified();
    let mut reads = e.reads.unwrap();
    let policy = Policy {
        exclude: vec!["README.md".into(), "docs/".into()],
    };
    check_reads("sortix", "node", &e.command, &policy, &reads).unwrap();
    reads.paths.push("docs/architecture.md".into());
    assert!(
        check_reads("sortix", "node", &e.command, &policy, &reads)
            .unwrap_err()
            .contains("excluded path")
    );
    reads.paths.pop();
    reads.complete = false;
    assert!(check_reads("sortix", "node", &e.command, &policy, &reads).is_err());
    reads.complete = true;
    assert!(check_reads("libc", "node", &e.command, &policy, &reads).is_err());
    assert!(inputs::relative("docs/../README.md").is_err());
    assert!(inputs::relative("docs//a").is_err());
}

fn commit(root: &Path) {
    git(root, &["add", "."]).unwrap();
    git(
        root,
        &[
            "-c",
            "user.name=Baseline test",
            "-c",
            "user.email=baseline@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ],
    )
    .unwrap();
}

#[test]
fn measured_exclusions_keep_readme_current_only_for_suites_that_do_not_read_it() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    git(root, &["init", "-q"]).unwrap();
    fs::create_dir_all(root.join("host/src")).unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("README.md"), "one").unwrap();
    fs::write(root.join("host/src/runtime.ts"), "one").unwrap();
    fs::write(root.join("docs/a.md"), "one").unwrap();
    commit(root);
    // These are synthetic read sets, not claims about real suite reads.
    let conformance = Policy {
        exclude: vec!["README.md".into(), "docs/".into()],
    };
    let vitest = Policy::default();
    let before_c = inputs::source_components(root, &conformance).unwrap();
    let before_v = inputs::source_components(root, &vitest).unwrap();
    fs::write(root.join("README.md"), "two").unwrap();
    commit(root);
    assert_eq!(
        before_c,
        inputs::source_components(root, &conformance).unwrap()
    );
    assert_ne!(before_v, inputs::source_components(root, &vitest).unwrap());
    let before_v = inputs::source_components(root, &vitest).unwrap();
    fs::write(root.join("docs/a.md"), "two").unwrap();
    commit(root);
    assert_eq!(
        before_c,
        inputs::source_components(root, &conformance).unwrap()
    );
    assert_ne!(before_v, inputs::source_components(root, &vitest).unwrap());
    fs::write(root.join("host/src/runtime.ts"), "two").unwrap();
    commit(root);
    assert_ne!(
        before_c,
        inputs::source_components(root, &conformance).unwrap()
    );
}

fn artifact_fixture(root: &Path) -> InputSpec {
    git(root, &["init", "-q"]).unwrap();
    fs::create_dir_all(root.join("host/src")).unwrap();
    fs::create_dir_all(root.join("artifacts/.kandelo")).unwrap();
    fs::create_dir_all(root.join("sysroot/lib")).unwrap();
    fs::write(root.join(".gitignore"), "artifacts/\nsysroot/\n").unwrap();
    fs::write(root.join("host/src/runtime.ts"), "original source").unwrap();
    fs::write(root.join("README.md"), "one").unwrap();
    fs::write(
        root.join("sysroot/.kandelo-musl.input-hash"),
        "fixture input stamp",
    )
    .unwrap();
    fs::write(root.join("sysroot/.kandelo-musl.outputs.json"), "{}").unwrap();
    fs::write(root.join("sysroot/lib/libc.a"), "fixture libc").unwrap();
    let wasm = crate::build_stamp::stamp_build_key(&wat::parse_str("(module)").unwrap(), &[1; 32])
        .unwrap();
    fs::write(root.join("artifacts/kernel.wasm"), &wasm).unwrap();
    let index =
        serde_json::json!({"format":"kandelo-program-packages-v2", "identities":{}, "packages":{}});
    let projection = serde_json::json!({
        "format":"kandelo-source-only-program-projection-v1", "projection": index,
        "graphAuthoritySha256":sha(b"graph"), "nodes":[{
            "node":{"kind":"package", "name":"kernel", "targetArch":"wasm32"},
            "manifestSha256":sha(b"manifest"),"cacheKeySha256":crate::util::hex(&[1;32]),"cacheReceiptSha256":sha(b"receipt"),
            "members":[{"sourceArtifact":"kernel.wasm","mirrorPath":"kernel.wasm","mode":420,"size":wasm.len(),"sha256":sha(&wasm)}]
        }]
    });
    write_json(&root.join("artifacts/program-packages.json"), &index).unwrap();
    write_json(
        &root.join("artifacts/.kandelo/source-only-program-projection-v1.json"),
        &projection,
    )
    .unwrap();
    commit(root);
    spec(Policy {
        exclude: vec!["README.md".into()],
    })
}

#[test]
fn complete_digest_tracks_artifact_bytes_environment_and_source_not_commit() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let spec = artifact_fixture(root);
    let versions = BTreeMap::from([
        ("node".into(), "v24.0.0".into()),
        ("os".into(), "test-os".into()),
    ]);
    let before = snapshot(root, &spec, &versions).unwrap();
    fs::write(root.join("README.md"), "readme-only change").unwrap();
    commit(root);
    let after = snapshot(root, &spec, &versions).unwrap();
    assert_eq!(before.digest, after.digest);
    assert_ne!(before.tree, after.tree);
    let mut environment = versions.clone();
    environment.insert("node".into(), "v25.0.0".into());
    assert_ne!(
        before.digest,
        snapshot(root, &spec, &environment).unwrap().digest
    );
    fs::write(
        root.join("sysroot/lib/libc.a"),
        "changed installed bytes, same stamp",
    )
    .unwrap();
    assert_ne!(
        before.digest,
        snapshot(root, &spec, &versions).unwrap().digest
    );
    fs::write(root.join("host/src/runtime.ts"), "changed read source").unwrap();
    assert!(
        snapshot(root, &spec, &versions)
            .unwrap_err()
            .contains("clean worktree")
    );
    commit(root);
    let changed = snapshot(root, &spec, &versions).unwrap();
    assert!(
        inputs::changed_paths(root, &before, &changed)
            .unwrap()
            .contains(&"host/src/runtime.ts".into())
    );
}

#[test]
fn corrupted_projected_members_fail_instead_of_reusing_receipts() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let spec = artifact_fixture(root);
    fs::write(
        root.join("artifacts/kernel.wasm"),
        crate::build_stamp::stamp_build_key(&wat::parse_str("(module)").unwrap(), &[2; 32])
            .unwrap(),
    )
    .unwrap();
    assert!(
        snapshot(root, &spec, &BTreeMap::new())
            .unwrap_err()
            .contains("differs from its build receipt")
    );
}

#[test]
fn classification_requires_same_reason_and_keeps_uncertainty_visible() {
    let mut b = Baseline::from_run(
        verified(),
        model::Parsed {
            tests: BTreeMap::from([("case".into(), Observation::new("fail", "reason A"))]),
            ..Default::default()
        },
    );
    assert_eq!(
        classify(&b, "case", &Observation::new("fail", "reason A"), None),
        "pre-existing"
    );
    assert_eq!(
        classify(&b, "case", &Observation::new("fail", "reason B"), None),
        "changed-outcome-or-reason"
    );
    assert!(
        classify(&b, "new case", &Observation::new("fail", "reason B"), None)
            .starts_with("absent-from-baseline")
    );
    b.warnings.push("unnamed cases".into());
    assert!(
        classify(&b, "new case", &Observation::new("fail", "reason B"), None)
            .starts_with("baseline-details-incomplete")
    );
    b.warnings.clear();
    b.evidence[0].full_suite = false;
    assert!(
        classify(&b, "new case", &Observation::new("fail", "reason B"), None)
            .starts_with("outside-recorded-scope")
    );
    b.tests.get_mut("case").unwrap().outcome = "intermittent".into();
    assert_eq!(
        classify(&b, "case", &Observation::new("fail", "reason A"), None),
        "baseline-intermittent"
    );
}

#[test]
fn missing_historical_case_names_cannot_invent_a_prior_passing_attempt() {
    let e = verified();
    let initial = model::Parsed {
        warnings: vec!["runner omitted case names".into()],
        ..Default::default()
    };
    let mut baseline = Baseline::from_run(e.clone(), initial);
    let mut rerun = e;
    rerun.capture_id = Some("new-target".into());
    rerun.reads.as_mut().unwrap().capture_id = "new-target".into();
    let parsed = model::Parsed {
        tests: BTreeMap::from([(
            "unnamed-before".into(),
            Observation::new("fail", "observed now"),
        )]),
        ..Default::default()
    };
    assert!(failed_results(&parsed));
    baseline.append(rerun, parsed).unwrap();
    assert_eq!(baseline.tests["unnamed-before"].outcome, "fail");
    assert_eq!(baseline.tests["unnamed-before"].attempts, 1);
}
