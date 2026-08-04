#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFY="$REPO_ROOT/scripts/verify-homebrew-main-shell-mirror-handoff.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
M="$(printf 'a%.0s' {1..40})"
TF="$(printf 'b%.0s' {1..40})"
C="$(printf 'c%.0s' {1..40})"
TMIRROR="$(printf 'e%.0s' {1..40})"
TCALLER="$(printf 'f%.0s' {1..40})"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}

make_fixture() {
  local root="$1"
  local mode="${2:-publish-lifecycle}"
  local mirror_authority bottle_sha plan plan_sha mirror_bytes mirror_count collection tag release_root
  case "$mode" in
    create-mirror) mirror_authority="$TCALLER" ;;
    publish-lifecycle) mirror_authority="$TMIRROR" ;;
    *) echo "test fixture has unknown mode: $mode" >&2; exit 2 ;;
  esac
  mkdir -p "$root/mirror"
  printf 'shell\n' >"$root/main-shell.vfs.zst"
  printf 'bootstrap\n' >"$root/homebrew-bootstrap.zip"
  printf 'portable ruby\n' >"$root/homebrew-portable-ruby.zip"
  printf 'env\n' >"$root/homebrew-brew.env"
  printf 'bottle\n' >"$root/mirror/hello.bottle.tar.gz"
  bottle_sha="$(sha256_file "$root/mirror/hello.bottle.tar.gz")"
  collection="$(printf 'd%.0s' {1..64})"
  tag="homebrew-shell-bottles-sha256-$collection"
  release_root="https://github.com/kandelo-dev/homebrew-tap-core/releases/download/$tag"
  plan="$root/mirror/kandelo-homebrew-bottle-mirror-plan.json"
  jq -n \
    --arg collection "$collection" \
    --arg tag "$tag" \
    --arg release_root "$release_root" \
    --arg bottle_sha "$bottle_sha" \
    --argjson bottle_bytes "$(bytes "$root/mirror/hello.bottle.tar.gz")" '
    {
      schema: 1,
      kind: "kandelo-homebrew-bottle-mirror-plan",
      repository: "kandelo-dev/homebrew-tap-core",
      collection_sha256: $collection,
      tag: $tag,
      release_root: $release_root,
      manifest_asset: "kandelo-homebrew-bottle-mirror-plan.json",
      assets: [{
        id: "first-party/hello",
        package: "kandelo-dev/tap-core/hello",
        asset: "hello.bottle.tar.gz",
        sha256: $bottle_sha,
        bytes: $bottle_bytes,
        url: ($release_root + "/hello.bottle.tar.gz")
      }]
    }
  ' >"$plan"
  plan_sha="$(sha256_file "$plan")"
  jq -n \
    --arg tap "$mirror_authority" \
    --arg tag "$tag" \
    --arg plan_sha "$plan_sha" \
    --arg bottle_sha "$bottle_sha" \
    --argjson plan_bytes "$(bytes "$plan")" \
    --argjson bottle_bytes "$(bytes "$root/mirror/hello.bottle.tar.gz")" '
    {
      schema: 1,
      repository: "kandelo-dev/homebrew-tap-core",
      tag: $tag,
      target_commitish: $tap,
      title: "test",
      body: "test",
      assets: [
        {
          name: "kandelo-homebrew-bottle-mirror-plan.json",
          sha256: $plan_sha,
          bytes: $plan_bytes
        },
        {
          name: "hello.bottle.tar.gz",
          sha256: $bottle_sha,
          bytes: $bottle_bytes
        }
      ],
      preferred_asset_names: [
        "kandelo-homebrew-bottle-mirror-plan.json",
        "hello.bottle.tar.gz"
      ],
      accepted_existing_asset_sets: []
    }
  ' >"$root/publish.json"
  mirror_bytes="$(
    find "$root/mirror" -type f -exec wc -c {} + |
      awk '{ total += $1 } END { print total + 0 }'
  )"
  mirror_count="$(find "$root/mirror" -type f | wc -l | tr -d '[:space:]')"
  jq -n \
    --arg kandelo "$M" \
    --arg tap_catalog "$TF" \
    --arg tap_mirror_authority "$mirror_authority" \
    --arg tap_caller_authority "$TCALLER" \
    --arg canary "$C" \
    --arg image_sha "$(sha256_file "$root/main-shell.vfs.zst")" \
    --argjson image_bytes "$(bytes "$root/main-shell.vfs.zst")" \
    --arg bootstrap_sha "$(sha256_file "$root/homebrew-bootstrap.zip")" \
    --argjson bootstrap_bytes "$(bytes "$root/homebrew-bootstrap.zip")" \
    --arg portable_ruby_sha "$(sha256_file "$root/homebrew-portable-ruby.zip")" \
    --argjson portable_ruby_bytes "$(bytes "$root/homebrew-portable-ruby.zip")" \
    --arg env_sha "$(sha256_file "$root/homebrew-brew.env")" \
    --argjson env_bytes "$(bytes "$root/homebrew-brew.env")" \
    --arg publish_sha "$(sha256_file "$root/publish.json")" \
    --argjson publish_bytes "$(bytes "$root/publish.json")" \
    --arg plan_sha "$plan_sha" \
    --argjson mirror_bytes "$mirror_bytes" \
    --argjson mirror_count "$mirror_count" '
    {
      schema: 1,
      kind: "kandelo-homebrew-main-shell-mirror-handoff",
      kandelo_ref: $kandelo,
      tap_catalog_ref: $tap_catalog,
      tap_mirror_authority_ref: $tap_mirror_authority,
      tap_caller_authority_ref: $tap_caller_authority,
      canary_ref: $canary,
      files: {
        "main-shell.vfs.zst": { sha256: $image_sha, bytes: $image_bytes },
        "homebrew-bootstrap.zip": {
          sha256: $bootstrap_sha, bytes: $bootstrap_bytes
        },
        "homebrew-portable-ruby.zip": {
          sha256: $portable_ruby_sha, bytes: $portable_ruby_bytes
        },
        "homebrew-brew.env": { sha256: $env_sha, bytes: $env_bytes },
        "publish.json": { sha256: $publish_sha, bytes: $publish_bytes }
      },
      mirror: {
        plan_sha256: $plan_sha,
        asset_count: $mirror_count,
        bytes: $mirror_bytes
      }
    }
  ' >"$root/handoff.json"
}

verify() {
  local root="$1"
  local mode="${2:-publish-lifecycle}"
  local mirror_authority
  case "$mode" in
    create-mirror) mirror_authority="$TCALLER" ;;
    publish-lifecycle) mirror_authority="$TMIRROR" ;;
    *) mirror_authority="$TMIRROR" ;;
  esac
  bash "$VERIFY" \
    --root "$root" \
    --publication-mode "$mode" \
    --kandelo-ref "$M" \
    --tap-catalog-ref "$TF" \
    --tap-mirror-authority-ref "$mirror_authority" \
    --tap-caller-authority-ref "$TCALLER" \
    --canary-ref "$C"
}

verify_with_authorities() {
  bash "$VERIFY" \
    --root "$1" \
    --publication-mode "$2" \
    --kandelo-ref "$M" \
    --tap-catalog-ref "$TF" \
    --tap-mirror-authority-ref "$3" \
    --tap-caller-authority-ref "$4" \
    --canary-ref "$C"
}

expect_rejected() {
  local root="$1"
  local mode="${2:-publish-lifecycle}"
  if verify "$root" "$mode" >/dev/null 2>&1; then
    echo "test-homebrew-main-shell-mirror-handoff: accepted invalid handoff" >&2
    exit 1
  fi
}

make_fixture "$TMP_ROOT/good"
verify "$TMP_ROOT/good" >/dev/null
make_fixture "$TMP_ROOT/good-create" create-mirror
verify "$TMP_ROOT/good-create" create-mirror >/dev/null

expect_rejected "$TMP_ROOT/good" create-mirror
expect_rejected "$TMP_ROOT/good-create" publish-lifecycle
expect_rejected "$TMP_ROOT/good" unsupported-mode
if verify_with_authorities \
  "$TMP_ROOT/good" create-mirror "$TMIRROR" "$TCALLER" \
  >/dev/null 2>&1; then
  echo "test-homebrew-main-shell-mirror-handoff: create accepted split authorities" >&2
  exit 1
fi
if verify_with_authorities \
  "$TMP_ROOT/good-create" publish-lifecycle "$TCALLER" "$TCALLER" \
  >/dev/null 2>&1; then
  echo "test-homebrew-main-shell-mirror-handoff: consume accepted one authority" >&2
  exit 1
fi

cp -R "$TMP_ROOT/good" "$TMP_ROOT/changed"
printf 'changed\n' >>"$TMP_ROOT/changed/main-shell.vfs.zst"
expect_rejected "$TMP_ROOT/changed"

cp -R "$TMP_ROOT/good" "$TMP_ROOT/extra"
printf 'extra\n' >"$TMP_ROOT/extra/undeclared"
expect_rejected "$TMP_ROOT/extra"

cp -R "$TMP_ROOT/good" "$TMP_ROOT/bottle"
printf 'tamper\n' >"$TMP_ROOT/bottle/mirror/hello.bottle.tar.gz"
expect_rejected "$TMP_ROOT/bottle"

cp -R "$TMP_ROOT/good" "$TMP_ROOT/authority"
jq --arg authority "$TF" '.tap_mirror_authority_ref = $authority' \
  "$TMP_ROOT/authority/handoff.json" >"$TMP_ROOT/authority/handoff.changed"
mv "$TMP_ROOT/authority/handoff.changed" "$TMP_ROOT/authority/handoff.json"
expect_rejected "$TMP_ROOT/authority"

cp -R "$TMP_ROOT/good" "$TMP_ROOT/caller-authority"
jq --arg authority "$TMIRROR" '.tap_caller_authority_ref = $authority' \
  "$TMP_ROOT/caller-authority/handoff.json" \
  >"$TMP_ROOT/caller-authority/handoff.changed"
mv "$TMP_ROOT/caller-authority/handoff.changed" \
  "$TMP_ROOT/caller-authority/handoff.json"
expect_rejected "$TMP_ROOT/caller-authority"

cp -R "$TMP_ROOT/good" "$TMP_ROOT/target"
jq --arg tap "$M" '.target_commitish = $tap' \
  "$TMP_ROOT/target/publish.json" >"$TMP_ROOT/target/publish.changed"
mv "$TMP_ROOT/target/publish.changed" "$TMP_ROOT/target/publish.json"
jq --arg sha "$(sha256_file "$TMP_ROOT/target/publish.json")" \
  --argjson size "$(bytes "$TMP_ROOT/target/publish.json")" \
  '.files["publish.json"] = {sha256: $sha, bytes: $size}' \
  "$TMP_ROOT/target/handoff.json" >"$TMP_ROOT/target/handoff.changed"
mv "$TMP_ROOT/target/handoff.changed" "$TMP_ROOT/target/handoff.json"
expect_rejected "$TMP_ROOT/target"

echo "test-homebrew-main-shell-mirror-handoff.sh: ok"
