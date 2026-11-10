#!/usr/bin/env python3
"""Expose the declared guest LLVM's build facts to rustc's native build script."""
import json
import os
from pathlib import Path
import shlex
import sys

root = Path(os.environ["WASM_POSIX_DEP_RUST_LLVM_DIR"])
facts = json.loads((root / "share/kandelo/llvm-config.json").read_text())
args = sys.argv[1:]
if args == ["--help"]:
    print("Supported queries: --version --components --cxxflags --libs --ldflags --host-target --system-libs --quote-paths", file=sys.stderr)
    raise SystemExit(0)
queries = {
    "--version": facts["version"],
    "--components": facts["components"],
    "--host-target": "wasm32-unknown-unknown",
    "--cxxflags": shlex.join(["-I" + str(root / "include"), "-std=c++17", "-fno-exceptions", "-fno-rtti", "-include", "endian.h"]),
    "--libs": "-lLLVM",
    "--ldflags": shlex.join(["-L" + str(root / "lib")]),
    "--system-libs": "-lc++ -lc++abi",
}
selected = [arg for arg in args if arg in queries]
components = set(facts["components"].split())
allowed = set(queries) | {"--link-static", "--quote-paths"} | components
if len(selected) != 1 or any(arg not in allowed for arg in args):
    raise SystemExit("unsupported guest LLVM query: " + shlex.join(args))
print(queries[selected[0]])
