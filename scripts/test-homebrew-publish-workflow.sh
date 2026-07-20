#!/usr/bin/env bash
# Focused checks for the trusted Homebrew publish workflow helper scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-publication-limits.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
TEST_FORBIDDEN_ROOT="/trusted/publisher/build-root"

fail() {
  echo "test-homebrew-publish-workflow.sh: $*" >&2
  exit 1
}

assert_ghcr_auth_env_does_not_cross_dev_shell() {
  local capture="$TMPDIR/ghcr-dev-shell-env.txt" nix_bin

  nix_bin="$(command -v nix || true)"
  if [ -z "$nix_bin" ]; then
    for candidate in /nix/var/nix/profiles/default/bin/nix "$HOME/.nix-profile/bin/nix"; do
      if [ -x "$candidate" ]; then
        nix_bin="$candidate"
        break
      fi
    done
  fi
  [ -n "$nix_bin" ] || fail "cannot exercise the GHCR dev-shell boundary without Nix"

  PATH="$(dirname "$nix_bin"):$PATH" \
    GHCR_AUTH_MODE=pat \
    GHCR_REQUIRE_PAT=true \
    GHCR_USER=package-bot \
    GHCR_DESTINATION_MODE=repository-canary \
    bash "$REPO_ROOT/scripts/dev-shell.sh" bash -c '
      printf "%s\n%s\n%s\n%s\n" \
        "${GHCR_AUTH_MODE:-}" \
        "${GHCR_REQUIRE_PAT:-}" \
        "${GHCR_USER:-}" \
        "${GHCR_DESTINATION_MODE:-}" >"$1"
    ' bash "$capture"

  cmp -s <(printf '\n\n\n\n') "$capture" ||
    fail "dev shell preserved Homebrew-only GHCR transport controls"
}

FORMULA_RUNNER_FIXTURE_ROOT="$TMPDIR/formula-runner-root"

make_formula_runner_fixture() {
  mkdir -p "$FORMULA_RUNNER_FIXTURE_ROOT/scripts" \
    "$FORMULA_RUNNER_FIXTURE_ROOT/homebrew/patches"
  cp "$REPO_ROOT/scripts/homebrew-bottle-build.sh" \
    "$REPO_ROOT/scripts/homebrew-verify-poured-bottle.sh" \
    "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$REPO_ROOT/scripts/homebrew-tap-identity.sh" \
    "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/"
  : >"$FORMULA_RUNNER_FIXTURE_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
  : >"$FORMULA_RUNNER_FIXTURE_ROOT/homebrew/patches/0002-support-isolated-publisher.patch"
  cat >"$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-patched-launcher.sh" <<'EOF'
HOMEBREW_PATCHED_BREW_BIN=""
HOMEBREW_PATCHED_PREFIX=""
HOMEBREW_PATCHED_NATIVE_PREFIX=""
HOMEBREW_PATCHED_NATIVE_HOME=""

homebrew_patched_launcher_select_host_git() {
  unset HOMEBREW_GIT_PATH
  HOMEBREW_GIT_PATH="$(command -v git || true)"
  [ -n "$HOMEBREW_GIT_PATH" ] || return 2
  export HOMEBREW_GIT_PATH
}

homebrew_patched_launcher_prepare() {
  HOMEBREW_PATCHED_BREW_BIN="$1"
  HOMEBREW_PATCHED_PREFIX="${FAKE_BREW_PREFIX:?}"
  mkdir -p "$HOMEBREW_PATCHED_PREFIX/Cellar"
}

homebrew_patched_launcher_snapshot_target_cellar_layout() {
  local rack rack_name keg
  for rack in "$HOMEBREW_PATCHED_PREFIX/Cellar"/*; do
    [ -e "$rack" ] || [ -L "$rack" ] || continue
    rack_name="${rack##*/}"
    printf 'rack:%s\n' "$rack_name"
    if [ -d "$rack" ] && [ ! -L "$rack" ]; then
      for keg in "$rack"/*; do
        [ -e "$keg" ] || [ -L "$keg" ] || continue
        printf 'keg:%s/%s\n' "$rack_name" "${keg##*/}"
      done
    fi
  done | LC_ALL=C sort
}

homebrew_patched_launcher_native_prefix_path() {
  printf '%s/p\n' "$1"
}

homebrew_patched_launcher_prepare_native_prefix() {
  HOMEBREW_PATCHED_NATIVE_PREFIX="$1"
  HOMEBREW_PATCHED_NATIVE_HOME="$5"
  mkdir -p "$@"
  if [ -n "${FAKE_NATIVE_PREFIX_CAPTURE:-}" ]; then
    printf '%s\n' "$HOMEBREW_PATCHED_NATIVE_PREFIX" >"$FAKE_NATIVE_PREFIX_CAPTURE"
  fi
  printf 'prepare-native\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
}

homebrew_patched_launcher_stage_dependency_plan() {
  printf 'stage-dependency-plan\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
}

homebrew_patched_launcher_seed_bundler_groups() {
  printf 'seed-bundler:%s\n' "$*" >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
}

homebrew_patched_launcher_isolate() {
  [ "$#" -ge 6 ] || return 2
  if [ -n "${FAKE_SYSROOT_BUILD_ROOT_CAPTURE:-}" ]; then
    printf '%s\n' "$6" >"$FAKE_SYSROOT_BUILD_ROOT_CAPTURE"
  fi
  printf 'isolate\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
}

homebrew_patched_launcher_run_native() {
  HOME="$HOMEBREW_PATCHED_NATIVE_HOME" FAKE_HOMEBREW_REALM=native \
    FAKE_NATIVE_PREFIX="$HOMEBREW_PATCHED_NATIVE_PREFIX" \
    HOMEBREW_RELOCATE_BUILD_PREFIX=1 \
    "$HOMEBREW_PATCHED_BREW_BIN" "$@"
}

homebrew_patched_launcher_seal_native_prefix() {
  printf 'seal-native\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
  if [ -n "${FAKE_REALM_COMMAND_LOG:-}" ]; then
    printf 'lifecycle|seal-native\n' >>"$FAKE_REALM_COMMAND_LOG"
  fi
}

homebrew_patched_launcher_bridge_native_formula() {
  printf 'bridge-native:%s\n' "$1" >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
  if [ -n "${FAKE_REALM_COMMAND_LOG:-}" ]; then
    printf 'lifecycle|bridge-native:%s\n' "$1" >>"$FAKE_REALM_COMMAND_LOG"
  fi
}

homebrew_patched_launcher_teardown() {
  printf 'teardown\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
}

homebrew_patched_launcher_verify_isolation() {
  printf 'verify-isolation\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
}

homebrew_patched_launcher_cleanup() {
  printf 'cleanup\n' >>"${FAKE_REALM_LIFECYCLE_LOG:?}"
  return "${FAKE_LAUNCHER_CLEANUP_STATUS:-0}"
}
EOF
}

make_tap() {
  local tap="$1"
  mkdir -p "$tap/Formula" "$tap/Kandelo"
  cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
end
EOF
  cat >"$tap/Kandelo/metadata.json" <<'EOF'
{"kandelo_abi":15,"release_tag":"bottles-abi-v15","packages":[]}
EOF
  git -C "$tap" init -q
  git -C "$tap" config user.name "Kandelo Test"
  git -C "$tap" config user.email "kandelo-test@example.invalid"
  git -C "$tap" add .
  git -C "$tap" commit -q -m "initial tap"
}

make_primary_resolved_tap_map() {
  local tap="$1" output="${1}.resolved-taps.json" commit
  commit="$(git -C "$tap" rev-parse HEAD)"
  cat >"$output" <<JSON
{
  "schema": 1,
  "primary": {
    "tap_name": "kandelo-dev/tap-core",
    "tap_repository": "kandelo-dev/homebrew-tap-core",
    "tap_commit": "$commit",
    "root": "$tap"
  },
  "dependencies": []
}
JSON
  chmod 0444 "$output"
  printf '%s\n' "$output"
}

assert_resolved_primary_override_is_bounded() {
  local root="$TMPDIR/resolved-primary-override"
  local planned="$root/planned"
  local current="$root/current"
  local dirty="$root/dirty"
  local unrelated="$root/unrelated"
  local provenance="$root/provenance.json"
  local resolved_taps planned_commit err

  mkdir -p "$root"
  make_tap "$planned"
  planned_commit="$(git -C "$planned" rev-parse HEAD)"
  resolved_taps="$(make_primary_resolved_tap_map "$planned")"
  jq -nS --arg tap_commit "$planned_commit" '{
    schema: 2,
    tap_repository: "kandelo-dev/homebrew-tap-core",
    tap_name: "kandelo-dev/tap-core",
    tap_commit: $tap_commit,
    bottle_root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
    bottle_tag: "wasm32_kandelo",
    formula: "hello",
    arch: "wasm32",
    dependencies: []
  }' >"$provenance"

  git clone -q "$planned" "$current"
  git -C "$current" config user.name "Kandelo Test"
  git -C "$current" config user.email "kandelo-test@example.invalid"
  printf 'safe concurrent tap state\n' >"$current/Kandelo/current-state.txt"
  git -C "$current" add Kandelo/current-state.txt
  git -C "$current" commit -q -m "advance current tap"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$provenance" \
      --tap-root "$current" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$planned_commit" \
      --formula hello \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core

  printf 'untracked drift\n' >"$current/Kandelo/untracked-state.txt"
  err="$root/untracked.err"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$provenance" \
      --tap-root "$current" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$planned_commit" \
      --formula hello \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>"$err"; then
    fail "dependency provenance accepted an untracked primary tap override"
  fi
  grep -F "primary tap override has working-tree changes" "$err" >/dev/null ||
    fail "dependency provenance did not explain an untracked primary tap override"

  git clone -q "$planned" "$dirty"
  printf '# tracked drift\n' >>"$dirty/Formula/hello.rb"
  err="$root/dirty.err"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$provenance" \
      --tap-root "$dirty" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$planned_commit" \
      --formula hello \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>"$err"; then
    fail "dependency provenance accepted a dirty primary tap override"
  fi
  grep -F "primary tap override has working-tree changes" "$err" >/dev/null ||
    fail "dependency provenance did not explain a dirty primary tap override"

  make_tap "$unrelated"
  printf '{"unrelated":true}\n' >"$unrelated/Kandelo/metadata.json"
  git -C "$unrelated" add Kandelo/metadata.json
  git -C "$unrelated" commit -q --amend --no-edit
  err="$root/unrelated.err"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$provenance" \
      --tap-root "$unrelated" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$planned_commit" \
      --formula hello \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>"$err"; then
    fail "dependency provenance accepted an unrelated primary tap override"
  fi
  grep -F "primary tap override HEAD is not a descendant of planned tap commit $planned_commit" \
    "$err" >/dev/null ||
    fail "dependency provenance did not explain an unrelated primary tap override"
}

assert_matrix() {
  local tap="$TMPDIR/matrix-tap"
  make_tap "$tap"
  local matrix
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32")"
  printf '%s\n' "$matrix" | jq -e '
    length == 2 and
    .[0] == {"formula":"hello","arch":"wasm32"} and
    .[1] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "unexpected matrix: $matrix"
  if bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" --formulae ' , ' --arches wasm32 >/dev/null 2>&1; then
    fail "planner accepted an empty Formula selection"
  fi
  if bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" --formulae hello --arches ' , ' >/dev/null 2>&1; then
    fail "planner accepted an empty architecture selection"
  fi
}

assert_matrix_skips_unchanged_cache_key() {
  local tap="$TMPDIR/matrix-skip-tap"
  local expected="$TMPDIR/expected-cache-keys.json"
  make_tap "$tap"
  cat >"$tap/Kandelo/metadata.json" <<'EOF'
{
  "kandelo_abi": 40,
  "release_tag": "bottles-abi-v40",
  "packages": [
    {
      "name": "hello",
      "bottles": [
        {
          "arch": "wasm32",
          "status": "success",
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "url": "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "cache_key_sha": "cache-key-current"
        },
        {
          "arch": "wasm64",
          "status": "success",
          "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "url": "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "cache_key_sha": "cache-key-old"
        }
      ]
    }
  ]
}
EOF
  cat >"$expected" <<'EOF'
{
  "hello": {
    "wasm32": "cache-key-current",
    "wasm64": "cache-key-new"
  }
}
EOF
  local matrix
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32" \
    --expected-cache-keys "$expected" \
    --expected-abi 40 \
    --expected-bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core)"
  printf '%s\n' "$matrix" | jq -e '
    length == 1 and
    .[0] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "expected unchanged wasm32 entry to be skipped: $matrix"

  jq '.packages[0].bottles[0].url =
    "https://ghcr.io/v2/kandelo-dev/tap-core/hello/blobs/sha256:" +
    .packages[0].bottles[0].sha256' \
    "$tap/Kandelo/metadata.json" >"$tap/Kandelo/metadata.json.tmp"
  mv "$tap/Kandelo/metadata.json.tmp" "$tap/Kandelo/metadata.json"
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm32" \
    --expected-cache-keys "$expected" \
    --expected-abi 40 \
    --expected-bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core)"
  printf '%s\n' "$matrix" | jq -e '
    . == [{"formula":"hello","arch":"wasm32"}]
  ' >/dev/null || fail "old-root cache metadata skipped the repository-root migration: $matrix"

  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32" \
    --expected-cache-keys "$expected" \
    --expected-abi 40 \
    --expected-bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --force)"
  printf '%s\n' "$matrix" | jq -e '
    length == 2 and
    .[0] == {"formula":"hello","arch":"wasm32"} and
    .[1] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "expected force to include unchanged cache keys: $matrix"

  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm32" \
    --expected-cache-keys "$expected" \
    --expected-abi 41 \
    --expected-bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core)"
  printf '%s\n' "$matrix" | jq -e '
    . == [{"formula":"hello","arch":"wasm32"}]
  ' >/dev/null || fail "older-ABI cache metadata skipped the new ABI build: $matrix"
}

assert_upload_dry_run() {
  local bottle="$TMPDIR/hello.bottle.tar.gz"
  local out="$TMPDIR/upload.env"
  printf 'bottle-bytes' >"$bottle"
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --bottle "$bottle" \
    --out-env "$out" \
    --dry-run >/dev/null
  # shellcheck disable=SC1090
  . "$out"
  [ "${BOTTLE_BYTES:-}" = "12" ] || fail "unexpected bottle byte count"
  case "${BOTTLE_URL:-}" in
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:*) ;;
    *) fail "unexpected bottle URL: ${BOTTLE_URL:-}" ;;
  esac
}

assert_upload_push_uses_relative_layer_path() {
  local bottle="$TMPDIR/hello.bottle.tar.gz"
  local out="$TMPDIR/upload.env"
  local bin="$TMPDIR/bin"
  local log="$TMPDIR/oras.log"
  local oras_configs oras_config
  printf 'bottle-bytes' >"$bottle"
  mkdir -p "$bin"
  cat >"$bin/oras" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$ORAS_LOG"
case "${1:-}" in
  login) cat >/dev/null ;;
  push) ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$bin/oras"
  ORAS_LOG="$log" GH_TOKEN="test-token" GITHUB_ACTOR="test-actor" \
    GITHUB_SHA="cccccccccccccccccccccccccccccccccccccccc" PATH="$bin:$PATH" \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --bottle "$bottle" \
      --out-env "$out" >/dev/null
  grep -F "push --registry-config " "$log" >/dev/null ||
    fail "oras push did not use isolated registry configuration"
  grep -F "ghcr.io/kandelo-dev/homebrew-tap-core/hello:bottles-abi-v15-wasm32-" "$log" >/dev/null ||
    fail "oras push was not invoked for the expected image"
  grep -F "hello.bottle.tar.gz:application/vnd.homebrew.bottle.layer.v1+gzip" "$log" >/dev/null ||
    fail "oras push did not use relative bottle layer path"
  ! grep -F "$bottle:application/vnd.homebrew.bottle.layer.v1+gzip" "$log" >/dev/null ||
    fail "oras push used an absolute bottle layer path"
  grep -F "org.opencontainers.image.revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$log" >/dev/null ||
    fail "oras push did not record the planned tap commit"
  grep -F "dev.kandelo.homebrew.kandelo_commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$log" >/dev/null ||
    fail "oras push did not record the planned Kandelo commit"
  ! grep -F "cccccccccccccccccccccccccccccccccccccccc" "$log" >/dev/null ||
    fail "oras push leaked the caller-context commit into provenance"
  oras_configs="$(sed -nE 's/.*--registry-config ([^ ]+).*/\1/p' "$log")"
  [ "$(printf '%s\n' "$oras_configs" | sed '/^$/d' | wc -l | tr -d '[:space:]')" = "2" ] ||
    fail "oras login and push did not both use isolated registry auth"
  [ "$(printf '%s\n' "$oras_configs" | sort -u | wc -l | tr -d '[:space:]')" = "1" ] ||
    fail "oras login and push used different registry auth files"
  oras_config="$(printf '%s\n' "$oras_configs" | head -n1)"
  [ ! -e "$oras_config" ] || fail "oras registry auth survived the upload command"
}

assert_sysroot_fingerprint_is_arch_specific() {
  local root="$TMPDIR/sysroot-fingerprint-root"
  local err="$TMPDIR/sysroot-fingerprint.err"
  local wasm32_sha wasm64_sha actual

  mkdir -p "$root/sysroot/lib" "$root/sysroot64/lib"
  printf 'wasm32 libc fixture\n' >"$root/sysroot/lib/libc.a"
  printf 'distinct wasm64 libc fixture\n' >"$root/sysroot64/lib/libc.a"
  wasm32_sha="$(shasum -a 256 "$root/sysroot/lib/libc.a" | awk '{print $1}')"
  wasm64_sha="$(shasum -a 256 "$root/sysroot64/lib/libc.a" | awk '{print $1}')"

  actual="$(bash "$REPO_ROOT/scripts/homebrew-sysroot-fingerprint.sh" \
    --kandelo-root "$root" --arch wasm64)"
  [ "$actual" = "$wasm64_sha" ] ||
    fail "wasm64 sidecar evidence fingerprinted the wrong target sysroot"
  [ "$actual" != "$wasm32_sha" ] ||
    fail "wasm64 sidecar evidence silently fingerprinted the wasm32 sysroot"

  rm "$root/sysroot64/lib/libc.a"
  if bash "$REPO_ROOT/scripts/homebrew-sysroot-fingerprint.sh" \
    --kandelo-root "$root" --arch wasm64 >/dev/null 2>"$err"; then
    fail "wasm64 sidecar evidence accepted an absent sysroot64 libc"
  fi
  grep -F "selected wasm64 sysroot libc must be a regular non-symlink file" "$err" >/dev/null ||
    fail "wasm64 sidecar evidence did not explain the absent sysroot64 libc"
}

assert_generator_validates_homebrew_commit_as_data() {
  local tap="$TMPDIR/generator-tap"
  local sidecars="$TMPDIR/generator-sidecars"
  local err="$TMPDIR/generator-brew-commit.err"
  local bottle="$TMPDIR/generator-bottle.tar.gz"
  local bottle_json="$TMPDIR/generator-bottle.json"
  local provenance="$TMPDIR/generator-dependency-provenance.json"
  local runtime_evidence="$TMPDIR/generator-runtime-evidence.json"
  local resolved_taps bottle_sha bottle_bytes abi nix_bin candidate

  make_tap "$tap"
  resolved_taps="$(make_primary_resolved_tap_map "$tap")"
  printf 'bottle\n' >"$bottle"
  printf '{}\n' >"$bottle_json"
  printf '{}\n' >"$provenance"
  printf '{}\n' >"$runtime_evidence"
  bottle_sha="$(sha256sum "$bottle" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$bottle" | awk '{print $1}')"
  bottle_bytes="$(wc -c <"$bottle" | tr -d '[:space:]')"
  abi="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
    "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"
  nix_bin="$(command -v nix || true)"
  if [ -z "$nix_bin" ]; then
    for candidate in /nix/var/nix/profiles/default/bin/nix "$HOME/.nix-profile/bin/nix"; do
      if [ -x "$candidate" ]; then
        nix_bin="$candidate"
        break
      fi
    done
  fi
  [ -n "$nix_bin" ] || fail "cannot exercise the dev-shell environment boundary without Nix"

  if PATH="$(dirname "$nix_bin"):$PATH" \
    HOMEBREW_BREW_COMMIT="not-a-commit" \
    KANDELO_HOMEBREW_TAP_ROOT="$tap" \
    KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$tap" \
    KANDELO_HOMEBREW_SIDECAR_ROOT="$sidecars" \
    KANDELO_HOMEBREW_FORMULA="hello" \
    KANDELO_HOMEBREW_ARCH="wasm32" \
    KANDELO_HOMEBREW_RELEASE_TAG="bottles-abi-v${abi}" \
    KANDELO_HOMEBREW_TAP_REPOSITORY="kandelo-dev/homebrew-tap-core" \
    KANDELO_HOMEBREW_TAP_NAME="kandelo-dev/tap-core" \
    KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$bottle" \
    KANDELO_HOMEBREW_BOTTLE_JSON="$bottle_json" \
    KANDELO_HOMEBREW_BOTTLE_ROOT_URL="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core" \
    KANDELO_HOMEBREW_BOTTLE_URL="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:${bottle_sha}" \
    KANDELO_HOMEBREW_BOTTLE_SHA256="$bottle_sha" \
    KANDELO_HOMEBREW_BOTTLE_BYTES="$bottle_bytes" \
    KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE="$provenance" \
    KANDELO_HOMEBREW_RUNTIME_EVIDENCE="$runtime_evidence" \
    KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON='["/trusted/publisher/build-root"]' \
    bash "$REPO_ROOT/scripts/dev-shell.sh" \
      env \
        KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
        KANDELO_HOMEBREW_TAP_NAME="kandelo-dev/tap-core" \
        KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON='["/trusted/publisher/build-root"]' \
      bash -c '
        [ "${KANDELO_HOMEBREW_RESOLVED_TAPS_FILE:-}" = "$1" ] || {
          echo "dev shell dropped the immutable resolved tap map" >&2
          exit 97
        }
        shift
        exec "$@"
      ' bash "$resolved_taps" \
        bash "$REPO_ROOT/scripts/homebrew-generate-sidecars-from-env.sh" \
      >"$err" 2>&1; then
    fail "sidecar generator accepted malformed Homebrew commit provenance"
  fi
  grep -F "invalid Homebrew commit: not-a-commit" "$err" >/dev/null || {
    cat "$err" >&2
    fail "sidecar generator did not explain malformed Homebrew commit provenance"
  }
  if grep -Eq 'HOMEBREW_BREW_FILE|brew info|bottle --merge|homebrew-patched-launcher' \
    "$REPO_ROOT/scripts/homebrew-generate-sidecars-from-env.sh"; then
    fail "post-build sidecar generator still evaluates Formula Ruby through Homebrew"
  fi
  grep -F -- "--keep HOMEBREW_BREW_COMMIT" "$REPO_ROOT/scripts/dev-shell.sh" >/dev/null ||
    fail "dev shell does not preserve the reviewed Homebrew commit"
}

make_build_handoff() {
  local handoff="$1"
  local extra_file_count="${BUILD_HANDOFF_EXTRA_FILE_COUNT:-0}"
  local dependency_provenance_source="${BUILD_HANDOFF_DEPENDENCY_PROVENANCE_SOURCE:-}"
  local formula_source="${BUILD_HANDOFF_FORMULA_SOURCE:-}"
  local source_dir="${handoff}.source"
  local bottle="$source_dir/hello--2.12.1.wasm32_kandelo.bottle.tar.gz"
  local bottle_json="$source_dir/hello--2.12.1.wasm32_kandelo.bottle.json"
  local dependency_provenance="$source_dir/dependency-provenance.json"
  local bottle_stage="$source_dir/stage/hello/2.12.1"
  local tap_repository="${BUILD_HANDOFF_TAP_REPOSITORY:-kandelo-dev/homebrew-tap-core}"
  local tap_name="${BUILD_HANDOFF_TAP_NAME:-kandelo-dev/tap-core}"
  local bottle_root="https://ghcr.io/v2/$(printf '%s' "$tap_repository" | tr '[:upper:]' '[:lower:]')"
  local formula_key="${tap_name}/hello"
  local formula_path="Library/Taps/${tap_name%%/*}/homebrew-${tap_name#*/}/Formula/hello.rb"
  local sha256

  mkdir -p "$bottle_stage/.brew" "$bottle_stage/bin"
  if [ -n "$formula_source" ]; then
    cp "$formula_source" "$bottle_stage/.brew/hello.rb"
  else
    cat >"$bottle_stage/.brew/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF
  fi
  if [ -n "$dependency_provenance_source" ]; then
    jq -S '{
      runtime_dependencies: [
        .dependencies[] | {declared_directly, full_name, version}
      ]
    }' "$dependency_provenance_source" >"$bottle_stage/INSTALL_RECEIPT.json"
  else
    printf '{"runtime_dependencies":[]}\n' >"$bottle_stage/INSTALL_RECEIPT.json"
  fi
  printf '#!/bin/sh\necho hello\n' >"$bottle_stage/bin/hello"
  chmod +x "$bottle_stage/bin/hello"
  cat >"$source_dir/hello.wat" <<'EOF'
(module
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const 18))
)
EOF
  wat2wasm "$source_dir/hello.wat" -o "$bottle_stage/bin/hello.wasm"
  chmod +x "$bottle_stage/bin/hello.wasm"
  tar -czf "$bottle" -C "$source_dir/stage" hello
  sha256="$(sha256sum "$bottle" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$bottle" | awk '{print $1}')"
  jq -n --arg sha256 "$sha256" --arg formula_key "$formula_key" \
    --arg formula_path "$formula_path" --arg bottle_root "$bottle_root" \
    --slurpfile receipt "$bottle_stage/INSTALL_RECEIPT.json" '{
    ($formula_key): {
      formula: {
        name: "hello",
        path: $formula_path,
        pkg_version: "2.12.1",
        tap_git_path: "Formula/hello.rb",
        tap_git_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        desc: "this artifact-only field must not reach Homebrew merge"
      },
      bottle: {
        root_url: $bottle_root,
        cellar: "any_skip_relocation",
        rebuild: 0,
        tags: {
          wasm32_kandelo: {
            local_filename: "hello--2.12.1.wasm32_kandelo.bottle.tar.gz",
            sha256: $sha256,
            tab: $receipt[0],
            path_exec_files: ["bin/hello"],
            all_files: [".brew/hello.rb", "INSTALL_RECEIPT.json", "bin/hello", "bin/hello.wasm"]
          }
        }
      }
    }
  }' >"$bottle_json"
  if [ "$extra_file_count" -gt 0 ]; then
    local expanded_json="$source_dir/expanded-bottle.json"
    jq --argjson count "$extra_file_count" '
      .[].bottle.tags.wasm32_kandelo.all_files += [
        range(0; $count) | "share/texmf-dist/fixture/path-\(.).tex"
      ]
    ' "$bottle_json" >"$expanded_json"
    mv "$expanded_json" "$bottle_json"
  fi
  if [ -n "$dependency_provenance_source" ]; then
    cp "$dependency_provenance_source" "$dependency_provenance"
  else
    jq -nS --arg tap_repository "$tap_repository" --arg tap_name "$tap_name" \
      --arg bottle_root "$bottle_root" '{
      schema: 2,
      formula: "hello",
      arch: "wasm32",
      tap_repository: $tap_repository,
      tap_name: $tap_name,
      tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bottle_root_url: $bottle_root,
      bottle_tag: "wasm32_kandelo",
      dependencies: []
    }' >"$dependency_provenance"
  fi

  bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository "$tap_repository" \
    --tap-name "$tap_name" \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url "$bottle_root" \
    --bottle "$bottle" \
    --bottle-json "$bottle_json" \
    --dependency-provenance "$dependency_provenance" \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out "$handoff" >/dev/null
}

assert_generic_tap_build_handoff_identity() {
  local handoff="$TMPDIR/generic-tap-build-handoff"
  local canonical_bottle_json="$TMPDIR/generic-tap-canonical-bottle.json"
  local tap="$TMPDIR/generic-tap-merge"
  BUILD_HANDOFF_TAP_REPOSITORY=Acme/homebrew-tools \
    BUILD_HANDOFF_TAP_NAME=acme/tools \
    make_build_handoff "$handoff"
  jq -e '
    .schema == 3 and
    .tap_repository == "Acme/homebrew-tools" and
    .tap_name == "acme/tools"
  ' "$handoff/manifest.json" >/dev/null ||
    fail "generic tap handoff conflated repository and Homebrew identities"
  jq -e '
    keys == ["acme/tools/hello"] and
    .["acme/tools/hello"].formula.path ==
      "Library/Taps/acme/homebrew-tools/Formula/hello.rb"
  ' "$handoff/bottle.json" >/dev/null ||
    fail "generic tap handoff used the GitHub repository as a Homebrew name"
  bash "$REPO_ROOT/scripts/homebrew-validate-build-handoff.sh" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Acme/homebrew-tools \
    --tap-name acme/tools \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/acme/homebrew-tools \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out-bottle-json "$canonical_bottle_json" >/dev/null
  mkdir -p "$tap/Formula"
  cat >"$tap/Formula/hello.rb" <<'RUBY'
class Hello < Formula
  desc "Generic tap merge fixture"
  homepage "https://example.invalid/hello"
  url "https://example.invalid/hello-2.12.1.tar.gz"
  sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
end
RUBY
  bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" \
    --tap-root "$tap" \
    --tap-repository Acme/homebrew-tools \
    --tap-name acme/tools \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --bottle-json "$canonical_bottle_json" \
    --expected-sha256 "$(jq -er '.hello.bottle.tags.wasm32_kandelo.sha256' "$canonical_bottle_json")" \
    --expected-root-url https://ghcr.io/v2/acme/homebrew-tools \
    --expected-cellar any_skip_relocation >/dev/null
  grep -F 'root_url "https://ghcr.io/v2/acme/homebrew-tools"' \
    "$tap/Formula/hello.rb" >/dev/null ||
    fail "generic tap merge did not use the repository-rooted GHCR namespace"
}

refresh_build_handoff_bottle_identity() {
  local handoff="$1"
  local archive="$handoff/bottle.tar.gz"
  local sha256 bytes tmp
  sha256="$(sha256sum "$archive" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$archive" | awk '{print $1}')"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  tmp="$handoff/manifest.json.tmp"
  jq --arg sha256 "$sha256" --argjson bytes "$bytes" \
    '.bottle.sha256 = $sha256 | .bottle.bytes = $bytes' \
    "$handoff/manifest.json" >"$tmp"
  mv "$tmp" "$handoff/manifest.json"
  tmp="$handoff/bottle.json.tmp"
  jq --arg sha256 "$sha256" \
    '.[].bottle.tags.wasm32_kandelo.sha256 = $sha256' \
    "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
}

validate_build_handoff() {
  local handoff="$1"
  shift
  bash "$REPO_ROOT/scripts/homebrew-validate-build-handoff.sh" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    "$@"
}

make_dry_upload_receipt() {
  local handoff="$1" receipt="$2"
  local mode="${3:-dry-run}"
  local sha256 bytes url layout canonical_sha
  sha256="$(jq -er '.bottle.sha256' "$handoff/manifest.json")"
  bytes="$(jq -er '.bottle.bytes' "$handoff/manifest.json")"
  url="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:$sha256"
  layout="${receipt}.layout"
  jq -nS \
    --arg sha256 "$sha256" \
    --argjson bytes "$bytes" \
    --arg url "$url" '{
      schema: 2,
      kind: "child",
      formula: "hello",
      arch: "wasm32",
      abi: 18,
      pkg_version: "2.12.1",
      formula_revision: 0,
      bottle_rebuild: 0,
      formula_source_sha256: ("1" * 64),
      formula_source_identity_sha256: ("2" * 64),
      source_closure_sha256: ("3" * 64),
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      tap_commit: ("a" * 40),
      kandelo_commit: ("b" * 40),
      top_ref: "2.12.1",
      bottle: {sha256: $sha256, bytes: $bytes, url: $url},
      oci: {
        config: {
          digest: ("sha256:" + ("4" * 64)),
          mediaType: "application/vnd.oci.image.config.v1+json",
          size: 1
        },
        diff_id: ("sha256:" + ("5" * 64)),
        homebrew_ref: "2.12.1.wasm32_kandelo",
        manifest: {digest: ("sha256:" + ("6" * 64)), size: 1},
        platform: {architecture: "wasm", os: "kandelo", variant: "wasm32"},
        transport_tag: ("sha256-" + ("6" * 64))
      }
    }' >"$layout"
  canonical_sha="$(jq -cS . "$layout" | sha256sum | awk '{print $1}')"
  jq -nS \
    --slurpfile layout "$layout" \
    --arg canonical_sha "$canonical_sha" \
    --arg mode "$mode" '{
      schema: 3,
      kind: "child",
      formula: "hello",
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      layout: $layout[0],
      layout_receipt_sha256: $canonical_sha,
      publication: {
        remote: "ghcr.io/kandelo-dev/homebrew-tap-core/hello",
        reference: ("sha256-" + ("6" * 64)),
        digest: ("sha256:" + ("6" * 64)),
        previous_digest: null,
        public_readback_digest: (
          if $mode == "dry-run" then null else ("sha256:" + ("6" * 64)) end
        ),
        status: $mode
      }
    }' >"$receipt"
  rm "$layout"
}

assert_build_handoff_is_minimal_and_validated() {
  local handoff="$TMPDIR/build-handoff-valid"
  local out_env="$TMPDIR/build-handoff-valid.env"
  local rawless_env="$TMPDIR/build-handoff-valid-rawless.env"
  local canonical_json="$TMPDIR/build-handoff-valid.bottle.json"
  local rebuild_seed="$TMPDIR/build-handoff-rebuild-seed"
  local rebuild_handoff="$TMPDIR/build-handoff-rebuild-valid"
  local rebuild_bottle="$TMPDIR/hello--2.12.1.wasm32_kandelo.bottle.1.tar.gz"
  local rebuild_json="$TMPDIR/hello--2.12.1.wasm32_kandelo.bottle.json"
  local rebuild_env="$TMPDIR/build-handoff-rebuild-valid.env"
  local files
  make_build_handoff "$handoff"
  validate_build_handoff "$handoff" --out-env "$rawless_env" >/dev/null
  ! grep -q '^BOTTLE_JSON=' "$rawless_env" ||
    fail "validated handoff env exposed raw artifact bottle JSON without reconstruction"
  validate_build_handoff "$handoff" \
    --out-env "$out_env" \
    --out-bottle-json "$canonical_json" >/dev/null

  files="$(find "$handoff" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort)"
  [ "$files" = $'bottle.json\nbottle.tar.gz\ndependency-provenance.json\nmanifest.json' ] ||
    fail "build handoff contains files outside its minimal data contract: $files"
  [ ! -e "$handoff/Formula" ] || fail "build handoff included formula source"
  [ ! -e "$handoff/build.env" ] || fail "build handoff included executable environment data"
  (
    # shellcheck disable=SC1090
    . "$out_env"
    [ "$FORMULA" = "hello" ] || fail "validated handoff env has the wrong formula"
    [ "$ARCH" = "wasm32" ] || fail "validated handoff env has the wrong arch"
    [ "$TAP_REPOSITORY" = "kandelo-dev/homebrew-tap-core" ] ||
      fail "validated handoff env has the wrong tap repository"
    [ "$BOTTLE_JSON" -ef "$canonical_json" ] ||
      fail "validated handoff env exposed raw artifact bottle JSON"
    [ "$BOTTLE_SHA256" = "$(sha256sum "$BOTTLE_ARCHIVE" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$BOTTLE_ARCHIVE" | awk '{print $1}')" ] ||
      fail "validated handoff env has the wrong archive SHA-256"
    [ "$BOTTLE_FILENAME" = "hello--2.12.1.wasm32_kandelo.bottle.tar.gz" ] ||
      fail "validated handoff env has the wrong Homebrew bottle filename"
    [ "$BOTTLE_BYTES" = "$(wc -c <"$BOTTLE_ARCHIVE" | tr -d '[:space:]')" ] ||
      fail "validated handoff env has the wrong archive byte count"
    [ "$BOTTLE_RELOCATION_CELLAR" = "any_skip_relocation" ] ||
      fail "validated handoff env lost the Homebrew relocation cellar"
    [ "$DEPENDENCY_PROVENANCE" -ef "$handoff/dependency-provenance.json" ] ||
      fail "validated handoff env lost dependency provenance"
  )
  jq -e --arg sha256 "$(jq -r '.bottle.sha256' "$handoff/manifest.json")" '
    keys == ["hello"] and
    (.hello | keys == ["bottle", "formula"]) and
    (.hello.formula | keys == ["name", "path", "pkg_version"]) and
    .hello.formula == {
      name: "hello",
      path: "Library/Taps/kandelo-dev/homebrew-tap-core/Formula/hello.rb",
      pkg_version: "2.12.1"
    } and
    (.hello.bottle | keys == ["cellar", "rebuild", "root_url", "tags"]) and
    .hello.bottle.root_url == "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core" and
    .hello.bottle.cellar == "any_skip_relocation" and
    .hello.bottle.rebuild == 0 and
    (.hello.bottle.tags | keys == ["wasm32_kandelo"]) and
    .hello.bottle.tags.wasm32_kandelo == {
      sha256: $sha256
    }
  ' "$canonical_json" >/dev/null ||
    fail "validator did not reconstruct the exact minimal Homebrew merge JSON"
  ! grep -q "artifact-only" "$canonical_json" ||
    fail "canonical bottle JSON copied untrusted artifact-only fields"

  make_build_handoff "$rebuild_seed"
  cp "$rebuild_seed/bottle.tar.gz" "$rebuild_bottle"
  jq '
    .[].bottle.rebuild = 1 |
    .[].bottle.tags.wasm32_kandelo.local_filename =
      "hello--2.12.1.wasm32_kandelo.bottle.1.tar.gz"
  ' "${rebuild_seed}.source/hello--2.12.1.wasm32_kandelo.bottle.json" \
    >"$rebuild_json"
  bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --bottle "$rebuild_bottle" \
    --bottle-json "$rebuild_json" \
    --dependency-provenance "${rebuild_seed}.source/dependency-provenance.json" \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out "$rebuild_handoff" >/dev/null
  validate_build_handoff "$rebuild_handoff" --out-env "$rebuild_env" >/dev/null
  (
    # shellcheck disable=SC1090
    . "$rebuild_env"
    [ "$BOTTLE_FILENAME" = "hello--2.12.1.wasm32_kandelo.bottle.1.tar.gz" ] ||
      fail "validated handoff put the bottle rebuild in the wrong filename position"
  )

  handoff="$TMPDIR/build-handoff-large-valid-json"
  BUILD_HANDOFF_EXTRA_FILE_COUNT=30000 make_build_handoff "$handoff"
  [ "$(wc -c <"$handoff/bottle.json" | tr -d '[:space:]')" -gt 1048576 ] ||
    fail "large bottle JSON fixture did not exceed the old 1 MiB bound"
  validate_build_handoff "$handoff" >/dev/null ||
    fail "build handoff validator rejected a valid large file inventory"
}

assert_build_handoff_rejects_untrusted_content() {
  local handoff err tmp renamed_bottle renamed_out zstd_bottle zstd_out invalid_gzip invalid_json invalid_out invalid_sha canonical_json out_env archive_stage stale_wat

  handoff="$TMPDIR/build-handoff-zstd-seed"
  make_build_handoff "$handoff"
  renamed_bottle="$TMPDIR/renamed.bottle.tar.gz"
  renamed_out="$TMPDIR/build-handoff-renamed"
  cp "$handoff/bottle.tar.gz" "$renamed_bottle"
  if bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --bottle "$renamed_bottle" \
    --bottle-json "${handoff}.source/hello--2.12.1.wasm32_kandelo.bottle.json" \
    --dependency-provenance "${handoff}.source/dependency-provenance.json" \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out "$renamed_out" >/dev/null 2>&1; then
    fail "build handoff creator accepted a bottle renamed after Homebrew built it"
  fi
  zstd_bottle="$TMPDIR/hello--2.12.1.wasm32_kandelo.bottle.tar.zst"
  zstd_out="$TMPDIR/build-handoff-zstd"
  cp "$handoff/bottle.tar.gz" "$zstd_bottle"
  if bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --bottle "$zstd_bottle" \
    --bottle-json "${handoff}.source/hello--2.12.1.wasm32_kandelo.bottle.json" \
    --dependency-provenance "${handoff}.source/dependency-provenance.json" \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out "$zstd_out" >/dev/null 2>&1; then
    fail "build handoff creator accepted a zstd bottle for the gzip-only publisher"
  fi

  invalid_gzip="$TMPDIR/hello--2.12.1.wasm32_kandelo.bottle.tar.gz"
  invalid_json="$TMPDIR/invalid-gzip.bottle.json"
  invalid_out="$TMPDIR/build-handoff-invalid-gzip"
  printf 'not gzip bytes\n' >"$invalid_gzip"
  invalid_sha="$(sha256sum "$invalid_gzip" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$invalid_gzip" | awk '{print $1}')"
  jq --arg sha256 "$invalid_sha" \
    '.[].bottle.tags.wasm32_kandelo.sha256 = $sha256' \
    "${handoff}.source/hello--2.12.1.wasm32_kandelo.bottle.json" >"$invalid_json"
  if bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --bottle "$invalid_gzip" \
    --bottle-json "$invalid_json" \
    --dependency-provenance "${handoff}.source/dependency-provenance.json" \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out "$invalid_out" >/dev/null 2>&1; then
    fail "build handoff creator accepted non-gzip bytes under a gzip filename"
  fi

  handoff="$TMPDIR/build-handoff-extra"
  make_build_handoff "$handoff"
  printf 'FORMULA=untrusted\n' >"$handoff/build.env"
  err="$TMPDIR/build-handoff-extra.err"
  if validate_build_handoff "$handoff" > /dev/null 2>"$err"; then
    fail "build handoff validator accepted an extra environment file"
  fi
  grep -q "exactly four files" "$err" ||
    fail "build handoff validator did not explain the extra file"

  handoff="$TMPDIR/build-handoff-symlink"
  make_build_handoff "$handoff"
  rm "$handoff/bottle.json"
  ln -s manifest.json "$handoff/bottle.json"
  err="$TMPDIR/build-handoff-symlink.err"
  if validate_build_handoff "$handoff" > /dev/null 2>"$err"; then
    fail "build handoff validator accepted a symlinked bottle JSON"
  fi
  grep -q "non-symlink" "$err" ||
    fail "build handoff validator did not explain the symlink"

  handoff="$TMPDIR/build-handoff-identity"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-identity.json"
  jq '.tap_commit = "cccccccccccccccccccccccccccccccccccccccc"' \
    "$handoff/manifest.json" >"$tmp"
  mv "$tmp" "$handoff/manifest.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a manifest from a different tap commit"
  fi

  handoff="$TMPDIR/build-handoff-archive-tamper"
  make_build_handoff "$handoff"
  printf 'tampered\n' >>"$handoff/bottle.tar.gz"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted modified bottle bytes"
  fi

  handoff="$TMPDIR/build-handoff-link-escape"
  make_build_handoff "$handoff"
  archive_stage="$TMPDIR/build-handoff-link-escape.stage"
  mkdir -p "$archive_stage"
  tar -xzf "$handoff/bottle.tar.gz" -C "$archive_stage"
  ln -s ../../../outside "$archive_stage/hello/2.12.1/bin/escape"
  tar -czf "$handoff/bottle.tar.gz" -C "$archive_stage" hello
  refresh_build_handoff_bottle_identity "$handoff"
  out_env="$TMPDIR/build-handoff-link-escape.env"
  err="$TMPDIR/build-handoff-link-escape.err"
  if validate_build_handoff "$handoff" --out-env "$out_env" >/dev/null 2>"$err"; then
    fail "build handoff validator accepted a bottle link escaping its payload"
  fi
  grep -q "escapes payload root" "$err" ||
    fail "build handoff validator did not explain the escaping archive link"
  [ ! -e "$out_env" ] ||
    fail "build handoff validator produced uploader data for an unsafe archive"

  handoff="$TMPDIR/build-handoff-build-root-leak"
  make_build_handoff "$handoff"
  archive_stage="$TMPDIR/build-handoff-build-root-leak.stage"
  mkdir -p "$archive_stage"
  tar -xzf "$handoff/bottle.tar.gz" -C "$archive_stage"
  printf '#!/bin/sh\nsource_dir=%s/source\n' "$TEST_FORBIDDEN_ROOT" \
    >"$archive_stage/hello/2.12.1/bin/hello"
  tar -czf "$handoff/bottle.tar.gz" -C "$archive_stage" hello
  refresh_build_handoff_bottle_identity "$handoff"
  out_env="$TMPDIR/build-handoff-build-root-leak.env"
  err="$TMPDIR/build-handoff-build-root-leak.err"
  if validate_build_handoff "$handoff" --out-env "$out_env" >/dev/null 2>"$err"; then
    fail "build handoff validator accepted an installed build-root leak"
  fi
  grep -F "bin/hello' contains forbidden build root '$TEST_FORBIDDEN_ROOT'" "$err" >/dev/null ||
    fail "build handoff validator did not explain the installed build-root leak"
  [ ! -e "$out_env" ] ||
    fail "build handoff validator produced uploader data for a build-root leak"

  handoff="$TMPDIR/build-handoff-hidden-receipt-dependency"
  make_build_handoff "$handoff"
  archive_stage="$TMPDIR/build-handoff-hidden-receipt-dependency.stage"
  mkdir -p "$archive_stage"
  tar -xzf "$handoff/bottle.tar.gz" -C "$archive_stage"
  tmp="$TMPDIR/build-handoff-hidden-receipt-dependency.json"
  jq '.runtime_dependencies = [{
    full_name: "example/tools/bubblewrap",
    version: "0.11.2",
    declared_directly: true
  }]' "$archive_stage/hello/2.12.1/INSTALL_RECEIPT.json" >"$tmp"
  mv "$tmp" "$archive_stage/hello/2.12.1/INSTALL_RECEIPT.json"
  tar -czf "$handoff/bottle.tar.gz" -C "$archive_stage" hello
  refresh_build_handoff_bottle_identity "$handoff"
  out_env="$TMPDIR/build-handoff-hidden-receipt-dependency.env"
  err="$TMPDIR/build-handoff-hidden-receipt-dependency.err"
  if validate_build_handoff "$handoff" --out-env "$out_env" >/dev/null 2>"$err"; then
    fail "build handoff validator accepted receipt dependencies omitted from provenance"
  fi
  grep -F "bottle receipt runtime dependencies do not match validated dependency provenance" \
    "$err" >/dev/null ||
    fail "build handoff validator did not explain the receipt/provenance mismatch"
  [ ! -e "$out_env" ] ||
    fail "build handoff validator produced uploader data for mismatched dependency provenance"

  handoff="$TMPDIR/build-handoff-stale-abi"
  make_build_handoff "$handoff"
  archive_stage="$TMPDIR/build-handoff-stale-abi.stage"
  stale_wat="$TMPDIR/build-handoff-stale-abi.wat"
  mkdir -p "$archive_stage"
  tar -xzf "$handoff/bottle.tar.gz" -C "$archive_stage"
  cat >"$stale_wat" <<'EOF'
(module
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const 17))
)
EOF
  wat2wasm "$stale_wat" \
    -o "$archive_stage/hello/2.12.1/bin/hello.wasm"
  chmod +x "$archive_stage/hello/2.12.1/bin/hello.wasm"
  tar -czf "$handoff/bottle.tar.gz" -C "$archive_stage" hello
  refresh_build_handoff_bottle_identity "$handoff"
  out_env="$TMPDIR/build-handoff-stale-abi.env"
  err="$TMPDIR/build-handoff-stale-abi.err"
  if validate_build_handoff "$handoff" --out-env "$out_env" >/dev/null 2>"$err"; then
    fail "build handoff validator accepted a stale executable ABI"
  fi
  grep -q "executable ABI 17 does not match expected ABI 18" "$err" ||
    fail "build handoff validator did not explain the stale executable ABI"
  [ ! -e "$out_env" ] ||
    fail "build handoff validator produced uploader data for a stale executable ABI"

  handoff="$TMPDIR/build-handoff-dependency-tamper"
  make_build_handoff "$handoff"
  jq '.tap_commit = "cccccccccccccccccccccccccccccccccccccccc"' \
    "$handoff/dependency-provenance.json" >"$tmp"
  mv "$tmp" "$handoff/dependency-provenance.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted modified dependency provenance"
  fi

  handoff="$TMPDIR/build-handoff-json-sha"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-json-sha.json"
  jq '.[].bottle.tags.wasm32_kandelo.sha256 =
      "0000000000000000000000000000000000000000000000000000000000000000"' \
    "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a bottle JSON SHA that differs from the archive"
  fi

  handoff="$TMPDIR/build-handoff-local-filename"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-local-filename.json"
  jq '.[].bottle.tags.wasm32_kandelo.local_filename = "bottle.tar.gz"' \
    "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  err="$TMPDIR/build-handoff-local-filename.err"
  out_env="$TMPDIR/build-handoff-local-filename.env"
  if validate_build_handoff "$handoff" --out-env "$out_env" >/dev/null 2>"$err"; then
    fail "build handoff validator accepted a noncanonical Homebrew bottle filename"
  fi
  grep -F "bottle local filename does not match Homebrew bottle metadata" \
    "$err" >/dev/null ||
    fail "build handoff validator did not explain the noncanonical bottle filename"
  [ ! -e "$out_env" ] ||
    fail "build handoff validator exported a noncanonical Homebrew bottle filename"

  handoff="$TMPDIR/build-handoff-formula-path"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-formula-path.json"
  jq '.[].formula.path = "Formula/hello.rb"' "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a non-canonical tap formula path"
  fi

  handoff="$TMPDIR/build-handoff-version-control"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-version-control.json"
  canonical_json="$TMPDIR/build-handoff-version-control.canonical.json"
  jq '.[].formula.pkg_version = "\u0000oops"' "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  if validate_build_handoff "$handoff" --out-bottle-json "$canonical_json" >/dev/null 2>&1; then
    fail "build handoff validator accepted a control character in pkg_version"
  fi
  [ ! -e "$canonical_json" ] ||
    fail "build handoff validator emitted canonical JSON for an invalid pkg_version"

  handoff="$TMPDIR/build-handoff-large-manifest"
  make_build_handoff "$handoff"
  head -c 65537 /dev/zero | tr '\0' ' ' >>"$handoff/manifest.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a manifest larger than 64 KiB"
  fi

  handoff="$TMPDIR/build-handoff-large-json"
  make_build_handoff "$handoff"
  head -c 16777217 /dev/zero | tr '\0' ' ' >>"$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted bottle JSON larger than 16 MiB"
  fi

  handoff="$TMPDIR/build-handoff-large-bottle"
  make_build_handoff "$handoff"
  truncate -s 2147483649 "$handoff/bottle.tar.gz"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a compressed bottle larger than 2 GiB"
  fi

  handoff="$TMPDIR/build-handoff-large-dependency-provenance"
  make_build_handoff "$handoff"
  truncate -s 1048577 "$handoff/dependency-provenance.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted dependency provenance larger than 1 MiB"
  fi
}

assert_upload_receipt_is_bound_to_build_handoff() {
  local handoff="$TMPDIR/upload-receipt-handoff"
  local receipt="$TMPDIR/upload-receipt.json"
  local out_env="$TMPDIR/upload-receipt.env"
  local canonical_json="$TMPDIR/upload-receipt.bottle.json"
  local colliding_output="$TMPDIR/upload-receipt-collision.out"
  local bad_receipt="$TMPDIR/upload-receipt-bad.json"
  make_build_handoff "$handoff"

  make_dry_upload_receipt "$handoff" "$receipt"

  bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --allow-dry-run \
    --out-env "$out_env" \
    --out-bottle-json "$canonical_json" >/dev/null
  (
    # shellcheck disable=SC1090
    . "$out_env"
    [ "$BOTTLE_URL" = "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/hello/blobs/sha256:${BOTTLE_SHA256}" ] ||
      fail "validated receipt env has the wrong bottle URL"
    [ "$BOTTLE_FILENAME" = "hello--2.12.1.wasm32_kandelo.bottle.tar.gz" ] ||
      fail "validated receipt env lost the Homebrew bottle filename"
    [ "$BOTTLE_JSON" -ef "$canonical_json" ] ||
      fail "validated receipt env exposed raw artifact bottle JSON"
  )

  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --allow-dry-run \
    --out-env "$colliding_output" \
    --out-bottle-json "$colliding_output" >/dev/null 2>&1; then
    fail "upload receipt validator accepted colliding output paths"
  fi
  [ ! -e "$colliding_output" ] ||
    fail "upload receipt validator wrote a colliding output before rejecting it"

  jq '.unexpected = true' "$receipt" >"$bad_receipt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$bad_receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --allow-dry-run >/dev/null 2>&1; then
    fail "upload receipt validator accepted an undeclared field"
  fi

  jq '.layout.bottle.bytes += 1' "$receipt" >"$bad_receipt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$bad_receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --allow-dry-run >/dev/null 2>&1; then
    fail "upload receipt validator accepted a byte count not backed by the build handoff"
  fi

  cp "$receipt" "$bad_receipt"
  head -c 65537 /dev/zero | tr '\0' ' ' >>"$bad_receipt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$bad_receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --allow-dry-run >/dev/null 2>&1; then
    fail "upload receipt validator accepted a receipt larger than 64 KiB"
  fi
}

make_publish_dependency_provenance() {
  local tap_root="$1" output="$2" directness="$3"
  local xz_direct=false zlib_direct=true xz_formula_sha zlib_formula_sha
  case "$directness" in
    valid) ;;
    direct-false) zlib_direct=false ;;
    transitive-true) xz_direct=true ;;
    *) fail "unknown publish dependency directness fixture: $directness" ;;
  esac
  xz_formula_sha="$(sha256sum "$tap_root/Formula/xz.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/xz.rb" | awk '{print $1}')"
  zlib_formula_sha="$(sha256sum "$tap_root/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/zlib.rb" | awk '{print $1}')"
  jq -nS \
    --arg xz_formula_sha "$xz_formula_sha" --arg zlib_formula_sha "$zlib_formula_sha" \
    --argjson xz_direct "$xz_direct" --argjson zlib_direct "$zlib_direct" '{
      schema: 2,
      formula: "hello",
      arch: "wasm32",
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bottle_root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
      bottle_tag: "wasm32_kandelo",
      dependencies: [
        {
          name: "xz",
          full_name: "kandelo-dev/tap-core/xz",
          version: "5.6.2",
          declared_directly: $xz_direct,
          formula: {path: "Formula/xz.rb", sha256: $xz_formula_sha},
          bottle: {
            cellar: "any_skip_relocation",
            rebuild: 0,
            sha256: "2222222222222222222222222222222222222222222222222222222222222222",
            tag: "wasm32_kandelo",
            url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/xz/blobs/sha256:2222222222222222222222222222222222222222222222222222222222222222"
          },
          receipt: {
            built_as_bottle: true,
            homebrew_version: "Homebrew fixture",
            installed_on_request: false,
            path: "Cellar/xz/5.6.2/INSTALL_RECEIPT.json",
            poured_from_bottle: true,
            sha256: "3333333333333333333333333333333333333333333333333333333333333333",
            source_tap: "kandelo-dev/tap-core",
            source_tap_git_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          install_log: {
            fetch: ["==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/xz/manifests/5.6.2"],
            pour: ["Pouring xz--5.6.2.wasm32_kandelo.bottle.tar.gz"],
            source_build_absent: true
          }
        },
        {
          name: "zlib",
          full_name: "kandelo-dev/tap-core/zlib",
          version: "1.3.1",
          declared_directly: $zlib_direct,
          formula: {path: "Formula/zlib.rb", sha256: $zlib_formula_sha},
          bottle: {
            cellar: "any_skip_relocation",
            rebuild: 0,
            sha256: "1111111111111111111111111111111111111111111111111111111111111111",
            tag: "wasm32_kandelo",
            url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:1111111111111111111111111111111111111111111111111111111111111111"
          },
          receipt: {
            built_as_bottle: true,
            homebrew_version: "Homebrew fixture",
            installed_on_request: false,
            path: "Cellar/zlib/1.3.1/INSTALL_RECEIPT.json",
            poured_from_bottle: true,
            sha256: "4444444444444444444444444444444444444444444444444444444444444444",
            source_tap: "kandelo-dev/tap-core",
            source_tap_git_head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          install_log: {
            fetch: ["==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1"],
            pour: ["Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz"],
            source_build_absent: true
          }
        }
      ]
    }' >"$output"
}

seed_publish_dependency_sidecars() {
  local tap_root="$1" metadata="$tap_root/Kandelo/metadata.json"
  local xz_formula_sha zlib_formula_sha
  xz_formula_sha="$(sha256sum "$tap_root/Formula/xz.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/xz.rb" | awk '{print $1}')"
  zlib_formula_sha="$(sha256sum "$tap_root/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/zlib.rb" | awk '{print $1}')"
  mkdir -p "$tap_root/Kandelo/formula" "$tap_root/Kandelo/link"
  printf '{}\n' >"$tap_root/Kandelo/link/xz-5.6.2-rebuild0-wasm32.json"
  printf '{}\n' >"$tap_root/Kandelo/link/zlib-1.3.1-rebuild0-wasm32.json"
  jq -nS \
    --arg xz_formula_sha "$xz_formula_sha" --arg zlib_formula_sha "$zlib_formula_sha" '
      def bottle($name; $sha; $formula_sha; $link): {
        arch: "wasm32",
        bottle_tag: "wasm32_kandelo",
        kandelo_abi: 18,
        cellar: "/home/linuxbrew/.linuxbrew/Cellar",
        prefix: "/home/linuxbrew/.linuxbrew",
        runtime_support: ["node"],
        browser_compatible: false,
        fork_instrumentation: "not-required",
        status: "failed",
        built_by: "https://example.invalid/actions/runs/1",
        built_from: {
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          tap_repository: "kandelo-dev/homebrew-tap-core",
          tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          formula_sha256: $formula_sha
        },
        error: "fixture retained last green bottle",
        last_attempt: "2026-07-12T00:00:00Z",
        last_attempt_by: "https://example.invalid/actions/runs/2",
        fallback_url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/" + $name + "/blobs/sha256:" + $sha),
        fallback_sha256: $sha,
        fallback_bytes: 123,
        fallback_cache_key_sha: $sha,
        fallback_link_manifest: $link,
        fallback_built_at: "2026-07-11T00:00:00Z"
      };
      {
        schema: 1,
        tap_repository: "kandelo-dev/homebrew-tap-core",
        tap_name: "kandelo-dev/tap-core",
        tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kandelo_repository: "Automattic/kandelo",
        kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        kandelo_abi: 18,
        release_tag: "bottles-abi-v18",
        generated_at: "2026-07-12T00:00:00Z",
        generator: "workflow dependency fixture",
        packages: [
          {
            name: "xz",
            full_name: "kandelo-dev/tap-core/xz",
            version: "5.6.2",
            formula_revision: 0,
            bottle_rebuild: 0,
            formula_path: "Formula/xz.rb",
            formula_metadata: "Kandelo/formula/xz.json",
            dependencies: [],
            bottles: [bottle("xz"; "2222222222222222222222222222222222222222222222222222222222222222"; $xz_formula_sha; "Kandelo/link/xz-5.6.2-rebuild0-wasm32.json")]
          },
          {
            name: "zlib",
            full_name: "kandelo-dev/tap-core/zlib",
            version: "1.3.1",
            formula_revision: 0,
            bottle_rebuild: 0,
            formula_path: "Formula/zlib.rb",
            formula_metadata: "Kandelo/formula/zlib.json",
            dependencies: [{
              name: "xz",
              full_name: "kandelo-dev/tap-core/xz",
              version: "5.6.2"
            }],
            bottles: [bottle("zlib"; "1111111111111111111111111111111111111111111111111111111111111111"; $zlib_formula_sha; "Kandelo/link/zlib-1.3.1-rebuild0-wasm32.json")]
          }
        ]
      }
    ' >"$metadata"
  jq -S '{
    schema, tap_repository, tap_name, tap_commit, kandelo_abi,
    source_metadata: "Kandelo/metadata.json"
  } + (.packages[0] | del(.formula_metadata))' "$metadata" >"$tap_root/Kandelo/formula/xz.json"
  jq -S '{
    schema, tap_repository, tap_name, tap_commit, kandelo_abi,
    source_metadata: "Kandelo/metadata.json"
  } + (.packages[1] | del(.formula_metadata))' "$metadata" >"$tap_root/Kandelo/formula/zlib.json"
}

make_publish_handoff() {
  local handoff="$1" tap_root="$2"
  local build_stage="${handoff}.build"
  local extra_link_count="${PUBLISH_HANDOFF_EXTRA_LINK_COUNT:-0}"
  local dependency_mode="${PUBLISH_HANDOFF_DEPENDENCY_MODE:-none}"
  local seed_dependency_sidecars="${PUBLISH_HANDOFF_SEED_DEPENDENCY_SIDECARS:-0}"
  local selected_formula_source="${PUBLISH_HANDOFF_FORMULA_SOURCE:-}"
  local archived_formula_source="${PUBLISH_HANDOFF_ARCHIVED_FORMULA_SOURCE:-}"
  local dependency_provenance_source="${handoff}.dependency-provenance.json"
  local composition_dependencies='[]'
  local bottle_sha bottle_bytes bottle_url formula_sha archived_formula_sha

  rm -rf "$handoff" "$tap_root" "$build_stage" "$dependency_provenance_source"
  mkdir -p "$tap_root/Formula" "$handoff/composition"
  if [ "$dependency_mode" = "none" ]; then
    if [ -n "$selected_formula_source" ]; then
      cp "$selected_formula_source" "$tap_root/Formula/hello.rb"
    else
      cat >"$tap_root/Formula/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF
    fi
  else
    cat >"$tap_root/Formula/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
  depends_on "kandelo-dev/tap-core/zlib"
end
EOF
    cat >"$tap_root/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  desc "direct dependency fixture"
  depends_on "kandelo-dev/tap-core/xz"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
    cat >"$tap_root/Formula/xz.rb" <<'EOF'
class Xz < Formula
  desc "transitive dependency fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"
  end
end
EOF
    make_publish_dependency_provenance \
      "$tap_root" "$dependency_provenance_source" "$dependency_mode"
    composition_dependencies='[{"name":"zlib","full_name":"kandelo-dev/tap-core/zlib","version":"1.3.1"}]'
    if [ "$seed_dependency_sidecars" = "1" ]; then
      seed_publish_dependency_sidecars "$tap_root"
    fi
  fi
  formula_sha="$(sha256sum "$tap_root/Formula/hello.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/hello.rb" | awk '{print $1}')"
  if [ "$dependency_mode" = "none" ]; then
    if [ -n "$archived_formula_source" ]; then
      BUILD_HANDOFF_FORMULA_SOURCE="$archived_formula_source" \
        make_build_handoff "$build_stage"
      archived_formula_sha="$(sha256sum "$archived_formula_source" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$archived_formula_source" | awk '{print $1}')"
    else
      make_build_handoff "$build_stage"
      archived_formula_sha="$formula_sha"
    fi
  else
    BUILD_HANDOFF_DEPENDENCY_PROVENANCE_SOURCE="$dependency_provenance_source" \
      BUILD_HANDOFF_FORMULA_SOURCE="$tap_root/Formula/hello.rb" \
      make_build_handoff "$build_stage"
    archived_formula_sha="$formula_sha"
  fi
  mv "$build_stage" "$handoff/build"
  make_dry_upload_receipt "$handoff/build" "$handoff/receipt.json" already-present

  bottle_sha="$(jq -r '.layout.bottle.sha256' "$handoff/receipt.json")"
  bottle_bytes="$(jq -r '.layout.bottle.bytes' "$handoff/receipt.json")"
  bottle_url="$(jq -r '.layout.bottle.url' "$handoff/receipt.json")"
  jq -nS \
    --arg sha "$bottle_sha" --arg bytes "$bottle_bytes" --arg url "$bottle_url" \
    --arg formula_sha "$formula_sha" --arg archived_formula_sha "$archived_formula_sha" \
    --argjson dependencies "$composition_dependencies" '{
      schema: 1,
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      kandelo_abi: 18,
      release_tag: "bottles-abi-v18",
      generated_at: "2026-07-12T00:00:00Z",
      generator: "workflow fixture",
      packages: [{
        name: "hello",
        full_name: "kandelo-dev/tap-core/hello",
        version: "2.12.1",
        formula_revision: 0,
        bottle_rebuild: 0,
        formula_path: "Formula/hello.rb",
        formula_source_sha256: $formula_sha,
        dependencies: $dependencies,
        bottles: [{
          arch: "wasm32",
          bottle_tag: "wasm32_kandelo",
          cellar: "/home/linuxbrew/.linuxbrew/Cellar",
          prefix: "/home/linuxbrew/.linuxbrew",
          runtime_support: ["node"],
          browser_compatible: false,
          fork_instrumentation: "not-required",
          status: "success",
          built_by: "https://example.invalid/actions/runs/1",
          built_at: "2026-07-12T00:00:00Z",
          bottle_file: "../build/bottle.tar.gz",
          archived_formula_sha256: $archived_formula_sha,
          url: $url,
          cache_key_sha: $sha,
          payload_root: "hello/2.12.1",
          links: [{type: "symlink", source: "bin/hello", target: "bin/hello"}],
          receipts: [".brew/hello.rb", "INSTALL_RECEIPT.json"],
          env: {PATH_prepend: ["bin"]},
          build: {
            github_run: "https://example.invalid/actions/runs/1",
            job: "verify-bottle",
            runner_os: "linux",
            brew_version: "Homebrew fixture",
            dev_shell: "scripts/dev-shell.sh",
            sdk_fingerprint: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            sysroot_fingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
          },
          validation: {outcome_lists: [{
            name: "schema", status: "success", passed: ["fixture"], failed: [], skipped: []
          }]}
        }]
      }]
    }' >"$handoff/composition/sidecars-input.json"
  if [ "$extra_link_count" -gt 0 ]; then
    local expanded_input="$handoff/composition/sidecars-input.expanded.json"
    jq --argjson count "$extra_link_count" '
      .packages[0].bottles[0].links += [
        range(0; $count) | {
          type: "symlink",
          source: "bin/hello",
          target: "share/texmf-dist/fixture/path-\(.).tex"
        }
      ]
    ' "$handoff/composition/sidecars-input.json" >"$expanded_input"
    mv "$expanded_input" "$handoff/composition/sidecars-input.json"
  fi
}

validate_publish_handoff() {
  local handoff="$1" tap_root="$2"
  shift 2
  bash "$REPO_ROOT/scripts/homebrew-validate-publish-handoff.sh" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --tap-root "$tap_root" \
    "$@"
}

rebind_publish_handoff_tap_commit() {
  local handoff="$1" tap_commit="$2"
  local file tmp dependency_sha
  while IFS= read -r file; do
    tmp="${file}.updated"
    sed "s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/$tap_commit/g" "$file" >"$tmp"
    mv "$tmp" "$file"
  done < <(find "$handoff" -type f -name '*.json' -print)
  dependency_sha="$(sha256sum "$handoff/build/dependency-provenance.json" 2>/dev/null | awk '{print $1}' || \
    shasum -a 256 "$handoff/build/dependency-provenance.json" | awk '{print $1}')"
  tmp="$handoff/build/manifest.updated.json"
  jq --arg sha "$dependency_sha" '.dependency_provenance.sha256 = $sha' \
    "$handoff/build/manifest.json" >"$tmp"
  mv "$tmp" "$handoff/build/manifest.json"
}

prepare_publish_dependency_drift_fixture() {
  local handoff="$1" tap_root="$2" planned
  PUBLISH_HANDOFF_DEPENDENCY_MODE=valid \
    PUBLISH_HANDOFF_SEED_DEPENDENCY_SIDECARS=1 \
    make_publish_handoff "$handoff" "$tap_root"
  git -C "$tap_root" init -q
  git -C "$tap_root" config user.name "Kandelo Test"
  git -C "$tap_root" config user.email "kandelo-test@example.invalid"
  git -C "$tap_root" add .
  git -C "$tap_root" commit -q -m "planned dependency closure"
  planned="$(git -C "$tap_root" rev-parse HEAD)"
  rebind_publish_handoff_tap_commit "$handoff" "$planned"
  printf '%s\n' "$planned"
}

make_publish_planned_resolved_tap_map() {
  local tap_root="$1" planned="$2"
  local immutable_root="${tap_root}-resolved-planned"
  git -C "$tap_root" worktree add --detach "$immutable_root" "$planned" >/dev/null
  make_primary_resolved_tap_map "$immutable_root"
}

add_publish_dependency_sibling_bottle() {
  local tap_root="$1"
  local formula="$tap_root/Formula/zlib.rb"
  local metadata="$tap_root/Kandelo/metadata.json"
  local updated="$tap_root/Formula/zlib.updated.rb"
  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$formula" "$formula" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    0 wasm64_kandelo any_skip_relocation \
    3333333333333333333333333333333333333333333333333333333333333333 \
    preserve \
    "$updated"
  mv "$updated" "$formula"
  printf '{}\n' >"$tap_root/Kandelo/link/zlib-1.3.1-rebuild0-wasm64.json"
  jq -S '
    (.packages[] | select(.name == "zlib").bottles) += [
      (.packages[] | select(.name == "zlib").bottles[0] |
        .arch = "wasm64" |
        .bottle_tag = "wasm64_kandelo" |
        .fallback_url = "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:3333333333333333333333333333333333333333333333333333333333333333" |
        .fallback_sha256 = "3333333333333333333333333333333333333333333333333333333333333333" |
        .fallback_cache_key_sha = "3333333333333333333333333333333333333333333333333333333333333333" |
        .fallback_link_manifest = "Kandelo/link/zlib-1.3.1-rebuild0-wasm64.json")
    ]
  ' "$metadata" >"$metadata.tmp"
  mv "$metadata.tmp" "$metadata"
  jq -S '{
    schema, tap_repository, tap_name, tap_commit, kandelo_abi,
    source_metadata: "Kandelo/metadata.json"
  } + (.packages[] | select(.name == "zlib") | del(.formula_metadata))' \
    "$metadata" >"$tap_root/Kandelo/formula/zlib.json"
  git -C "$tap_root" add Formula/zlib.rb Kandelo
  git -C "$tap_root" commit -q -m "publish dependency sibling bottle"
}

set_publish_handoff_rebuild() {
  local handoff="$1" rebuild="$2" tmp
  tmp="$handoff/build/bottle.updated.json"
  jq --argjson rebuild "$rebuild" '.[].bottle.rebuild = $rebuild' \
    "$handoff/build/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/build/bottle.json"
  tmp="$handoff/composition/sidecars-input.updated.json"
  jq --argjson rebuild "$rebuild" '.packages[0].bottle_rebuild = $rebuild' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
}

assert_publish_handoff_is_exact_inert_data() {
  local handoff tap_root tmp external before after err generated composed host link
  local selected_formula archived_formula selected_formula_sha

  handoff="$TMPDIR/publish-handoff-valid"
  tap_root="$TMPDIR/publish-handoff-valid-tap"
  make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null

  selected_formula="$TMPDIR/publish-handoff-second-arch-selected.rb"
  archived_formula="$TMPDIR/publish-handoff-second-arch-archived.rb"
  cat >"$selected_formula" <<'RUBY'
class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end

end
RUBY
  cat >"$archived_formula" <<'RUBY'
class Hello < Formula
  desc "reviewed fixture"

end
RUBY
  handoff="$TMPDIR/publish-handoff-second-arch"
  tap_root="$TMPDIR/publish-handoff-second-arch-tap"
  PUBLISH_HANDOFF_FORMULA_SOURCE="$selected_formula" \
    PUBLISH_HANDOFF_ARCHIVED_FORMULA_SOURCE="$archived_formula" \
    make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null
  selected_formula_sha="$(sha256sum "$selected_formula" 2>/dev/null | awk '{print $1}' || \
    shasum -a 256 "$selected_formula" | awk '{print $1}')"
  tmp="$handoff/composition/sidecars-input.invalid-archive-sha.json"
  jq --arg sha "$selected_formula_sha" \
    '.packages[0].bottles[0].archived_formula_sha256 = $sha' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  err="$TMPDIR/publish-handoff-second-arch.err"
  if validate_publish_handoff "$handoff" "$tap_root" > /dev/null 2>"$err"; then
    fail "publish handoff validator accepted the selected Formula digest as archived receipt evidence"
  fi
  grep -F "archived Formula sha256 differs from bounded inspection" "$err" >/dev/null ||
    fail "publish handoff validator did not explain archived Formula digest drift"

  handoff="$TMPDIR/publish-handoff-dry-run"
  tap_root="$TMPDIR/publish-handoff-dry-run-tap"
  make_publish_handoff "$handoff" "$tap_root"
  make_dry_upload_receipt "$handoff/build" "$handoff/receipt.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a dry-run receipt in write mode"
  fi
  validate_publish_handoff "$handoff" "$tap_root" --allow-dry-run >/dev/null

  handoff="$TMPDIR/publish-handoff-public-as-dry-run"
  tap_root="$TMPDIR/publish-handoff-public-as-dry-run-tap"
  make_publish_handoff "$handoff" "$tap_root"
  if validate_publish_handoff "$handoff" "$tap_root" --allow-dry-run >/dev/null 2>&1; then
    fail "publish handoff validator accepted a public receipt in dry-run mode"
  fi

  handoff="$TMPDIR/publish-handoff-large-valid-sidecar"
  tap_root="$TMPDIR/publish-handoff-large-valid-sidecar-tap"
  generated="$TMPDIR/publish-handoff-large-valid-sidecar-generated"
  composed="$TMPDIR/publish-handoff-large-valid-sidecar.rb"
  PUBLISH_HANDOFF_EXTRA_LINK_COUNT=25000 make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null
  cp -a "$tap_root" "$generated"
  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$generated/Formula/hello.rb" "$tap_root/Formula/hello.rb" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    0 wasm32_kandelo any_skip_relocation \
    "$(jq -r '.layout.bottle.sha256' "$handoff/receipt.json")" \
    discard "$composed"
  mv "$composed" "$generated/Formula/hello.rb"
  host="$(rustc -vV | awk '/^host/ {print $2}')"
  (
    cd "$REPO_ROOT"
    cargo run --release -p xtask --target "$host" --quiet -- \
      homebrew-sidecars --tap-root "$generated" \
      --input "$handoff/composition/sidecars-input.json"
    cargo run --release -p xtask --target "$host" --quiet -- \
      homebrew-validate --tap-root "$generated"
  ) >/dev/null
  link="$(find "$generated/Kandelo/link" -mindepth 1 -maxdepth 1 -type f -print -quit)"
  [ -n "$link" ] || fail "large sidecar fixture did not generate a link manifest"
  [ "$(wc -c <"$link" | tr -d '[:space:]')" -gt 2097152 ] ||
    fail "valid large link sidecar did not exceed the old 2 MiB bound"
  [ "$(wc -c <"$link" | tr -d '[:space:]')" -le "$HOMEBREW_MAX_SIDECAR_JSON_BYTES" ] ||
    fail "valid large link sidecar exceeded the current 16 MiB bound"

  handoff="$TMPDIR/publish-handoff-extra"
  tap_root="$TMPDIR/publish-handoff-extra-tap"
  make_publish_handoff "$handoff" "$tap_root"
  printf 'untrusted\n' >"$handoff/run.sh"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted an extra top-level executable"
  fi

  handoff="$TMPDIR/publish-handoff-symlink"
  tap_root="$TMPDIR/publish-handoff-symlink-tap"
  make_publish_handoff "$handoff" "$tap_root"
  rm "$handoff/composition/sidecars-input.json"
  ln -s ../receipt.json "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a symlinked composition input"
  fi

  handoff="$TMPDIR/publish-handoff-extra-field"
  tap_root="$TMPDIR/publish-handoff-extra-field-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-extra-field.json"
  jq '.untrusted = "command"' "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted an unknown composition field"
  fi

  handoff="$TMPDIR/publish-handoff-formula-drift"
  tap_root="$TMPDIR/publish-handoff-formula-drift-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-formula.rb"
  sed 's/desc "reviewed fixture"/desc "artifact-mutated code"/' \
    "$tap_root/Formula/hello.rb" >"$tmp"
  mv "$tmp" "$tap_root/Formula/hello.rb"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted Formula source drift"
  fi

  handoff="$TMPDIR/publish-handoff-bottle-path"
  tap_root="$TMPDIR/publish-handoff-bottle-path-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-bottle-path.json"
  jq '.packages[0].bottles[0].bottle_file = "../../outside.tar.gz"' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a bottle path outside the handoff"
  fi

  handoff="$TMPDIR/publish-handoff-wrong-sha"
  tap_root="$TMPDIR/publish-handoff-wrong-sha-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-wrong-sha.json"
  jq '.packages[0].bottles[0].cache_key_sha = "0000000000000000000000000000000000000000000000000000000000000000"' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted bottle digest drift"
  fi

  handoff="$TMPDIR/publish-handoff-large-input"
  tap_root="$TMPDIR/publish-handoff-large-input-tap"
  make_publish_handoff "$handoff" "$tap_root"
  truncate -s 4194305 "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted oversized composition input"
  fi

  handoff="$TMPDIR/publish-handoff-tap-symlink"
  tap_root="$TMPDIR/publish-handoff-tap-symlink-tap"
  external="$TMPDIR/publish-handoff-external-formula.rb"
  err="$TMPDIR/publish-handoff-tap-symlink.err"
  make_publish_handoff "$handoff" "$tap_root"
  cp "$tap_root/Formula/hello.rb" "$external"
  rm "$tap_root/Formula/hello.rb"
  ln -s "$external" "$tap_root/Formula/hello.rb"
  before="$(sha256sum "$external" 2>/dev/null || shasum -a 256 "$external")"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a symlink in the tap Formula tree"
  fi
  grep -F "symlink" "$err" >/dev/null ||
    fail "publish handoff validator did not explain the tap symlink"

  git -C "$tap_root" init -q
  git -C "$tap_root" config user.name "Kandelo Test"
  git -C "$tap_root" config user.email "kandelo-test@example.invalid"
  git -C "$tap_root" add Formula
  git -C "$tap_root" commit -q -m "add symlinked Formula fixture"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "sidecar publisher accepted a tracked symlink in the tap Formula tree"
  fi
  after="$(sha256sum "$external" 2>/dev/null || shasum -a 256 "$external")"
  [ "$before" = "$after" ] || fail "sidecar publisher wrote through the tap Formula symlink"
}

assert_stale_bottle_rebuild_cannot_rewind_publication() {
  local handoff="$TMPDIR/publish-rebuild-new"
  local stale_handoff="$TMPDIR/publish-rebuild-stale"
  local tap_root="$TMPDIR/publish-rebuild-tap"
  local err="$TMPDIR/publish-rebuild-stale.err"
  local planned before_formula before_metadata before_head after_formula after_metadata after_head

  make_publish_handoff "$handoff" "$tap_root"
  cp -a "$handoff" "$stale_handoff"
  set_publish_handoff_rebuild "$handoff" 2
  set_publish_handoff_rebuild "$stale_handoff" 1
  git -C "$tap_root" init -q
  git -C "$tap_root" config user.name "Kandelo Test"
  git -C "$tap_root" config user.email "kandelo-test@example.invalid"
  git -C "$tap_root" add .
  git -C "$tap_root" commit -q -m "planned rebuild fixture"
  planned="$(git -C "$tap_root" rev-parse HEAD)"
  rebind_publish_handoff_tap_commit "$handoff" "$planned"
  rebind_publish_handoff_tap_commit "$stale_handoff" "$planned"

  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit "$planned" \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null
  jq -e '.packages[] | select(.name == "hello") | .bottle_rebuild == 2' \
    "$tap_root/Kandelo/metadata.json" >/dev/null ||
    fail "new bottle rebuild fixture did not publish rebuild 2"

  before_formula="$(sha256sum "$tap_root/Formula/hello.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/hello.rb" | awk '{print $1}')"
  before_metadata="$(sha256sum "$tap_root/Kandelo/metadata.json" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Kandelo/metadata.json" | awk '{print $1}')"
  before_head="$(git -C "$tap_root" rev-parse HEAD)"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$stale_handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit "$planned" \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "same-ABI publisher accepted an older bottle rebuild"
  fi
  grep -F "refusing stale hello bottle rebuild 1 after rebuild 2" "$err" >/dev/null ||
    fail "same-ABI publisher did not explain the stale bottle rebuild"
  after_formula="$(sha256sum "$tap_root/Formula/hello.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/hello.rb" | awk '{print $1}')"
  after_metadata="$(sha256sum "$tap_root/Kandelo/metadata.json" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Kandelo/metadata.json" | awk '{print $1}')"
  after_head="$(git -C "$tap_root" rev-parse HEAD)"
  [ "$before_formula" = "$after_formula" ] ||
    fail "stale bottle rebuild modified the published Formula"
  [ "$before_metadata" = "$after_metadata" ] ||
    fail "stale bottle rebuild modified published metadata"
  [ "$before_head" = "$after_head" ] ||
    fail "stale bottle rebuild created a tap commit"
}

assert_publish_dependencies_are_source_bound() {
  local handoff tap_root tmp err planned resolved_taps

  handoff="$TMPDIR/publish-dependencies-valid"
  tap_root="$TMPDIR/publish-dependencies-valid-tap"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=valid \
    PUBLISH_HANDOFF_SEED_DEPENDENCY_SIDECARS=1 \
    make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null

  handoff="$TMPDIR/publish-dependencies-missing"
  tap_root="$TMPDIR/publish-dependencies-missing-tap"
  err="$TMPDIR/publish-dependencies-missing.err"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=valid make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-dependencies-missing.json"
  jq '.packages[0].dependencies = []' "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted an omitted direct composition dependency"
  fi
  grep -F "composition dependencies do not match exact direct dependency provenance" "$err" >/dev/null ||
    fail "publish handoff validator did not explain the omitted direct dependency"

  handoff="$TMPDIR/publish-dependencies-extra"
  tap_root="$TMPDIR/publish-dependencies-extra-tap"
  err="$TMPDIR/publish-dependencies-extra.err"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=valid make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-dependencies-extra.json"
  jq '.packages[0].dependencies += [{
    name: "xz",
    full_name: "kandelo-dev/tap-core/xz",
    version: "5.6.2"
  }]' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a transitive dependency as direct composition data"
  fi
  grep -F "composition dependencies do not match exact direct dependency provenance" "$err" >/dev/null ||
    fail "publish handoff validator did not explain the extra composition dependency"

  handoff="$TMPDIR/publish-dependencies-version"
  tap_root="$TMPDIR/publish-dependencies-version-tap"
  err="$TMPDIR/publish-dependencies-version.err"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=valid make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-dependencies-version.json"
  jq '.packages[0].dependencies[0].version = "9.9.9"' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a dependency version not backed by provenance"
  fi
  grep -F "composition dependencies do not match exact direct dependency provenance" "$err" >/dev/null ||
    fail "publish handoff validator did not explain the dependency version mismatch"

  handoff="$TMPDIR/publish-dependencies-duplicate"
  tap_root="$TMPDIR/publish-dependencies-duplicate-tap"
  err="$TMPDIR/publish-dependencies-duplicate.err"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=valid make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-dependencies-duplicate.json"
  jq '.packages[0].dependencies += [.packages[0].dependencies[0]]' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a duplicate direct dependency"
  fi
  grep -F "composition dependencies do not match exact direct dependency provenance" "$err" >/dev/null ||
    fail "publish handoff validator did not explain the duplicate dependency"

  handoff="$TMPDIR/publish-dependencies-direct-false"
  tap_root="$TMPDIR/publish-dependencies-direct-false-tap"
  err="$TMPDIR/publish-dependencies-direct-false.err"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=direct-false make_publish_handoff "$handoff" "$tap_root"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a direct Formula dependency marked transitive"
  fi
  grep -F "declared_directly differs from the exact Formula" "$err" >/dev/null ||
    fail "publish handoff validator did not explain forged false directness"

  handoff="$TMPDIR/publish-dependencies-transitive-true"
  tap_root="$TMPDIR/publish-dependencies-transitive-true-tap"
  err="$TMPDIR/publish-dependencies-transitive-true.err"
  PUBLISH_HANDOFF_DEPENDENCY_MODE=transitive-true make_publish_handoff "$handoff" "$tap_root"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a transitive Formula dependency marked direct"
  fi
  grep -F "declared_directly differs from the exact Formula" "$err" >/dev/null ||
    fail "publish handoff validator did not explain forged true directness"

  handoff="$TMPDIR/publish-dependencies-concurrent-bottle"
  tap_root="$TMPDIR/publish-dependencies-concurrent-bottle-tap"
  err="$TMPDIR/publish-dependencies-concurrent-bottle.err"
  planned="$(prepare_publish_dependency_drift_fixture "$handoff" "$tap_root")"
  resolved_taps="$(make_publish_planned_resolved_tap_map "$tap_root" "$planned")"
  add_publish_dependency_sibling_bottle "$tap_root"
  if ! KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit "$planned" \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    cat "$err" >&2
    fail "under-lock publisher rejected concurrent sibling bottle metadata"
  fi

  handoff="$TMPDIR/publish-dependencies-concurrent-whitespace"
  tap_root="$TMPDIR/publish-dependencies-concurrent-whitespace-tap"
  err="$TMPDIR/publish-dependencies-concurrent-whitespace.err"
  planned="$(prepare_publish_dependency_drift_fixture "$handoff" "$tap_root")"
  resolved_taps="$(make_publish_planned_resolved_tap_map "$tap_root" "$planned")"
  add_publish_dependency_sibling_bottle "$tap_root"
  tmp="$tap_root/Formula/zlib.updated.rb"
  sed 's/desc "direct dependency fixture"/desc  "direct dependency fixture"/' \
    "$tap_root/Formula/zlib.rb" >"$tmp"
  mv "$tmp" "$tap_root/Formula/zlib.rb"
  git -C "$tap_root" add Formula/zlib.rb
  git -C "$tap_root" commit -q -m "change dependency Formula whitespace"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit "$planned" \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "under-lock publisher accepted concurrent dependency Formula whitespace drift"
  fi
  grep -F "Formula differs from the planned tap outside canonical bottle metadata" "$err" >/dev/null ||
    fail "under-lock publisher did not explain dependency Formula whitespace drift"

  handoff="$TMPDIR/publish-dependencies-concurrent-recipe"
  tap_root="$TMPDIR/publish-dependencies-concurrent-recipe-tap"
  err="$TMPDIR/publish-dependencies-concurrent-recipe.err"
  planned="$(prepare_publish_dependency_drift_fixture "$handoff" "$tap_root")"
  resolved_taps="$(make_publish_planned_resolved_tap_map "$tap_root" "$planned")"
  add_publish_dependency_sibling_bottle "$tap_root"
  tmp="$tap_root/Formula/zlib.updated.rb"
  sed 's/desc "direct dependency fixture"/desc "concurrently changed dependency source"/' \
    "$tap_root/Formula/zlib.rb" >"$tmp"
  mv "$tmp" "$tap_root/Formula/zlib.rb"
  git -C "$tap_root" add Formula/zlib.rb
  git -C "$tap_root" commit -q -m "change dependency recipe"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit "$planned" \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "under-lock publisher accepted concurrent dependency recipe drift"
  fi
  grep -F "Formula differs from the planned tap outside canonical bottle metadata" "$err" >/dev/null ||
    fail "under-lock publisher did not explain concurrent dependency recipe drift"

  handoff="$TMPDIR/publish-dependencies-concurrent-edge"
  tap_root="$TMPDIR/publish-dependencies-concurrent-edge-tap"
  err="$TMPDIR/publish-dependencies-concurrent-edge.err"
  planned="$(prepare_publish_dependency_drift_fixture "$handoff" "$tap_root")"
  resolved_taps="$(make_publish_planned_resolved_tap_map "$tap_root" "$planned")"
  add_publish_dependency_sibling_bottle "$tap_root"
  tmp="$tap_root/Formula/zlib.updated.rb"
  sed '/depends_on "kandelo-dev\/tap-core\/xz"/d' "$tap_root/Formula/zlib.rb" >"$tmp"
  mv "$tmp" "$tap_root/Formula/zlib.rb"
  git -C "$tap_root" add Formula/zlib.rb
  git -C "$tap_root" commit -q -m "change dependency edge"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps" \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit "$planned" \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "under-lock publisher accepted concurrent dependency-edge drift"
  fi
  if ! grep -F "bottle metadata differs from the exact tap" "$err" >/dev/null &&
     ! grep -F "dependency provenance does not match the exact tap's static runtime closure" \
       "$err" >/dev/null; then
    fail "under-lock publisher did not explain concurrent dependency-edge drift"
  fi
}

assert_bottle_build_trusts_selected_tap() {
  local tap="$TMPDIR/bottle-trust-tap"
  local brew_repo="$TMPDIR/bottle-trust-brew-repo"
  local brew_prefix="$TMPDIR/bottle-trust-prefix"
  local fake_brew="$TMPDIR/bottle-trust-brew"
  local out="$TMPDIR/bottle-trust-out"
  local log="$TMPDIR/bottle-trust.log"
  local lifecycle_log="$TMPDIR/bottle-trust-lifecycle.log"
  local ci_err="$TMPDIR/bottle-trust-ci.err"
  local caller_config="$TMPDIR/caller-homebrew-config"
  local symlink_target="$TMPDIR/runner-write-target"
  local KANDELO_HOMEBREW_RESOLVED_TAPS_FILE
  make_tap "$tap"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$(make_primary_resolved_tap_map "$tap")"
  export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
end
EOF
  mkdir -p "$brew_repo" "$brew_prefix" "$caller_config"
  printf 'sentinel\n' >"$symlink_target"

  cat >"$fake_brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  export HOMEBREW_USER_CONFIG_HOME="$XDG_CONFIG_HOME/homebrew"
fi
printf '%s|%s\n' "${HOMEBREW_USER_CONFIG_HOME:-}" "$*" >>"$FAKE_BREW_LOG"
case "${1:-}" in
  --prefix)
    printf '%s\n' "$FAKE_BREW_PREFIX"
    ;;
  --repository)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_REPOSITORY"
    else
      printf '%s\n' "$FAKE_TAP_ROOT"
    fi
    ;;
  tap)
    ;;
  trust)
    [ -d "${HOMEBREW_USER_CONFIG_HOME:-}" ]
    permissions="$(stat -c %a "$HOMEBREW_USER_CONFIG_HOME" 2>/dev/null || stat -f %Lp "$HOMEBREW_USER_CONFIG_HOME")"
    [ "$permissions" = "700" ]
    case "$HOMEBREW_USER_CONFIG_HOME" in
      */xdg-config/homebrew) ;;
      *) exit 43 ;;
    esac
    case "$*" in
      'trust --tap kandelo-dev/tap-core') ;;
      *) exit 45 ;;
    esac
    ;;
  deps)
    work_dir="${XDG_CONFIG_HOME%/xdg-config}"
    ln -sfn "$FAKE_SYMLINK_TARGET" "$work_dir/brew-install.log"
    ln -sfn "$FAKE_SYMLINK_TARGET" "$work_dir/brew-install-attempt-1.log"
    ;;
  missing)
    [ "${FAKE_HOMEBREW_REALM:-target}" = native ] || exit 44
    ;;
  install)
    [ "$*" = 'install --build-bottle --ignore-dependencies --formula kandelo-dev/tap-core/hello' ] || exit 43
    printf 'target-bottle-tags=%s|%s\n' \
      "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
      >>"$FAKE_BREW_LOG"
    printf '::add-mask::kandelo-formula-mask-sentinel\n'
    printf 'Formula-controlled runner write attempt\n'
    exit 42
    ;;
  *)
    exit 44
    ;;
esac
EOF
  chmod +x "$fake_brew"

  if FAKE_BREW_LOG="$log" \
    FAKE_REALM_LIFECYCLE_LOG="$lifecycle_log" \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    FAKE_SYMLINK_TARGET="$symlink_target" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    HOMEBREW_KANDELO_BOTTLE_TAG=caller-poison \
    KANDELO_HOMEBREW_BOTTLE_TAG=caller-poison \
    XDG_CONFIG_HOME="$caller_config" \
    GITHUB_ACTIONS=true \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>"$ci_err"; then
    fail "CI bottle build ran without an isolated Formula identity"
  fi
  grep -F "CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER" \
    "$ci_err" >/dev/null ||
    fail "CI bottle build did not explain its isolated-identity requirement"
  : >"$log"

  if FAKE_BREW_LOG="$log" \
    FAKE_REALM_LIFECYCLE_LOG="$lifecycle_log" \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    FAKE_SYMLINK_TARGET="$symlink_target" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    XDG_CONFIG_HOME="$caller_config" \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>&1; then
    fail "bottle trust fixture unexpectedly completed its sentinel install"
  fi

  local tap_line tap_trust_line install_line
  local trust_config first_config
  tap_line="$(grep -n '|tap kandelo-dev/tap-core ' "$log" | cut -d: -f1)"
  tap_trust_line="$(grep -n '|trust --tap kandelo-dev/tap-core$' "$log" | cut -d: -f1)"
  install_line="$(grep -n '|install --build-bottle --ignore-dependencies --formula kandelo-dev/tap-core/hello$' "$log" | cut -d: -f1)"
  [ -n "$tap_line" ] && [ -n "$tap_trust_line" ] && \
    [ -n "$install_line" ] ||
    fail "bottle build did not trust the selected tap before install"
  if grep -q '|trust --formula ' "$log"; then
    fail "bottle build persisted redundant Formula trust"
  fi
  grep -Fx 'target-bottle-tags=|' "$log" >/dev/null ||
    fail "target source build inherited the Kandelo bottle tag intended for bottle selection"
  [ "$tap_line" -lt "$tap_trust_line" ] && \
    [ "$tap_trust_line" -lt "$install_line" ] ||
    fail "bottle build did not freeze selected-tap trust before Formula evaluation"

  trust_config="$(grep '|trust --tap kandelo-dev/tap-core$' "$log" | cut -d'|' -f1)"
  first_config="$(head -n1 "$log" | cut -d'|' -f1)"
  [ -n "$trust_config" ] || fail "bottle build trust used no isolated config store"
  [ "$first_config" = "$trust_config" ] ||
    fail "launcher discovery ran outside the build-local Homebrew config store"
  [ "$trust_config" != "$caller_config/homebrew" ] ||
    fail "bottle build reused the caller's Homebrew config store"
  [ ! -e "$trust_config" ] || fail "build-local Homebrew config survived cleanup"
  [ -z "$(find "$caller_config" -mindepth 1 -print -quit)" ] ||
    fail "bottle build mutated the caller's Homebrew config store"
  [ "$(cat "$symlink_target")" = "sentinel" ] ||
    fail "Formula-planted log symlink gained runner-owned output"
}

assert_bottle_build_forces_same_tap_dependencies() {
  local tap="$TMPDIR/bottle-dependency-tap"
  local brew_repo="$TMPDIR/bottle-dependency-brew-repo"
  local brew_prefix="$TMPDIR/bottle-dependency-prefix"
  local fake_brew="$TMPDIR/bottle-dependency-brew"
  local out="$TMPDIR/bottle-dependency-out"
  local log="$TMPDIR/bottle-dependency.log"
  local lifecycle_log="$TMPDIR/bottle-dependency-lifecycle.log"
  local KANDELO_HOMEBREW_RESOLVED_TAPS_FILE
  make_tap "$tap"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$(make_primary_resolved_tap_map "$tap")"
  export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE
  mkdir -p "$brew_repo" "$brew_prefix"
  cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
  depends_on "kandelo-dev/tap-core/zlib"
end
EOF
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any, wasm32_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end
end
EOF

  cat >"$fake_brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_BREW_LOG"
case "${1:-}" in
  --prefix) printf '%s\n' "$FAKE_BREW_PREFIX" ;;
  --repository)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_REPOSITORY"
    else
      printf '%s\n' "$FAKE_TAP_ROOT"
    fi
    ;;
  tap|trust) ;;
  deps)
    printf '%s\n' 'cmake' 'kandelo-dev/tap-core/zlib'
    ;;
  missing)
    [ "${FAKE_HOMEBREW_REALM:-target}" = native ] || exit 44
    ;;
  install)
    if [ "$*" = 'install --force-bottle --as-dependency --ignore-dependencies --formula kandelo-dev/tap-core/zlib' ]; then
      printf 'dependency-bottle-tags=%s|%s\n' \
        "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
        >>"$FAKE_BREW_LOG"
      exit 42
    fi
    exit 43
    ;;
  *) exit 44 ;;
esac
EOF
  chmod +x "$fake_brew"

  if FAKE_BREW_LOG="$log" \
    FAKE_REALM_LIFECYCLE_LOG="$lifecycle_log" \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    HOMEBREW_KANDELO_BOTTLE_TAG=caller-poison \
    KANDELO_HOMEBREW_BOTTLE_TAG=caller-poison \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>&1; then
    fail "dependency force-bottle fixture unexpectedly completed"
  fi

  grep -Fx 'deps --topological --full-name --formula kandelo-dev/tap-core/hello' "$log" >/dev/null ||
    fail "bottle build did not resolve the runtime dependency closure"
  grep -Fx 'install --force-bottle --as-dependency --ignore-dependencies --formula kandelo-dev/tap-core/zlib' "$log" >/dev/null ||
    fail "bottle build did not force the selected same-tap dependency bottle"
  grep -Fx 'dependency-bottle-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "same-tap dependency bottle selection did not receive the Kandelo bottle tag"
  ! grep -F 'install --force-bottle' "$log" | grep -F 'cmake' >/dev/null ||
    fail "bottle build treated a host dependency as a Kandelo bottle"
  ! grep -F 'install --build-bottle' "$log" >/dev/null ||
    fail "bottle build continued to the target source build after a dependency bottle failure"
}

assert_bottle_build_installs_test_dependencies() {
  local tap="$TMPDIR/bottle-test-dependency-tap"
  local brew_repo="$TMPDIR/bottle-test-dependency-brew-repo"
  local brew_prefix="$TMPDIR/bottle-test-dependency-prefix"
  local fake_bin="$TMPDIR/bottle-test-dependency-bin"
  local fake_brew="$TMPDIR/bottle-test-dependency-brew"
  local out="$TMPDIR/bottle-test-dependency-out"
  local log="$TMPDIR/bottle-test-dependency.log"
  local realm_log="$TMPDIR/bottle-test-dependency-realms.log"
  local lifecycle_log="$TMPDIR/bottle-test-dependency-lifecycle.log"
  local provenance_capture="$TMPDIR/bottle-test-dependency-provenance.txt"
  local provenance_log_capture="$TMPDIR/bottle-test-dependency-install.log"
  local native_prefix_capture="$TMPDIR/bottle-test-dependency-native-prefix.txt"
  local native_prefix real_python3 gnu_tar_bin host_git_bin
  local KANDELO_HOMEBREW_RESOLVED_TAPS_FILE
  make_tap "$tap"
  mkdir -p "$brew_repo" "$brew_prefix" "$fake_bin"
  cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    rebuild 1
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end

  depends_on "cmake" => [:build, :test]
  depends_on "ninja" => :build
  depends_on "kandelo-dev/tap-core/zlib"
  depends_on "kandelo-dev/tap-core/test-helper" => :test
end
EOF
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any, wasm32_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end
end
EOF
  cat >"$tap/Formula/test-helper.rb" <<'EOF'
class TestHelper < Formula
end
EOF
  git -C "$tap" add Formula
  git -C "$tap" commit -q -m "add bottle builder fixtures"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$(make_primary_resolved_tap_map "$tap")"
  export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE

  cat >"$fake_brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_BREW_LOG"
printf '%s|%s\n' "${FAKE_HOMEBREW_REALM:-target}" "$*" >>"$FAKE_REALM_COMMAND_LOG"
if [ "${FAKE_HOMEBREW_REALM:-target}" = native ]; then
  [ "${HOMEBREW_RELOCATE_BUILD_PREFIX:-}" = 1 ] || exit 52
else
  [ -z "${HOMEBREW_RELOCATE_BUILD_PREFIX+x}" ] || exit 53
fi
case "${1:-}" in
  --prefix)
    if [ "${FAKE_HOMEBREW_REALM:-target}" = native ]; then
      printf '%s\n' "$FAKE_NATIVE_PREFIX"
    else
      printf '%s\n' "$FAKE_BREW_PREFIX"
    fi
    ;;
  --repository)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_REPOSITORY"
    else
      printf '%s\n' "$FAKE_TAP_ROOT"
    fi
    ;;
  tap|trust) ;;
  deps)
    case "$*" in
      'deps --topological --full-name --formula kandelo-dev/tap-core/hello')
        printf '%s\n' 'dynamic-runtime-host' 'kandelo-dev/tap-core/zlib'
        ;;
      'deps --topological --full-name --include-build --include-test --formula kandelo-dev/tap-core/hello')
        printf '%s\n' \
          'dynamic-build-host' \
          'kandelo-dev/tap-core/zlib' \
          'kandelo-dev/tap-core/test-helper'
        ;;
      *) exit 45 ;;
    esac
    ;;
  install)
    case "$*" in
      'install --as-dependency --formula homebrew/core/cmake'|\
      'install --as-dependency --formula homebrew/core/ninja')
        [ "${FAKE_HOMEBREW_REALM:-target}" = native ] || exit 42
        printf 'native-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        printf 'native-provenance-sentinel\n'
        ;;
      'install --force-bottle --as-dependency --ignore-dependencies --formula kandelo-dev/tap-core/zlib')
        printf 'zlib-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        ;;
      'install --force-bottle --as-dependency --ignore-dependencies --formula kandelo-dev/tap-core/test-helper')
        printf 'test-helper-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        ;;
      'install --build-bottle --ignore-dependencies --formula kandelo-dev/tap-core/hello')
        printf 'target-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        tap_head="$(git -C "$FAKE_TAP_ROOT" rev-parse HEAD)"
        cat >"$FAKE_BREW_PREFIX/INSTALL_RECEIPT.json" <<JSON
{"source":{"path":"Formula/hello.rb","tap":"kandelo-dev/tap-core","tap_git_head":"$tap_head","versions":{"stable":"1.0"}},"built_as_bottle":false,"poured_from_bottle":false}
JSON
        mkdir -p "$FAKE_BREW_PREFIX/bin"
        cat >"$FAKE_BREW_PREFIX/bin/git" <<'TARGET_GIT'
#!/usr/bin/env bash
exit 86
TARGET_GIT
        chmod +x "$FAKE_BREW_PREFIX/bin/git"
        ;;
      *) exit 43 ;;
    esac
    ;;
  info)
    [ "${FAKE_HOMEBREW_REALM:-target}" = native ] || exit 47
    case "$*" in
      'info --json=v2 homebrew/core/cmake') dependency=cmake ;;
      'info --json=v2 homebrew/core/ninja') dependency=ninja ;;
      *) exit 47 ;;
    esac
    printf '{"formulae":[{"name":"%s","full_name":"%s","tap":"homebrew/core","installed":[{"version":"1"}]}]}\n' \
      "$dependency" "$dependency"
    ;;
  missing)
    [ "${FAKE_HOMEBREW_REALM:-target}" = native ] && [ "$*" = missing ] || exit 48
    ;;
  list)
    [ "${FAKE_HOMEBREW_REALM:-target}" = target ] || exit 49
    case "$*" in
      'list --formula cmake'|'list --formula ninja') ;;
      *) exit 49 ;;
    esac
    ;;
  test)
    [ "$*" = 'test kandelo-dev/tap-core/hello' ] || exit 46
    if [ "${FAKE_ASSERT_GIT_CONTROL_PLANE:-}" = 1 ]; then
      [ -x "$FAKE_BREW_PREFIX/bin/git" ] || exit 56
      [ "${HOMEBREW_GIT_PATH:-}" = "$FAKE_EXPECTED_HOST_GIT" ] || exit 57
      [ "$HOMEBREW_GIT_PATH" != "$FAKE_BREW_PREFIX/bin/git" ] || exit 58
      "$HOMEBREW_GIT_PATH" --version >/dev/null || exit 59
      "$HOMEBREW_GIT_PATH" -C "$FAKE_TAP_ROOT" rev-parse HEAD >/dev/null || exit 60
      [ "$(grep -c '^trust --tap kandelo-dev/tap-core$' "$FAKE_BREW_LOG")" -eq 1 ] || exit 61
    fi
    if [ "${FAKE_INSTALL_IMPLICIT_NATIVE:-}" = "1" ]; then
      mkdir -p "$FAKE_BREW_PREFIX/Cellar/bubblewrap/0.11.2"
    fi
    ;;
  bottle)
    [ "$*" = 'bottle --json --keep-old --root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core kandelo-dev/tap-core/hello' ] || exit 55
    printf 'bottle-tags=%s|%s\n' \
      "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
      >>"$FAKE_BREW_LOG"
    [[ "${HOMEBREW_KANDELO_GNU_TAR:-}" =~ ^/nix/store/[0-9a-z]{32}-gnutar-[^/]+/bin/tar$ ]] || exit 54
    bottle_dir="$PWD"
    bottle_stage="$(mktemp -d "$PWD/fake-bottle.XXXXXX")"
    mkdir -p "$bottle_stage/hello/1.0/bin"
    jq 'del(.source.tap_git_head)' \
      "$FAKE_BREW_PREFIX/INSTALL_RECEIPT.json" \
      >"$bottle_stage/hello/1.0/INSTALL_RECEIPT.json"
    printf 'stable target payload\n' >"$bottle_stage/hello/1.0/bin/hello"
    python3 -c '
import os, sys
root, timestamp = sys.argv[1], int(sys.argv[2])
for directory, names, files in os.walk(root):
    os.utime(directory, (timestamp, timestamp))
    for name in names + files:
        path = os.path.join(directory, name)
        os.utime(path, (timestamp, timestamp), follow_symlinks=False)
' "$bottle_stage" "${FAKE_BUILD_TIME:?}"
    bottle_tar="$bottle_dir/hello--1.0.wasm32_kandelo.bottle.1.tar"
    (
      cd "$bottle_stage"
      "$HOMEBREW_KANDELO_GNU_TAR" --create --numeric-owner \
        --mtime='2024-01-22 17:12:37' \
        --sort=name \
        --owner=0 --group=0 --numeric-owner \
        --format=pax \
        --pax-option=globexthdr.name=/GlobalHead.%n,exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
        --file "$bottle_tar" hello/1.0
    )
    gzip -n -c "$bottle_tar" \
      >"$bottle_dir/hello--1.0.wasm32_kandelo.bottle.1.tar.gz"
    rm -f "$bottle_tar"
    python3 -c 'import os, sys; os.utime(sys.argv[1], (1705948357, 1705948357))' \
      "$bottle_dir/hello--1.0.wasm32_kandelo.bottle.1.tar.gz"
    cat >hello--1.0.wasm32_kandelo.bottle.json <<'JSON'
{
  "kandelo-dev/tap-core/hello": {
    "formula": {"name": "hello", "pkg_version": "1.0"},
    "bottle": {
      "date": "2024-01-22T17:12:37Z",
      "rebuild": 1,
      "tags": {
        "wasm32_kandelo": {
          "local_filename": "hello--1.0.wasm32_kandelo.bottle.1.tar.gz"
        }
      }
    }
  }
}
JSON
    if [ "${FAKE_BOTTLE_REBUILD_DRIFT:-}" = "1" ]; then
      jq '.[].bottle.rebuild = 2' \
        hello--1.0.wasm32_kandelo.bottle.json \
        >hello--1.0.wasm32_kandelo.bottle.drift.json
      mv hello--1.0.wasm32_kandelo.bottle.drift.json \
        hello--1.0.wasm32_kandelo.bottle.json
    fi
    python3 -c 'import os, sys; os.utime(sys.argv[1], (1705948357, 1705948357))' \
      hello--1.0.wasm32_kandelo.bottle.json
    ;;
  *) exit 44 ;;
esac
EOF
  chmod +x "$fake_brew"

  real_python3="$(command -v python3)"
  gnu_tar_bin="$(command -v tar)"
  host_git_bin="$(command -v git)"
  cat >"$fake_bin/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$(basename "${1:-}")" != 'homebrew-dependency-provenance.py' ]; then
  exec "$REAL_PYTHON3" "$@"
fi
shift
[ "${1:-}" = 'capture' ] || exit 47
shift
expected=""
out=""
install_log=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-dependencies) expected="${2:-}"; shift 2 ;;
    --install-log) install_log="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$expected" ] && [ -n "$install_log" ] && [ -n "$out" ] || exit 48
cp "$expected" "$FAKE_PROVENANCE_CAPTURE"
cp "$install_log" "$FAKE_PROVENANCE_LOG_CAPTURE"
printf '{"schema":1}\n' >"$out"
EOF
  chmod +x "$fake_bin/python3"

  if ! PATH="$fake_bin:$PATH" \
    REAL_PYTHON3="$real_python3" \
    FAKE_PROVENANCE_CAPTURE="$provenance_capture" \
    FAKE_PROVENANCE_LOG_CAPTURE="$provenance_log_capture" \
    FAKE_BREW_LOG="$log" \
    FAKE_REALM_COMMAND_LOG="$realm_log" \
    FAKE_REALM_LIFECYCLE_LOG="$lifecycle_log" \
    FAKE_NATIVE_PREFIX_CAPTURE="$native_prefix_capture" \
    FAKE_BUILD_TIME=1700000000 \
    FAKE_ASSERT_GIT_CONTROL_PLANE=1 \
    FAKE_EXPECTED_HOST_GIT="$host_git_bin" \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    HOMEBREW_KANDELO_BOTTLE_TAG=caller-poison \
    KANDELO_HOMEBREW_BOTTLE_TAG=caller-poison \
    HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
    HOMEBREW_GIT_PATH=caller-poison \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>&1; then
    fail "test dependency fixture did not complete"
  fi
  native_prefix="$(cat "$native_prefix_capture")"
  case "$native_prefix" in
    /tmp/k.??????/p|/private/tmp/k.??????/p) ;;
    *) fail "bottle build did not use the bounded native prefix: $native_prefix" ;;
  esac
  (
    # shellcheck disable=SC1090
    . "$out/build.env"
    [ "$NATIVE_BUILD_ROOT" = "${native_prefix%/p}" ] ||
      fail "bottle build did not export its exact native root for archive scanning"
    [ "$(basename "$BOTTLE_ARCHIVE")" = \
      "hello--1.0.wasm32_kandelo.bottle.1.tar.gz" ] ||
      fail "bottle build did not export the rebuild archive selected by raw JSON"
  )
  [ ! -e "${native_prefix%/p}" ] ||
    fail "bottle build retained its native prefix after successful cleanup"

  local drift_out="$TMPDIR/bottle-rebuild-drift-out"
  local drift_prefix="$TMPDIR/bottle-rebuild-drift-prefix"
  local drift_log="$TMPDIR/bottle-rebuild-drift.log"
  local drift_realm_log="$TMPDIR/bottle-rebuild-drift-realms.log"
  local drift_lifecycle_log="$TMPDIR/bottle-rebuild-drift-lifecycle.log"
  local drift_native_capture="$TMPDIR/bottle-rebuild-drift-native-prefix.txt"
  local drift_provenance_capture="$TMPDIR/bottle-rebuild-drift-provenance.txt"
  local drift_provenance_log="$TMPDIR/bottle-rebuild-drift-install.log"
  local drift_err="$TMPDIR/bottle-rebuild-drift.err"
  local drift_status
  mkdir -p "$drift_prefix"
  set +e
  PATH="$fake_bin:$PATH" \
    REAL_PYTHON3="$real_python3" \
    FAKE_PROVENANCE_CAPTURE="$drift_provenance_capture" \
    FAKE_PROVENANCE_LOG_CAPTURE="$drift_provenance_log" \
    FAKE_BREW_LOG="$drift_log" \
    FAKE_REALM_COMMAND_LOG="$drift_realm_log" \
    FAKE_REALM_LIFECYCLE_LOG="$drift_lifecycle_log" \
    FAKE_NATIVE_PREFIX_CAPTURE="$drift_native_capture" \
    FAKE_BUILD_TIME=1700000000 \
    FAKE_BOTTLE_REBUILD_DRIFT=1 \
    FAKE_BREW_PREFIX="$drift_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$drift_out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>"$drift_err"
  drift_status="$?"
  set -e
  [ "$drift_status" -eq 1 ] ||
    fail "bottle build accepted Homebrew rebuild drift: $drift_status"
  grep -F 'Homebrew bottle rebuild 2 differs from planned Formula rebuild 1' \
    "$drift_err" >/dev/null ||
    fail "bottle build did not explain Homebrew rebuild drift"

  # A later tap-only report commit and a different wall-clock build time must
  # not change the bottle layer. The fake Brew mirrors the patched publisher's
  # copied receipt, exact upstream GNU tar arguments, and stable archive time;
  # the installed receipt must still retain each run's truthful selected head.
  local first_tap_head second_tap_head first_archive second_archive first_sha second_sha
  local second_out="$TMPDIR/bottle-test-dependency-second-out"
  local second_prefix="$TMPDIR/bottle-test-dependency-second-prefix"
  local second_log="$TMPDIR/bottle-test-dependency-second.log"
  local second_realm_log="$TMPDIR/bottle-test-dependency-second-realms.log"
  local second_lifecycle_log="$TMPDIR/bottle-test-dependency-second-lifecycle.log"
  local second_native_capture="$TMPDIR/bottle-test-dependency-second-native-prefix.txt"
  local second_provenance_capture="$TMPDIR/bottle-test-dependency-second-provenance.txt"
  local second_provenance_log="$TMPDIR/bottle-test-dependency-second-install.log"
  first_tap_head="$(git -C "$tap" rev-parse HEAD)"
  first_archive="$out/bottles/hello--1.0.wasm32_kandelo.bottle.1.tar.gz"
  first_sha="$(sha256sum "$first_archive" 2>/dev/null | awk '{print $1}' || \
    shasum -a 256 "$first_archive" | awk '{print $1}')"
  [ "$(jq -r '.source.tap_git_head' "$brew_prefix/INSTALL_RECEIPT.json")" = \
    "$first_tap_head" ] ||
    fail "first bottle run did not preserve its installed tap provenance"
  "$gnu_tar_bin" --extract --gzip --to-stdout \
    --file "$first_archive" hello/1.0/INSTALL_RECEIPT.json |
    jq -e '.source.tap == "kandelo-dev/tap-core" and
      (.source | has("tap_git_head") | not)' >/dev/null ||
    fail "first bottle archive did not retain only stable receipt provenance"

  printf 'retry after unrelated finalizer commit\n' >"$tap/Kandelo/retry-state.txt"
  git -C "$tap" add Kandelo/retry-state.txt
  git -C "$tap" commit -q -m "record unrelated publication retry"
  second_tap_head="$(git -C "$tap" rev-parse HEAD)"
  [ "$first_tap_head" != "$second_tap_head" ] ||
    fail "reproducible bottle fixture did not change tap HEAD"
  mkdir -p "$second_prefix"
  if ! PATH="$fake_bin:$PATH" \
    REAL_PYTHON3="$real_python3" \
    FAKE_PROVENANCE_CAPTURE="$second_provenance_capture" \
    FAKE_PROVENANCE_LOG_CAPTURE="$second_provenance_log" \
    FAKE_BREW_LOG="$second_log" \
    FAKE_REALM_COMMAND_LOG="$second_realm_log" \
    FAKE_REALM_LIFECYCLE_LOG="$second_lifecycle_log" \
    FAKE_NATIVE_PREFIX_CAPTURE="$second_native_capture" \
    FAKE_BUILD_TIME=1800000000 \
    FAKE_BREW_PREFIX="$second_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$second_out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>&1; then
    fail "second reproducible bottle fixture did not complete"
  fi
  second_archive="$second_out/bottles/hello--1.0.wasm32_kandelo.bottle.1.tar.gz"
  second_sha="$(sha256sum "$second_archive" 2>/dev/null | awk '{print $1}' || \
    shasum -a 256 "$second_archive" | awk '{print $1}')"
  [ "$first_sha" = "$second_sha" ] ||
    fail "tap-only retry or build time changed the bottle archive SHA"
  [ "$(jq -r '.source.tap_git_head' "$second_prefix/INSTALL_RECEIPT.json")" = \
    "$second_tap_head" ] ||
    fail "second bottle run did not preserve its installed tap provenance"
  [ "$(jq -r '."kandelo-dev/tap-core/hello".bottle.date' \
    "$out/bottles/hello--1.0.wasm32_kandelo.bottle.json")" = \
    "$(jq -r '."kandelo-dev/tap-core/hello".bottle.date' \
      "$second_out/bottles/hello--1.0.wasm32_kandelo.bottle.json")" ] ||
    fail "tap-only retry changed the normalized bottle date"
  [ "$(python3 -c 'import os, sys; print(int(os.stat(sys.argv[1]).st_mtime))' \
    "$first_archive")" = 1705948357 ] &&
    [ "$(python3 -c 'import os, sys; print(int(os.stat(sys.argv[1]).st_mtime))' \
      "$second_archive")" = 1705948357 ] ||
    fail "fake bottle runner did not normalize both archive mtimes"

  local runtime_query_line build_test_query_line native_cmake_line native_ninja_line
  local native_cmake_info_line native_ninja_info_line native_missing_line seal_line
  local cmake_bridge_line cmake_proxy_line ninja_bridge_line ninja_proxy_line
  local zlib_line test_helper_line target_line
  runtime_query_line="$(grep -n '^target|deps --topological --full-name --formula ' "$realm_log" | cut -d: -f1)"
  build_test_query_line="$(grep -n '^target|deps --topological --full-name --include-build --include-test ' "$realm_log" | cut -d: -f1)"
  native_cmake_line="$(grep -n '^native|install --as-dependency --formula homebrew/core/cmake$' "$realm_log" | cut -d: -f1)"
  native_ninja_line="$(grep -n '^native|install --as-dependency --formula homebrew/core/ninja$' "$realm_log" | cut -d: -f1)"
  native_cmake_info_line="$(grep -n '^native|info --json=v2 homebrew/core/cmake$' "$realm_log" | cut -d: -f1)"
  native_ninja_info_line="$(grep -n '^native|info --json=v2 homebrew/core/ninja$' "$realm_log" | cut -d: -f1)"
  native_missing_line="$(grep -n '^native|missing$' "$realm_log" | cut -d: -f1)"
  seal_line="$(grep -n '^lifecycle|seal-native$' "$realm_log" | cut -d: -f1)"
  cmake_bridge_line="$(grep -n '^lifecycle|bridge-native:cmake$' "$realm_log" | cut -d: -f1)"
  cmake_proxy_line="$(grep -n '^target|list --formula cmake$' "$realm_log" | cut -d: -f1)"
  ninja_bridge_line="$(grep -n '^lifecycle|bridge-native:ninja$' "$realm_log" | cut -d: -f1)"
  ninja_proxy_line="$(grep -n '^target|list --formula ninja$' "$realm_log" | cut -d: -f1)"
  zlib_line="$(grep -n '^target|install --force-bottle .*zlib$' "$realm_log" | cut -d: -f1)"
  test_helper_line="$(grep -n '^target|install --force-bottle .*test-helper$' "$realm_log" | cut -d: -f1)"
  target_line="$(grep -n '^target|install --build-bottle --ignore-dependencies ' "$realm_log" | cut -d: -f1)"
  [ -n "$runtime_query_line" ] && [ -n "$build_test_query_line" ] && \
    [ -n "$native_cmake_line" ] && [ -n "$native_ninja_line" ] && \
    [ -n "$native_cmake_info_line" ] && [ -n "$native_ninja_info_line" ] && \
    [ -n "$native_missing_line" ] && [ -n "$seal_line" ] && \
    [ -n "$cmake_bridge_line" ] && [ -n "$cmake_proxy_line" ] && \
    [ -n "$ninja_bridge_line" ] && [ -n "$ninja_proxy_line" ] && \
    [ -n "$zlib_line" ] && [ -n "$test_helper_line" ] && \
    [ -n "$target_line" ] ||
    fail "bottle build omitted a dependency resolution or installation phase"
  [ "$native_cmake_line" -lt "$native_ninja_line" ] && \
    [ "$native_ninja_line" -lt "$native_cmake_info_line" ] && \
    [ "$native_cmake_info_line" -lt "$native_ninja_info_line" ] && \
    [ "$native_ninja_info_line" -lt "$native_missing_line" ] && \
    [ "$native_missing_line" -lt "$runtime_query_line" ] && \
    [ "$runtime_query_line" -lt "$build_test_query_line" ] && \
    [ "$build_test_query_line" -lt "$seal_line" ] && \
    [ "$seal_line" -lt "$cmake_bridge_line" ] && \
    [ "$cmake_bridge_line" -lt "$cmake_proxy_line" ] && \
    [ "$cmake_proxy_line" -lt "$ninja_bridge_line" ] && \
    [ "$ninja_bridge_line" -lt "$ninja_proxy_line" ] && \
    [ "$ninja_proxy_line" -lt "$zlib_line" ] && \
    [ "$zlib_line" -lt "$test_helper_line" ] && \
    [ "$test_helper_line" -lt "$target_line" ] ||
    fail "bottle build installed same-tap, host, or target dependencies out of order"
  ! grep -F 'homebrew/core/dynamic-' "$realm_log" >/dev/null ||
    fail "bottle build selected its native plan from evaluated Formula output"
  [ "$(cat "$lifecycle_log")" = $'prepare-native\nseed-bundler:bottle formula_test\nstage-dependency-plan\nseal-native\nbridge-native:cmake\nbridge-native:ninja\ncleanup' ] ||
    fail "bottle build did not prepare, seal, bridge, and clean up the native realm"
  grep -Fx 'zlib-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "same-tap runtime dependency lost the Kandelo bottle tag"
  grep -Fx 'test-helper-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "same-tap build/test dependency was not force-poured as a Kandelo bottle"
  grep -Fx 'native-tags=|' "$log" >/dev/null ||
    fail "native test dependency install inherited the Kandelo bottle tag"
  grep -Fx 'target-tags=|' "$log" >/dev/null ||
    fail "target source build inherited the Kandelo bottle tag"
  grep -Fx 'bottle-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "bottle creation lost the Kandelo bottle tag"
  [ "$(cat "$provenance_capture")" = 'kandelo-dev/tap-core/zlib' ] ||
    fail "runtime provenance included the build/test-only same-tap dependency"
  ! grep -F 'native-provenance-sentinel' "$provenance_log_capture" >/dev/null ||
    fail "native Homebrew output contaminated target dependency provenance"

  local cellar_leak_out="$TMPDIR/bottle-cellar-leak-out"
  local cellar_leak_temp="$TMPDIR/bottle-cellar-leak-temp"
  local cellar_leak_prefix="$TMPDIR/bottle-cellar-leak-prefix"
  local cellar_leak_err="$TMPDIR/bottle-cellar-leak.err"
  local cellar_leak_lifecycle="$TMPDIR/bottle-cellar-leak-lifecycle.log"
  local cellar_leak_capture="$TMPDIR/bottle-cellar-leak-native-prefix.txt"
  local cellar_leak_native_prefix cellar_leak_status
  mkdir -p "$cellar_leak_temp" "$cellar_leak_prefix"
  set +e
  PATH="$fake_bin:$PATH" \
    TMPDIR="$cellar_leak_temp" \
    REAL_PYTHON3="$real_python3" \
    FAKE_PROVENANCE_CAPTURE="$provenance_capture" \
    FAKE_PROVENANCE_LOG_CAPTURE="$provenance_log_capture" \
    FAKE_BREW_LOG="$log" \
    FAKE_REALM_COMMAND_LOG="$realm_log" \
    FAKE_REALM_LIFECYCLE_LOG="$cellar_leak_lifecycle" \
    FAKE_NATIVE_PREFIX_CAPTURE="$cellar_leak_capture" \
    FAKE_BUILD_TIME=1700000000 \
    FAKE_INSTALL_IMPLICIT_NATIVE=1 \
    FAKE_BREW_PREFIX="$cellar_leak_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$cellar_leak_out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>"$cellar_leak_err"
  cellar_leak_status="$?"
  set -e
  [ "$cellar_leak_status" -eq 1 ] ||
    fail "bottle build accepted an implicit native target-Cellar install: $cellar_leak_status"
  grep -F 'Formula test or bottle creation changed the planned target Cellar' \
    "$cellar_leak_err" >/dev/null ||
    fail "bottle build did not explain the changed target Cellar"
  grep -F '+keg:bubblewrap/0.11.2' "$cellar_leak_err" >/dev/null ||
    fail "target Cellar audit did not identify the implicit native keg"
  cellar_leak_native_prefix="$(cat "$cellar_leak_capture")"
  [ ! -e "${cellar_leak_native_prefix%/p}" ] ||
    fail "target Cellar rejection retained the native Homebrew realm"

  local cleanup_failure_out="$TMPDIR/bottle-cleanup-failure-out"
  local cleanup_failure_temp="$TMPDIR/bottle-cleanup-failure-temp"
  local cleanup_failure_lifecycle="$TMPDIR/bottle-cleanup-failure-lifecycle.log"
  local cleanup_failure_capture="$TMPDIR/bottle-cleanup-failure-native-prefix.txt"
  local cleanup_failure_prefix cleanup_failure_status
  mkdir -p "$cleanup_failure_temp"
  set +e
  PATH="$fake_bin:$PATH" \
    TMPDIR="$cleanup_failure_temp" \
    REAL_PYTHON3="$real_python3" \
    FAKE_PROVENANCE_CAPTURE="$provenance_capture" \
    FAKE_PROVENANCE_LOG_CAPTURE="$provenance_log_capture" \
    FAKE_BREW_LOG="$log" \
    FAKE_REALM_COMMAND_LOG="$realm_log" \
    FAKE_REALM_LIFECYCLE_LOG="$cleanup_failure_lifecycle" \
    FAKE_NATIVE_PREFIX_CAPTURE="$cleanup_failure_capture" \
    FAKE_BUILD_TIME=1700000000 \
    FAKE_LAUNCHER_CLEANUP_STATUS=7 \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
    GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --formula hello \
      --arch wasm32 \
      --out "$cleanup_failure_out" \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      >/dev/null 2>&1
  cleanup_failure_status="$?"
  set -e
  [ "$cleanup_failure_status" -eq 7 ] ||
    fail "successful bottle work hid its cleanup-only failure: $cleanup_failure_status"
  cleanup_failure_prefix="$(cat "$cleanup_failure_capture")"
  [ -d "${cleanup_failure_prefix%/p}" ] ||
    fail "cleanup failure did not preserve the native Homebrew realm"
  rm -rf "${cleanup_failure_prefix%/p}"
}

assert_bottle_verifier_installs_test_dependencies() {
  local root="$TMPDIR/bottle-verifier-test-dependencies"
  local tap="$root/tap"
  local provenance_tap="$root/provenance-tap"
  local tapped_tap="$root/tapped-tap"
  local brew_repo="$root/brew-repo"
  local brew_prefix="$root/brew-prefix"
  local fake_bin="$root/bin"
  local fake_brew="$fake_bin/brew"
  local bottle="$root/hello--1.0.wasm32_kandelo.bottle.tar.gz"
  local renamed_bottle="$root/bottle.tar.gz"
  local bottle_json="$root/hello.bottle.json"
  local dependency_provenance="$root/dependency-provenance.json"
  local selection_receipt="$root/selection-receipt.json"
  local sysroot_build_root="$root/sysroot-build"
  local runtime_evidence="$root/runtime-evidence.json"
  local target_prefix="$brew_prefix/Cellar/hello/1.0"
  local target_opt_prefix="$brew_prefix/opt/hello"
  local nested_target_prefix="$brew_prefix/Cellar/hello/nested/Cellar/hello/1.0"
  local cache="$root/cache"
  local brew_temp="$root/tmp"
  local log="$root/brew.log"
  local realm_log="$root/realms.log"
  local lifecycle_log="$root/lifecycle.log"
  local state="$root/state"
  local provenance_capture="$root/provenance.txt"
  local provenance_log_capture="$root/provenance-install.log"
  local native_prefix_capture="$root/native-prefix.txt"
  local sysroot_build_root_capture="$root/sysroot-build-root.txt"
  local shared_temp="$root/shared-temp"
  local renamed_err="$root/renamed-bottle.err"
  local nested_target_err="$root/nested-target.err"
  local bottle_sha bottle_bytes tap_commit native_prefix real_python3 real_rm host_git_bin
  local KANDELO_HOMEBREW_RESOLVED_TAPS_FILE

  make_tap "$tap"
  cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
  depends_on "cmake" => :test
  depends_on "ninja" => :test
  depends_on "kandelo-dev/tap-core/zlib"
  depends_on "kandelo-dev/tap-core/test-helper" => :test
end
EOF
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any, wasm32_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end
end
EOF
  cat >"$tap/Formula/test-helper.rb" <<'EOF'
class TestHelper < Formula
end
EOF
  git -C "$tap" add Formula
  git -C "$tap" commit -q -m "add verifier dependencies"
  tap_commit="$(git -C "$tap" rev-parse HEAD)"
  git clone -q "$tap" "$provenance_tap"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$(make_primary_resolved_tap_map "$provenance_tap")"
  export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE
  printf '\n# reconstructed bottle metadata\n' >>"$tap/Formula/hello.rb"

  mkdir -p "$brew_repo" "$brew_prefix/opt" "$fake_bin" "$target_prefix" \
    "$nested_target_prefix" \
    "$cache" "$brew_temp" "$state" "$sysroot_build_root/sysroot/lib" "$shared_temp"
  printf 'fixture libc archive\n' >"$sysroot_build_root/sysroot/lib/libc.a"
  ln -s ../Cellar/hello/1.0 "$target_opt_prefix"
  target_prefix="$(cd "$target_prefix" && pwd -P)"
  printf 'stale cache entry\n' >"$cache/stale"
  printf 'verified bottle bytes\n' >"$bottle"
  printf '{"schema":1}\n' >"$dependency_provenance"
  printf '{"bottle":{"mode":"anonymous-public-readback"}}\n' >"$selection_receipt"
  printf '{"poured_from_bottle":true}\n' >"$target_prefix/INSTALL_RECEIPT.json"
  bottle_sha="$(sha256sum "$bottle" | awk '{print $1}')"
  bottle_bytes="$(wc -c <"$bottle" | tr -d '[:space:]')"
  jq -nS --arg sha256 "$bottle_sha" '{
    hello: {
      formula: {name: "hello", path: "Formula/hello.rb", pkg_version: "1.0"},
      bottle: {
        root_url: "https://example.invalid",
        cellar: "any_skip_relocation",
        rebuild: 0,
        tags: {wasm32_kandelo: {sha256: $sha256}}
      }
    }
  }' >"$bottle_json"

  cp "$bottle" "$renamed_bottle"
  if GITHUB_ACTIONS= \
    bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-verify-poured-bottle.sh" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$tap_commit" \
      --formula hello \
      --arch wasm32 \
      --abi 39 \
      --bottle "$renamed_bottle" \
      --bottle-json "$bottle_json" \
      --bottle-url https://example.invalid/hello--1.0.wasm32_kandelo.bottle.tar.gz \
      --bottle-sha256 "$bottle_sha" \
      --bottle-bytes "$bottle_bytes" \
      --bottle-root-url https://example.invalid \
      --dependency-provenance "$dependency_provenance" \
      --selection-receipt "$selection_receipt" \
      --sysroot-build-root "$sysroot_build_root" \
      --out "$root/renamed-runtime-evidence.json" >/dev/null 2>"$renamed_err"; then
    fail "bottle verifier accepted a generic local archive filename"
  fi
  grep -F "selected bottle must use Homebrew filename hello--1.0.wasm32_kandelo.bottle.tar.gz" \
    "$renamed_err" >/dev/null ||
    fail "bottle verifier did not explain the generic local archive filename"

  cat >"$fake_brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_BREW_LOG"
printf '%s|%s\n' "${FAKE_HOMEBREW_REALM:-target}" "$*" >>"$FAKE_REALM_COMMAND_LOG"
if [ "${FAKE_HOMEBREW_REALM:-target}" = native ]; then
  [ "${HOMEBREW_RELOCATE_BUILD_PREFIX:-}" = 1 ] || exit 52
else
  [ -z "${HOMEBREW_RELOCATE_BUILD_PREFIX+x}" ] || exit 53
fi
case "${1:-}" in
  --prefix)
    if [ "${FAKE_HOMEBREW_REALM:-target}" = native ]; then
      printf '%s\n' "$FAKE_NATIVE_PREFIX"
    elif [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_PREFIX"
    else
      printf '%s\n' "$FAKE_TARGET_OPT_PREFIX"
    fi
    ;;
  --repository)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_REPOSITORY"
    else
      printf '%s\n' "$FAKE_TAP_ROOT"
    fi
    ;;
  tap)
    [ "$#" -eq 3 ] || exit 39
    rm -rf "$FAKE_TAP_ROOT"
    git clone -q --no-local "$3" "$FAKE_TAP_ROOT"
    ;;
  trust)
    case "$*" in
      'trust --tap kandelo-dev/tap-core') ;;
      *) exit 40 ;;
    esac
    ;;
  deps)
    case "$*" in
      'deps --topological --full-name --formula kandelo-dev/tap-core/hello')
        printf '%s\n' dynamic-runtime-host kandelo-dev/tap-core/zlib
        ;;
      'deps --topological --full-name --include-test --formula kandelo-dev/tap-core/hello')
        printf '%s\n' dynamic-test-host kandelo-dev/tap-core/zlib \
          kandelo-dev/tap-core/test-helper
        ;;
      *) exit 41 ;;
    esac
    ;;
  install)
    case "$*" in
      'install --as-dependency --formula homebrew/core/cmake'|\
      'install --as-dependency --formula homebrew/core/ninja')
        [ "${FAKE_HOMEBREW_REALM:-target}" = native ] || exit 42
        printf 'native-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        printf 'native-provenance-sentinel\n'
        : >"$FAKE_STATE/native"
        ;;
      'install --force-bottle --as-dependency --ignore-dependencies --formula kandelo-dev/tap-core/zlib')
        [ -f "$FAKE_STATE/native" ] && [ -f "$HOMEBREW_CACHE/stale" ] || exit 43
        printf 'zlib-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        : >"$FAKE_STATE/zlib"
        ;;
      'install --force-bottle --as-dependency --ignore-dependencies --formula kandelo-dev/tap-core/test-helper')
        [ -f "$FAKE_STATE/zlib" ] && [ -f "$HOMEBREW_CACHE/stale" ] || exit 43
        printf 'test-helper-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        : >"$FAKE_STATE/test-helper"
        ;;
      'install --force-bottle --ignore-dependencies --formula kandelo-dev/tap-core/hello')
        [ -f "$FAKE_STATE/native" ] && [ -f "$FAKE_STATE/test-helper" ] && \
          [ ! -e "$HOMEBREW_CACHE/stale" ] || exit 45
        cmp -s "$FAKE_TAP_ROOT/Formula/hello.rb" \
          "$FAKE_RECONSTRUCTED_TAP/Formula/hello.rb" || exit 44
        [ -z "$(find "$HOMEBREW_CACHE" -mindepth 1 -print -quit)" ] || exit 46
        printf 'target-tags=%s|%s\n' \
          "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
          >>"$FAKE_BREW_LOG"
        cp "$FAKE_BOTTLE" "$HOMEBREW_CACHE/selected-bottle.tar.gz"
        mkdir -p "$FAKE_BREW_PREFIX/bin"
        cat >"$FAKE_BREW_PREFIX/bin/git" <<'TARGET_GIT'
#!/usr/bin/env bash
exit 86
TARGET_GIT
        chmod +x "$FAKE_BREW_PREFIX/bin/git"
        : >"$FAKE_STATE/target"
        ;;
      *) exit 47 ;;
    esac
    ;;
  list)
    case "$*" in
      'list --formula cmake'|'list --formula ninja') ;;
      'list --versions --formula kandelo-dev/tap-core/hello') ;;
      *) exit 48 ;;
    esac
    ;;
  info)
    if [ "${FAKE_HOMEBREW_REALM:-target}" = native ]; then
      case "$*" in
        'info --json=v2 homebrew/core/cmake') dependency=cmake ;;
        'info --json=v2 homebrew/core/ninja') dependency=ninja ;;
        *) exit 49 ;;
      esac
      printf '{"formulae":[{"name":"%s","full_name":"%s","tap":"homebrew/core","installed":[{"version":"1"}]}]}\n' \
        "$dependency" "$dependency"
    else
      [ "$*" = 'info --json=v2 kandelo-dev/tap-core/hello' ] || exit 49
      printf '{}\n'
    fi
    ;;
  missing)
    [ "${FAKE_HOMEBREW_REALM:-target}" = native ] && [ "$*" = missing ] || exit 50
    ;;
  test)
    [ "$*" = 'test kandelo-dev/tap-core/hello' ] && \
      [ -f "$FAKE_STATE/target" ] || exit 50
    [ -x "$FAKE_BREW_PREFIX/bin/git" ] || exit 54
    [ "${HOMEBREW_GIT_PATH:-}" = "$FAKE_EXPECTED_HOST_GIT" ] || exit 55
    [ "$HOMEBREW_GIT_PATH" != "$FAKE_BREW_PREFIX/bin/git" ] || exit 56
    "$HOMEBREW_GIT_PATH" --version >/dev/null || exit 57
    trusted_remote="$("$HOMEBREW_GIT_PATH" -C "$FAKE_TAP_ROOT" \
      config --local --get remote.origin.url)"
    trusted_remote="${trusted_remote#file://}"
    [ "$(cd "$trusted_remote" && pwd -P)" = \
      "$(cd "$FAKE_RECONSTRUCTED_TAP" && pwd -P)" ] || exit 58
    [ "$(grep -c '^trust --tap kandelo-dev/tap-core$' "$FAKE_BREW_LOG")" -eq 1 ] || exit 59
    printf 'test-tags=%s|%s\n' \
      "${HOMEBREW_KANDELO_BOTTLE_TAG:-}" "${KANDELO_HOMEBREW_BOTTLE_TAG:-}" \
      >>"$FAKE_BREW_LOG"
    printf '{"schema":1}\n' >"$HOMEBREW_KANDELO_NODE_RECEIPT_PATH"
    ;;
  *) exit 51 ;;
esac
EOF
  chmod +x "$fake_brew"

  real_python3="$(command -v python3)"
  real_rm="$(command -v rm)"
  host_git_bin="$(command -v git)"
  cat >"$fake_bin/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
tool="$(basename "${1:-}")"
if [ "$tool" != homebrew-dependency-provenance.py ] && \
   [ "$tool" != homebrew-bottle-runtime-evidence.py ]; then
  exec "$REAL_PYTHON3" "$@"
fi
shift
[ "${1:-}" = capture ] || exit 60
shift
expected=""
out=""
install_log=""
target_prefix=""
target_receipt=""
tap_root=""
dependency_tap_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-dependencies) expected="${2:-}"; shift 2 ;;
    --install-log) install_log="${2:-}"; shift 2 ;;
    --target-prefix) target_prefix="${2:-}"; shift 2 ;;
    --target-receipt) target_receipt="${2:-}"; shift 2 ;;
    --tap-root) tap_root="${2:-}"; shift 2 ;;
    --dependency-tap-root) dependency_tap_root="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$install_log" ] && [ -n "$out" ] || exit 61
cp "$install_log" "$FAKE_PROVENANCE_LOG_CAPTURE"
if [ "$tool" = homebrew-dependency-provenance.py ]; then
  [ -n "$expected" ] || exit 62
  [ "$(cd "$tap_root" && pwd -P)" = \
    "$(cd "$FAKE_PROVENANCE_TAP_ROOT" && pwd -P)" ] || exit 65
  cp "$expected" "$FAKE_PROVENANCE_CAPTURE"
else
  [ "$(cd "$tap_root" && pwd -P)" = \
    "$(cd "$FAKE_RECONSTRUCTED_TAP" && pwd -P)" ] || exit 66
  [ "$(cd "$dependency_tap_root" && pwd -P)" = \
    "$(cd "$FAKE_PROVENANCE_TAP_ROOT" && pwd -P)" ] || exit 67
  [ "$target_prefix" = "$FAKE_TARGET_PREFIX" ] || exit 63
  [ "$target_receipt" = "$FAKE_TARGET_PREFIX/INSTALL_RECEIPT.json" ] || exit 64
fi
printf '{"schema":1}\n' >"$out"
EOF
  chmod +x "$fake_bin/python3"

  cat >"$fake_bin/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--) shift ;;
    *) break ;;
  esac
done
command="$1"
shift
if [ "$command" = /usr/bin/rm ]; then
  command="${REAL_RM:?}"
fi
exec "$command" "$@"
EOF
  chmod +x "$fake_bin/sudo"

  run_bottle_verifier_fixture() {
    local evidence_out="$1"
    PATH="$fake_bin:$PATH" \
      REAL_PYTHON3="$real_python3" \
      REAL_RM="$real_rm" \
      FAKE_BREW_LOG="$log" \
      FAKE_REALM_COMMAND_LOG="$realm_log" \
      FAKE_REALM_LIFECYCLE_LOG="$lifecycle_log" \
      FAKE_NATIVE_PREFIX_CAPTURE="$native_prefix_capture" \
      FAKE_SYSROOT_BUILD_ROOT_CAPTURE="$sysroot_build_root_capture" \
      FAKE_BREW_PREFIX="$brew_prefix" \
      FAKE_BREW_REPOSITORY="$brew_repo" \
      FAKE_TAP_ROOT="$tapped_tap" \
      FAKE_RECONSTRUCTED_TAP="$tap" \
      FAKE_EXPECTED_HOST_GIT="$host_git_bin" \
      FAKE_TARGET_OPT_PREFIX="$target_opt_prefix" \
      FAKE_TARGET_PREFIX="$target_prefix" \
      FAKE_STATE="$state" \
      FAKE_BOTTLE="$bottle" \
      FAKE_PROVENANCE_TAP_ROOT="$provenance_tap" \
      FAKE_PROVENANCE_CAPTURE="$provenance_capture" \
      FAKE_PROVENANCE_LOG_CAPTURE="$provenance_log_capture" \
      HOMEBREW_BREW_FILE="$fake_brew" \
      HOMEBREW_CACHE="$cache" \
      HOMEBREW_TEMP="$brew_temp" \
      KANDELO_HOMEBREW_BUILD_USER=fixture-build-user \
      KANDELO_HOMEBREW_SHARED_TEMP="$shared_temp" \
      KANDELO_HOMEBREW_SUDO_BIN="$fake_bin/sudo" \
      HOMEBREW_KANDELO_BOTTLE_TAG=caller-poison \
      KANDELO_HOMEBREW_BOTTLE_TAG=caller-poison \
      HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
      HOMEBREW_GIT_PATH=caller-poison \
      GITHUB_ACTIONS= \
      bash "$FORMULA_RUNNER_FIXTURE_ROOT/scripts/homebrew-verify-poured-bottle.sh" \
        --tap-root "$tap" \
        --tap-repository kandelo-dev/homebrew-tap-core \
        --tap-commit "$tap_commit" \
        --formula hello \
        --arch wasm32 \
        --abi 39 \
        --bottle "$bottle" \
        --bottle-json "$bottle_json" \
        --bottle-url https://example.invalid/hello--1.0.wasm32_kandelo.bottle.tar.gz \
        --bottle-sha256 "$bottle_sha" \
        --bottle-bytes "$bottle_bytes" \
        --bottle-root-url https://example.invalid \
        --dependency-provenance "$dependency_provenance" \
        --selection-receipt "$selection_receipt" \
        --sysroot-build-root "$sysroot_build_root" \
        --out "$evidence_out"
  }

  rm "$target_opt_prefix"
  ln -s ../Cellar/hello/nested/Cellar/hello/1.0 "$target_opt_prefix"
  if run_bottle_verifier_fixture "$root/nested-runtime-evidence.json" \
      >/dev/null 2>"$nested_target_err"; then
    fail "bottle verifier accepted a nested lookalike target keg"
  fi
  grep -F "target Formula opt prefix does not select the exact versioned keg" \
    "$nested_target_err" >/dev/null ||
    {
      cat "$nested_target_err" >&2
      fail "bottle verifier did not explain the nested lookalike target keg"
    }

  rm "$target_opt_prefix"
  ln -s ../Cellar/hello/1.0 "$target_opt_prefix"
  rm -rf "$brew_prefix/Cellar/hello/nested" "$cache" "$state"
  mkdir -p "$cache" "$state"
  printf 'stale cache entry\n' >"$cache/stale"
  : >"$log"
  : >"$realm_log"
  : >"$lifecycle_log"

  run_bottle_verifier_fixture "$runtime_evidence" >/dev/null

  [ "$(cat "$sysroot_build_root_capture")" = \
    "$(cd "$sysroot_build_root" && pwd -P)" ] ||
    fail "bottle verifier passed the wrong protected sysroot build root"

  [ -L "$target_opt_prefix" ] && \
    [ "$(readlink "$target_opt_prefix")" = ../Cellar/hello/1.0 ] ||
    fail "bottle verifier changed the canonical target opt link"

  cmp -s "$tap/Formula/hello.rb" "$tapped_tap/Formula/hello.rb" ||
    fail "bottle verifier did not materialize the reconstructed Formula into Homebrew's tap"
  [ "$(git -C "$tapped_tap" rev-parse HEAD)" = "$tap_commit" ] ||
    fail "bottle verifier changed the selected tap commit"
  [ "$(git -C "$tapped_tap" status --short --untracked-files=all)" = \
    " M Formula/hello.rb" ] ||
    fail "bottle verifier changed the selected tap outside the reconstructed Formula"

  native_prefix="$(cat "$native_prefix_capture")"
  case "$native_prefix" in
    /tmp/k.??????/p) ;;
    *) fail "bottle verifier did not use the bounded native prefix: $native_prefix" ;;
  esac
  [ ! -e "${native_prefix%/p}" ] ||
    fail "bottle verifier retained its native prefix after successful cleanup"

  local tap_trust_line native_cmake_line native_ninja_line
  local native_cmake_info_line native_ninja_info_line native_missing_line
  local runtime_line test_query_line seal_line cmake_bridge_line cmake_proxy_line
  local ninja_bridge_line ninja_proxy_line
  local zlib_line helper_line target_line formula_test_line
  tap_trust_line="$(grep -n '^target|trust --tap kandelo-dev/tap-core$' "$realm_log" | cut -d: -f1)"
  native_cmake_line="$(grep -n '^native|install --as-dependency --formula homebrew/core/cmake$' "$realm_log" | cut -d: -f1)"
  native_ninja_line="$(grep -n '^native|install --as-dependency --formula homebrew/core/ninja$' "$realm_log" | cut -d: -f1)"
  native_cmake_info_line="$(grep -n '^native|info --json=v2 homebrew/core/cmake$' "$realm_log" | cut -d: -f1)"
  native_ninja_info_line="$(grep -n '^native|info --json=v2 homebrew/core/ninja$' "$realm_log" | cut -d: -f1)"
  native_missing_line="$(grep -n '^native|missing$' "$realm_log" | cut -d: -f1)"
  runtime_line="$(grep -n '^target|deps --topological --full-name --formula ' "$realm_log" | cut -d: -f1)"
  test_query_line="$(grep -n '^target|deps --topological --full-name --include-test ' "$realm_log" | cut -d: -f1)"
  seal_line="$(grep -n '^lifecycle|seal-native$' "$realm_log" | cut -d: -f1)"
  cmake_bridge_line="$(grep -n '^lifecycle|bridge-native:cmake$' "$realm_log" | cut -d: -f1)"
  cmake_proxy_line="$(grep -n '^target|list --formula cmake$' "$realm_log" | cut -d: -f1)"
  ninja_bridge_line="$(grep -n '^lifecycle|bridge-native:ninja$' "$realm_log" | cut -d: -f1)"
  ninja_proxy_line="$(grep -n '^target|list --formula ninja$' "$realm_log" | cut -d: -f1)"
  zlib_line="$(grep -n '^target|install --force-bottle .*zlib$' "$realm_log" | cut -d: -f1)"
  helper_line="$(grep -n '^target|install --force-bottle .*test-helper$' "$realm_log" | cut -d: -f1)"
  target_line="$(grep -n '^target|install --force-bottle --ignore-dependencies --formula .*hello$' "$realm_log" | cut -d: -f1)"
  formula_test_line="$(grep -n '^target|test kandelo-dev/tap-core/hello$' "$realm_log" | cut -d: -f1)"
  [ "$tap_trust_line" -lt "$native_cmake_line" ] && \
    [ "$native_cmake_line" -lt "$native_ninja_line" ] && \
    [ "$native_ninja_line" -lt "$native_cmake_info_line" ] && \
    [ "$native_cmake_info_line" -lt "$native_ninja_info_line" ] && \
    [ "$native_ninja_info_line" -lt "$native_missing_line" ] && \
    [ "$native_missing_line" -lt "$runtime_line" ] && \
    [ "$runtime_line" -lt "$test_query_line" ] && \
    [ "$test_query_line" -lt "$seal_line" ] && \
    [ "$seal_line" -lt "$cmake_bridge_line" ] && \
    [ "$cmake_bridge_line" -lt "$cmake_proxy_line" ] && \
    [ "$cmake_proxy_line" -lt "$ninja_bridge_line" ] && \
    [ "$ninja_bridge_line" -lt "$ninja_proxy_line" ] && \
    [ "$ninja_proxy_line" -lt "$zlib_line" ] && \
    [ "$zlib_line" -lt "$helper_line" ] && \
    [ "$helper_line" -lt "$target_line" ] && \
    [ "$target_line" -lt "$formula_test_line" ] ||
    fail "bottle verifier installed dependencies, target, or test out of order"
  ! grep -F 'homebrew/core/dynamic-' "$realm_log" >/dev/null ||
    fail "bottle verifier selected its native plan from evaluated Formula output"
  [ "$(cat "$lifecycle_log")" = $'prepare-native\nseed-bundler:bottle formula_test\nstage-dependency-plan\nisolate\nseal-native\nbridge-native:cmake\nbridge-native:ninja\nteardown\nverify-isolation\ncleanup' ] ||
    fail "bottle verifier did not prepare, seal, bridge, and clean up the native realm"
  if grep -q '^trust --formula ' "$log"; then
    fail "bottle verifier persisted redundant Formula trust"
  fi
  grep -Fx 'zlib-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "verifier runtime dependency lost the Kandelo bottle tag"
  grep -Fx 'test-helper-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "verifier test dependency was not force-poured as a Kandelo bottle"
  grep -Fx 'native-tags=|' "$log" >/dev/null ||
    fail "verifier host test dependencies inherited a Kandelo bottle tag"
  grep -Fx 'target-tags=wasm32_kandelo|wasm32_kandelo' "$log" >/dev/null ||
    fail "verifier public target pour lost the Kandelo bottle tag"
  grep -Fx 'test-tags=|' "$log" >/dev/null ||
    fail "Formula test inherited a Kandelo bottle tag"
  [ "$(cat "$provenance_capture")" = 'kandelo-dev/tap-core/zlib' ] ||
    fail "verifier runtime provenance included its test-only dependency"
  ! grep -F 'native-provenance-sentinel' "$provenance_log_capture" >/dev/null ||
    fail "native Homebrew output contaminated verifier provenance"
  [ -f "$runtime_evidence" ] || fail "bottle verifier did not emit runtime evidence"
}

assert_dependency_pour_provenance_is_bounded() {
  local root="$TMPDIR/dependency-provenance"
  local tap="$root/tap"
  local cellar="$root/cellar/zlib/1.3.1"
  local target_receipt="$root/target-receipt.json"
  local expected_dependencies="$root/expected-dependencies.txt"
  local install_log="$root/install.log"
  local fake_brew="$root/prefix/bin/brew"
  local fake_brew_target="$root/homebrew/bin/brew"
  local info="$root/zlib-info.json"
  local output="$root/provenance.json"
  local bad="$root/bad.json"
  local err="$root/external-dependency.err"
  local formula_sha
  local bottle_sha="1111111111111111111111111111111111111111111111111111111111111111"
  local tap_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  mkdir -p "$tap/Formula" "$cellar" "$(dirname "$fake_brew")" "$(dirname "$fake_brew_target")"
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  desc "fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
  cat >"$tap/Formula/curl.rb" <<'EOF'
class Curl < Formula
  desc "consumer fixture"
  depends_on "kandelo-dev/tap-core/zlib"
end
EOF
  formula_sha="$(sha256sum "$tap/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap/Formula/zlib.rb" | awk '{print $1}')"
  jq -nS --arg tap_commit "$tap_commit" '{
    homebrew_version: "Homebrew fixture",
    built_as_bottle: true,
    poured_from_bottle: true,
    installed_on_request: false,
    source: {
      tap: "kandelo-dev/tap-core",
      tap_git_head: $tap_commit
    },
    runtime_dependencies: []
  }' >"$cellar/INSTALL_RECEIPT.json"
  jq -nS '{runtime_dependencies: [{
    full_name: "kandelo-dev/tap-core/zlib",
    version: "1.3.1",
    pkg_version: "1.3.1",
    revision: 0,
    declared_directly: true
  }]}' >"$target_receipt"
  printf '%s\n' 'kandelo-dev/tap-core/zlib' >"$expected_dependencies"
  jq -nS --arg formula_sha "$formula_sha" --arg bottle_sha "$bottle_sha" '{
    formulae: [{
      name: "zlib",
      full_name: "kandelo-dev/tap-core/zlib",
      ruby_source_checksum: {sha256: $formula_sha},
      bottle: {stable: {
        rebuild: 0,
        files: {wasm32_kandelo: {
          cellar: ":any_skip_relocation",
          url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:" + $bottle_sha),
          sha256: $bottle_sha
        }}
      }}
    }],
    casks: []
  }' >"$info"
  cat >"$fake_brew_target" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
launcher_prefix="$(cd "$(dirname "$0")/.." && pwd -P)"
expected_prefix="$(cd "$FAKE_PREFIX" && pwd -P)"
[ "$launcher_prefix" = "$expected_prefix" ] || {
  echo "brew launcher derived the wrong prefix: $launcher_prefix" >&2
  exit 3
}
case "${1:-}" in
  --cellar)
    [ "${2:-}" = "kandelo-dev/tap-core/zlib" ]
    printf '%s\n' "$FAKE_CELLAR/zlib"
    ;;
  info)
    [ "${2:-}" = "--json=v2" ]
    [ "${3:-}" = "kandelo-dev/tap-core/zlib" ]
    cat "$FAKE_INFO"
    ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$fake_brew_target"
  ln -s "$fake_brew_target" "$fake_brew"
  cat >"$install_log" <<EOF
==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1
==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz
EOF

  FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" \
      --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$tap_commit" \
      --formula curl \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" \
      --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" \
      --out "$output"
  python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$output" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" \
    --formula curl \
    --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap"
  jq -e --arg bottle_sha "$bottle_sha" '
    (.dependencies | length) == 1 and
    .dependencies[0].name == "zlib" and
    .dependencies[0].bottle.sha256 == $bottle_sha and
    .dependencies[0].bottle.cellar == "any_skip_relocation" and
    .dependencies[0].bottle.rebuild == 0 and
    .dependencies[0].receipt.built_as_bottle == true and
    .dependencies[0].receipt.poured_from_bottle == true and
    .dependencies[0].receipt.installed_on_request == false and
    .dependencies[0].install_log.fetch == [
      "==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1"
    ] and
    (.dependencies[0].install_log.pour | length) == 1 and
    .dependencies[0].install_log.source_build_absent == true
  ' "$output" >/dev/null || fail "dependency provenance omitted exact bottle-pour evidence"

  local exact_blob_output="$root/provenance-exact-blob.json"
  jq --arg bottle_sha "$bottle_sha" '
    .dependencies[0].install_log.fetch = [
      ("==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:" + $bottle_sha)
    ]
  ' "$output" >"$exact_blob_output"
  python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$exact_blob_output" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" \
    --formula curl \
    --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap"

  jq '.formulae[0].bottle.stable.files.wasm32_kandelo.cellar = ":unsupported"' \
    "$info" >"$bad"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$bad" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/unsupported-symbolic-cellar.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted an unknown symbolic brew info cellar"
  fi

  local malformed_rebuild
  for malformed_rebuild in 'null' '"0"' 'true' '-1'; do
    jq --argjson value "$malformed_rebuild" \
      '.runtime_dependencies[0].bottle_rebuild = $value' "$target_receipt" >"$bad"
    if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
      python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
        --brew-bin "$fake_brew" --tap-root "$tap" \
        --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
        --formula curl --arch wasm32 \
        --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
        --target-receipt "$bad" --expected-dependencies "$expected_dependencies" \
        --install-log "$install_log" --out "$root/malformed-receipt-rebuild.json" \
        >/dev/null 2>&1; then
      fail "dependency provenance accepted malformed target receipt bottle_rebuild $malformed_rebuild"
    fi
  done

  jq '.runtime_dependencies[0].bottle_rebuild = 1' "$target_receipt" >"$bad"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$bad" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/mismatched-receipt-rebuild.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted a target receipt for another bottle rebuild"
  fi

  local malformed_install_log="$root/malformed-install.log"
  cat >"$malformed_install_log" <<EOF
==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:$bottle_sha
==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz.extra
EOF
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$malformed_install_log" --out "$root/malformed-capture.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance capture accepted a suffixed bottle filename"
  fi

  jq '.dependencies[0].install_log.pour = [
    "==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz.extra"
  ]' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "dependency provenance validator accepted a suffixed bottle filename"
  fi

  local malformed_fetch_line
  for malformed_fetch_line in \
    '==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1.extra' \
    '==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1?query' \
    '==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/manifests/1.3.1' \
    '==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.2' \
    '==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1-1' \
    '==> Fetching downloads for: zlib'; do
    jq --arg line "$malformed_fetch_line" \
      '.dependencies[0].install_log.fetch = [$line]' \
      "$output" >"$bad"
    if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$bad" --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-commit "$tap_commit" --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --tap-root "$tap" >/dev/null 2>&1; then
      fail "dependency provenance validator accepted malformed fetch line $malformed_fetch_line"
    fi
  done

  local rebuild_output="$root/provenance-rebuild1.json"
  cp "$tap/Formula/zlib.rb" "$root/zlib-rebuild0.rb"
  cp "$info" "$root/zlib-info-rebuild0.json"
  cp "$target_receipt" "$root/target-receipt-rebuild0.json"
  cp "$install_log" "$root/install-rebuild0.log"
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  desc "fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    rebuild 1
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
  formula_sha="$(sha256sum "$tap/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap/Formula/zlib.rb" | awk '{print $1}')"
  jq --arg formula_sha "$formula_sha" '
    .formulae[0].ruby_source_checksum.sha256 = $formula_sha |
    .formulae[0].bottle.stable.rebuild = 1
  ' "$root/zlib-info-rebuild0.json" >"$info"
  cat >"$install_log" <<EOF
==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1-1
==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.1.tar.gz
EOF
  local omitted_rebuild_output="$root/omitted-nonzero-rebuild.json"
  FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$root/target-receipt-rebuild0.json" \
      --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$omitted_rebuild_output"
  python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$omitted_rebuild_output" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap"
  jq -e '
    .dependencies[0].bottle.rebuild == 1 and
    .dependencies[0].install_log.fetch == [
      "==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1-1"
    ] and
    .dependencies[0].install_log.pour == [
      "==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.1.tar.gz"
    ]
  ' "$omitted_rebuild_output" >/dev/null ||
    fail "dependency provenance did not bind an omitted receipt rebuild to exact pour evidence"

  jq '.runtime_dependencies[0].bottle_rebuild = 0' \
    "$root/target-receipt-rebuild0.json" >"$target_receipt"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/explicit-stale-rebuild.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted an explicit stale bottle rebuild"
  fi
  jq '.runtime_dependencies[0].bottle_rebuild = 1' \
    "$root/target-receipt-rebuild0.json" >"$target_receipt"
  FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$rebuild_output"
  python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$rebuild_output" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap"
  jq -e '
    .dependencies[0].bottle.rebuild == 1 and
    .dependencies[0].install_log.fetch == [
      "==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/manifests/1.3.1-1"
    ] and
    .dependencies[0].install_log.pour == [
      "==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.1.tar.gz"
    ]
  ' "$rebuild_output" >/dev/null ||
    fail "dependency provenance did not preserve exact rebuild bottle evidence"

  cat >"$install_log" <<EOF
==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:$bottle_sha
==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz
EOF
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/rebuild-missing-suffix.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance capture accepted a rebuild bottle without its suffix"
  fi

  jq '.dependencies[0].install_log.pour = [
    "==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz"
  ]' "$rebuild_output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "dependency provenance validator accepted a rebuild bottle without its suffix"
  fi
  cp "$root/zlib-rebuild0.rb" "$tap/Formula/zlib.rb"
  cp "$root/zlib-info-rebuild0.json" "$info"
  cp "$root/target-receipt-rebuild0.json" "$target_receipt"
  cp "$root/install-rebuild0.log" "$install_log"
  formula_sha="$(sha256sum "$tap/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap/Formula/zlib.rb" | awk '{print $1}')"

  local fabricated_sha="2222222222222222222222222222222222222222222222222222222222222222"
  jq --arg fabricated_sha "$fabricated_sha" '
    .dependencies[0].bottle.sha256 = $fabricated_sha |
    .dependencies[0].bottle.url =
      ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:" + $fabricated_sha) |
    .dependencies[0].install_log.fetch = [
      ("==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/zlib/blobs/sha256:" + $fabricated_sha)
    ]
  ' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "fresh dependency validation accepted fabricated prior-bottle metadata"
  fi

  jq '.dependencies = []' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "fresh dependency validation accepted an omitted exact-tap closure"
  fi

  jq '.runtime_dependencies = []' "$target_receipt" >"$bad"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$bad" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/missing-dependency.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted a target receipt missing a resolved dependency"
  fi

  jq '.runtime_dependencies += [{
    full_name: "example/tools/bubblewrap",
    version: "0.11.2",
    pkg_version: "0.11.2",
    revision: 0,
    bottle_rebuild: 0,
    declared_directly: true
  }]' "$target_receipt" >"$bad"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$bad" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/external-dependency.json" \
      >/dev/null 2>"$err"; then
    fail "dependency provenance silently filtered an external target receipt dependency"
  fi
  grep -F "target receipt runtime dependency 'example/tools/bubblewrap' is outside immutable resolved taps" \
    "$err" >/dev/null ||
    {
      cat "$err" >&2
      fail "dependency provenance did not explain the external target receipt dependency"
    }
  [ ! -e "$root/external-dependency.json" ] ||
    fail "dependency provenance emitted output after rejecting an external dependency"

  # A planned tap root belongs only to the selected primary tap. External
  # dependencies remain bound to their own exact resolved checkout; validating
  # one must never look for its Formula in the primary tap.
  local cross_root="$root/cross-tap-planned-root"
  local cross_primary="$cross_root/primary"
  local cross_core="$cross_root/core"
  local cross_cellar="$cross_root/cellar/zlib/1.3.1"
  local cross_info="$cross_root/zlib-info.json"
  local cross_resolved="$cross_root/resolved-taps.json"
  local cross_output="$cross_root/provenance.json"
  local cross_primary_commit cross_core_commit cross_formula_sha
  mkdir -p "$cross_primary/Formula" "$cross_primary/Kandelo" \
    "$cross_core/Formula" "$cross_cellar"
  cp "$tap/Formula/zlib.rb" "$cross_core/Formula/zlib.rb"
  cat >"$cross_primary/Formula/m4.rb" <<'EOF'
class M4 < Formula
  desc "external dependency consumer fixture"
  depends_on "kandelo-dev/tap-core/zlib"
end
EOF
  git -C "$cross_core" init -q
  git -C "$cross_core" config user.name "Kandelo Test"
  git -C "$cross_core" config user.email "kandelo-test@example.invalid"
  git -C "$cross_core" add Formula/zlib.rb
  git -C "$cross_core" commit -q -m "exact core dependency"
  cross_core_commit="$(git -C "$cross_core" rev-parse HEAD)"
  cat >"$cross_primary/Kandelo/dependency-taps.json" <<EOF
{
  "schema": 1,
  "taps": [
    {
      "tap_name": "kandelo-dev/tap-core",
      "tap_repository": "kandelo-dev/homebrew-tap-core",
      "tap_commit": "$cross_core_commit"
    }
  ]
}
EOF
  git -C "$cross_primary" init -q
  git -C "$cross_primary" config user.name "Kandelo Test"
  git -C "$cross_primary" config user.email "kandelo-test@example.invalid"
  git -C "$cross_primary" add Formula/m4.rb Kandelo/dependency-taps.json
  git -C "$cross_primary" commit -q -m "exact external consumer"
  cross_primary_commit="$(git -C "$cross_primary" rev-parse HEAD)"
  python3 "$REPO_ROOT/scripts/homebrew-dependency-taps.py" resolve \
    --tap-root "$cross_primary" \
    --tap-name example/tools \
    --tap-repository example/homebrew-tools \
    --tap-commit "$cross_primary_commit" \
    --dependency-root "kandelo-dev/tap-core=$cross_core" \
    --out "$cross_resolved"
  cross_formula_sha="$(sha256sum "$cross_core/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$cross_core/Formula/zlib.rb" | awk '{print $1}')"
  jq --arg formula_sha "$cross_formula_sha" \
    '.formulae[0].ruby_source_checksum.sha256 = $formula_sha' \
    "$info" >"$cross_info"
  jq --arg core_commit "$cross_core_commit" \
    '.source.tap_git_head = $core_commit' \
    "$cellar/INSTALL_RECEIPT.json" >"$cross_cellar/INSTALL_RECEIPT.json"

  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$cross_resolved" \
    FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$cross_root/cellar" FAKE_INFO="$cross_info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" \
      --tap-root "$cross_primary" \
      --tap-name example/tools \
      --tap-repository example/homebrew-tools \
      --tap-commit "$cross_primary_commit" \
      --formula m4 \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/example/homebrew-tools \
      --target-receipt "$target_receipt" \
      --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" \
      --out "$cross_output"
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$cross_resolved" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$cross_output" \
      --tap-root "$cross_primary" \
      --tap-name example/tools \
      --tap-repository example/homebrew-tools \
      --tap-commit "$cross_primary_commit" \
      --formula m4 \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/example/homebrew-tools
  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$cross_resolved" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$cross_output" \
      --tap-root "$cross_primary" \
      --planned-tap-root "$cross_primary" \
      --tap-name example/tools \
      --tap-repository example/homebrew-tools \
      --tap-commit "$cross_primary_commit" \
      --formula m4 \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/example/homebrew-tools
  jq -e --arg core_commit "$cross_core_commit" '
    .schema == 3 and
    .tap_name == "example/tools" and
    .dependencies == [
      (.dependencies[0] | select(
        .full_name == "kandelo-dev/tap-core/zlib" and
        .origin.tap_name == "kandelo-dev/tap-core" and
        .origin.tap_commit == $core_commit
      ))
    ]
  ' "$cross_output" >/dev/null ||
    fail "cross-tap dependency provenance lost its exact external origin"

  printf 'untracked external tap drift\n' >"$cross_core/Formula/untracked.rb"
  if KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$cross_resolved" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
      --input "$cross_output" \
      --tap-root "$cross_primary" \
      --tap-name example/tools \
      --tap-repository example/homebrew-tools \
      --tap-commit "$cross_primary_commit" \
      --formula m4 \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/example/homebrew-tools \
      >/dev/null 2>"$root/cross-untracked.err"; then
    fail "dependency provenance accepted an untracked external resolved tap"
  fi
  grep -F "resolved tap kandelo-dev/tap-core has working-tree changes" \
    "$root/cross-untracked.err" >/dev/null ||
    fail "dependency provenance did not explain an untracked external resolved tap"

  jq '.poured_from_bottle = false' "$cellar/INSTALL_RECEIPT.json" >"$bad"
  mv "$bad" "$cellar/INSTALL_RECEIPT.json"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository kandelo-dev/homebrew-tap-core --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$bad" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted a source-built dependency receipt"
  fi

  jq '.dependencies[0].install_log.source_build_absent = false' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    >/dev/null 2>&1; then
    fail "dependency provenance validator accepted a source-build claim"
  fi

  printf '# changed after build\n' >>"$tap/Formula/zlib.rb"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$output" --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "dependency provenance accepted Formula drift from the exact tap"
  fi
}

assert_static_formula_closure_is_fail_closed() {
  local tap="$TMPDIR/static-closure-tap"
  local output
  mkdir -p "$tap/Formula"
  cat >"$tap/Formula/dep-b.rb" <<'RUBY'
class DepB < Formula
end
RUBY
  cat >"$tap/Formula/dep-a.rb" <<'RUBY'
class DepA < Formula
  depends_on "kandelo-dev/tap-core/dep-b"
end
RUBY
  cat >"$tap/Formula/dep-recommended.rb" <<'RUBY'
class DepRecommended < Formula
end
RUBY
  cat >"$tap/Formula/root.rb" <<'RUBY'
class Root < Formula
  depends_on "pkgconf" => :build
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/dep-a"
  depends_on "kandelo-dev/tap-core/dep-recommended" => :recommended
  depends_on "kandelo-dev/tap-core/not-installed" => :optional
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core root)"
  [ "$output" = $'kandelo-dev/tap-core/dep-a\nkandelo-dev/tap-core/dep-b\nkandelo-dev/tap-core/dep-recommended' ] ||
    fail "static Formula resolver did not produce the recursive runtime closure: $output"
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core root --direct)"
  [ "$output" = $'kandelo-dev/tap-core/dep-a\nkandelo-dev/tap-core/dep-recommended' ] ||
    fail "static Formula resolver did not produce only direct runtime dependencies: $output"
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core root --bottle-identity-json)"
  printf '%s\n' "$output" | jq -e '
    keys == ["bottle", "formula", "full_name", "schema", "tap"] and
    .schema == 1 and
    .tap == "kandelo-dev/tap-core" and
    .formula == "root" and
    .full_name == "kandelo-dev/tap-core/root" and
    .bottle == {"root_url": null, "rebuild": 0}
  ' >/dev/null ||
    fail "static Formula resolver did not preserve unbottled rebuild zero: $output"

  cat >"$tap/Formula/rebuilt.rb" <<'RUBY'
class Rebuilt < Formula
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    rebuild 7
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core rebuilt --bottle-identity-json)"
  printf '%s\n' "$output" | jq -e '
    .schema == 1 and
    .tap == "kandelo-dev/tap-core" and
    .formula == "rebuilt" and
    .full_name == "kandelo-dev/tap-core/rebuilt" and
    .bottle == {
      "root_url": "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
      "rebuild": 7
    }
  ' >/dev/null ||
    fail "static Formula resolver did not preserve a positive bottle rebuild: $output"

  cat >"$tap/Formula/rich-static.rb" <<'RUBY'
class RichStatic < Formula
  PAYLOAD_VERSION = "1.0".freeze
  PAYLOAD_NAME = "payload-#{PAYLOAD_VERSION}".freeze

  depends_on "kandelo-dev/tap-core/dep-a"

  on_macos do
    keg_only :provided_by_macos
  end

  resource "payload" do
    url "https://example.invalid/payload.tar.gz"
    version PAYLOAD_VERSION
    sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end

  def install
    prepare_package_specific_inputs
    verify_payload_contract
  end

  private

  def verify_payload_contract
    dependencies = [PAYLOAD_NAME]
    dependencies.fetch(0)
  end

  def prepare_package_specific_inputs
    PAYLOAD_NAME
  end
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core rich-static)"
  [ "$output" = $'kandelo-dev/tap-core/dep-a\nkandelo-dev/tap-core/dep-b' ] ||
    fail "static Formula resolver rejected safe constants, resources, or private helpers: $output"

  expect_static_closure_failure() {
    local formula="$1" label="$2"
    if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
      "$tap" kandelo-dev/tap-core "$formula" >/dev/null 2>&1; then
      fail "static Formula resolver accepted $label"
    fi
  }

  cat >"$tap/Formula/conditional.rb" <<'RUBY'
class Conditional < Formula
  if ENV["INCLUDE_DEP"]
    depends_on "kandelo-dev/tap-core/dep-a"
  end
end
RUBY
  expect_static_closure_failure conditional "a conditional dependency"

  cat >"$tap/Formula/modifier.rb" <<'RUBY'
class Modifier < Formula
  depends_on "kandelo-dev/tap-core/dep-a" if ENV["INCLUDE_DEP"]
end
RUBY
  expect_static_closure_failure modifier "a modifier-if dependency"

  cat >"$tap/Formula/interpolated.rb" <<'RUBY'
class Interpolated < Formula
  dependency = "dep-a"
  depends_on "kandelo-dev/tap-core/#{dependency}"
end
RUBY
  expect_static_closure_failure interpolated "an interpolated dependency"

  cat >"$tap/Formula/helper.rb" <<'RUBY'
class Helper < Formula
  def self.declare_dependency
    depends_on "kandelo-dev/tap-core/dep-a"
  end
end
RUBY
  expect_static_closure_failure helper "a dependency hidden in a helper"

  cat >"$tap/Formula/initializer.rb" <<'RUBY'
class Initializer < Formula
  def initialize(*args)
    super
    self.class.__send__("depends_" + "on", "kandelo-dev/tap-core/dep-a")
  end
end
RUBY
  expect_static_closure_failure initializer "an initialization-time dependency dispatch"

  cat >"$tap/Formula/dependencies-override.rb" <<'RUBY'
class DependenciesOverride < Formula
  def dependencies
    []
  end
end
RUBY
  expect_static_closure_failure dependencies-override "a Formula dependency accessor override"

  cat >"$tap/Formula/receiver.rb" <<'RUBY'
class Receiver < Formula
  self.depends_on "kandelo-dev/tap-core/dep-a"
end
RUBY
  expect_static_closure_failure receiver "a dependency with a dynamic receiver"

  cat >"$tap/Formula/string-dispatch.rb" <<'RUBY'
class StringDispatch < Formula
  send("depends_" + "on", "kandelo-dev/tap-core/dep-a")
end
RUBY
  expect_static_closure_failure string-dispatch "a dependency built through string dispatch"

  cat >"$tap/Formula/class-eval.rb" <<'RUBY'
class ClassEval < Formula
  class_eval("depends_" + "on \"kandelo-dev/tap-core/dep-a\"")
end
RUBY
  expect_static_closure_failure class-eval "a dependency built through class_eval"

  cat >"$tap/Formula/patch-execution.rb" <<'RUBY'
class PatchExecution < Formula
  patch do
    PatchExecution.singleton_class.instance_method(("depends_" + "on").to_sym).bind_call(
      PatchExecution,
      "kandelo-dev/tap-core/dep-a",
    )
  end
end
RUBY
  expect_static_closure_failure patch-execution "executable dependency dispatch in a patch block"

  cat >"$tap/Formula/on-macos-argument.rb" <<'RUBY'
class OnMacosArgument < Formula
  on_macos(system("touch", "/tmp/untrusted-formula-block")) do
  end
end
RUBY
  expect_static_closure_failure on-macos-argument "executable arguments on an on_macos block"

  cat >"$tap/Formula/patch-argument.rb" <<'RUBY'
class PatchArgument < Formula
  patch(system("touch", "/tmp/untrusted-formula-block")) do
  end
end
RUBY
  expect_static_closure_failure patch-argument "executable arguments on a patch block"

  cat >"$tap/Formula/test-argument.rb" <<'RUBY'
class TestArgument < Formula
  test(system("touch", "/tmp/untrusted-formula-block")) do
  end
end
RUBY
  expect_static_closure_failure test-argument "executable arguments on a test block"

  cat >"$tap/Formula/private-hook.rb" <<'RUBY'
class PrivateHook < Formula
  private

  def recursive_dependencies
    []
  end
end
RUBY
  expect_static_closure_failure private-hook "a private Formula dependency hook override"

  cat >"$tap/Formula/private-copy-hook.rb" <<'RUBY'
class PrivateCopyHook < Formula
  private

  def initialize_copy(other)
    super
  end
end
RUBY
  expect_static_closure_failure private-copy-hook "a private Ruby initialization hook override"

  cat >"$tap/Formula/foreign-include.rb" <<'RUBY'
class ForeignInclude < Formula
  include DependencyDeclaringSupport
end
RUBY
  expect_static_closure_failure foreign-include "an alternate class-body support module"

  mkdir -p "$tap/Kandelo/formula_support"
  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  KANDELO_TAP_FORMULA_PREFIX = "kandelo-dev/tap-core/"

  def formula_opt_prefix(name)
    name.delete_prefix(KANDELO_TAP_FORMULA_PREFIX)
  end

  def kandelo_fixture
    "fixture"
  end
end
RUBY
  cat >"$tap/Formula/support-ok.rb" <<'RUBY'
require "digest"
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportOk < Formula
  include KandeloFormulaSupport
  depends_on "kandelo-dev/tap-core/dep-a"
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core support-ok)"
  [ "$output" = $'kandelo-dev/tap-core/dep-a\nkandelo-dev/tap-core/dep-b' ] ||
    fail "static Formula resolver rejected a canonical benign support module: $output"

  cat >"$tap/Formula/unsupported-require.rb" <<'RUBY'
require "pathname"

class UnsupportedRequire < Formula
end
RUBY
  expect_static_closure_failure unsupported-require "an unapproved top-level standard-library require"

  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def self.included(formula)
    formula.singleton_class.instance_method(("depends_" + "on").to_sym).bind_call(
      formula,
      "kandelo-dev/tap-core/dep-a",
    )
  end
end
RUBY
  cat >"$tap/Formula/support-hook.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportHook < Formula
  include KandeloFormulaSupport
end
RUBY
  expect_static_closure_failure support-hook "a load-time Kandelo support-module hook"

  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def kandelo_fixture
  end
ensure
  Formula.singleton_class.instance_method(("depends_" + "on").to_sym).bind(Formula).call(
    "kandelo-dev/tap-core/dep-a",
  )
end
RUBY
  cat >"$tap/Formula/support-ensure.rb" <<'RUBY'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportEnsure < Formula
  include KandeloFormulaSupport
end
RUBY
  expect_static_closure_failure support-ensure "an executable support-module ensure tail"

  cat >"$tap/Formula/uses-from-macos.rb" <<'RUBY'
class UsesFromMacos < Formula
  uses_from_macos "kandelo-dev/tap-core/dep-a"
end
RUBY
  expect_static_closure_failure uses-from-macos "an alternate dependency DSL"

  cat >"$tap/Formula/deps-mutation.rb" <<'RUBY'
class DepsMutation < Formula
  deps << Dependency.new("kandelo-dev/tap-core/dep-a")
end
RUBY
  expect_static_closure_failure deps-mutation "a direct dependency collector mutation"

  cat >"$tap/Formula/top-level.rb" <<'RUBY'
warn "unexpected Formula-load execution"

class TopLevel < Formula
  depends_on "kandelo-dev/tap-core/dep-a"
end
RUBY
  expect_static_closure_failure top-level "an unsupported top-level executable statement"

  cat >"$tap/Formula/class-ensure.rb" <<'RUBY'
class ClassEnsure < Formula
  desc "fixture"
ensure
  singleton_class.instance_method(("depends_" + "on").to_sym).bind(self).call(
    "kandelo-dev/tap-core/dep-a",
  )
end
RUBY
  expect_static_closure_failure class-ensure "an executable Formula class ensure tail"

  cat >"$tap/Formula/unnormalized.rb" <<'RUBY'
class Unnormalized < Formula
  depends_on "Kandelo-dev/tap-core/dep-a"
end
RUBY
  expect_static_closure_failure unnormalized "an unnormalized same-tap dependency"

  cat >"$tap/Formula/unknown-tag.rb" <<'RUBY'
class UnknownTag < Formula
  depends_on "kandelo-dev/tap-core/dep-a" => :mystery
end
RUBY
  expect_static_closure_failure unknown-tag "an unknown dependency tag"

  cat >"$tap/Formula/wrong-name.rb" <<'RUBY'
class Wrong < Formula
end
RUBY
  expect_static_closure_failure wrong-name "a Formula class that does not match its filename"

  cat >"$tap/Formula/cycle-a.rb" <<'RUBY'
class CycleA < Formula
  depends_on "kandelo-dev/tap-core/cycle-b"
end
RUBY
  cat >"$tap/Formula/cycle-b.rb" <<'RUBY'
class CycleB < Formula
  depends_on "kandelo-dev/tap-core/cycle-a"
end
RUBY
  expect_static_closure_failure cycle-a "a same-tap dependency cycle"

  mkdir -p "$TMPDIR/static-closure-symlink-tap"
  ln -s "$tap/Formula" "$TMPDIR/static-closure-symlink-tap/Formula"
  if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$TMPDIR/static-closure-symlink-tap" kandelo-dev/tap-core root \
    >/dev/null 2>&1; then
    fail "static Formula resolver accepted a symlinked Formula directory"
  fi
}

assert_failure_preserves_metadata() {
  local tap="$TMPDIR/failure-tap"
  make_tap "$tap"
  local before after
  before="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "intentional test failure" \
    --dry-run \
    --no-lock >/dev/null
  after="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  [ "$before" = "$after" ] || fail "failure path modified metadata.json"
  find "$tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' -print -quit |
    grep -q . || fail "failure path did not write failure report"
}

assert_success_payload_size_bounds_are_final() {
  local tap="$TMPDIR/oversized-sidecar-tap"
  local payload="$TMPDIR/oversized-sidecar-payload"
  local err="$TMPDIR/oversized-sidecar.err"
  local link metadata
  make_tap "$tap"
  metadata="$TMPDIR/oversized-sidecar-metadata.json"
  jq '.packages = [{
    name: "hello",
    version: "2.12.1",
    formula_revision: 0,
    bottle_rebuild: 0
  }]' "$tap/Kandelo/metadata.json" >"$metadata"
  mv "$metadata" "$tap/Kandelo/metadata.json"
  mkdir -p "$tap/Kandelo/formula" "$tap/Kandelo/link"
  printf '{}\n' >"$tap/Kandelo/formula/hello.json"
  printf '{}\n' >"$tap/Kandelo/link/hello-1-rebuild0-wasm32.json"
  git -C "$tap" add Kandelo
  git -C "$tap" commit -q -m "add sidecar size fixtures"
  link="$(find "$tap/Kandelo/link" -mindepth 1 -maxdepth 1 -type f -print -quit)"

  for relative in \
    Kandelo/metadata.json \
    Kandelo/formula/hello.json \
    "Kandelo/link/$(basename "$link")"; do
    rm -rf "$payload"
    cp -a "$tap" "$payload"
    truncate -s "$((HOMEBREW_MAX_SIDECAR_JSON_BYTES + 1))" "$payload/$relative"
    if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
      --tap-root "$tap" \
      --sidecar-root "$payload" \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --status success \
      --dry-run \
      --no-lock >/dev/null 2>"$err"; then
      fail "sidecar publisher accepted oversized final $relative"
    fi
    grep -q "exceeds $HOMEBREW_MAX_SIDECAR_JSON_BYTES bytes" "$err" ||
      fail "sidecar publisher did not explain oversized final $relative"
  done

  rm -rf "$payload"
  cp -a "$tap" "$payload"
  truncate -s "$((HOMEBREW_MAX_SIDECAR_JSON_BYTES + 1))" \
    "$tap/Kandelo/formula/stale.json"
  git -C "$tap" add Kandelo/formula/stale.json
  git -C "$tap" commit -q -m "add stale oversized sidecar"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --sidecar-root "$payload" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status success \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "sidecar publisher accepted an oversized stale file in the final merged tap"
  fi
  grep -q "exceeds $HOMEBREW_MAX_SIDECAR_JSON_BYTES bytes" "$err" ||
    fail "sidecar publisher did not explain an oversized stale file in the final merged tap"
}

assert_failure_reports_do_not_collide_within_one_second() {
  local tap="$TMPDIR/failure-collision-tap"
  local bin="$TMPDIR/failure-collision-bin"
  local report_count
  make_tap "$tap"
  mkdir -p "$bin"
  cat >"$bin/date" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "-u +%FT%TZ" ]; then
  printf '%s\n' '2026-07-12T12:34:56Z'
else
  exec /bin/date "$@"
fi
EOF
  chmod +x "$bin/date"

  PATH="$bin:$PATH" GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
      --tap-root "$tap" \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --status failed \
      --error "first same-second failure" \
      --dry-run \
      --no-lock >/dev/null
  PATH="$bin:$PATH" GITHUB_RUN_ID=101 GITHUB_RUN_ATTEMPT=2 \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
      --tap-root "$tap" \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --status failed \
      --error "second same-second failure" \
      --dry-run \
      --no-lock >/dev/null

  report_count="$(find "$tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' | wc -l | tr -d '[:space:]')"
  [ "$report_count" = "2" ] || fail "same-second failure reports overwrote one another"
  find "$tap/Kandelo/reports/failures" -type f -name '*-run-100-attempt-1-hello-wasm32.json' -print -quit |
    grep -q . || fail "first failure report lacks stable run identity"
  find "$tap/Kandelo/reports/failures" -type f -name '*-run-101-attempt-2-hello-wasm32.json' -print -quit |
    grep -q . || fail "second failure report lacks stable run identity"
}

assert_write_publish_requires_attached_branch_and_pushes_explicit_ref() {
  local remote="$TMPDIR/publish-origin.git"
  local seed="$TMPDIR/publish-seed"
  local tap="$TMPDIR/publish-tap"
  local report_tap="$TMPDIR/publish-report-tap"
  local updater="$TMPDIR/publish-updater"
  local err="$TMPDIR/detached-publish.err"
  local local_head remote_head report planned_tap planned_kandelo

  git init --bare -q "$remote"
  make_tap "$seed"
  git -C "$seed" branch -M main
  git -C "$seed" remote add origin "$remote"
  git -C "$seed" push -q -u origin main
  git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
  git clone -q "$remote" "$tap"
  git -C "$tap" config user.name "Kandelo Test"
  git -C "$tap" config user.email "kandelo-test@example.invalid"
  planned_tap="$(git -C "$tap" rev-parse HEAD)"
  planned_kandelo="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  git -C "$tap" checkout -q --detach
  if GITHUB_SHA="cccccccccccccccccccccccccccccccccccccccc" \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "detached publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "write publication accepted a detached tap checkout"
  fi
  grep -q "requires an attached tap branch" "$err" ||
    fail "detached publication did not explain the branch requirement"

  git -C "$tap" switch -q --force-create feature HEAD
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "feature publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "write publication accepted a non-main tap branch"
  fi
  grep -q "requires tap main" "$err" ||
    fail "non-main publication did not explain the main-branch requirement"

  git -C "$tap" switch -q --force-create main HEAD
  printf '\nUNVALIDATED_PARTIAL\n' >>"$tap/Formula/hello.rb"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "dirty failure publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "failure publication accepted a dirty tap checkout"
  fi
  grep -q "must be clean before publication" "$err" ||
    fail "dirty failure publication did not explain the clean-checkout requirement"
  ! git --git-dir="$remote" show main:Formula/hello.rb | grep -q UNVALIDATED_PARTIAL ||
    fail "dirty failure publication pushed an unvalidated partial payload"

  git -C "$tap" add Formula/hello.rb
  git -C "$tap" commit -q -m "unvalidated local success attempt"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "locally committed failure publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "failure publication accepted an unpushed local commit"
  fi
  grep -q "must match origin/main after refresh" "$err" ||
    fail "local-ahead failure publication did not explain the remote-main requirement"
  ! git --git-dir="$remote" show main:Formula/hello.rb | grep -q UNVALIDATED_PARTIAL ||
    fail "local-ahead failure publication pushed an unvalidated partial payload"

  git clone -q "$remote" "$updater"
  git -C "$updater" config user.name "Kandelo Test"
  git -C "$updater" config user.email "kandelo-test@example.invalid"
  printf 'remote advance\n' >"$updater/README.md"
  git -C "$updater" add README.md
  git -C "$updater" commit -q -m "advance tap main"
  git -C "$updater" push -q origin main

  git clone -q "$remote" "$report_tap"
  git -C "$report_tap" checkout -q --detach "$planned_tap"
  git -C "$report_tap" switch -q --force-create main "$planned_tap"
  GITHUB_SHA="cccccccccccccccccccccccccccccccccccccccc" \
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$report_tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "record after refresh" \
    --no-lock >/dev/null

  local_head="$(git -C "$report_tap" rev-parse HEAD)"
  remote_head="$(git --git-dir="$remote" rev-parse refs/heads/main)"
  [ "$local_head" = "$remote_head" ] ||
    fail "sidecar publication did not push the attached main branch"
  git -C "$report_tap" merge-base --is-ancestor "$(git -C "$updater" rev-parse HEAD)" HEAD ||
    fail "sidecar publication did not refresh from remote main before committing"
  report="$(find "$report_tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' -print -quit)"
  [ -n "$report" ] || fail "attached publication did not write its failure report"
  jq -e --arg tap "$planned_tap" --arg kandelo "$planned_kandelo" '
    .tap_commit == $tap and .kandelo_commit == $kandelo
  ' "$report" >/dev/null || fail "failure report did not record the planned source commits"
  ! grep -q "cccccccccccccccccccccccccccccccccccccccc" "$report" ||
    fail "failure report leaked the caller-context commit into provenance"
  if git --git-dir="$remote" show-ref --verify --quiet refs/heads/HEAD; then
    fail "sidecar publication created an inferred HEAD branch"
  fi
}

assert_failed_payload_rejects_success_status() {
  local tap="$TMPDIR/failure-payload-tap"
  local payload="$TMPDIR/failure-success-payload"
  local err="$TMPDIR/failure-success-payload.err"
  make_tap "$tap"
  mkdir -p "$payload/Kandelo"
  cat >"$payload/Kandelo/metadata.json" <<'EOF'
{
  "packages": [
    {
      "name": "hello",
      "bottles": [
        {
          "arch": "wasm32",
          "status": "success"
        }
      ]
    }
  ]
}
EOF
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --sidecar-root "$payload" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --dry-run \
    --no-lock > /dev/null 2>"$err"; then
    fail "failed publish accepted a success sidecar payload"
  fi
  grep -q "missing a non-success status" "$err" ||
    fail "failed publish did not explain rejected success payload"
}

assert_rollback_preserves_metadata() {
  local tap="$TMPDIR/rollback-tap"
  make_tap "$tap"
  local before after report
  before="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status rollback \
    --reason "bad bottle block selected by tap commit" \
    --rollback-ref "refs/heads/main~1" \
    --dry-run \
    --no-lock >/dev/null
  after="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  [ "$before" = "$after" ] || fail "rollback path modified metadata.json"
  report="$(find "$tap/Kandelo/reports/rollbacks" -type f -name '*-hello-wasm32.json' -print -quit)"
  [ -n "$report" ] || fail "rollback path did not write rollback report"
  jq -e '
    .status == "rollback" and
    .rollback_ref == "refs/heads/main~1" and
    .package_deletion.performed == false and
    (.package_deletion.policy | contains("exceptional"))
  ' "$report" >/dev/null || fail "rollback report did not record rollback policy"
}

assert_rollback_deletion_requires_reason() {
  local tap="$TMPDIR/rollback-deletion-tap"
  local err="$TMPDIR/rollback-deletion.err"
  make_tap "$tap"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status rollback \
    --reason "legal package removal" \
    --deleted-package-url "https://ghcr.io/v2/example/package/blobs/sha256:bad" \
    --dry-run \
    --no-lock > /dev/null 2>"$err"; then
    fail "rollback package deletion without reason unexpectedly succeeded"
  fi
  grep -q -- "--deletion-reason is required" "$err" ||
    fail "rollback deletion did not explain missing deletion reason"
}

assert_publisher_trust_contract() {
  ruby "$REPO_ROOT/scripts/check-homebrew-publish-workflow-trust.rb"
}

assert_index_artifact_download_topologies() {
  local helper="$REPO_ROOT/scripts/homebrew-index-artifact-paths.sh"
  local flat_child="$TMPDIR/index-artifacts-flat-child"
  local flat_publication="$TMPDIR/index-artifacts-flat-publication"
  local nested_child="$TMPDIR/index-artifacts-nested-child"
  local nested_publication="$TMPDIR/index-artifacts-nested-publication"
  local nested_single="$TMPDIR/index-artifacts-nested-single"
  local ambiguous="$TMPDIR/index-artifacts-ambiguous"
  local symlinked="$TMPDIR/index-artifacts-symlinked"
  local empty="$TMPDIR/index-artifacts-empty"
  local arch child_dir out publication_dir
  local -a paths=()

  mkdir -p "$flat_child/layout" "$flat_publication"
  printf '{"arch":"wasm32"}\n' >"$flat_child/receipt.json"
  printf '{"arch":"wasm32"}\n' >"$flat_publication/receipt.json"
  out="$TMPDIR/index-artifacts-flat-child.paths"
  bash "$helper" --root "$flat_child" --kind child --formula zlib \
    --run-attempt 1 --out "$out"
  mapfile -d '' -t paths <"$out"
  [ "${#paths[@]}" -eq 1 ] && [ "${paths[0]}" = "$flat_child/receipt.json" ] ||
    fail "single pattern-matched child artifact was not accepted in its flattened layout"
  out="$TMPDIR/index-artifacts-flat-publication.paths"
  bash "$helper" --root "$flat_publication" --kind publication --formula zlib \
    --run-attempt 1 --out "$out"
  mapfile -d '' -t paths <"$out"
  [ "${#paths[@]}" -eq 1 ] && [ "${paths[0]}" = "$flat_publication/receipt.json" ] ||
    fail "single pattern-matched publication artifact was not accepted in its flattened layout"

  for arch in wasm32 wasm64; do
    child_dir="$nested_child/homebrew-oci-child-zlib-${arch}-attempt-2"
    publication_dir="$nested_publication/homebrew-upload-receipt-zlib-${arch}-attempt-2"
    mkdir -p "$child_dir/layout" "$publication_dir"
    printf '{"arch":"%s"}\n' "$arch" >"$child_dir/receipt.json"
    printf '{"arch":"%s"}\n' "$arch" >"$publication_dir/receipt.json"
  done
  out="$TMPDIR/index-artifacts-nested-child.paths"
  bash "$helper" --root "$nested_child" --kind child --formula zlib \
    --run-attempt 2 --out "$out"
  mapfile -d '' -t paths <"$out"
  [ "${#paths[@]}" -eq 2 ] &&
    [ "${paths[0]}" = "$nested_child/homebrew-oci-child-zlib-wasm32-attempt-2/receipt.json" ] &&
    [ "${paths[1]}" = "$nested_child/homebrew-oci-child-zlib-wasm64-attempt-2/receipt.json" ] ||
    fail "multi-architecture child artifacts did not retain named-directory isolation"
  out="$TMPDIR/index-artifacts-nested-publication.paths"
  bash "$helper" --root "$nested_publication" --kind publication --formula zlib \
    --run-attempt 2 --out "$out"
  mapfile -d '' -t paths <"$out"
  [ "${#paths[@]}" -eq 2 ] &&
    [ "${paths[0]}" = "$nested_publication/homebrew-upload-receipt-zlib-wasm32-attempt-2/receipt.json" ] &&
    [ "${paths[1]}" = "$nested_publication/homebrew-upload-receipt-zlib-wasm64-attempt-2/receipt.json" ] ||
    fail "multi-architecture publication artifacts did not retain named-directory isolation"

  mkdir -p "$ambiguous/layout" \
    "$ambiguous/homebrew-oci-child-zlib-wasm32-attempt-1/layout"
  printf '{}\n' >"$ambiguous/receipt.json"
  printf '{}\n' >"$ambiguous/homebrew-oci-child-zlib-wasm32-attempt-1/receipt.json"
  if bash "$helper" --root "$ambiguous" --kind child --formula zlib \
    --run-attempt 1 --out "$TMPDIR/index-artifacts-ambiguous.paths" >/dev/null 2>&1; then
    fail "index artifact collector accepted mixed flattened and nested layouts"
  fi

  mkdir -p "$symlinked/layout" "$empty"
  printf '{}\n' >"$TMPDIR/index-artifacts-real-receipt.json"
  ln -s "$TMPDIR/index-artifacts-real-receipt.json" "$symlinked/receipt.json"
  if bash "$helper" --root "$symlinked" --kind child --formula zlib \
    --run-attempt 1 --out "$TMPDIR/index-artifacts-symlinked.paths" >/dev/null 2>&1; then
    fail "index artifact collector accepted a symlinked receipt"
  fi
  if bash "$helper" --root "$empty" --kind publication --formula zlib \
    --run-attempt 1 --out "$TMPDIR/index-artifacts-empty.paths" >/dev/null 2>&1; then
    fail "index artifact collector accepted a missing publication receipt"
  fi

  mkdir -p "$nested_single/homebrew-upload-receipt-zlib-wasm32-attempt-1"
  printf '{}\n' \
    >"$nested_single/homebrew-upload-receipt-zlib-wasm32-attempt-1/receipt.json"
  if bash "$helper" --root "$nested_single" --kind publication --formula zlib \
    --run-attempt 1 --out "$TMPDIR/index-artifacts-nested-single.paths" >/dev/null 2>&1; then
    fail "index artifact collector accepted an impossible nested single-artifact layout"
  fi
}

assert_formula_composition_is_static_and_lossless() {
  local planned="$TMPDIR/formula-planned.rb"
  local current="$TMPDIR/formula-current.rb"
  local composed="$TMPDIR/formula-composed.rb"
  local malicious="$TMPDIR/formula-malicious.rb"
  local unbottled="$TMPDIR/formula-unbottled.rb"
  local data_formula="$TMPDIR/formula-data.rb"
  local data_expected="$TMPDIR/formula-data-expected.rb"
  local nested_bottle="$TMPDIR/formula-nested-bottle.rb"
  local frozen_false="$TMPDIR/formula-frozen-false.rb"
  local frozen_true="$TMPDIR/formula-frozen-true.rb"
  local planned_digest current_digest

  cat >"$planned" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"
  end
end
EOF
  cat >"$current" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
  planned_digest="$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$planned")"
  current_digest="$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$current")"
  [ "$planned_digest" = "$current_digest" ] ||
    fail "Formula source digest treated a static sibling bottle as source drift"

  cat >"$unbottled" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF
  if [ "$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$unbottled")" = "$current_digest" ]; then
    fail "Formula source digest ignored bottle-block insertion or removal"
  fi
  ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" \
    --equivalent-excluding-bottle "$unbottled" "$current" >/dev/null ||
    fail "Formula source comparison rejected composer-owned bottle insertion"

  cat >"$frozen_false" <<'EOF'
# frozen_string_literal: false
class Hello < Formula
  VALUE = "runtime semantics"
end
EOF
  cat >"$frozen_true" <<'EOF'
# frozen_string_literal: true
class Hello < Formula
  VALUE = "runtime semantics"
end
EOF
  if [ "$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$frozen_false")" = \
       "$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$frozen_true")" ]; then
    fail "Formula source digest ignored a semantics-bearing magic comment"
  fi

  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$current" "$planned" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    0 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    preserve \
    "$composed"
  grep -F 'wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"' \
    "$composed" >/dev/null || fail "Formula composer omitted the selected bottle tag"
  grep -F 'wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"' \
    "$composed" >/dev/null || fail "Formula composer dropped the refreshed sibling bottle tag"

  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$current" "$planned" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    1 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    discard \
    "$composed"
  grep -F 'rebuild 1' "$composed" >/dev/null ||
    fail "Formula composer did not apply the transitioned bottle rebuild"
  if grep -F 'wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"' \
    "$composed" >/dev/null; then
    fail "Formula composer retained a sibling bottle across an identity transition"
  fi

  cat >"$data_formula" <<'EOF'
class Hello < Formula
  desc "Formula with an embedded patch"
  patch :DATA
end

__END__
diff --git a/source.c b/source.c
--- a/source.c
+++ b/source.c
@@ -1 +1 @@
-end
+patched
EOF
  cat >"$data_expected" <<'EOF'
class Hello < Formula
  desc "Formula with an embedded patch"
  patch :DATA

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"
  end

end

__END__
diff --git a/source.c b/source.c
--- a/source.c
+++ b/source.c
@@ -1 +1 @@
-end
+patched
EOF
  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$data_formula" "$data_formula" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    0 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    discard \
    "$composed"
  cmp "$data_expected" "$composed" >/dev/null ||
    fail "Formula composer did not insert before or preserve an embedded DATA patch"

  cat >"$malicious" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
  bottle { system "touch", "/tmp/untrusted" }
end
EOF
  if ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$malicious" \
    >/dev/null 2>&1; then
    fail "Formula source digest accepted a noncanonical executable bottle block"
  fi
  if ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$malicious" "$planned" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    0 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    preserve \
    "$composed" >/dev/null 2>&1; then
    fail "Formula composer accepted a noncanonical executable bottle block"
  fi

  cat >"$nested_bottle" <<'EOF'
class Hello < Formula
  def install
  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"
  end
  end
end
EOF
  if ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$nested_bottle" \
    >/dev/null 2>&1; then
    fail "Formula source digest accepted a bottle block inside an instance method"
  fi
  if ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$nested_bottle" "$planned" \
    https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    0 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    preserve \
    "$composed" >/dev/null 2>&1; then
    fail "Formula composer accepted a bottle block inside an instance method"
  fi
}

assert_formula_source_closure_is_bound() {
  local tap="$TMPDIR/formula-source-closure-tap"
  local reviewed="$TMPDIR/formula-source-closure-reviewed-tap"
  local err="$TMPDIR/formula-source-closure.err"
  local base

  mkdir -p "$tap/Formula" "$tap/Kandelo/formula_support"
  cat >"$tap/Formula/hello.rb" <<'EOF'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"
  end

  include KandeloFormulaSupport
end
EOF
  cat >"$tap/Formula/escape.rb" <<'EOF'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Escape < Formula
  include KandeloFormulaSupport

  def install
    require_relative "../Kandelo/other"
  end
end
EOF
  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'EOF'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def kandelo_runner_command
    runner = Pathname(__dir__)/"run-network-wasm.ts"
    command = +""
    root = "/tmp/root"
    command << "#{Shellwords.escape(runner.to_s)} #{Shellwords.escape(root)} "
  end

  def kandelo_runner_array
    runner = Pathname(__dir__)/"run-network-wasm.ts"
    command = [
      "node", runner, "/tmp/root"
    ].map { |arg| Shellwords.escape(arg.to_s) }.join(" ")
  end
end
EOF
  printf 'export const reviewed = true;\n' \
    >"$tap/Kandelo/formula_support/run-network-wasm.ts"
  printf 'Kandelo/formula_support/runtime-cache.tmp\n' >"$tap/.gitignore"
  git -C "$tap" init -q
  git -C "$tap" config user.name "Kandelo Test"
  git -C "$tap" config user.email "kandelo-test@example.invalid"
  git -C "$tap" add .
  git -C "$tap" commit -q -m "review Formula source closure"
  base="$(git -C "$tap" rev-parse HEAD)"
  git clone -q "$tap" "$reviewed"

  cat >"$tap/Formula/hello.rb" <<'EOF'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end

  include KandeloFormulaSupport
end
EOF
  bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" >/dev/null
  bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" \
    --reviewed-tap-root "$reviewed" >/dev/null
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula escape \
    --base-ref "$base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted an extra local reference with canonical support"
  fi
  grep -F "Formula has an unsupported local source reference" "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain the extra local reference"
  if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core escape --declarations-json \
    >/dev/null 2>"$err"; then
    fail "static Formula parser accepted require_relative inside an install method"
  fi
  grep -F 'require_relative' "$err" >/dev/null ||
    fail "static Formula parser did not explain the local reference"

  local support_fixture="$tap/Kandelo/formula_support/kandelo_formula_support.rb"
  local support_case support_expression
  for support_case in \
    missing traversal slash dynamic chained derived two_step_binary two_step_parent \
    nested_to_s array_alias interpolated_alias array_first reflected reassigned duplicate; do
    case "$support_case" in
      missing) support_expression='Pathname(__dir__)/"missing-runner.ts"' ;;
      traversal) support_expression='Pathname(__dir__)/"../other.rb"' ;;
      slash) support_expression='Pathname(__dir__)/"nested/runner.ts"' ;;
      dynamic) support_expression='Pathname(__dir__)/ENV.fetch("KANDELO_RUNNER")' ;;
      chained) support_expression='Pathname(__dir__)/"run-network-wasm.ts"/"child"' ;;
      derived) support_expression='(Pathname(__dir__)/"run-network-wasm.ts").parent/"other.rb"' ;;
      two_step_binary) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    runner/"child"' ;;
      two_step_parent) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    File.read(runner.parent.parent/"other.rb")' ;;
      nested_to_s) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    File.dirname(runner.to_s)' ;;
      array_alias) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    paths = [runner]\n    File.read(paths.first.parent.parent/"other.rb")' ;;
      interpolated_alias) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    text = "#{runner.to_s}"\n    Pathname(text).parent/"other.rb"' ;;
      array_first) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    [runner].first.parent.parent/"other.rb"' ;;
      reflected) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    binding.local_variable_set(:runner, Pathname("/tmp/other.rb"))' ;;
      reassigned) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    runner = Pathname("/tmp/other.rb")' ;;
      duplicate) support_expression=$'Pathname(__dir__)/"run-network-wasm.ts"\n    runner = Pathname(__dir__)/"run-network-wasm.ts"' ;;
    esac
    cat >"$support_fixture" <<EOF
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def kandelo_escape
    runner = $support_expression
    runner.to_s
  end
end
EOF
    if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
      "$tap" kandelo-dev/tap-core hello --declarations-json \
      >/dev/null 2>"$err"; then
      fail "static Formula parser accepted a $support_case support path escape"
    fi
    case "$support_case" in
      duplicate)
        grep -F 'binds more than one local support child' "$err" >/dev/null ||
          fail "static Formula parser did not explain the $support_case support path escape"
        ;;
      two_step_binary|two_step_parent|nested_to_s|array_alias|interpolated_alias|array_first|reassigned)
        grep -F 'derives or reassigns bound support child' "$err" >/dev/null ||
          fail "static Formula parser did not explain the $support_case support path escape"
        ;;
      reflected)
        grep -F 'forbidden local source operation "binding"' "$err" >/dev/null ||
          fail "static Formula parser did not explain the $support_case support path escape"
        ;;
      *)
        grep -F 'forbidden local source operation "__dir__"' "$err" >/dev/null ||
          fail "static Formula parser did not explain the $support_case support path escape"
        ;;
    esac
  done

  local wrapper_case support_method_body
  for wrapper_case in \
    nested_binding begin_binding if_binding wrapped_append wrapped_array wrapped_begin_append; do
    case "$wrapper_case" in
      nested_binding)
        support_method_body=$'    outside =\n      runner = Pathname(__dir__)/"run-network-wasm.ts"\n    command = +""\n    root = "/tmp/root"\n    command << "#{Shellwords.escape(runner.to_s)} #{Shellwords.escape(root)} "\n    File.read(outside.parent/"other.rb")'
        ;;
      begin_binding)
        support_method_body=$'    outside = begin\n      runner = Pathname(__dir__)/"run-network-wasm.ts"\n    end\n    command = +""\n    root = "/tmp/root"\n    command << "#{Shellwords.escape(runner.to_s)} #{Shellwords.escape(root)} "\n    File.read(outside.parent/"other.rb")'
        ;;
      if_binding)
        support_method_body=$'    outside = if true\n      runner = Pathname(__dir__)/"run-network-wasm.ts"\n    end\n    command = +""\n    root = "/tmp/root"\n    command << "#{Shellwords.escape(runner.to_s)} #{Shellwords.escape(root)} "\n    File.read(outside.parent/"other.rb")'
        ;;
      wrapped_append)
        support_method_body=$'    runner = Pathname(__dir__)/"run-network-wasm.ts"\n    command = +""\n    root = "/tmp/root"\n    outside = File.dirname(\n      command << "#{Shellwords.escape(runner.to_s)} #{Shellwords.escape(root)} "\n    )'
        ;;
      wrapped_array)
        support_method_body=$'    runner = Pathname(__dir__)/"run-network-wasm.ts"\n    File.dirname(\n      command = [\n        "node", runner, "/tmp/root"\n      ].map { |arg| Shellwords.escape(arg.to_s) }.join(" ")\n    )'
        ;;
      wrapped_begin_append)
        support_method_body=$'    runner = Pathname(__dir__)/"run-network-wasm.ts"\n    command = +""\n    root = "/tmp/root"\n    outside = begin\n      command << "#{Shellwords.escape(runner.to_s)} #{Shellwords.escape(root)} "\n    end'
        ;;
    esac
    cat >"$support_fixture" <<EOF
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def kandelo_escape
$support_method_body
  end
end
EOF
    if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
      "$tap" kandelo-dev/tap-core hello --declarations-json \
      >/dev/null 2>"$err"; then
      fail "static Formula parser accepted a $wrapper_case support path escape"
    fi
    case "$wrapper_case" in
      nested_binding|begin_binding|if_binding)
        grep -F 'forbidden local source operation "__dir__"' "$err" >/dev/null ||
          fail "static Formula parser did not explain the $wrapper_case support path escape"
        ;;
      *)
        grep -F 'derives or reassigns bound support child' "$err" >/dev/null ||
          fail "static Formula parser did not explain the $wrapper_case support path escape"
        ;;
    esac
  done
  git -C "$tap" show "$base:Kandelo/formula_support/kandelo_formula_support.rb" \
    >"$support_fixture"

  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'EOF'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def kandelo_escape
    require_relative "../other"
  end
end
EOF
  cat >"$tap/Formula/escape.rb" <<'EOF'
require (Tap.fetch("kandelo-dev", "tap-core").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Escape < Formula
  include KandeloFormulaSupport

  def install
    kandelo_escape
  end
end
EOF
  cat >"$tap/Formula/data-escape.rb" <<'EOF'
class DataEscape < Formula
  def install
    File.read(File.join(__dir__, "../Kandelo/options.txt"))
  end
end
EOF
  printf 'REVIEWED = true\n' >"$tap/Kandelo/other.rb"
  printf 'reviewed=true\n' >"$tap/Kandelo/options.txt"
  git -C "$tap" add Formula/escape.rb Formula/data-escape.rb \
    Kandelo/formula_support/kandelo_formula_support.rb Kandelo/other.rb Kandelo/options.txt
  git -C "$tap" commit -q -m "review support-local source reference"
  local escape_base
  escape_base="$(git -C "$tap" rev-parse HEAD)"
  printf 'REVIEWED = false\n' >"$tap/Kandelo/other.rb"
  printf 'reviewed=false\n' >"$tap/Kandelo/options.txt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula escape \
    --base-ref "$escape_base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted a support method loading unbound tap source"
  fi
  grep -F 'forbidden local source operation "require_relative"' "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain the support-local source escape"
  if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core escape --declarations-json \
    >/dev/null 2>"$err"; then
    fail "static Formula parser accepted a support method loading unbound tap source"
  fi
  grep -F 'forbidden local source operation "require_relative"' "$err" >/dev/null ||
    fail "static Formula parser did not explain the support-local source escape"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula data-escape \
    --base-ref "$escape_base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted an unbound tap-local data file"
  fi
  grep -F 'forbidden tap-local source operation "__dir__"' "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain the tap-local data escape"
  if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" kandelo-dev/tap-core data-escape --declarations-json \
    >/dev/null 2>"$err"; then
    fail "static Formula parser accepted an unbound tap-local data file"
  fi
  grep -F 'forbidden tap-local source operation "__dir__"' "$err" >/dev/null ||
    fail "static Formula parser did not explain the tap-local data escape"
  git -C "$tap" show "$base:Formula/escape.rb" >"$tap/Formula/escape.rb"
  git -C "$tap" show "$base:Kandelo/formula_support/kandelo_formula_support.rb" \
    >"$tap/Kandelo/formula_support/kandelo_formula_support.rb"
  rm "$tap/Formula/data-escape.rb" "$tap/Kandelo/other.rb" "$tap/Kandelo/options.txt"
  git -C "$tap" add -A Formula/escape.rb Formula/data-escape.rb Kandelo
  git -C "$tap" commit -q -m "restore reviewed source closure"

  printf 'module KandeloFormulaSupport\n  REVIEWED = false\nend\n' \
    >"$reviewed/Kandelo/formula_support/kandelo_formula_support.rb"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" \
    --reviewed-tap-root "$reviewed" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted a dirty reviewed tap"
  fi
  grep -F "reviewed tap root must be clean" "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain reviewed-tap drift"
  git -C "$reviewed" show HEAD:Kandelo/formula_support/kandelo_formula_support.rb \
    >"$reviewed/Kandelo/formula_support/kandelo_formula_support.rb"

  chmod +x "$tap/Formula/hello.rb"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted working-tree mode drift"
  fi
  grep -F "Formula file mode changed after the bottle build" "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain working-tree mode drift"
  git -C "$tap" add Formula/hello.rb
  git -C "$tap" commit -q -m "change only Formula mode"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted committed mode drift"
  fi
  chmod -x "$tap/Formula/hello.rb"
  git -C "$tap" add Formula/hello.rb
  git -C "$tap" commit -q -m "restore reviewed Formula mode"

  printf 'unreviewed helper payload\n' \
    >"$tap/Kandelo/formula_support/runtime-cache.tmp"
  git -C "$tap" check-ignore -q Kandelo/formula_support/runtime-cache.tmp ||
    fail "ignored source-closure fixture is not ignored"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted an ignored helper file"
  fi
  grep -F "Formula support working tree changed after the bottle build" "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain ignored helper drift"
  rm "$tap/Kandelo/formula_support/runtime-cache.tmp"

  printf 'module KandeloFormulaSupport\n  REVIEWED = false\nend\n' \
    >"$tap/Kandelo/formula_support/kandelo_formula_support.rb"
  git -C "$tap" add Kandelo/formula_support/kandelo_formula_support.rb
  git -C "$tap" commit -q -m "mutate only shared Formula support"
  git -C "$tap" show "$base:Formula/hello.rb" >"$TMPDIR/formula-source-closure-reviewed.rb"
  if [ "$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" \
      "$TMPDIR/formula-source-closure-reviewed.rb")" != \
       "$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" \
      "$tap/Formula/hello.rb")" ]; then
    fail "helper-only drift fixture changed the reviewed Formula source"
  fi
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted helper-only drift"
  fi
  grep -F "Formula support source changed after the bottle build" "$err" >/dev/null ||
    fail "Formula source-closure validator did not explain helper-only drift"
  if bash "$REPO_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
    --tap-root "$tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --base-ref "$base" \
    --reviewed-tap-root "$reviewed" >/dev/null 2>"$err"; then
    fail "Formula source-closure validator accepted helper drift against a fresh reviewed tap"
  fi
  grep -F "Formula support working tree changed after the bottle build" "$err" >/dev/null ||
    fail "Formula source-closure validator did not compare against the fresh reviewed tap"

  grep -F "scripts/homebrew-validate-formula-source-closure.sh" \
    "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" >/dev/null ||
    fail "under-lock publisher does not revalidate the Formula source closure"
}

make_formula_runner_fixture
assert_ghcr_auth_env_does_not_cross_dev_shell
assert_matrix
assert_matrix_skips_unchanged_cache_key
assert_resolved_primary_override_is_bounded
bash "$REPO_ROOT/scripts/test-homebrew-tap-identity.sh"
bash "$REPO_ROOT/scripts/test-homebrew-publisher-overlay-patch.sh"
bash "$REPO_ROOT/scripts/test-homebrew-oci-layout.sh"
assert_index_artifact_download_topologies
assert_sysroot_fingerprint_is_arch_specific
assert_bottle_build_trusts_selected_tap
assert_bottle_build_forces_same_tap_dependencies
assert_bottle_build_installs_test_dependencies
assert_bottle_verifier_installs_test_dependencies
bash "$REPO_ROOT/scripts/test-homebrew-provision-formula-browser.sh"
bash "$REPO_ROOT/scripts/test-materialize-resolver-binaries.sh"
assert_dependency_pour_provenance_is_bounded
assert_static_formula_closure_is_fail_closed
assert_generator_validates_homebrew_commit_as_data
assert_generic_tap_build_handoff_identity
assert_build_handoff_is_minimal_and_validated
assert_build_handoff_rejects_untrusted_content
assert_upload_receipt_is_bound_to_build_handoff
assert_publish_handoff_is_exact_inert_data
assert_stale_bottle_rebuild_cannot_rewind_publication
assert_publish_dependencies_are_source_bound
assert_failure_preserves_metadata
assert_success_payload_size_bounds_are_final
assert_failure_reports_do_not_collide_within_one_second
assert_write_publish_requires_attached_branch_and_pushes_explicit_ref
assert_failed_payload_rejects_success_status
assert_rollback_preserves_metadata
assert_rollback_deletion_requires_reason
bash "$REPO_ROOT/scripts/test-homebrew-sibling-bottle-policy.sh"
bash "$REPO_ROOT/scripts/test-homebrew-patched-launcher.sh"
bash "$REPO_ROOT/scripts/test-homebrew-inspect-bottle.sh"
bash "$REPO_ROOT/scripts/test-homebrew-formula-runtime-closure.sh"
bash "$REPO_ROOT/scripts/test-homebrew-bottle-runtime-evidence.sh"
assert_formula_composition_is_static_and_lossless
assert_formula_source_closure_is_bound
assert_publisher_trust_contract

echo "test-homebrew-publish-workflow.sh: ok"
