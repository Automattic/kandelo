#!/usr/bin/env bash
# make-plan.sh <label>: write .context/fpr2/<label>.plan for
# `wasm-fork-instrument --sink-plan` from an fsa run (run.sh <label> ...):
# every function in the sink set (A) and every closed sink in it (B).
set -eu
D=${FPR:-$PWD/.context/fpr2}; L=$1
sed 's/^/A\t/' "$D/$L.set" > "$D/$L.plan"
awk -F'\t' '$1=="SINK"{print $2}' "$D/$L.fsa.txt" | grep -Fx -f "$D/$L.set" | sed 's/^/B\t/' >> "$D/$L.plan" || true
echo "$D/$L.plan: $(grep -c '^A' "$D/$L.plan") instrumented, $(grep -c '^B' "$D/$L.plan") boundaries"
