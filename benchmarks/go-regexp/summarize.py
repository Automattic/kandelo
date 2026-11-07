"""Summarize compilation-only measurements, retaining baseline stack failures."""

from collections import defaultdict
import json
from pathlib import Path
import statistics
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".context/go-regexp-evaluation")
native = json.loads((root / "native-benchmarks.json").read_text())["rows"]
browser = json.loads((root / "browser-benchmarks.json").read_text())["rows"]
groups = defaultdict(list)
checksums = defaultdict(set)
wasm_hashes = defaultdict(set)
errors = []

for row in native + browser:
    host = row.get("host", row.get("engine"))
    if host != "native":
        wasm_hashes[row["variant"]].add(row["sha256"])
    data = row["result"] if "host" in row else row["parsed"]
    if data is None:
        error = row["result"].get("error")
        errors.append({
            "host": host,
            "case": row["name"],
            "variant": row["variant"],
            "error": error,
        })
        continue
    checksums[row["name"]].add(data["Checksum"])
    for sample in data["Samples"]:
        groups[host, row["name"], row["variant"]].append((
            sample["DurationNs"] / data["N"],
            sample["TotalAlloc"] / data["N"],
            sample["Mallocs"] / data["N"],
        ))

if any(len(hashes) != 1 for hashes in wasm_hashes.values()):
    raise SystemExit("Mixed WASI artifacts across Node/browser measurements")

summary = []
for host in ["native", "node-wasi", "chromium", "firefox", "webkit"]:
    for name in ["literal", "literal-text", "class", "capture", "bounded-lazy", "url"]:
        baseline = groups.get((host, name, "baseline"))
        candidate = groups.get((host, name, "candidate"))
        if not baseline or not candidate:
            print(host, name, "not comparable")
            continue
        before = [statistics.median(sample[i] for sample in baseline) for i in range(3)]
        after = [statistics.median(sample[i] for sample in candidate) for i in range(3)]
        result = {
            "host": host,
            "case": name,
            "baselineNs": before[0],
            "candidateNs": after[0],
            "changePercent": 100 * (after[0] / before[0] - 1),
            "baselineBytes": before[1],
            "candidateBytes": after[1],
            "baselineAllocs": before[2],
            "candidateAllocs": after[2],
        }
        summary.append(result)
        print(
            f"{host:10} {name:13} {before[0]:9.1f} -> {after[0]:9.1f} ns "
            f"{result['changePercent']:+6.1f}% "
            f"bytes {before[1]:.1f}->{after[1]:.1f} "
            f"allocs {before[2]:.2f}->{after[2]:.2f}"
        )

result = {
    "scope": "Median of recorded samples; see raw round counts; compilation only",
    "nativeRows": len(native),
    "browserRows": len(browser),
    "rows": summary,
    "errors": errors,
    "checksumVariants": {name: len(values) for name, values in checksums.items()},
    "wasmArtifacts": {variant: sorted(hashes) for variant, hashes in wasm_hashes.items()},
}
(root / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
for error in errors:
    print("ERROR", error)
    if not (
        error["host"] == "webkit"
        and error["case"] == "url"
        and error["variant"] == "baseline"
        and "call stack" in (error["error"] or {}).get("message", "")
    ):
        raise SystemExit("Unexpected benchmark failure")
if any(len(values) != 1 for values in checksums.values()):
    raise SystemExit("Bytecode checksum mismatch between variants")
