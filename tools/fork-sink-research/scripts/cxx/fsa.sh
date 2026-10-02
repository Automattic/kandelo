#!/usr/bin/env bash
# fsa.sh <label> <link> <itargets> [extra fsa args]
set -u
FPR=/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr
HOST=$(rustc -vV | awk '/^host/ {print $2}')
F=tools/fork-sink-research/fsa/target/$HOST/release/fsa
label=$1; link=$2; it=$3; shift 3
$F --wasm $FPR/shims/links/$link.wasm --itargets "$it" --registries --param --cancel --exc equiv ${FSA_MD---main-direct} "$@" --show-open 40 --out-set .context/cxx/$label.set > .context/cxx/$label.fsa.txt 2>&1
echo "$label exit=$? $(grep -E '^(instrumented_today|closure_same_rules_no_sinks|instrumented_sink|closed)' .context/cxx/$label.fsa.txt | tr '\n' ' ')"
