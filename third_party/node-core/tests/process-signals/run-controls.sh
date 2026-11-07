#!/usr/bin/env bash
set -euo pipefail
# No fixture provisioning, package resolver, global setup or product rebuild.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${SIGNAL_CONTROL_DIR:?Set an isolated evidence output directory}"
: "${NODE26_REFERENCE:?Set the pinned native Node26 executable}"
mkdir -p "$SIGNAL_CONTROL_DIR"
python3 "$repo_root/third_party/node-core/generate-process-signals.py" --shell-dir "$SIGNAL_CONTROL_DIR/staged"
python3 "$repo_root/third_party/node-core/generate-process-signals.py" > "$SIGNAL_CONTROL_DIR/process-signals.js"
cp "$SIGNAL_CONTROL_DIR/staged/kandelo-node-signal-constants.h" "$SIGNAL_CONTROL_DIR/staged/signal-constants.h"
c++ -std=c++20 -Wall -Wextra -Werror -pedantic -pthread -I "$repo_root/third_party/node-core" -I "$SIGNAL_CONTROL_DIR/staged" "$repo_root/third_party/node-core/tests/process-signals/owner-control.cpp" -o "$SIGNAL_CONTROL_DIR/owner-control" > "$SIGNAL_CONTROL_DIR/compile.stdout" 2> "$SIGNAL_CONTROL_DIR/compile.stderr"
"$SIGNAL_CONTROL_DIR/owner-control" > "$SIGNAL_CONTROL_DIR/owner.stdout" 2> "$SIGNAL_CONTROL_DIR/owner.stderr"
"$NODE26_REFERENCE" -e 'const a=require("node:assert/strict"),f=require("node:fs"),o=require("node:os");const line=f.readFileSync(process.argv[1],"utf8").split("\n").find(x=>x.startsWith("CONSTANTS "));a.deepEqual(Object.entries(JSON.parse(line.slice(10))),Object.entries(o.constants.signals));a.equal(Object.getPrototypeOf(o.constants.signals),null);console.log("PASS compiled native signal names/values match pinned Node on this actual host");' "$SIGNAL_CONTROL_DIR/owner.stdout" > "$SIGNAL_CONTROL_DIR/constants.stdout" 2> "$SIGNAL_CONTROL_DIR/constants.stderr"
for mode in native adapter worker; do
 "$NODE26_REFERENCE" --expose-internals --no-warnings "$repo_root/third_party/node-core/tests/process-signals/platform-control.cjs" "$mode" "$SIGNAL_CONTROL_DIR/process-signals.js" > "$SIGNAL_CONTROL_DIR/$mode.stdout" 2> "$SIGNAL_CONTROL_DIR/$mode.stderr"
done
