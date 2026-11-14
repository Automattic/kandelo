#!/usr/bin/env python3
"""Retain every round; mark unstable comparisons instead of silently pruning."""
import json
from pathlib import Path
from statistics import median
import sys

root = Path(sys.argv[1])
paths = [root / f"optimization-{host}-{cohort}.json"
         for host in ["node", "chromium", "firefox", "webkit"] for cohort in [1, 2]]
if not all(p.exists() for p in paths):
    print("Correctness-only run; full optimization timing cohorts are not present.")
    raise SystemExit(0)
records = {host: [json.loads((root / f"optimization-{host}-{cohort}.json").read_text()) for cohort in [1, 2]]
           for host in ["node", "chromium", "firefox", "webkit"]}
summary = {"scope": "trusted freestanding C mechanism fixtures; manually expressed transforms, no general compiler pass or PHP performance claim",
           "reference": "matched native uses the same compiler profile and scalar/SIMD operation; scalar anchor always uses O2 native scalar",
           "qualityRule": "each cohort >=4/7 native brackets within25%, samples>=2ms; cohort median ratios agree within20%; keep all raw samples",
           "hosts": {}}
for host, cohorts in records.items():
    assert all(len(c["correctness"]["scalarGroups"]) == 35 and c["correctness"]["oracleOperations"] == 210000 for c in cohorts)
    cases = []
    for index, case in enumerate(cohorts[0]["benchmark"]["results"]):
        other = cohorts[1]["benchmark"]["results"][index]
        assert (case["op"], case["size"], case["layout"]) == (other["op"], other["size"], other["layout"])
        rows = []
        for row in case["rows"]:
            pair = next(r for r in other["rows"] if r["id"] == row["id"])
            samples = row["samples"] + pair["samples"]
            medians = [row["medianRatioMatched"], pair["medianRatioMatched"]]
            agreement = max(medians) / min(medians)
            repeatable = min(row["stableBrackets"], pair["stableBrackets"]) >= 4 and agreement <= 1.2
            rows.append({"id": row["id"], "profile": row["profile"], "operation": row["operation"],
                         "nativeReference": row["nativeReference"],
                         "ratioMatched": median(s["ratioMatched"] for s in samples),
                         "ratioScalar": median(s["ratioScalar"] for s in samples),
                         "nsPerOp": median(s["sample"]["nsPerOp"] for s in samples),
                         "matchedNativeNsPerOp": median((s["matchedBefore"]["nsPerOp"] + s["matchedAfter"]["nsPerOp"]) / 2 for s in samples),
                         "ratioRange": [min(s["ratioMatched"] for s in samples), max(s["ratioMatched"] for s in samples)],
                         "stableBrackets": [row["stableBrackets"], pair["stableBrackets"]],
                         "stableScalarBrackets": [sum(s["stableScalarBracket"] for s in r["samples"]) for r in [row, pair]],
                         "cohortMedians": medians, "cohortAgreement": agreement, "repeatable": repeatable})
        cases.append({"op": case["op"], "size": case["size"], "layout": case["layout"], "rows": rows})
    summary["hosts"][host] = {"versions": [c.get("browserVersion", c["host"].get("node")) for c in cohorts],
                               "cases": cases}
(root / "optimization-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
lines = ["# Individual and combined common-memory optimizations", "",
         "Ratios below use matched untranslated native Wasm: the same compiler profile and scalar/SIMD operation. 1.00× is native time; smaller is less elapsed time.",
         "A separate O2 scalar native anchor and absolute ns/op are retained for every row. SIMD gains must not be confused with removal of translation overhead.", "",
         "Two cohorts per host, seven randomized rounds per case, candidate bracketed by native before/after. Iteration counts are calibrated separately and normalized per logical operation.",
         "Mappings stay fixed during calls, caches are invocation-local, and generic fallbacks preserve faults. These are manually expressed C mechanisms, not a general C/Wasm instrumentation pass.", "",
         "A dagger marks an unstable comparison: either cohort has fewer than4 of7 acceptable brackets or its median differs by more than20% from the other cohort. All samples, including unstable ones, are retained.", "",
         "## Individual changes and combined candidate (64 KiB)", "",
         "| Candidate | Representative operation | Node | Chromium | Firefox | WebKit |",
         "|---|---|---:|---:|---:|---:|"]
representatives = [("Checked baseline", "generic", "read", "O2/generic"),
                   ("One span guard", "span", "read", "O2/span"),
                   ("Cached page", "cache", "chase", "O2/cache"),
                   ("Proved alignment", "aligned", "read", "O2/aligned"),
                   ("Preserved bulk", "bulk", "copy", "O2/bulk-preserved"),
                   ("Scalarized bulk control", "scalarized", "copy", "O2/scalarized"),
                   ("Preserved SIMD", "simd", "read", "O2/vector"),
                   ("Opaque calls O2", "opaque", "read", "O2/opaque"),
                   ("Clang O3", "O3", "read", "O3/generic"),
                   ("Clang O3 + LTO", "lto", "read", "O3-lto/generic"),
                   ("Opaque calls + LTO", "lto-visible", "read", "O3-lto/opaque"),
                   ("LLVM auto-vectorization", "auto", "read", "O3-lto-auto/generic"),
                   ("Combined, scalar O2", "combined-scalar", "read", "O2/combined"),
                   ("All together", "all", "read", "all")]
def cell(row):
    return f"{row['ratioMatched']:.2f}×" + ("†" if not row["repeatable"] else "")
for title, _, op, name in representatives:
    values = []
    for host in records:
        case = next(c for c in summary["hosts"][host]["cases"] if c["op"] == op and c["size"] == 65536 and c["layout"] == "contiguous")
        values.append(cell(next(r for r in case["rows"] if r["id"] == name)))
    lines.append(f"| {title} | {op} | " + " | ".join(values) + " |")
lines += ["", "## All together across workloads", "",
          "This combines span guards, call-local caches, alignment knowledge, retained bulk/SIMD, Clang O3, LTO, LLVM auto-vectorization and final Binaryen O3. Unavailable fast paths fall back instead of stacking redundant guards.", "",
          "| Operation | KiB | Layout | Node | Chromium | Firefox | WebKit |", "|---|---:|---|---:|---:|---:|---:|"]
for c in summary["hosts"]["node"]["cases"]:
    values = []
    for host in records:
        case = next(x for x in summary["hosts"][host]["cases"] if (x["op"], x["size"], x["layout"]) == (c["op"], c["size"], c["layout"]))
        values.append(cell(next(r for r in case["rows"] if r["id"] == "all")))
    lines.append(f"| {c['op']} | {c['size']//1024} | {c['layout']} | " + " | ".join(values) + " |")
for host, data in summary["hosts"].items():
    lines += ["", f"## {host}: complete matrix", "",
              "| Operation | KiB | Layout | Candidate | Matched native | Ratio | O2 scalar ratio | ns/op | Stable brackets |",
              "|---|---:|---|---|---|---:|---:|---:|---|"]
    for c in data["cases"]:
        for r in c["rows"]:
            lines.append(f"| {c['op']} | {c['size']//1024} | {c['layout']} | {r['id']} | {r['nativeReference']} | {cell(r)} | {r['ratioScalar']:.2f}× | {r['nsPerOp']:.3f} | {r['stableBrackets']} |")
lines += ["", "## Limits", "",
          "The native graph has contiguous physical storage. Fragmented translated mappings are a fallback stress control with different physical page ordering; their ratios include layout effects.",
          "Clang O2/O3/LTO scalar profiles disable automatic loop/SLP vectorization to isolate scalar transforms. O3-lto-auto enables it; the all-together profile enables it and final Binaryen O3. Explicit SIMD is measured against an explicit SIMD native control.",
          "The bulk comparison includes an intentionally scalarized control. The earlier WAT prototype already preserved memory.copy; retained bulk is not a newly claimed improvement over that earlier path.",
          "Private-page cloning is a harness operation, not Kandelo fork continuation. No PHP-FPM/OPcache integration, production ABI/runtime changes, general compiler transformation, concurrent mapping revocation or application speedup is claimed.", ""]
(root / "optimization-summary.md").write_text("\n".join(lines))
print("\n".join(lines[:36]))
