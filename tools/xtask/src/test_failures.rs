//! Import failure evidence; runner exit status and expectations stay authoritative.
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

type Cases = BTreeMap<String, Value>;

fn add(out: &mut Cases, id: String, outcome: &str, reason: &str) -> Result<(), String> {
    if out.contains_key(&id) {
        return Err(format!(
            "duplicate case ID: {id}; keep the raw report or select distinct cases"
        ));
    }
    out.insert(
        id,
        json!({"outcome": outcome,
        "reason": reason.split_whitespace().collect::<Vec<_>>().join(" ")}),
    );
    Ok(())
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value[key]
        .as_array()
        .ok_or_else(|| format!("missing array: {key}"))
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing string: {key}"))
}

fn conformance(text: &str) -> Result<Value, String> {
    let ansi = Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap();
    let text = ansi.replace_all(text, "");
    let row = Regex::new(r"^(FAIL|XFAIL-MISMATCH|XFAIL|XPASS|SKIP|TIME|TIMEOUT|ERROR|BUILD|UNRES|UNRESOLVED|FLAKE-PASS|FLAKE-FAIL|FLAKE-TIME)\s+(\S+?)(?::\s+(.*)|\s+\((.*)\))?$").unwrap();
    let count =
        Regex::new(r"^(FAIL|XFAIL|XPASS|SKIP|TIMEOUT|ERROR|BUILD|UNRESOLVED|FLAKY):\s+(\d+)\s*$")
            .unwrap();
    let mut cases = Cases::new();
    let mut counts = BTreeMap::new();
    for line in text.lines() {
        // Grouped lists repeat the primary results with less detail.
        if let Some(c) = row.captures(line.trim_end()) {
            let outcome = match &c[1] {
                "FAIL" | "XFAIL-MISMATCH" | "FLAKE-FAIL" => "fail",
                "XFAIL" => "expected-fail",
                "XPASS" => "unexpected-pass",
                "SKIP" => "skip",
                "TIME" | "TIMEOUT" | "FLAKE-TIME" => "timeout",
                "FLAKE-PASS" => "known-flaky-pass",
                _ => "error",
            };
            add(&mut cases, c[2].into(), outcome, line)?;
            if c[1].starts_with("FLAKE-") {
                cases.get_mut(&c[2]).unwrap()["known_flaky"] = json!(true);
            }
        }
        if let Some(c) = count.captures(line.trim()) {
            let n: u64 = c[2].parse().map_err(|e| format!("invalid count: {e}"))?;
            if n > 0 {
                counts.insert(c[1].to_string(), n);
            }
        }
    }
    if !text.lines().any(|line| line.trim().starts_with("TOTAL:")) {
        return Err("no TOTAL summary; keep the incomplete raw log instead".into());
    }
    Ok(json!({"counts": counts, "cases": cases}))
}

fn vitest(report: &Value, root: &Path) -> Result<Value, String> {
    let total = report["numTotalTests"]
        .as_u64()
        .ok_or("missing numTotalTests")?;
    let mut out = Cases::new();
    for file in array(report, "testResults")? {
        let path = Path::new(string(file, "name")?);
        let name = if path.is_absolute() {
            path.strip_prefix(root)
                .map_err(|_| "file outside context.repo_root; supply the root used by this run")?
        } else {
            path
        }
        .to_string_lossy();
        for case in array(file, "assertionResults")? {
            let status = string(case, "status")?;
            if status == "passed" {
                continue;
            }
            let outcome = match status {
                "failed" => "fail",
                "skipped" | "pending" | "todo" | "disabled" => "skip",
                _ => return Err(format!("unknown Vitest status: {status}")),
            };
            let reason = case["failureMessages"]
                .as_array()
                .and_then(|v| v.first())
                .and_then(Value::as_str)
                .unwrap_or(status);
            add(
                &mut out,
                format!("{name} > {}", string(case, "fullName")?),
                outcome,
                reason,
            )?;
        }
        // Import/collection errors can fail a file without failing a named test.
        if file["status"] == "failed" && file["message"].as_str().is_some_and(|s| !s.is_empty()) {
            add(
                &mut out,
                format!("{name} > [file error]"),
                "error",
                string(file, "message")?,
            )?;
        }
    }
    if total == 0 || report["success"] == false && out.is_empty() {
        add(
            &mut out,
            "[runner]".into(),
            "error",
            "run unsuccessful or collected zero tests; inspect raw log",
        )?;
    }
    Ok(json!({"cases": out}))
}

fn playwright_suites(suites: &[Value], parents: &[String], out: &mut Cases) -> Result<(), String> {
    for suite in suites {
        let mut titles = parents.to_vec();
        titles.push(string(suite, "title")?.into());
        for spec in array(suite, "specs")? {
            for test in array(spec, "tests")? {
                let status = string(test, "status")?;
                let expected = string(test, "expectedStatus")?;
                if status == "expected" && expected == "passed" {
                    continue;
                }
                let results = array(test, "results")?;
                let observed: Vec<_> = results
                    .iter()
                    .map(|r| string(r, "status"))
                    .collect::<Result<_, _>>()?;
                let outcome = match status {
                    "expected" => "expected-fail",
                    "flaky" => "intermittent",
                    "skipped" => "skip",
                    "unexpected" if observed.last() == Some(&"passed") => "unexpected-pass",
                    "unexpected" if observed.last() == Some(&"timedOut") => "timeout",
                    "unexpected"
                        if observed.is_empty() || observed.last() == Some(&"interrupted") =>
                    {
                        "error"
                    }
                    "unexpected" => "fail",
                    _ => return Err(format!("unknown Playwright status: {status}")),
                };
                let id = format!(
                    "[{}] {} > {} > {}",
                    string(test, "projectName")?,
                    string(spec, "file")?,
                    titles.join(" > "),
                    string(spec, "title")?
                );
                let reason = results
                    .iter()
                    .find_map(|r| {
                        r["error"]["message"]
                            .as_str()
                            .or_else(|| r["errors"][0]["message"].as_str())
                    })
                    .unwrap_or(status);
                add(out, id.clone(), outcome, reason)?;
                out.get_mut(&id).unwrap()["observed"] = json!(observed);
            }
        }
        if let Some(children) = suite.get("suites") {
            playwright_suites(
                children.as_array().ok_or("invalid suites array")?,
                &titles,
                out,
            )?;
        }
    }
    Ok(())
}

fn parse(format: &str, text: &str, root: &Path) -> Result<Value, String> {
    if format == "conformance" {
        return conformance(text);
    }
    let report: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    match format {
        "vitest" => vitest(&report, root),
        "playwright" => {
            let expected = report["stats"]["expected"]
                .as_u64()
                .ok_or("missing stats.expected")?;
            let mut out = Cases::new();
            playwright_suites(array(&report, "suites")?, &[], &mut out)?;
            for (i, error) in array(&report, "errors")?.iter().enumerate() {
                add(
                    &mut out,
                    format!("[runner error {i}]"),
                    "error",
                    string(error, "message")?,
                )?;
            }
            if expected == 0 && out.is_empty() {
                add(
                    &mut out,
                    "[runner]".into(),
                    "error",
                    "zero-test report; inspect raw log",
                )?;
            }
            Ok(json!({"cases": out}))
        }
        _ => Err("format must be conformance, vitest, or playwright".into()),
    }
}

fn recorded(format: &str, text: &str, context: Value) -> Result<Value, String> {
    let exit = context["exit_code"]
        .as_i64()
        .ok_or("context.exit_code must record the runner exit status")?;
    let default_root = crate::repo_root();
    let root = context["repo_root"]
        .as_str()
        .map(Path::new)
        .unwrap_or(&default_root);
    let mut result = parse(format, text, root)?;
    // JSON reporters can omit unhandled errors even when assertions passed.
    if exit != 0 {
        result["cases"]["[runner exit]"] = json!({"outcome":"error",
            "reason": format!("runner exited {exit}; inspect the console log for errors omitted by the reporter")});
    }
    result["context"] = context;
    Ok(result)
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    if args.len() != 3 {
        return Err(
            "usage: xtask test-failures <conformance|vitest|playwright> <report> <context.json>"
                .into(),
        );
    }
    let raw = fs::read(&args[1]).map_err(|e| e.to_string())?;
    let context: Value = serde_json::from_slice(&fs::read(&args[2]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !context.is_object() {
        return Err("context must be a JSON object".into());
    }
    let mut result = recorded(
        &args[0],
        std::str::from_utf8(&raw).map_err(|e| e.to_string())?,
        context,
    )?;
    result["source_sha256"] = json!(format!("{:x}", Sha256::digest(&raw)));
    // One sorted case per line keeps generated JSON reviewable in Git.
    let cases = result.as_object_mut().unwrap().remove("cases").unwrap();
    let header = serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?;
    print!(
        "{},\n  \"cases\": {{",
        header.trim_end_matches('}').trim_end()
    );
    for (i, (id, case)) in cases.as_object().unwrap().iter().enumerate() {
        if i > 0 {
            print!(",");
        }
        print!("\n    {}: {}", json!(id), case);
    }
    println!("\n  }}\n}}");
    Ok(())
}

#[cfg(test)]
mod tests;
