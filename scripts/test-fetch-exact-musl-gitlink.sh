#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/fetch-exact-musl-gitlink.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

fail() {
  echo "test-fetch-exact-musl-gitlink: $*" >&2
  exit 1
}

configure_repository() {
  local root="$1"
  git -C "$root" config user.name "Kandelo fixture"
  git -C "$root" config user.email "fixture@example.invalid"
}

musl_source="$TMP_ROOT/musl-source"
git init -q "$musl_source"
configure_repository "$musl_source"
printf 'fixture musl copyright\n' >"$musl_source/COPYRIGHT"
git -C "$musl_source" add COPYRIGHT
git -C "$musl_source" commit -q -m "fixture musl"
musl_commit="$(git -C "$musl_source" rev-parse HEAD)"

candidate="$TMP_ROOT/candidate"
git init -q "$candidate"
configure_repository "$candidate"
mkdir -p "$candidate/libc"
printf 'fixture candidate\n' >"$candidate/README"
cat >"$candidate/.gitmodules" <<'EOF'
[submodule "musl"]
	path = libc/musl
	url = https://evil.invalid/candidate-controlled-musl.git
EOF
git -C "$candidate" add README .gitmodules
git -C "$candidate" update-index \
  --add --cacheinfo "160000,$musl_commit,libc/musl"
git -C "$candidate" commit -q -m "record exact musl gitlink"
candidate_commit="$(git -C "$candidate" rev-parse HEAD)"
mkdir -p "$candidate/libc/musl"

KANDELO_ABI_STAGING_TESTING=1 \
  bash "$HELPER" \
    --source-root "$candidate" \
    --commit "$candidate_commit" \
    --test-remote "$musl_source"

[ "$(git -C "$candidate/libc/musl" rev-parse HEAD)" = "$musl_commit" ] ||
  fail "materialized musl differs from the exact gitlink"
[ "$(cat "$candidate/libc/musl/COPYRIGHT")" = "fixture musl copyright" ] ||
  fail "materialized musl bytes differ"
[ -z "$(git -C "$candidate" status --porcelain=v1 --untracked-files=all)" ] ||
  fail "materialization dirtied the exact candidate checkout"

# A second call must revalidate the exact existing materialization rather than
# moving it or accepting a different checkout.
KANDELO_ABI_STAGING_TESTING=1 \
  bash "$HELPER" \
    --source-root "$candidate" \
    --commit "$candidate_commit" \
    --test-remote "$musl_source"

if bash "$HELPER" \
    --source-root "$candidate" \
    --commit "$candidate_commit" \
    --test-remote "$musl_source" >"$TMP_ROOT/production-override.out" 2>&1
then
  fail "production invocation accepted a test-only remote"
fi
grep -F 'test-only remote' "$TMP_ROOT/production-override.out" >/dev/null ||
  fail "test-only remote rejection was not explicit"

if KANDELO_ABI_STAGING_TESTING=1 \
    bash "$HELPER" \
      --source-root "$candidate" \
      --commit 0000000000000000000000000000000000000000 \
      --test-remote "$musl_source" >"$TMP_ROOT/wrong-head.out" 2>&1
then
  fail "helper accepted a source commit other than exact HEAD"
fi
grep -F 'exact source commit' "$TMP_ROOT/wrong-head.out" >/dev/null ||
  fail "wrong source commit rejection was not explicit"

symlink_candidate="$TMP_ROOT/symlink-candidate"
git clone -q "$candidate" "$symlink_candidate"
if [ "$(git -C "$symlink_candidate/libc/musl" rev-parse --show-toplevel 2>/dev/null || true)" = \
     "$(cd "$symlink_candidate/libc/musl" && pwd -P)" ]; then
  fail "fixture clone unexpectedly initialized its submodule"
fi
rmdir "$symlink_candidate/libc/musl" 2>/dev/null || true
ln -s "$musl_source" "$symlink_candidate/libc/musl"
if KANDELO_ABI_STAGING_TESTING=1 \
    bash "$HELPER" \
      --source-root "$symlink_candidate" \
      --commit "$candidate_commit" \
      --test-remote "$musl_source" >"$TMP_ROOT/symlink.out" 2>&1
then
  fail "helper accepted a symlinked musl path"
fi
grep -F 'symbolic link' "$TMP_ROOT/symlink.out" >/dev/null ||
  fail "symlink rejection was not explicit"

wrong_source="$TMP_ROOT/wrong-source"
git init -q "$wrong_source"
configure_repository "$wrong_source"
printf 'wrong source\n' >"$wrong_source/COPYRIGHT"
git -C "$wrong_source" add COPYRIGHT
git -C "$wrong_source" commit -q -m "wrong source"

unavailable_candidate="$TMP_ROOT/unavailable-candidate"
git clone -q "$candidate" "$unavailable_candidate"
if KANDELO_ABI_STAGING_TESTING=1 \
    bash "$HELPER" \
      --source-root "$unavailable_candidate" \
      --commit "$candidate_commit" \
      --test-remote "$wrong_source" >"$TMP_ROOT/unavailable.out" 2>&1
then
  fail "helper accepted a remote without the exact gitlink"
fi
grep -F 'exact musl gitlink' "$TMP_ROOT/unavailable.out" >/dev/null ||
  fail "unavailable gitlink rejection was not explicit"

echo "test-fetch-exact-musl-gitlink: PASS"
