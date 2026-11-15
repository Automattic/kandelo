#!/usr/bin/env python3
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
hosts = ["node", "chromium", "firefox", "webkit"]
data = {host: json.loads((root / f"{host}.json").read_text()) for host in hosts}
lines = ["# Common-memory mechanism: diagnostic timings", "",
         "These are standalone Wasm microbenchmarks, not PHP, Kandelo fork, or production performance results.", "",
         "One 64 MiB initial / 128 MiB maximum shared Wasm memory per group; 64 KiB virtual pages and a 64 MiB virtual address limit.",
         "Inline translation includes bounds, permission and cross-page checks. Page tables remain stable during each guest call.", "",
         "Nine rotated/reversed rounds, three warmups per variant, common iteration count calibrated on native to a 50 ms target (with a finite iteration cap). Setup is excluded.",
         "The helper is a minimal Wasm-to-Wasm call control using the same resolver; it is not the old Madison helper with leases and mapping revocation.", "",
         "The machine was not exclusively reserved for this run. Treat the numbers as diagnostic estimates, not controlled application benchmarks.", "",
         "Pointer chasing traverses at least four whole graphs plus a remainder with a nonzero independently modeled checksum.", "",
         "| Workload | Working set | Node inline/native | Chromium | Firefox | WebKit |", "|---|---:|---:|---:|---:|---:|"]
if all("benchmark" in d for d in data.values()):
    for i, row in enumerate(data["node"]["benchmark"]["results"]):
        values = [data[h]["benchmark"]["results"][i] for h in hosts]
        assert all((v["workload"], v["workingSetBytes"]) == (row["workload"], row["workingSetBytes"]) for v in values)
        lines.append(f"| {row['workload']} | {row['workingSetBytes']//1024} KiB | " + " | ".join(f"{v['inlineOverNative']:.2f}×" for v in values) + " |")
    lines += ["", "## Absolute medians and helper control", "",
              "Each scalar operation is one i32 access, write, or atomic RMW. A chase operation is one dependent pointer load. Each copy operation copies 64 KiB.", "",
              "| Host | Workload | KiB | Native ns/op | Inline ns/op | Helper ns/op | Inline/native | Helper/native |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for h in hosts:
        for r in data[h]["benchmark"]["results"]:
            lines.append(f"| {h} | {r['workload']} | {r['workingSetBytes']//1024} | " +
                         " | ".join(f"{r['stats'][m]['medianNsPerOp']:.3f}" for m in ["native", "inline", "helper"]) +
                         f" | {r['inlineOverNative']:.2f}× | {r['helperOverNative']:.2f}× |")
lines += ["", "## Correctness and limits", ""]
for h, d in data.items():
    lines.append(f"- {h} {d.get('browserVersion', d.get('host', {}).get('node', ''))}: {len(d['correctness']['passed'])} mechanism groups; "
                 f"{d['correctness']['randomized']['operations']} oracle operations; negative clone control rejected.")
lines += ["", "The private-page clone is a harness operation, not Kandelo fork continuation. No general C/Wasm rewriter, guest syscall host translation, concurrent mapping-revocation protocol, untrusted-module isolation, dynamic linking, SIMD or memory64 is implemented.",
          "The scatter-copy fallback is bounded to 64 KiB; contiguous copies use native memory.copy after range validation.",
          "PHP-FPM/OPcache has not been built in this architecture. The measured gate precedes that integration.", "",
          "Raw per-round samples, checksums, host versions/load snapshots and source/artifact hashes are in the sibling JSON files.", ""]
(root / "summary.md").write_text("\n".join(lines))
print("\n".join(lines[:24]))
