#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-tap-identity.sh"

fail() {
  echo "test-homebrew-tap-identity.sh: $*" >&2
  exit 1
}

expect_identity_rejection() {
  local label="$1" repository="$2" tap_name="${3:-}"
  if homebrew_resolve_tap_name "$repository" "$tap_name" >/dev/null 2>&1; then
    fail "accepted $label"
  fi
}

expect_local_clone_rejection() {
  local label="$1" checkout="$2"
  if homebrew_local_tap_clone_url "$checkout" >/dev/null 2>&1; then
    fail "accepted $label"
  fi
}

assert_local_clone_transport_detaches_git_objects() {
  local fixture="$TMPDIR/local clone # fixture"
  local source="$fixture/source" direct="$fixture/direct"
  local transported="$fixture/transported" url source_head
  local direct_shared transported_shared

  mkdir -p "$source"
  source="$(cd "$source" && pwd -P)"
  fixture="${source%/source}"
  direct="$fixture/direct"
  transported="$fixture/transported"
  git -C "$source" init -q
  git -C "$source" config user.name fixture
  git -C "$source" config user.email fixture@example.test
  printf 'reviewed tap bytes\n' >"$source/Formula.rb"
  git -C "$source" add Formula.rb
  git -C "$source" commit -q -m fixture
  git -C "$source" gc --prune=now -q
  source_head="$(git -C "$source" rev-parse HEAD)"
  # Synthetic campaign taps are detached at the reviewed campaign commit.
  # Exercise that production shape so transport cannot silently select a
  # branch tip instead.
  git -C "$source" checkout -q --detach "$source_head"

  # This control recreates the production failure: Git's local-path clone
  # shares object inodes with the source checkout on one filesystem.
  git clone -q --local "$source" "$direct"
  direct_shared="$(find "$direct/.git/objects" -type f -links +1 \
    -print -quit)"
  [ -n "$direct_shared" ] ||
    fail "local-clone fixture did not create shared Git object inodes"

  url="$(homebrew_local_tap_clone_url "$source")"
  case "$url" in
    file://*%20*%23*) ;;
    *) fail "local tap URL did not quote spaces and URL delimiters: $url" ;;
  esac
  git clone -q "$url" "$transported"
  [ "$(git -C "$transported" rev-parse HEAD)" = "$source_head" ] ||
    fail "transported local tap clone selected another commit"
  transported_shared="$(find "$transported/.git/objects" -type f \
    -links +1 -print -quit)"
  [ -z "$transported_shared" ] ||
    fail "transported local tap clone retained a shared Git object inode"
}

[ "$(homebrew_resolve_tap_name kandelo-dev/homebrew-tap-core '')" = \
  "kandelo-dev/tap-core" ] || fail "protected default identity changed"
[ "$(homebrew_resolve_tap_name Acme/homebrew-tools Acme/tools)" = \
  "acme/tools" ] || fail "conventional third-party identity was not normalized"
[ "$(homebrew_bottle_root_url kandelo-dev/homebrew-tap-core '')" = \
  "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core" ] || fail "protected repository-rooted bottle namespace changed"
[ "$(homebrew_bottle_root_url Acme/homebrew-tools Acme/tools)" = \
  "https://ghcr.io/v2/acme/homebrew-tools" ] || fail "third-party bottle root was not derived from its repository"
[ "$(homebrew_candidate_bottle_root_url kandelo-dev/homebrew-tap-core 9 curl)" = \
  "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-9-candidates/curl" ] ||
  fail "candidate bottle root was not derived from its repository, ABI, and Formula"
[ "$(homebrew_candidate_bottle_root_url Acme/homebrew-tools 17 mini-tool)" = \
  "https://ghcr.io/v2/acme/homebrew-tools-abi-17-candidates/mini-tool" ] ||
  fail "third-party candidate bottle root was not normalized"
if homebrew_candidate_bottle_root_url \
  kandelo-dev/homebrew-tap-core 0 curl >/dev/null 2>&1; then
  fail "candidate bottle root accepted ABI zero"
fi
if homebrew_candidate_bottle_root_url \
  kandelo-dev/homebrew-tap-core 9 '../curl' >/dev/null 2>&1; then
  fail "candidate bottle root accepted an unsafe Formula path"
fi

homebrew_formula_bottle_root_matches_build_authority \
  kandelo-dev/homebrew-tap-core kandelo-dev/tap-core lsof 43 \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-43-candidates/lsof \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core ||
  fail "candidate build rejected the tap's legacy canonical Formula root"
homebrew_formula_bottle_root_matches_build_authority \
  kandelo-dev/homebrew-tap-core kandelo-dev/tap-core lsof 43 \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-43-candidates/lsof \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-42/lsof ||
  fail "candidate build rejected the preceding ABI's canonical Formula root"
if homebrew_formula_bottle_root_matches_build_authority \
  kandelo-dev/homebrew-tap-core kandelo-dev/tap-core lsof 43 \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-43-candidates/lsof \
  https://ghcr.io/v2/attacker/homebrew-foreign; then
  fail "candidate build accepted a foreign Formula bottle root"
fi
if homebrew_formula_bottle_root_matches_build_authority \
  kandelo-dev/homebrew-tap-core kandelo-dev/tap-core lsof 43 \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-43-candidates/lsof \
  https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-42/other; then
  fail "candidate build accepted another Formula's preceding ABI root"
fi

# The exact staging adapter supplies this option to the normal bottle builder.
# Exercise the real parser and candidate namespace instead of merely checking
# the helper, so a later option-table merge cannot strand every hosted build.
candidate_tap="$TMPDIR/candidate-tap"
candidate_out="$TMPDIR/candidate-out"
candidate_err="$TMPDIR/candidate.err"
mkdir -p "$candidate_tap/Formula"
printf 'class Hello < Formula; end\n' >"$candidate_tap/Formula/hello.rb"
if HOMEBREW_BREW_FILE="$TMPDIR/missing-brew" \
  bash "$REPO_ROOT/scripts/homebrew-bottle-build.sh" \
    --tap-root "$candidate_tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula hello \
    --arch wasm32 \
    --out "$candidate_out" \
    --bottle-root-url \
      https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-43-candidates/hello \
    --staging-candidate-abi 43 \
    > /dev/null 2>"$candidate_err"; then
  fail "candidate parser fixture unexpectedly completed without Homebrew"
fi
grep -Fq 'HOMEBREW_BREW_FILE does not name an executable brew' \
  "$candidate_err" || {
  cat "$candidate_err" >&2
  fail "normal bottle builder did not accept its exact staging candidate ABI"
}

expect_identity_rejection "an implicit third-party tap name" Acme/homebrew-tools
expect_identity_rejection "a nonconventional third-party repository" Acme/tools Acme/tools
expect_identity_rejection "a mismatched third-party tap name" Acme/homebrew-tools Acme/other
expect_identity_rejection "a mismatched default tap name" \
  kandelo-dev/homebrew-tap-core kandelo-dev/homebrew-tap-core

relative_checkout="relative-tap-checkout"
regular_file="$TMPDIR/not-a-checkout"
real_checkout="$TMPDIR/real-checkout"
checkout_link="$TMPDIR/checkout-link"
printf 'not a checkout\n' >"$regular_file"
mkdir "$real_checkout"
ln -s "$real_checkout" "$checkout_link"
expect_local_clone_rejection "a relative local tap checkout" \
  "$relative_checkout"
expect_local_clone_rejection "a regular local tap checkout file" \
  "$regular_file"
expect_local_clone_rejection "a symlinked local tap checkout" \
  "$checkout_link"
assert_local_clone_transport_detaches_git_objects

# These identity-only `hello` values are synthetic input. They do not resolve a
# tap Formula, read GHCR, or describe a package retained by the active tap.
provenance="$TMPDIR/dependency-provenance.json"
jq -nS '{
  schema: 2,
  formula: "hello",
  arch: "wasm32",
  tap_repository: "Acme/homebrew-tools",
  tap_name: "acme/tools",
  tap_commit: ("a" * 40),
  bottle_root_url: "https://ghcr.io/v2/acme/homebrew-tools",
  bottle_tag: "wasm32_kandelo",
  dependencies: []
}' >"$provenance"

python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/tools \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/acme/homebrew-tools

if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/other \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/acme/homebrew-tools >/dev/null 2>&1; then
  fail "dependency provenance accepted a mismatched repository and tap name"
fi

default_provenance="$TMPDIR/default-dependency-provenance.json"
jq -nS '{
  schema: 2,
  formula: "hello",
  arch: "wasm32",
  tap_repository: "kandelo-dev/homebrew-tap-core",
  tap_name: "kandelo-dev/tap-core",
  tap_commit: ("a" * 40),
  bottle_root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
  bottle_tag: "wasm32_kandelo",
  dependencies: []
}' >"$default_provenance"
python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$default_provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core

if python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" source-closure \
  --tap-root "$REPO_ROOT" \
  --kandelo-root "$REPO_ROOT" \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/other \
  --formula hello \
  --out "$TMPDIR/source-closure.json" >/dev/null 2>&1; then
  fail "OCI source closure accepted a mismatched repository and tap name"
fi

python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" source-closure \
  --tap-root "$REPO_ROOT/homebrew/homebrew-tap-core" \
  --kandelo-root "$REPO_ROOT" \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --formula what \
  --out "$TMPDIR/default-source-closure.json"

echo "test-homebrew-tap-identity.sh: ok"
