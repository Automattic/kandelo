#!/usr/bin/env python3
"""Build the pinned Rust tools with the same static compiler dependencies.

Upstream bootstrap supplies compiler crates through a staging sysroot. Our
Cargo bootstrap instead builds them in one workspace, so tools must declare
their actual compiler dependencies rather than search a host rustc-dev sysroot.
Only resolver-staged source is modified.
"""

import os
from pathlib import Path
import re
import sys
import tomllib


root = Path(sys.argv[1]).resolve()
members = ["compiler/rustc", "src/tools/rustdoc", "src/tools/rustfmt", "src/tools/clippy"]
workspace = root / "Cargo.toml"
source, count = re.subn(
    r"members = \[.*?\]",
    "members = [\n" + "".join(f'    "{member}",\n' for member in members) + "]",
    workspace.read_text(),
    count=1,
    flags=re.S,
)
if count != 1 or tomllib.loads(source)["workspace"]["members"] != members:
    raise SystemExit("cannot select the pinned compiler/tool workspace")
workspace.write_text(source)

tools = [
    "src/librustdoc",
    "src/tools/rustfmt",
    "src/tools/clippy",
    "src/tools/clippy/clippy_config",
    "src/tools/clippy/clippy_lints",
    "src/tools/clippy/clippy_utils",
    "src/tools/clippy/declare_clippy_lint",
]
for tool in tools:
    directory = root / tool
    manifest = directory / "Cargo.toml"
    original = manifest.read_text()
    data = tomllib.loads(original)
    entrypoints = [directory / data.get("lib", {}).get("path", "src/lib.rs")]
    entrypoints += [directory / binary["path"] for binary in data.get("bin", [])]
    required = set()
    for entrypoint in entrypoints:
        if entrypoint.exists():
            required.update(re.findall(r"^\s*(?:pub(?:\([^)]*\))?\s+)?extern\s+crate\s+(rustc_\w+|thin_vec)\b", entrypoint.read_text(), re.M))
    additions = []
    for name in sorted(required):
        if name == "thin_vec":
            key = "thin-vec"
            dependency = tomllib.loads((root / "compiler/rustc_ast/Cargo.toml").read_text())["dependencies"][key]
            if not isinstance(dependency, str):
                raise SystemExit("unexpected pinned thin-vec dependency")
            value = f'"{dependency}"'
        else:
            key = name
            dependency = root / "compiler" / name
            if not (dependency / "Cargo.toml").is_file():
                raise SystemExit(f"missing pinned compiler dependency {name}")
            value = '{ path = "' + Path(os.path.relpath(dependency, directory)).as_posix() + '" }'
        if key in data.get("dependencies", {}):
            expected = tomllib.loads(f"{key} = {value}")[key]
            if data["dependencies"][key] != expected:
                raise SystemExit(f"unexpected pre-existing {key} dependency in {manifest}")
            continue
        additions.append(f"{key} = {value}\n")
    header = "[dependencies]\n"
    if header in original:
        updated = original.replace(header, header + "".join(additions), 1)
    else:
        updated = original + "\n" + header + "".join(additions)
    tomllib.loads(updated)
    manifest.write_text(updated)
