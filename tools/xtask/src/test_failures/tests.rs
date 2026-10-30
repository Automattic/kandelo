use super::*;

#[test]
fn real_conformance_excerpts_preserve_mismatches_and_incident_counts() {
    // TOTAL lines are from the same archived logs; excerpts omit success counters.
    let node = conformance(&format!(
        "{}\nTOTAL: 5121\n",
        include_str!("../../../../tests/baselines/sortix-node.log")
    ))
    .unwrap();
    assert_eq!(node["counts"]["TIMEOUT"], 1357);
    let mismatch = &node["cases"]["basic/pthread/pthread_getcpuclockid"];
    assert_eq!(mismatch["outcome"], "fail");
    assert!(
        mismatch["reason"]
            .as_str()
            .unwrap()
            .starts_with("XFAIL-MISMATCH")
    );
    let browser = conformance(&format!(
        "{}\nTOTAL: 5121\n",
        include_str!("../../../../tests/baselines/sortix-chromium.log")
    ))
    .unwrap();
    assert_eq!(browser["counts"]["FAIL"], 21);
    assert_eq!(browser["counts"]["XPASS"], 9);
    assert_eq!(browser["cases"].as_object().unwrap().len(), 32);
    assert!(browser["counts"].get("PASS").is_none());
}

#[test]
fn runner_errors_and_repeated_grouped_lines() {
    // Real lines from archived runs/port-pinned.log, not guest failures.
    let report = conformance("ERROR malloc/malloc-0: browser runner exited with status 1 before reporting result\n  ERROR malloc/malloc-0\nERROR: 1\nTOTAL: 1\n").unwrap();
    assert_eq!(report["cases"].as_object().unwrap().len(), 1);
    assert_eq!(report["cases"]["malloc/malloc-0"]["outcome"], "error");
    assert!(conformance("FAIL foo (exit 1)").is_err());
}

// Synthetic JSON exercises reporter schemas, not claimed historical runs.
#[test]
fn vitest_json_omits_passes_and_keeps_file_errors_and_skips() {
    let result = vitest(&json!({"numTotalTests":3,"success":false,"testResults":[
        {"name":"test/example.test.ts","status":"failed","message":"", "assertionResults":[
            {"fullName":"plain pass","status":"passed","failureMessages":[]},
            {"fullName":"failure","status":"failed","failureMessages":["AssertionError: expected 2\nstack"]},
            {"fullName":"skipped case","status":"pending","failureMessages":[]}
        ]},
        {"name":"test/unloaded.test.ts","status":"failed","message":"import failed","assertionResults":[]}
    ]}), Path::new("/repo")).unwrap();
    let cases = result["cases"].as_object().unwrap();
    assert_eq!(cases.len(), 3);
    assert_eq!(cases["test/example.test.ts > failure"]["outcome"], "fail");
    assert_eq!(
        cases["test/example.test.ts > skipped case"]["outcome"],
        "skip"
    );
    assert_eq!(
        cases["test/unloaded.test.ts > [file error]"]["outcome"],
        "error"
    );
}

#[test]
fn playwright_json_preserves_projects_nested_titles_and_retry_observations() {
    let test = |status: &str, expected: &str, observed: &[&str]| {
        json!({
            "projectName":"webkit", "status":status, "expectedStatus":expected,
            "results":observed.iter().map(|s| json!({"status":s,"error":{"message":"test detail"}})).collect::<Vec<_>>()
        })
    };
    let report = json!({"errors":[{"message":"worker crashed"}], "stats":{"expected":1}, "suites":[{
        "title":"file", "specs":[], "suites":[{"title":"nested", "specs":[
            {"file":"test/a.spec.ts","title":"case","tests":[
                test("expected","passed", &["passed"]),
                test("flaky","passed", &["failed","passed"])
            ]},
            {"file":"test/a.spec.ts","title":"skip","tests":[test("skipped","passed", &["skipped"])]},
            {"file":"test/a.spec.ts","title":"xfail","tests":[test("expected","failed", &["failed"])]},
            {"file":"test/a.spec.ts","title":"xpass","tests":[test("unexpected","failed", &["passed"])]}
        ]}]
    }]});
    let parsed = parse("playwright", &report.to_string(), Path::new("/repo")).unwrap();
    let cases = parsed["cases"].as_object().unwrap();
    assert_eq!(cases.len(), 5);
    let case = &cases["[webkit] test/a.spec.ts > file > nested > case"];
    assert_eq!(case["outcome"], "intermittent");
    assert_eq!(case["observed"], json!(["failed", "passed"]));
    assert_eq!(
        cases["[webkit] test/a.spec.ts > file > nested > xpass"]["outcome"],
        "unexpected-pass"
    );
    assert_eq!(
        cases["[webkit] test/a.spec.ts > file > nested > xfail"]["outcome"],
        "expected-fail"
    );
    assert_eq!(cases["[runner error 0]"]["outcome"], "error");
}

#[test]
fn malformed_and_zero_test_reports_do_not_look_clean() {
    assert!(parse("vitest", "{}", Path::new("/repo")).is_err());
    assert!(parse("playwright", "{broken", Path::new("/repo")).is_err());
    let parsed = parse(
        "vitest",
        r#"{"numTotalTests":0,"success":true,"testResults":[]}"#,
        Path::new("/repo"),
    )
    .unwrap();
    assert_eq!(parsed["cases"]["[runner]"]["outcome"], "error");
    let parsed = parse(
        "playwright",
        r#"{"suites":[],"errors":[],"stats":{"expected":0}}"#,
        Path::new("/repo"),
    )
    .unwrap();
    assert_eq!(parsed["cases"]["[runner]"]["outcome"], "error");
}

#[test]
fn runner_exit_is_retained_when_vitest_json_claims_success() {
    let source = r#"{"numTotalTests":1,"success":true,"testResults":[{"name":"a.test.ts","assertionResults":[{"status":"passed","fullName":"passes"}]}]}"#;
    let result = recorded("vitest", source, json!({"exit_code":1})).unwrap();
    assert_eq!(result["cases"]["[runner exit]"]["outcome"], "error");
    assert!(recorded("vitest", source, json!({})).is_err());
    assert!(
        recorded("vitest", source, json!({"exit_code":0})).unwrap()["cases"]
            .as_object()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn absolute_vitest_names_are_relative_to_the_recorded_worktree() {
    let source = |root: &str| {
        json!({"numTotalTests":1,"success":false,"testResults":[{
            "name":format!("{root}/host/test/a.test.ts"),"assertionResults":[
                {"status":"failed","fullName":"fails","failureMessages":["same defect"]}
            ]
        }]})
        .to_string()
    };
    let main = recorded(
        "vitest",
        &source("/main"),
        json!({"exit_code":1,"repo_root":"/main"}),
    )
    .unwrap();
    let branch = recorded(
        "vitest",
        &source("/pr"),
        json!({"exit_code":1,"repo_root":"/pr"}),
    )
    .unwrap();
    assert_eq!(main["cases"], branch["cases"]);
    assert_eq!(
        main["cases"]["host/test/a.test.ts > fails"]["outcome"],
        "fail"
    );
    assert!(
        recorded(
            "vitest",
            &source("/main"),
            json!({"exit_code":1,"repo_root":"/pr"})
        )
        .is_err()
    );
}

#[test]
fn duplicate_nonpassing_json_ids_are_rejected_instead_of_losing_evidence() {
    let case = json!({"status":"failed","fullName":"same name","failureMessages":["failure"]});
    let source = json!({"numTotalTests":2,"testResults":[{"name":"a.test.ts","assertionResults":[case.clone(),case]}]});
    assert!(
        vitest(&source, Path::new("/repo"))
            .unwrap_err()
            .contains("duplicate case ID")
    );
    let test = |status: &str| {
        json!({"projectName":"webkit","expectedStatus":"passed","status":status,
        "results":[{"status":if status=="skipped" {"skipped"} else {"failed"}}]})
    };
    let source = json!({"stats":{"expected":0},"errors":[],"suites":[{"title":"a.spec.ts","specs":[{
        "title":"repeat","file":"a.spec.ts","tests":[test("skipped"),test("unexpected")]
    }]}]});
    assert!(
        parse("playwright", &source.to_string(), Path::new("/repo"))
            .unwrap_err()
            .contains("duplicate case ID")
    );
}

#[test]
fn flaky_annotations_do_not_invent_mixed_observations() {
    let result = conformance("FLAKE-TIME regression/a (timeout 30s)\nFLAKE-FAIL regression/b (exit 1)\nFLAKE-PASS regression/c\nFLAKY: 3\nTOTAL: 3\n").unwrap();
    for (id, outcome) in [("a", "timeout"), ("b", "fail"), ("c", "known-flaky-pass")] {
        let case = &result["cases"][format!("regression/{id}")];
        assert_eq!(case["outcome"], outcome);
        assert_eq!(case["known_flaky"], true);
    }
}
