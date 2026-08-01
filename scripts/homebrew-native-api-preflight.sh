#!/usr/bin/env bash
# Prepare and verify the signed native Homebrew API used by bottle jobs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ORACLE="$SCRIPT_DIR/homebrew-native-api-contract.rb"
. "$SCRIPT_DIR/homebrew-native-bounded-environment.sh"

die() {
  echo "homebrew-native-api-preflight: $*" >&2
  exit 2
}

require_regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ] ||
    die "$1 must be a regular file"
}

policy_commit() {
  jq -er '
    if .schema == 1 and
       .kind == "kandelo-homebrew-native-roots" and
       .architecture == "x86_64_linux" and
       (.homebrew_commit | type == "string" and
         test("^[0-9a-f]{40}$")) and
       (.roots | type == "object")
    then .homebrew_commit
    else empty
    end
  ' "$1"
}

run_oracle() {
  local brew_bin="$1" cache_root="$2" state_root="$3"
  shift 3
  homebrew_native_bounded_run \
    "$brew_bin" "$cache_root" "$state_root" api-oracle \
    ruby "$ORACLE" "$@"
}

validate_roots() {
  local policy="$1" purpose="$2" roots="$3"
  require_regular_file "$roots"
  [ "$(wc -c <"$roots" | tr -d '[:space:]')" -le 65536 ] ||
    die "native root list exceeds the size limit"
  jq -e --arg purpose "$purpose" --rawfile text "$roots" '
    ($text | split("\n") | map(select(length > 0))) as $actual |
    ($actual == ($actual | sort | unique)) and
    ($actual | length <= 256) and
    (all($actual[]; test("^[a-z0-9][a-z0-9+@._-]{0,254}$"))) and
    (if $purpose == "all"
     then ([.roots[][]] | unique) == $actual
     else (.roots[$purpose] | type == "array") and
       (($actual - .roots[$purpose]) | length == 0)
     end)
  ' "$policy" >/dev/null ||
    die "native roots are not a sorted subset of purpose $purpose"
}

check_api_seal() {
  local api_root="$1" cache_root cache_state expected_cache_state
  [ -d "$api_root" ] && [ ! -L "$api_root" ] ||
    die "sealed Homebrew API cache is missing"
  cache_root="$(dirname "$api_root")"
  [ -d "$cache_root" ] && [ ! -L "$cache_root" ] ||
    die "sealed Homebrew API cache parent is missing"
  cache_state="$(stat -c '%u:%a' "$cache_root")" ||
    die "cannot inspect the sealed Homebrew API cache parent"
  expected_cache_state="$(id -u):755"
  [ "$cache_state" = "$expected_cache_state" ] ||
    die "sealed Homebrew API cache parent has state $cache_state," \
      "expected $expected_cache_state"
  if find "$api_root" -perm -0022 -print -quit | grep -q .; then
    die "sealed Homebrew API cache is group- or world-writable"
  fi
}

prepare() {
  [ "$#" -eq 6 ] ||
    die "usage: prepare BREW CACHE STATE POLICY PURPOSE ROOTS"
  local brew_bin="$1" cache_root="$2" state_root="$3"
  local policy="$4" purpose="$5" roots="$6" commit sudo_bin api_root

  [ -x "$brew_bin" ] ||
    die "reviewed brew must be executable"
  require_regular_file "$policy"
  commit="$(policy_commit "$policy")"
  validate_roots "$policy" "$purpose" "$roots"
  [ ! -e "$cache_root" ] && [ ! -L "$cache_root" ] ||
    die "cache directory must not already exist"
  [ ! -e "$state_root" ] && [ ! -L "$state_root" ] ||
    die "state directory must not already exist"
  # WHY: these roots later cross a privilege boundary and the API subtree is
  # made root-owned. Refusing every occupied leaf, including a dangling
  # symlink, prevents an earlier workflow step from redirecting that write or
  # making old signed state look like this realm's fresh snapshot.
  mkdir -m 0700 -- "$cache_root" "$state_root"
  mkdir -m 0700 -- \
    "$state_root/home" "$state_root/tmp" "$state_root/config"
  cp "$roots" "$state_root/roots.txt"
  chmod 0600 "$state_root/roots.txt"

  if [ ! -s "$state_root/roots.txt" ]; then
    printf '%s\n' empty >"$state_root/mode"
    return
  fi
  api_root="$cache_root/api"
  [ ! -e "$api_root" ] ||
    die "prepare requires a fresh Homebrew API cache"

  # Prime does the only network fetch. Exact Homebrew verifies both JWS
  # signatures and generates every lazy name/alias/executable helper before
  # the seal.
  run_oracle "$brew_bin" "$cache_root" "$state_root" \
    prime "$commit" "$state_root/prime.json"
  sudo_bin="${KANDELO_HOMEBREW_SUDO_BIN:-}"
  if [ -n "$sudo_bin" ]; then
    [ -x "$sudo_bin" ] || die "configured sudo executable is unavailable"
    "$sudo_bin" -n chown -R root:root "$api_root"
    "$sudo_bin" -n find "$api_root" -type d -exec chmod 0555 {} +
    "$sudo_bin" -n find "$api_root" -type f -exec chmod 0444 {} +
  else
    find "$api_root" -type d -exec chmod 0555 {} +
    find "$api_root" -type f -exec chmod 0444 {} +
  fi
  # WHY: the root-owned API subtree is the protected source, but the isolated
  # identity cannot inspect or bind-mount it unless every ancestor is
  # traversable. Keep the cache parent owned and writable only by this trusted
  # coordinator because Homebrew still needs it for later download-cache
  # entries; mode 0755 gives the separate Formula identity traversal without
  # permission to replace the sealed API subtree.
  chmod 0755 "$cache_root"
  check_api_seal "$api_root"
  run_oracle "$brew_bin" "$cache_root" "$state_root" \
    recheck "$commit" "$state_root/prime.json"
  printf '%s\n' populated >"$state_root/mode"
}

generate_lock() {
  [ "$#" -eq 7 ] ||
    die "usage: generate-lock BREW CACHE STATE POLICY ROOTS CLOSURE OUT"
  local brew_bin="$1" cache_root="$2" state_root="$3"
  local policy="$4" roots="$5" closure="$6" output="$7" commit

  require_regular_file "$policy"
  require_regular_file "$roots"
  require_regular_file "$closure"
  commit="$(policy_commit "$policy")"
  validate_roots "$policy" all "$roots"
  check_api_seal "$cache_root/api"
  run_oracle "$brew_bin" "$cache_root" "$state_root" \
    generate-lock "$commit" "$policy" "$roots" "$closure" \
    "$state_root/prime.json" "$output"
  run_oracle "$brew_bin" "$cache_root" "$state_root" \
    recheck "$commit" "$state_root/prime.json"
}

command="${1:-}"
[ -n "$command" ] || die "expected prepare or generate-lock"
shift
case "$command" in
  prepare) prepare "$@" ;;
  generate-lock) generate_lock "$@" ;;
  *) die "expected prepare or generate-lock" ;;
esac
