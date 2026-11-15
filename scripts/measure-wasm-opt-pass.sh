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
#   --level  wasm-opt level, with or without the dash (default: Os, the
#            instrumenter's post-optimize level)
#   --runs   alternating with/without pairs per input, a positive integer
#            (default: 3)
#   --out    directory for outputs and runs.tsv (default: a new mktemp dir)
#
# The two outputs of every input are kept in the output directory, so it
# needs about twice the inputs' total size per level measured (clang alone
# is about 109 MB). Inputs that share a file name are told apart by their
# position on the command line: two x.wasm inputs become 1-x and 2-x.
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
# summary table on stdout. Exit status 1 if any run failed, 2 on bad usage.
set -euo pipefail

usage() {
  [ "$#" -eq 0 ] || echo "$0: $*" >&2
  echo "usage: $0 [--pass NAME] [--level LEVEL] [--runs N] [--out DIR] INPUT.wasm..." >&2
  exit 2
}

pass=constraint-analysis
level=Os
runs=3
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pass|--level|--runs|--out)
      [ "$#" -ge 2 ] || usage "$1 needs a value"
      case "$1" in
        --pass) pass="$2" ;;
        --level) level="$2" ;;
        --runs) runs="$2" ;;
        --out) out="$2" ;;
      esac
      shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    --) shift; break ;;
    -*) usage "unknown option: $1" ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] || usage "no inputs"
[[ "$runs" =~ ^[1-9][0-9]*$ ]] || usage "--runs must be a positive integer, not '$runs'"
level="${level#-}"
[[ "$level" =~ ^O[0-4sz]$ ]] || usage "--level must be one of O0-O4, Os, Oz (with or without the dash), not '$level'"
[ -n "$pass" ] || usage "--pass needs a pass name"
for input in "$@"; do
  case "$input" in -*) usage "options go before the inputs: $input" ;; esac
  [ -f "$input" ] || usage "no such input: $input"
done

# One output name per input: the file name without .wasm, prefixed with the
# input's position when another input has the same file name.
names=()
index=0
for input in "$@"; do
  index=$((index + 1))
  base="$(basename "$input" .wasm)"
  shared=0
  for other in "$@"; do
    [ "$(basename "$other" .wasm)" = "$base" ] && shared=$((shared + 1))
  done
  if [ "$shared" -gt 1 ]; then names+=("$index-$base"); else names+=("$base"); fi
done
duplicate="$(printf '%s\n' "${names[@]}" | sort | uniq -d | head -n 1)"
[ -z "$duplicate" ] || usage "two inputs would share the output name '$duplicate'; rename one"
tool="${WASM_OPT:-wasm-opt}"
# Read the whole help first: `grep -q` closing the pipe early would make
# wasm-opt die of SIGPIPE, and pipefail would report the pass as missing.
help="$("$tool" --help 2>/dev/null || true)"
if ! printf '%s\n' "$help" | grep -qE -- "^ *--$pass( |,|$)"; then
  echo "$("$tool" --version 2>/dev/null || echo "$tool") has no pass named $pass" >&2
  exit 2
fi
[ -n "$out" ] || out="$(mktemp -d "${TMPDIR:-/tmp}/measure-wasm-opt-pass.XXXXXX")"
mkdir -p "$out"
tsv="$out/runs.tsv"
printf 'input\tcfg\trun\treal_s\tcpu_s\tbytes\texit\n' > "$tsv"
echo "$("$tool" --version), -$level, pass $pass, $runs run(s) each; outputs in $out" >&2

failed=0
index=0
for input in "$@"; do
  name="${names[$index]}"
  index=$((index + 1))
  [ "$name" = "$(basename "$input" .wasm)" ] || echo "$input is measured as $name" >&2
  for run in $(seq 1 "$runs"); do
    for cfg in with without; do
      extra=()
      [ "$cfg" = without ] && extra=("--skip-pass=$pass")
      result="$out/$name.$cfg.wasm"
      timing="$out/$name.$cfg.$run.time"
      errors="$out/$name.$cfg.$run.err"
      status=0
      # bash's `time` reports the child's real, user and system seconds.
      { TIMEFORMAT='%R %U %S'; time "$tool" "$input" "-$level" ${extra[@]+"${extra[@]}"} \
          -o "$result" 2>"$errors"; } 2>"$timing" || status=$?
      read -r real user sys < <(tail -n 1 "$timing")
      bytes=0
      [ "$status" -eq 0 ] && bytes="$(wc -c < "$result" | tr -d ' ')"
      [ "$status" -eq 0 ] || { failed=1; echo "$name ($cfg, run $run): exit $status; see $errors" >&2; }
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
