#!/usr/bin/env python3
"""Summarize complete, matched three-control cohorts; retain launch variation."""
import hashlib
import json
import math
from pathlib import Path
import statistics as stats
import sys

node, browser, output = map(Path, sys.argv[1:4])
rows = []
for run in json.loads((node / "runs.json").read_text()):
    if run["exit"] != 0:
        raise SystemExit("failed Node child")
    retained = node / Path(run["output"]).name / "result.json"
    result = json.loads((retained if retained.exists() else Path(run["output"]) / "result.json").read_text())
    rows.append({**run, "host": "node", "run": result, "version": result["runtime"]})
for path in sorted(browser.glob("*.json")):
    result = json.loads(path.read_text())
    rows.append({**result, "host": path.name.split("-")[0]})
if len(rows) != 32:
    raise SystemExit(f"expected 32 controls, got {len(rows)}")
files = set()
artifacts = {}
for row in rows:
    run = row["run"]
    trial = run["trial"]
    if not trial["passed"] or not run["destroyed"] or run.get("error") or trial.get("error") or run["stderr"] or run["diagnostics"]:
        raise SystemExit("failed control: " + str(row))
    if trial["serverExit"] != 0 or trial["rounds"] != 7 or trial["warmup"] != 64:
        raise SystemExit("incomplete or mismatched control")
    if row["host"] == "node" and run["flags"]:
        raise SystemExit("unexpected engine flags")
    if row["host"] != "node" and (row["pageErrors"] or not run["crossOriginIsolated"]):
        raise SystemExit("browser boundary failure")
    if len(trial["samples"]) != 436 or len(trial["throughput"]) != 14:
        raise SystemExit("missing workload samples")
    files.add(json.dumps(trial["files"], sort_keys=True))
    artifacts.setdefault("native" if row["label"] == "native-file" else "virtual", set()).add(trial["artifactSha256"])
if len(files) != 1 or any(len(values) != 1 for values in artifacts.values()):
    raise SystemExit("source or artifact identity mismatch")

def median(row, workload, metric="elapsedMs"):
    return stats.median(s[metric] for s in row["run"]["trial"]["samples"] if s["phase"] == "warm" and s["workload"] == workload)

def summary(values):
    return {"geomean": stats.geometric_mean(values), "min": min(values), "max": max(values), "values": values}

report = {"schema": 1, "scope": "diagnostic PHP-FPM workloads; 2 fresh-parent cohorts; native brackets each VM pair; default engine settings", "trials": len(rows), "samples": sum(len(r["run"]["trial"]["samples"]) for r in rows), "artifacts": {k: next(iter(v)) for k, v in artifacts.items()}, "workloadDigest": hashlib.sha256(next(iter(files)).encode()).hexdigest(), "hosts": {}}
for host in ["node", "chromium", "firefox", "webkit"]:
    selected = [r for r in rows if r["host"] == host]
    if len(selected) != 8:
        raise SystemExit("host inventory mismatch")
    h = {"versions": sorted({r["version"] for r in selected}), "workloads": {}, "modes": {}}
    for label in ["native-file", "vm-file", "vm-shared"]:
        modes = [r["run"]["trial"] for r in selected if r["label"] == label]
        h["modes"][label] = {
            "listenerReadyMs": summary([t["listenerReadyMs"] for t in modes]),
            "firstRequestMs": summary([t["samples"][0]["elapsedMs"] for t in modes]),
            "firstWorkloads": [t["samples"][0]["workload"] for t in modes],
            "memory": [t["memory"] for t in modes],
            "kernelPages": [t["kernelPages"] for t in modes],
            "observedClockCallIntervalNs": [t["meta"]["clock_min_ns"] for t in modes],
        }
    for workload in ["empty", "compute", "includes"]:
        w = {}
        for label in ["native-file", "vm-file", "vm-shared"]:
            matching = [r for r in selected if r["label"] == label]
            w[label] = {metric: summary([median(r, workload, metric) for r in matching]) for metric in ["elapsedMs", "guest_ms"]}
            if workload != "empty":
                w[label]["requestsPerSecond"] = summary([stats.median(t["requestsPerSecond"] for t in r["run"]["trial"]["throughput"] if t["workload"] == workload) for r in matching])
        for label in ["vm-file", "vm-shared"]:
            for metric in ["elapsedMs", "guest_ms"]:
                ratios, envelope, drift = [], [], []
                for cohort in [0, 1]:
                    cohort_rows = [r for r in selected if r["cohort"] == cohort]
                    baseline = [median(r, workload, metric) for r in cohort_rows if r["label"] == "native-file"]
                    candidate = median(next(r for r in cohort_rows if r["label"] == label), workload, metric)
                    ratios.append(candidate / stats.geometric_mean(baseline))
                    envelope.extend(candidate / b for b in baseline)
                    drift.append(max(baseline) / min(baseline))
                w[label][metric]["relativeToNative"] = summary(ratios)
                w[label][metric]["baselineBracketEnvelope"] = {"min": min(envelope), "max": max(envelope)}
                w[label][metric]["baselineDrift"] = drift
        h["workloads"][workload] = w
    report["hosts"][host] = h
output.write_text(json.dumps(report, indent=2) + "\n")
for host, h in report["hosts"].items():
    print(host)
    for name, w in h["workloads"].items():
        print(" ", name, "ms", *[f'{label}={w[label]["elapsedMs"]["geomean"]:.3f}' for label in ["native-file", "vm-file", "vm-shared"]])
        if name != "empty":
            for label in ["vm-file", "vm-shared"]:
                m = w[label]["elapsedMs"]
                e = m["baselineBracketEnvelope"]
                print(f'    {label}: {m["relativeToNative"]["geomean"]:.2f}x; baseline-bracket envelope {e["min"]:.2f}–{e["max"]:.2f}x')
