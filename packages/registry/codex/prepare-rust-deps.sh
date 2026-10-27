#!/usr/bin/env bash
# Sourced inside the private Codex Rust build environment.
set -euo pipefail

# Cargo verifies archive checksums against Cargo.lock while vendoring. Keep
# portable target support patches in separate copies so the original vendor
# tree and its checksum records remain intact.
cp Cargo.lock "$WORK_DIR/locked-versions.toml"
cargo vendor --locked --versioned-dirs "$WORK_DIR/vendor" > "$WORK_DIR/vendor-config.toml"
export CARGO_HOME="$WORK_DIR/codex-cargo-home"
mkdir -p "$CARGO_HOME"
cp "$WORK_DIR/vendor-config.toml" "$CARGO_HOME/config.toml"
mkdir -p "$WORK_DIR/patched-crates"
python3 - "$SCRIPT_DIR/patches" "$WORK_DIR" <<'PY'
from pathlib import Path
import shutil
import subprocess
import sys

patches, work = map(Path, sys.argv[1:])
entries = []
updates = []
for patch in sorted(patches.glob("*.patch")):
    crate = patch.stem
    name, _, version = crate.rpartition("-")
    source = work / "vendor" / crate
    destination = work / "patched-crates" / crate
    if not source.is_dir():
        raise SystemExit(f"missing locked crate for patch: {crate}")
    shutil.copytree(source, destination)
    (destination / ".cargo-checksum.json").unlink()
    with patch.open("rb") as data:
        subprocess.run(["patch", "-p1", "--forward", "--batch", "--fuzz=0"],
                       cwd=destination, stdin=data, check=True)
    key = name.replace("-", "_") + "_" + version.replace(".", "_")
    entries.append(f'{key} = {{ package = "{name}", path = "{destination}" }}')
    updates.append(f"{name}@{version}")
manifest = Path("Cargo.toml")
text = manifest.read_text()
anchor = "[patch.crates-io]\n"
assert text.count(anchor) == 1
manifest.write_text(text.replace(anchor, anchor + "\n".join(entries) + "\n"))
(work / "patched-crates.txt").write_text("\n".join(updates) + "\n")
PY
export CARGO_NET_OFFLINE=true
# Admit path overrides into the lockfile without changing registry versions.
update_args=()
while IFS= read -r crate; do
    update_args+=(-p "$crate")
done < "$WORK_DIR/patched-crates.txt"
cargo update --offline "${update_args[@]}"
python3 - "$WORK_DIR/locked-versions.toml" Cargo.lock <<'PY'
from collections import Counter
import sys, tomllib

def versions(path):
    with open(path, "rb") as source:
        lock = tomllib.load(source)
    return Counter((p["name"], p["version"]) for p in lock["package"])

if versions(sys.argv[1]) != versions(sys.argv[2]):
    raise SystemExit("portability patches must preserve Codex's locked dependency versions")
PY
