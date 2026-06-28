#!/usr/bin/env bash
# Emit a JSON matrix of selected Homebrew formula/arch bottle builds.
set -euo pipefail

TAP_ROOT=""
FORMULAE="all"
ARCHES="wasm32"

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-plan-matrix.sh --tap-root <tap-root> [--formulae <list|all>] [--arches <list>]

Lists may be comma, space, or newline separated. Output is a JSON array of
{"formula": "...", "arch": "..."} entries.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --formulae) FORMULAE="${2:-}"; shift 2 ;;
    --arches) ARCHES="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-plan-matrix.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$TAP_ROOT" ]; then
  echo "homebrew-plan-matrix.sh: --tap-root is required" >&2
  exit 2
fi

if [ ! -d "$TAP_ROOT/Formula" ]; then
  echo "homebrew-plan-matrix.sh: $TAP_ROOT/Formula is not a directory" >&2
  exit 2
fi

valid_formula() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9._-]*$ ]]
}

valid_arch() {
  case "$1" in
    wasm32|wasm64) return 0 ;;
    *) return 1 ;;
  esac
}

split_words() {
  tr ',[:space:]' '\n' | sed '/^$/d'
}

formula_file_for() {
  printf '%s/Formula/%s.rb\n' "$TAP_ROOT" "$1"
}

formula_list="$(mktemp)"
arch_list="$(mktemp)"
trap 'rm -f "$formula_list" "$arch_list"' EXIT

if [ "$FORMULAE" = "all" ]; then
  find "$TAP_ROOT/Formula" -maxdepth 1 -type f -name '*.rb' -print |
    sed -E 's|.*/([^/]+)\.rb$|\1|' |
    sort >"$formula_list"
else
  printf '%s\n' "$FORMULAE" | split_words | sort -u >"$formula_list"
fi

printf '%s\n' "$ARCHES" | split_words | sort -u >"$arch_list"

while IFS= read -r formula; do
  if ! valid_formula "$formula"; then
    echo "homebrew-plan-matrix.sh: invalid formula name: $formula" >&2
    exit 2
  fi
  if [ ! -f "$(formula_file_for "$formula")" ]; then
    echo "homebrew-plan-matrix.sh: Formula/$formula.rb does not exist in tap root" >&2
    exit 2
  fi
done <"$formula_list"

while IFS= read -r arch; do
  if ! valid_arch "$arch"; then
    echo "homebrew-plan-matrix.sh: invalid arch: $arch (expected wasm32 or wasm64)" >&2
    exit 2
  fi
done <"$arch_list"

{
  while IFS= read -r formula; do
    while IFS= read -r arch; do
      printf '%s\t%s\n' "$formula" "$arch"
    done <"$arch_list"
  done <"$formula_list"
} | jq -Rsc -c '
  split("\n")[:-1]
  | map(split("\t") | {formula: .[0], arch: .[1]})
'
