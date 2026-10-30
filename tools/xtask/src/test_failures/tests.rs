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
    ]})).unwrap();
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
    let parsed = parse("playwright", &report.to_string()).unwrap();
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
    assert!(parse("vitest", "{}").is_err());
    assert!(parse("playwright", "{broken").is_err());
    let parsed = parse(
        "vitest",
        r#"{"numTotalTests":0,"success":true,"testResults":[]}"#,
    )
    .unwrap();
    assert_eq!(parsed["cases"]["[runner]"]["outcome"], "error");
    let parsed = parse(
        "playwright",
        r#"{"suites":[],"errors":[],"stats":{"expected":0}}"#,
    )
    .unwrap();
    assert_eq!(parsed["cases"]["[runner]"]["outcome"], "error");
}
