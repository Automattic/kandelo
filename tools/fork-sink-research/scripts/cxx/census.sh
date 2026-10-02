#!/usr/bin/env bash
# census.sh <label> <program-link> [fpa rules...]
set -u
FPR=/Users/brandon/conductor/workspaces/kandelo/ljubljana/.context/fpr
HOST=$(rustc -vV | awk '/^host/ {print $2}')
FPA=tools/fork-sink-research/fpa/target/$HOST/release/fpa
label=$1; link=$2; shift 2
B=$FPR/shims/links/$link
R=(); for r in "$@"; do R+=(--rule "$r"); done
$FPA --wasm $B.wasm --map $B.map --inputs $B.inputs --side-dir $FPR/shims/side --aliases ${ALIASES:-$FPR/runtime/aliases.tsv} "${R[@]}" --mode registry --census ${CENSUS:-30} --cuts 0 --export-targets .context/cxx/$label.itargets registry > .context/cxx/$label.census.txt 2>&1
echo "$label exit=$? $(grep -E '^mode registry' .context/cxx/$label.census.txt | cut -c1-200)"
