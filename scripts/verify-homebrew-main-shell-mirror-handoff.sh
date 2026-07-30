#!/usr/bin/env bash
set -euo pipefail

ROOT=""
EXPECTED_KANDELO=""
EXPECTED_TAP_CATALOG=""
EXPECTED_TAP_MIRROR_AUTHORITY=""
EXPECTED_TAP_CALLER_AUTHORITY=""
EXPECTED_CANARY=""
MAX_MIRROR_BYTES="$((512 * 1024 * 1024))"
MAX_HANDOFF_BYTES="$((1024 * 1024 * 1024))"
MAX_MIRROR_ASSETS=256

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --kandelo-ref) EXPECTED_KANDELO="$2"; shift 2 ;;
    --tap-catalog-ref) EXPECTED_TAP_CATALOG="$2"; shift 2 ;;
    --tap-mirror-authority-ref)
      EXPECTED_TAP_MIRROR_AUTHORITY="$2"; shift 2 ;;
    --tap-caller-authority-ref)
      EXPECTED_TAP_CALLER_AUTHORITY="$2"; shift 2 ;;
    --canary-ref) EXPECTED_CANARY="$2"; shift 2 ;;
    *) echo "verify-homebrew-main-shell-mirror-handoff: unknown flag $1" >&2; exit 2 ;;
  esac
done

for value in \
  "$EXPECTED_KANDELO" "$EXPECTED_TAP_CATALOG" \
  "$EXPECTED_TAP_MIRROR_AUTHORITY" "$EXPECTED_TAP_CALLER_AUTHORITY" \
  "$EXPECTED_CANARY"
do
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || {
    echo "verify-homebrew-main-shell-mirror-handoff: exact M/TF/TA0/TA1/C refs are required" >&2
    exit 2
  }
done
[ "$EXPECTED_TAP_MIRROR_AUTHORITY" != "$EXPECTED_TAP_CALLER_AUTHORITY" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror and caller authorities must differ" >&2
  exit 2
}
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ] || [ -L "$ROOT" ]; then
  echo "verify-homebrew-main-shell-mirror-handoff: --root must be a regular directory" >&2
  exit 2
fi
for tool in find jq wc; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-homebrew-main-shell-mirror-handoff: missing $tool" >&2
    exit 2
  }
done
if ! command -v sha256sum >/dev/null 2>&1 &&
   ! command -v shasum >/dev/null 2>&1; then
  echo "verify-homebrew-main-shell-mirror-handoff: missing SHA-256 tool" >&2
  exit 2
fi

HANDOFF="$ROOT/handoff.json"
PUBLISH="$ROOT/publish.json"
MIRROR="$ROOT/mirror"
for path in \
  "$HANDOFF" \
  "$PUBLISH" \
  "$ROOT/main-shell.vfs.zst" \
  "$ROOT/homebrew-bootstrap.zip" \
  "$ROOT/homebrew-brew.env"
do
  [ -f "$path" ] && [ ! -L "$path" ] || {
    echo "verify-homebrew-main-shell-mirror-handoff: missing regular handoff file: $path" >&2
    exit 1
  }
done
[ -d "$MIRROR" ] && [ ! -L "$MIRROR" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror is not a regular directory" >&2
  exit 1
}
root_entries="$(
  find "$ROOT" -mindepth 1 -maxdepth 1 -print |
    sed 's#^.*/##' |
    sort
)"
expected_root_entries="$(
  printf '%s\n' \
    handoff.json \
    homebrew-bootstrap.zip \
    homebrew-brew.env \
    main-shell.vfs.zst \
    mirror \
    publish.json |
    sort
)"
[ "$root_entries" = "$expected_root_entries" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: handoff root contains unexpected entries" >&2
  exit 1
}
handoff_bytes="$(
  find "$ROOT" -type f -exec wc -c {} + |
    awk '{ total += $1 } END { print total + 0 }'
)"
[ "$handoff_bytes" -le "$MAX_HANDOFF_BYTES" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: total handoff byte bound is exceeded" >&2
  exit 1
}

jq -e \
  --arg kandelo "$EXPECTED_KANDELO" \
  --arg tap_catalog "$EXPECTED_TAP_CATALOG" \
  --arg tap_mirror_authority "$EXPECTED_TAP_MIRROR_AUTHORITY" \
  --arg tap_caller_authority "$EXPECTED_TAP_CALLER_AUTHORITY" \
  --arg canary "$EXPECTED_CANARY" '
  (keys | sort) == [
    "canary_ref", "files", "kandelo_ref", "kind", "mirror",
    "schema", "tap_caller_authority_ref", "tap_catalog_ref",
    "tap_mirror_authority_ref"
  ] and
  .schema == 1 and
  .kind == "kandelo-homebrew-main-shell-mirror-handoff" and
  .kandelo_ref == $kandelo and
  .tap_catalog_ref == $tap_catalog and
  .tap_mirror_authority_ref == $tap_mirror_authority and
  .tap_caller_authority_ref == $tap_caller_authority and
  .canary_ref == $canary and
  (.files | keys | sort) == [
    "homebrew-bootstrap.zip", "homebrew-brew.env",
    "main-shell.vfs.zst", "publish.json"
  ] and
  ([.files[] |
    (keys | sort) == ["bytes", "sha256"] and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and . > 0 and floor == .)
  ] | all) and
  (.mirror | keys | sort) == ["asset_count", "bytes", "plan_sha256"] and
  (.mirror.asset_count | type == "number" and . > 0 and floor == .) and
  (.mirror.bytes | type == "number" and . > 0 and floor == .) and
  (.mirror.plan_sha256 | type == "string" and test("^[0-9a-f]{64}$"))
' "$HANDOFF" >/dev/null || {
  echo "verify-homebrew-main-shell-mirror-handoff: handoff manifest is invalid" >&2
  exit 1
}

file_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
file_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}
for name in \
  main-shell.vfs.zst \
  homebrew-bootstrap.zip \
  homebrew-brew.env \
  publish.json
do
  expected_sha="$(jq -er --arg name "$name" '.files[$name].sha256' "$HANDOFF")"
  expected_bytes="$(jq -er --arg name "$name" '.files[$name].bytes' "$HANDOFF")"
  [ "$(file_sha "$ROOT/$name")" = "$expected_sha" ] &&
    [ "$(file_bytes "$ROOT/$name")" = "$expected_bytes" ] || {
      echo "verify-homebrew-main-shell-mirror-handoff: $name differs from its manifest" >&2
      exit 1
    }
done

PLAN="$MIRROR/kandelo-homebrew-bottle-mirror-plan.json"
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: exact mirror plan is missing" >&2
  exit 1
}
plan_release_root="$(jq -er '.release_root' "$PLAN")" || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror release root is invalid" >&2
  exit 1
}
jq -e --arg root "$plan_release_root" '
  (keys | sort) == [
    "assets", "collection_sha256", "kind", "manifest_asset",
    "release_root", "repository", "schema", "tag"
  ] and
  .schema == 1 and
  .kind == "kandelo-homebrew-bottle-mirror-plan" and
  .repository == "kandelo-dev/homebrew-tap-core" and
  (.collection_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
  .tag == ("homebrew-shell-bottles-sha256-" + .collection_sha256) and
  .manifest_asset == "kandelo-homebrew-bottle-mirror-plan.json" and
  .release_root ==
    ("https://github.com/kandelo-dev/homebrew-tap-core/releases/download/" + .tag) and
  (.assets | type == "array" and length > 0 and length <= 255) and
  ([.assets[] |
    (keys | sort) == ["asset", "bytes", "id", "package", "sha256", "url"] and
    (.id | type == "string" and length > 0) and
    (.package | type == "string" and length > 0) and
    (.asset | type == "string" and
      test("^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and . > 0 and floor == .) and
    .url == ($root + "/" + .asset)
  ] | all)
' "$PLAN" >/dev/null || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror plan is invalid" >&2
  exit 1
}
[ "$(file_sha "$PLAN")" = "$(jq -er '.mirror.plan_sha256' "$HANDOFF")" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror plan digest differs" >&2
  exit 1
}
while IFS=$'\t' read -r name expected_sha expected_bytes; do
  path="$MIRROR/$name"
  [ -f "$path" ] && [ ! -L "$path" ] &&
    [ "$(file_sha "$path")" = "$expected_sha" ] &&
    [ "$(file_bytes "$path")" = "$expected_bytes" ] || {
      echo "verify-homebrew-main-shell-mirror-handoff: mirror asset differs from its plan: $name" >&2
      exit 1
    }
done < <(jq -er '.assets[] | [.asset, .sha256, .bytes] | @tsv' "$PLAN")

if [ -n "$(find "$MIRROR" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]; then
  echo "verify-homebrew-main-shell-mirror-handoff: mirror contains a non-regular entry" >&2
  exit 1
fi
expected_names="$(
  jq -er '.manifest_asset, (.assets[] | .asset)' "$PLAN" | sort
)"
actual_names="$(
  find "$MIRROR" -mindepth 1 -maxdepth 1 -type f -print |
    sed 's#^.*/##' |
    sort
)"
[ "$expected_names" = "$actual_names" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror file set differs from its plan" >&2
  exit 1
}
actual_count="$(
  find "$MIRROR" -mindepth 1 -maxdepth 1 -type f -print |
    wc -l | tr -d '[:space:]'
)"
[ "$actual_count" -eq "$(jq -er '.mirror.asset_count' "$HANDOFF")" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror asset count differs" >&2
  exit 1
}
[ "$actual_count" -le "$MAX_MIRROR_ASSETS" ] || {
  echo "verify-homebrew-main-shell-mirror-handoff: mirror asset bound is exceeded" >&2
  exit 1
}
mirror_bytes="$(
  find "$MIRROR" -mindepth 1 -maxdepth 1 -type f -exec wc -c {} + |
    awk '{ total += $1 } END { print total + 0 }'
)"
[ "$mirror_bytes" -eq "$(jq -er '.mirror.bytes' "$HANDOFF")" ] &&
  [ "$mirror_bytes" -le "$MAX_MIRROR_BYTES" ] || {
    echo "verify-homebrew-main-shell-mirror-handoff: mirror byte bound differs or is exceeded" >&2
    exit 1
  }

jq -e \
  --arg tap "$EXPECTED_TAP_MIRROR_AUTHORITY" \
  --arg plan_sha "$(file_sha "$PLAN")" \
  --argjson plan_bytes "$(file_bytes "$PLAN")" \
  --slurpfile plan "$PLAN" '
  .schema == 1 and
  .repository == $plan[0].repository and
  .tag == $plan[0].tag and
  .target_commitish == $tap and
  (.assets | map({name, sha256, bytes}) | sort_by(.name)) ==
    ([
      {
        name: $plan[0].manifest_asset,
        sha256: $plan_sha,
        bytes: $plan_bytes
      }
    ] + [
      $plan[0].assets[] |
      {name: .asset, sha256: .sha256, bytes: .bytes}
    ] | sort_by(.name)) and
  (.preferred_asset_names | sort) == (.assets | map(.name) | sort) and
  .accepted_existing_asset_sets == []
' "$PUBLISH" >/dev/null || {
  echo "verify-homebrew-main-shell-mirror-handoff: publish manifest differs from the mirror plan" >&2
  exit 1
}

echo "verify-homebrew-main-shell-mirror-handoff: ok"
