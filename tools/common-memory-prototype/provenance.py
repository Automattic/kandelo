#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in sorted(root.iterdir()) if p.is_file()}
result = {"gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
          "sources": files,
          "build": json.loads((Path(sys.argv[1]) / "build.json").read_text()),
          "artifacts": {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                        for p in sorted(Path(sys.argv[1]).glob("*.wasm"))}}
if (Path(sys.argv[1]) / "optimization-build.json").exists():
    result["optimizationBuild"] = json.loads((Path(sys.argv[1]) / "optimization-build.json").read_text())
target = Path(sys.argv[1]) / "provenance.json"
if "--check" in sys.argv:
    if json.loads(target.read_text()) != result:
        raise SystemExit("source/artifact changed during run")
else:
    target.write_text(json.dumps(result, indent=2) + "\n")
