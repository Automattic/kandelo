#!/usr/bin/env bash
# Emit a JSON matrix of selected Homebrew formula/arch bottle builds.
set -euo pipefail

TAP_ROOT=""
FORMULAE="all"
ARCHES="wasm32"
METADATA_PATH=""
EXPECTED_CACHE_KEYS=""
EXPECTED_ABI=""
EXPECTED_BOTTLE_ROOT_URL=""
FORCE=0

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-plan-matrix.sh --tap-root <tap-root> [--formulae <list|all>] [--arches <list>] [--metadata <path>] [--expected-cache-keys <path> --expected-abi <N> --expected-bottle-root-url <url>] [--force]

Lists may be comma, space, or newline separated. Output is a JSON array of
{"formula": "...", "arch": "..."} entries.

When --expected-cache-keys is provided, entries whose current successful tap
metadata already carries the expected cache key under the exact expected ABI
and release tag and repository-rooted bottle URL are skipped unless --force is
set. The expected cache-key JSON may be either {"formula":"sha"} or
{"formula":{"wasm32":"sha","wasm64":"sha"}}.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --formulae) FORMULAE="${2:-}"; shift 2 ;;
    --arches) ARCHES="${2:-}"; shift 2 ;;
    --metadata) METADATA_PATH="${2:-}"; shift 2 ;;
    --expected-cache-keys) EXPECTED_CACHE_KEYS="${2:-}"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="${2:-}"; shift 2 ;;
    --expected-bottle-root-url) EXPECTED_BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
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
if [ -z "$(printf '%s' "$FORMULAE" | tr -d ',[:space:]')" ]; then
  echo "homebrew-plan-matrix.sh: formula selection must not be empty" >&2
  exit 2
fi
if [ -z "$(printf '%s' "$ARCHES" | tr -d ',[:space:]')" ]; then
  echo "homebrew-plan-matrix.sh: architecture selection must not be empty" >&2
  exit 2
fi
if [ -z "$METADATA_PATH" ]; then
  METADATA_PATH="$TAP_ROOT/Kandelo/metadata.json"
fi
if [ -n "$EXPECTED_CACHE_KEYS" ] && [ ! -f "$EXPECTED_CACHE_KEYS" ]; then
  echo "homebrew-plan-matrix.sh: expected cache-key file does not exist: $EXPECTED_CACHE_KEYS" >&2
  exit 2
fi
if [ -n "$EXPECTED_CACHE_KEYS" ]; then
  if ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] || [ "$EXPECTED_ABI" -gt 4294967295 ]; then
    echo "homebrew-plan-matrix.sh: --expected-abi is required with cache keys and must be a positive u32" >&2
    exit 2
  fi
  if ! [[ "$EXPECTED_BOTTLE_ROOT_URL" =~ ^https://ghcr\.io/v2/[a-z0-9._-]+/[a-z0-9._/-]+$ ]] ||
     [[ "$EXPECTED_BOTTLE_ROOT_URL" == */ ]]; then
    echo "homebrew-plan-matrix.sh: --expected-bottle-root-url is required with cache keys and must be a GHCR v2 root" >&2
    exit 2
  fi
elif [ -n "$EXPECTED_ABI" ]; then
  echo "homebrew-plan-matrix.sh: --expected-abi requires --expected-cache-keys" >&2
  exit 2
elif [ -n "$EXPECTED_BOTTLE_ROOT_URL" ]; then
  echo "homebrew-plan-matrix.sh: --expected-bottle-root-url requires --expected-cache-keys" >&2
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

matrix_candidates="$({
  while IFS= read -r formula; do
    while IFS= read -r arch; do
      printf '%s\t%s\n' "$formula" "$arch"
    done <"$arch_list"
  done <"$formula_list"
} | jq -Rsc -c '
  split("\n")[:-1]
  | map(split("\t") | {formula: .[0], arch: .[1]})
')"

metadata_json="null"
expected_json="null"
force_json="false"

if [ -n "$EXPECTED_CACHE_KEYS" ] && [ -f "$METADATA_PATH" ]; then
  metadata_json="$(jq -c . "$METADATA_PATH")"
fi
if [ -n "$EXPECTED_CACHE_KEYS" ]; then
  expected_json="$(jq -c . "$EXPECTED_CACHE_KEYS")"
fi
if [ "$FORCE" = "1" ]; then
  force_json="true"
fi

jq -c \
  --argjson metadata "$metadata_json" \
  --argjson expected "$expected_json" \
  --argjson force "$force_json" \
  --arg expected_abi "$EXPECTED_ABI" \
  --arg expected_bottle_root_url "$EXPECTED_BOTTLE_ROOT_URL" '
  def expected_key($formula; $arch):
    if $expected == null then
      null
    elif (($expected[$formula]? | type) == "string") then
      $expected[$formula]
    elif (($expected[$formula]? | type) == "object") and (($expected[$formula][$arch]? | type) == "string") then
      $expected[$formula][$arch]
    else
      null
    end;

  def current_key($formula; $arch):
    if $metadata == null or $expected_abi == "" or
       $metadata.kandelo_abi != ($expected_abi | tonumber) or
       $metadata.release_tag != ("bottles-abi-v" + $expected_abi) then
      null
    else
      [
        ($metadata.packages // [])[]?
        | select(.name == $formula)
        | (.bottles // [])[]?
        | select(
            .arch == $arch and ((.status // "success") == "success") and
            (.sha256 | type) == "string" and
            .url == ($expected_bottle_root_url + "/" + $formula +
              "/blobs/sha256:" + .sha256)
          )
        | .cache_key_sha // empty
      ][0] // null
    end;

  map(select(
    $force or
    (expected_key(.formula; .arch) == null) or
    (current_key(.formula; .arch) != expected_key(.formula; .arch))
  ))
' <<<"$matrix_candidates"
