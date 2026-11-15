#!/usr/bin/env bash
# Measure what one Binaryen pass is worth on real Kandelo modules: run
# `wasm-opt INPUT -<level>` with and without `--skip-pass=<pass>`, alternating
# the two so background load affects both alike, and report output size and
# wasm-opt CPU time for each input.
#
# Written for the constraint-analysis decision (docs/future-improvements.md,
# "Revisit Binaryen's constraint-analysis pass"); any pass name works.
#
# Usage (inside scripts/dev-shell.sh, so wasm-opt is the pinned Binaryen):
#   scripts/measure-wasm-opt-pass.sh [--pass NAME] [--level LEVEL] \
#       [--runs N] [--out DIR] INPUT.wasm...
#
#   --pass   pass to compare (default: constraint-analysis)
#   --level  wasm-opt level without the dash (default: Os, the
#            instrumenter's post-optimize level)
#   --runs   alternating with/without pairs per input (default: 3)
#   --out    directory for outputs and runs.tsv (default: a new mktemp dir)
#
# WASM_OPT selects the wasm-opt under test (default: wasm-opt on PATH). Use a
# build containing every fix the pass needs: an input the pass aborts on is
# reported as a failed run, not measured. No feature flags are passed;
# wasm-opt reads them from each input's target_features section, as the
# instrumenter and the SDK do.
#
# Inputs are the modules wasm-opt sees in a real build: raw wasm-ld links
# (link with `wasm32posix-cc ... --no-wasm-opt`), instrumenter output before
# its own pass (`wasm-fork-instrument --post-optimize none`), and installed
# binaries under local-binaries/ or a package's output directory.
#
# Output: runs.tsv (input, cfg, run, real_s, cpu_s, bytes, exit) and a
# summary table on stdout. Exit status 1 if any run failed.
set -euo pipefail

pass=constraint-analysis
level=Os
runs=3
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pass) pass="$2"; shift 2 ;;
    --level) level="$2"; shift 2 ;;
    --runs) runs="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] || { echo "usage: $0 [--pass NAME] [--level LEVEL] [--runs N] [--out DIR] INPUT.wasm..." >&2; exit 2; }
tool="${WASM_OPT:-wasm-opt}"
if ! "$tool" --help 2>/dev/null | grep -qE -- "^ *--$pass( |,|$)"; then
  echo "$("$tool" --version 2>/dev/null || echo "$tool") has no pass named $pass" >&2
  exit 2
fi
[ -n "$out" ] || out="$(mktemp -d "${TMPDIR:-/tmp}/measure-wasm-opt-pass.XXXXXX")"
mkdir -p "$out"
tsv="$out/runs.tsv"
printf 'input\tcfg\trun\treal_s\tcpu_s\tbytes\texit\n' > "$tsv"
echo "$("$tool" --version), -$level, pass $pass, $runs run(s) each; outputs in $out" >&2

failed=0
for input in "$@"; do
  name="$(basename "$input" .wasm)"
  for run in $(seq 1 "$runs"); do
    for cfg in with without; do
      extra=()
      [ "$cfg" = without ] && extra=("--skip-pass=$pass")
      result="$out/$name.$cfg.wasm"
      timing="$out/$name.$cfg.$run.time"
      status=0
      # bash's `time` reports the child's real, user and system seconds.
      { TIMEFORMAT='%R %U %S'; time "$tool" "$input" "-$level" ${extra[@]+"${extra[@]}"} \
          -o "$result" 2>"$out/$name.$cfg.err"; } 2>"$timing" || status=$?
      read -r real user sys < <(tail -n 1 "$timing")
      bytes=0
      [ "$status" -eq 0 ] && bytes="$(wc -c < "$result" | tr -d ' ')"
      [ "$status" -eq 0 ] || { failed=1; echo "$name ($cfg, run $run): exit $status; see $out/$name.$cfg.err" >&2; }
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$cfg" "$run" "$real" \
        "$(awk -v u="$user" -v s="$sys" 'BEGIN { printf "%.2f", u + s }')" "$bytes" "$status" >> "$tsv"
    done
  done
done

# Summary: sizes from the last run (wasm-opt is deterministic; the identical
# column compares the two outputs), CPU as the median over runs.
awk -F '\t' -v dir="$out" '
  function median(list,    n, a, i, j, t) {
    n = split(list, a, " ")
    for (i = 2; i <= n; i++) for (j = i; j > 1 && a[j - 1] + 0 > a[j] + 0; j--) { t = a[j]; a[j] = a[j - 1]; a[j - 1] = t }
    return n % 2 ? a[(n + 1) / 2] : (a[n / 2] + a[n / 2 + 1]) / 2
  }
  NR == 1 { next }
  !($1 in seen) { seen[$1] = 1; order[++count] = $1 }
  $7 != 0 { bad[$1] = 1 }
  { cpu[$1, $2] = cpu[$1, $2] " " $5; size[$1, $2] = $6 }
  END {
    printf "%-28s %12s %12s %8s %9s %10s %9s %9s %7s\n", "input", "bytes with", "bytes w/o", "delta", "delta %", "identical", "cpu with", "cpu w/o", "cpu %"
    for (i = 1; i <= count; i++) {
      p = order[i]
      if (p in bad) { printf "%-28s failed (see runs.tsv)\n", p; continue }
      w = size[p, "with"]; o = size[p, "without"]
      same = system("cmp -s \"" dir "/" p ".with.wasm\" \"" dir "/" p ".without.wasm\"") == 0 ? "yes" : "no"
      cw = median(cpu[p, "with"]); co = median(cpu[p, "without"])
      cpu_pct = 0
      if (co > 0) cpu_pct = (cw - co) * 100 / co
      printf "%-28s %12d %12d %8d %9.4f %10s %9.2f %9.2f %7.1f\n", p, w, o, w - o, (w - o) * 100 / o, same, cw, co, cpu_pct
    }
  }' "$tsv"
exit "$failed"
