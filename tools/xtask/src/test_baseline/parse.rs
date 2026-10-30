//! Parse the runners as they are. Do not change their verdicts or exit codes.
use super::model::{Observation, Parsed};
use regex::Regex;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex")
}

pub fn clean(text: &str) -> String {
    re(r"\x1b\[[0-9;?]*[A-Za-z]")
        .replace_all(text, "")
        .replace('\r', "")
}

pub fn parse(suite: &str, host: &str, text: &str) -> Result<Parsed, String> {
    let text = clean(text);
    let mut result = match suite {
        "libc" | "posix" | "sortix" => conformance(&text),
        "vitest" if host == "node" => vitest(&text),
        "playwright" if host != "node" => playwright(host, &text),
        _ => return Err(format!("unsupported suite/host: {suite}/{host}")),
    }?;
    if result.totals.is_empty() {
        return Err("no completed runner summary found; retain the log, but do not record an incomplete run".into());
    }
    for outcome in [
        "fail",
        "expected-fail",
        "unexpected-pass",
        "skip",
        "timeout",
        "error",
    ] {
        let reported = result.totals.get(outcome).copied().unwrap_or(0);
        let named = result
            .tests
            .values()
            .filter(|v| {
                v.outcome == outcome
                    || (outcome == "fail"
                        && matches!(suite, "vitest" | "playwright")
                        && v.outcome == "timeout")
            })
            .count() as u64;
        if reported > named {
            result.warnings.push(format!("runner reports {reported} {outcome}, but names only {named}; unnamed cases cannot be reconstructed from this log"));
        }
    }
    Ok(result)
}

fn outcome(label: &str) -> &'static str {
    match label {
        "PASS" => "pass",
        "FAIL" | "XFAIL-MISMATCH" => "fail",
        "XFAIL" => "expected-fail",
        "XPASS" => "unexpected-pass",
        "SKIP" => "skip",
        "TIME" | "TIMEOUT" => "timeout",
        "FLAKE-PASS" | "FLAKE-FAIL" | "FLAKE-TIME" => "intermittent",
        _ => "error",
    }
}

fn conformance(text: &str) -> Result<Parsed, String> {
    let mut out = Parsed::default();
    let row = re(
        r"^(PASS|FAIL|XFAIL-MISMATCH|XFAIL|XPASS|SKIP|TIME|TIMEOUT|ERROR|BUILD|UNRES|UNRESOLVED|FLAKE-PASS|FLAKE-FAIL|FLAKE-TIME)\s+(\S+?)(?::\s+(.*)|\s+\((.*)\))?$",
    );
    let total = re(
        r"^(PASS|FAIL|XFAIL|XPASS|SKIP|TIMEOUT|ERROR|BUILD|UNRESOLVED|TOTAL|FLAKY):\s+(\d+)\s*$",
    );
    for line in text.lines() {
        if let Some(c) = total.captures(line.trim()) {
            let key = match &c[1] {
                "TOTAL" => "total",
                "FLAKY" => "intermittent",
                s => outcome(s),
            };
            // BUILD/UNRESOLVED/ERROR are distinct runner counters, one outcome.
            let n = c[2].parse::<u64>().map_err(|e| e.to_string())?;
            if key == "error" {
                *out.totals.entry(key.into()).or_default() += n;
            } else {
                out.totals.insert(key.into(), n);
            }
            continue;
        }
        if let Some(c) = row.captures(line.trim()) {
            let id = c[2].to_string();
            let label = &c[1];
            let detail = c
                .get(3)
                .or_else(|| c.get(4))
                .map(|m| m.as_str())
                .unwrap_or("");
            let reason = if label == "XFAIL-MISMATCH" {
                format!("XFAIL-MISMATCH: {detail}")
            } else if label == "XFAIL" {
                format!(
                    "observed XFAIL ({detail}); expectations remain owned by the runner at the recorded commit"
                )
            } else if detail.is_empty() {
                format!("runner reported {label}; no further reason in log")
            } else {
                format!("{label}: {detail}")
            };
            let mut observation = Observation::new(outcome(label), &reason);
            if label == "FLAKE-PASS" {
                observation.adverse = 0;
            }
            // Final grouped results repeat earlier lines with less detail.
            // A mismatch is still a failure, never an accepted XFAIL.
            if !out.tests.contains_key(&id) || label == "XFAIL-MISMATCH" {
                out.tests.insert(id, observation);
            }
        }
    }
    Ok(out)
}

fn vitest_path(path: &str) -> String {
    if let Some(path) = path.strip_prefix("../") {
        path.to_string()
    } else if path.starts_with("test/") {
        format!("host/{path}")
    } else {
        path.to_string()
    }
}

fn vitest(text: &str) -> Result<Parsed, String> {
    let mut out = Parsed::default();
    let fail = re(r"^\s*FAIL\s+(\S+)(.*)$");
    let counts = re(r"(\d+) (failed|passed|skipped|todo)");
    let summary = re(r"^\s*Tests\s+(.+)$");
    let file = re(r"^\s*[✓❯↓]\s+(\S+\.(?:ts|tsx|js|mjs))\s+\((\d+) tests?(?:\s*\|[^)]*)?\)");
    let skipped = re(r"(\d+) skipped");
    let verbose = re(r"^\s*([✓×↓□])\s+(\S+\.(?:ts|tsx|js|mjs))(?::\d+)? > (.+)$");
    let suffix = re(
        r"(?:\s+\d+(?:\.\d+)?ms)?(?:\s+\(retry x\d+\))?(?:\s+\(repeat x\d+\))?(?:\s+\[[^]]+\])?$",
    );
    let retry = re(r"\(retry x(\d+)\)");
    let lines: Vec<_> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = summary.captures(line) {
            for c in counts.captures_iter(&c[1]) {
                let key = match &c[2] {
                    "failed" => "fail",
                    "passed" => "pass",
                    _ => "skip",
                };
                *out.totals.entry(key.into()).or_default() +=
                    c[1].parse::<u64>().map_err(|e| e.to_string())?;
            }
        }
        if let Some(c) = verbose.captures(line) {
            let title = suffix.replace(&c[3], "").trim().to_string();
            let id = format!("{} > {title}", vitest_path(&c[2]));
            let kind = match &c[1] {
                "✓" => "pass",
                "×" => "fail",
                _ => "skip",
            };
            let mut value = Observation::new(kind, &format!("Vitest verbose reporter: {kind}"));
            if let Some(n) = retry.captures(&c[3]) {
                let count: u64 = n[1]
                    .parse()
                    .map_err(|e| format!("invalid retry count: {e}"))?;
                value.attempts = count + 1;
                value.adverse = count + u64::from(kind == "fail");
                if kind == "pass" {
                    value.outcome = "intermittent".into();
                }
                value.reason = format!(
                    "{} adverse / {} attempts; final outcome {kind}",
                    value.adverse, value.attempts
                );
            }
            if let Some(previous) = out.tests.get_mut(&id) {
                if previous.outcome == "skip" {
                    *previous = value;
                } else if value.outcome != "skip" {
                    previous.merge(&value);
                }
            } else {
                out.tests.insert(id, value);
            }
        }
        if let Some(c) = fail.captures(line) {
            let path = vitest_path(&c[1]);
            let title = c[2].trim();
            let id = if title.is_empty() {
                path
            } else {
                format!("{path} {title}")
            };
            let reason = lines[i + 1..]
                .iter()
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .unwrap_or("no failure detail");
            let kind = if title.is_empty() {
                "error"
            } else if reason.contains("timed out") {
                "timeout"
            } else {
                "fail"
            };
            if let Some(previous) = out.tests.get_mut(&id) {
                previous.reason = reason.into();
                if previous.outcome != "intermittent" {
                    previous.outcome = kind.into();
                }
            } else {
                out.tests.insert(id, Observation::new(kind, reason));
            }
        }
        if let Some(c) = file.captures(line) {
            if let Some(n) = skipped.captures(line) {
                out.warnings.push(format!(
                    "{}: {} skipped test(s); default reporter may omit their titles",
                    vitest_path(&c[1]),
                    &n[1]
                ));
            }
        }
    }
    if !out.totals.is_empty() {
        let n = out.totals.values().sum();
        out.totals.insert("total".into(), n);
    }
    // Vitest counts timeouts as failures. Keep that runner total; observations
    // retain the more useful timeout outcome without changing its verdict.
    Ok(out)
}

fn playwright(host: &str, text: &str) -> Result<Parsed, String> {
    let mut out = Parsed::default();
    let row = re(
        r"^\s*([✓✘×±-])\s+\d+\s+\[([^]]+)\]\s+›\s+(.+?):\d+:\d+\s+›\s+(.+?)(?:\s+\(retry #\d+\))?(?:\s+\([\d.]+(?:ms|s|m|h)\))?\s*$",
    );
    let total = re(r"^\s+(\d+) (passed|failed|skipped|flaky|interrupted|did not run)(?:\s|$)");
    let block = re(r"^\s*\d+\) \[([^]]+)\] › (.+?):\d+:\d+ › (.+?)\s*[─]*\s*$");
    let lines: Vec<_> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = total.captures(line) {
            let key = match &c[2] {
                "passed" => "pass",
                "failed" => "fail",
                "skipped" | "did not run" => "skip",
                "flaky" => "intermittent",
                _ => "error",
            };
            *out.totals.entry(key.into()).or_default() +=
                c[1].parse::<u64>().map_err(|e| e.to_string())?;
        }
        if let Some(c) = row.captures(line) {
            if &c[2] != host {
                return Err(format!("log contains project {}, expected {host}", &c[2]));
            }
            let id = format!("{} > {}", &c[3], &c[4]);
            let kind = match &c[1] {
                "✓" => "pass",
                "-" => "skip",
                _ => "fail",
            };
            let value = Observation::new(kind, &format!("Playwright list reporter: {kind}"));
            if let Some(previous) = out.tests.get_mut(&id) {
                previous.merge(&value);
            } else {
                out.tests.insert(id, value);
            }
        }
        if let Some(c) = block.captures(line) {
            if &c[1] != host {
                return Err("failure block belongs to another browser".into());
            }
            let id = format!("{} > {}", &c[2], c[3].trim_end_matches('─').trim());
            if let Some(v) = out.tests.get_mut(&id) {
                let reason = lines[i + 1..]
                    .iter()
                    .map(|s| s.trim())
                    .take_while(|s| !s.starts_with("Retry #") && !block.is_match(s))
                    .find(|s| {
                        s.contains("Error:") || s.contains("Timeout") || s.contains("timeout")
                    });
                if let Some(reason) = reason {
                    v.reason = reason.into();
                    if v.outcome == "fail"
                        && (reason.contains("Timeout") || reason.contains("timeout"))
                    {
                        v.outcome = "timeout".into();
                    }
                }
            }
        }
    }
    let n = out.totals.values().sum();
    if n > 0 {
        out.totals.insert("total".into(), n);
    }
    Ok(out)
}
