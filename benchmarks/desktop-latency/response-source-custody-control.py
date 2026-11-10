#!/usr/bin/env python3
"""Actual seal/verify control, with a tiny JS fixture rather than a GUI run."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

helper = Path(__file__).with_name("response-source-custody.py")
report = []
with tempfile.TemporaryDirectory(prefix="roi-source-custody-") as directory:
    base = Path(directory)
    root, out = base / "origin", base / "result"
    bench = root / "benchmarks/desktop-latency"
    bench.mkdir(parents=True)
    out.mkdir()
    program = bench / "fixture.js"
    program.write_text("console.log('original')\n")
    run = lambda *args: subprocess.run([sys.executable, str(helper), *map(str, args)], capture_output=True, text=True)
    assert run("freeze", root, out).returncode == 0
    assert run("verify", root, out, "untouched").returncode == 0
    program.write_text("console.log('mutated-origin')\n")
    actual = subprocess.check_output(["node", str(out / "source/benchmarks/desktop-latency/fixture.js")], text=True).strip()
    assert actual == "original", actual
    assert run("verify", root, out, "origin-mutation").returncode == 1
    record = json.loads((out / "source-integrity.json").read_text())
    assert not record["valid"] and record["origin"]["changed"] == ["benchmarks/desktop-latency/fixture.js"]
    report.append({"case": "actual sealed execution survives origin mutation; verification refuses", "executed": actual, "judgment": record})
    program.write_text("console.log('original')\n")
    (out / "source/benchmarks/desktop-latency/fixture.js").write_text("console.log('mutated-seal')\n")
    assert run("verify", root, out, "sealed-mutation").returncode == 1
    report.append({"case": "sealed mutation refuses", "judgment": json.loads((out / "source-integrity.json").read_text())})
    (out / "source/benchmarks/desktop-latency/fixture.js").write_text("console.log('original')\n")
    (bench / "new-source.ts").write_text("export {}\n")
    assert run("verify", root, out, "namespace-mutation").returncode == 1
    report.append({"case": "new authored dependency refuses", "judgment": json.loads((out / "source-integrity.json").read_text())})
Path(sys.argv[1]).write_text(json.dumps(report, indent=2) + "\n")
print("PASS source sealing / real execution / origin, seal and namespace mutation refusals", len(report))
