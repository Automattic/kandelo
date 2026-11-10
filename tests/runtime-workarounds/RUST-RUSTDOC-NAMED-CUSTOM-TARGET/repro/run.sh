#!/usr/bin/env bash
# Standalone: requires only matching rustc, rustdoc and Python 3 on PATH.
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
export RUSTC_BOOTSTRAP=1
host=$(rustc -vV | sed -n 's/^host: //p')
rustc -Zunstable-options --print target-spec-json --target "$host" > "$work/rustdoc-repro.json"
# compile_fail avoids needing a rebuilt standard library for the renamed
# target: a missing core crate is also an ordinary compiler rejection.
printf '%s\n' '```compile_fail' 'let _: MissingType = ();' '```' > "$work/example.md"
set +e
rustdoc -Zunstable-options --test "$work/example.md" > "$work/control" 2>&1
control=$?
RUST_TARGET_PATH="$work" rustdoc -Zunstable-options --test --target rustdoc-repro "$work/example.md" > "$work/output" 2>&1
status=$?
set -e
python3 - "$work" "$control" "$status" <<'PY'
import json
from pathlib import Path
import sys
work = Path(sys.argv[1])
control, status = map(int, sys.argv[2:])
output = (work / "output").read_text()
if control != 0:
    verdict = "inconclusive"
elif status != 0 and "built-in target" in output and "compiler unexpectedly panicked" in output:
    verdict = "reproduced"
elif status == 0 and "1 passed; 0 failed" in output:
    verdict = "not-reproduced"
else:
    verdict = "inconclusive"
print("REPRO-VERDICT " + json.dumps({"verdict": verdict, "details": {
    "controlExit": control, "customExit": status,
    "control": (work / "control").read_text(), "custom": output}}))
PY
