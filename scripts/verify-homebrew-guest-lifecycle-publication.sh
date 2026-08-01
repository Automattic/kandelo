#!/usr/bin/env bash
set -euo pipefail

ROOT=""
PLAN=""
KANDELO_REF=""
TAP_CATALOG_REF=""
TAP_MIRROR_AUTHORITY_REF=""
TAP_CALLER_AUTHORITY_REF=""
CANARY_REF=""
MAX_HANDOFF_BYTES="$((512 * 1024 * 1024))"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --bottle-mirror-plan) PLAN="$2"; shift 2 ;;
    --kandelo-ref) KANDELO_REF="$2"; shift 2 ;;
    --tap-catalog-ref) TAP_CATALOG_REF="$2"; shift 2 ;;
    --tap-mirror-authority-ref)
      TAP_MIRROR_AUTHORITY_REF="$2"; shift 2 ;;
    --tap-caller-authority-ref)
      TAP_CALLER_AUTHORITY_REF="$2"; shift 2 ;;
    --canary-ref) CANARY_REF="$2"; shift 2 ;;
    *)
      echo "verify-homebrew-guest-lifecycle-publication: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

for ref in \
  "$KANDELO_REF" "$TAP_CATALOG_REF" \
  "$TAP_MIRROR_AUTHORITY_REF" "$TAP_CALLER_AUTHORITY_REF" "$CANARY_REF"
do
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || {
    echo "verify-homebrew-guest-lifecycle-publication: exact refs are required" >&2
    exit 2
  }
done
[ "$TAP_MIRROR_AUTHORITY_REF" != "$TAP_CALLER_AUTHORITY_REF" ] || {
  echo "verify-homebrew-guest-lifecycle-publication: mirror and caller authorities must differ" >&2
  exit 2
}
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ] || [ -L "$ROOT" ]; then
  echo "verify-homebrew-guest-lifecycle-publication: root must be a regular directory" >&2
  exit 2
fi
if [ -z "$PLAN" ] || [ ! -f "$PLAN" ] || [ -L "$PLAN" ]; then
  echo "verify-homebrew-guest-lifecycle-publication: plan must be a regular file" >&2
  exit 2
fi

expected_names="$(
  printf '%s\n' \
    handoff.json \
    homebrew-bootstrap.zip \
    homebrew-brew.env \
    main-shell-brew-package-tree.json \
    main-shell.vfs.zst \
    publish.json |
    sort
)"
actual_names="$(
  find "$ROOT" -mindepth 1 -maxdepth 1 -type f -print |
    sed 's#^.*/##' |
    sort
)"
if [ "$actual_names" != "$expected_names" ] ||
   [ -n "$(find "$ROOT" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]; then
  echo "verify-homebrew-guest-lifecycle-publication: handoff files differ" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}

HANDOFF="$ROOT/handoff.json"
PUBLISH="$ROOT/publish.json"
plan_sha="$(sha256_file "$PLAN")"
plan_bytes="$(file_bytes "$PLAN")"
plan_url="$(jq -er '.release_root + "/" + .manifest_asset' "$PLAN")"

jq -e \
  --arg kandelo "$KANDELO_REF" \
  --arg tap_catalog "$TAP_CATALOG_REF" \
  --arg tap_mirror_authority "$TAP_MIRROR_AUTHORITY_REF" \
  --arg tap_caller_authority "$TAP_CALLER_AUTHORITY_REF" \
  --arg canary "$CANARY_REF" \
  --arg plan_url "$plan_url" \
  --arg plan_sha "$plan_sha" \
  --argjson plan_bytes "$plan_bytes" '
  (keys | sort) == [
    "bootstrap", "bottle_mirror", "canary_ref", "files", "kandelo_ref",
    "kind", "release", "schema", "tap_caller_authority_ref",
    "tap_catalog_ref", "tap_mirror_authority_ref"
  ] and
  .schema == 1 and
  .kind == "kandelo-homebrew-guest-lifecycle-inputs-handoff" and
  .kandelo_ref == $kandelo and
  .tap_catalog_ref == $tap_catalog and
  .tap_mirror_authority_ref == $tap_mirror_authority and
  .tap_caller_authority_ref == $tap_caller_authority and
  .canary_ref == $canary and
  .bootstrap == {
    state: "transitional",
    source_kind: "kandelo-package-registry",
    package: "homebrew-bootstrap",
    guest_prefix: "/opt/kandelo/homebrew",
    stable_entrypoint: "/usr/bin/brew"
  } and
  .bottle_mirror == {
    url: $plan_url, sha256: $plan_sha, bytes: $plan_bytes
  } and
  (.release | keys | sort) == [
    "collection_sha256", "repository", "root", "tag"
  ] and
  .release.repository == "kandelo-dev/homebrew-tap-core" and
  (.release.collection_sha256 |
    type == "string" and test("^[0-9a-f]{64}$")) and
  .release.tag ==
    ("homebrew-guest-lifecycle-inputs-sha256-" +
      .release.collection_sha256) and
  .release.root ==
    ("https://github.com/kandelo-dev/homebrew-tap-core/releases/download/" +
      .release.tag + "/") and
  (.files | keys | sort) == [
    "homebrew-bootstrap.zip", "homebrew-brew.env",
    "main-shell-brew-package-tree.json", "main-shell.vfs.zst",
    "publish.json"
  ] and
  ([.files[] |
    (keys | sort) == ["bytes", "sha256"] and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and . > 0 and floor == .)
  ] | all)
' "$HANDOFF" >/dev/null || {
  echo "verify-homebrew-guest-lifecycle-publication: handoff manifest is invalid" >&2
  exit 1
}

for name in \
  main-shell.vfs.zst \
  main-shell-brew-package-tree.json \
  homebrew-bootstrap.zip \
  homebrew-brew.env \
  publish.json
do
  expected_sha="$(jq -er --arg name "$name" '.files[$name].sha256' "$HANDOFF")"
  expected_bytes="$(jq -er --arg name "$name" '.files[$name].bytes' "$HANDOFF")"
  if [ "$(sha256_file "$ROOT/$name")" != "$expected_sha" ] ||
     [ "$(file_bytes "$ROOT/$name")" != "$expected_bytes" ]; then
    echo "verify-homebrew-guest-lifecycle-publication: $name differs from its handoff identity" >&2
    exit 1
  fi
done

jq -e \
  --arg tap "$TAP_CALLER_AUTHORITY_REF" \
  --slurpfile handoff "$HANDOFF" '
  .schema == 1 and
  .repository == $handoff[0].release.repository and
  .tag == $handoff[0].release.tag and
  .target_commitish == $tap and
  (.assets | map({name, sha256, bytes})) ==
    ([
      "main-shell.vfs.zst",
      "main-shell-brew-package-tree.json",
      "homebrew-bootstrap.zip",
      "homebrew-brew.env"
    ] | map(. as $name |
      {name: $name} + $handoff[0].files[$name]
    )) and
  .preferred_asset_names == (.assets | map(.name)) and
  .accepted_existing_asset_sets == []
' "$PUBLISH" >/dev/null || {
  echo "verify-homebrew-guest-lifecycle-publication: publish manifest differs from the handoff" >&2
  exit 1
}

handoff_bytes="$(
  find "$ROOT" -type f -exec wc -c {} + |
    awk '{ total += $1 } END { print total + 0 }'
)"
if [ "$handoff_bytes" -gt "$MAX_HANDOFF_BYTES" ]; then
  echo "verify-homebrew-guest-lifecycle-publication: handoff byte bound is exceeded" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT
env -u GH_TOKEN -u GITHUB_TOKEN PYTHONDONTWRITEBYTECODE=1 \
  python3 "$script_dir/validate-immutable-github-release-manifest.py" \
    --manifest "$PUBLISH" \
    --asset-root "$ROOT" \
    --stage-dir "$tmp_root/staged" \
    --out-manifest "$tmp_root/normalized.json"

echo "verify-homebrew-guest-lifecycle-publication: ok"
