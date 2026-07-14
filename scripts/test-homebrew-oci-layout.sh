#!/usr/bin/env bash
# Regression coverage for deterministic Homebrew-native OCI bottle layouts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
ABI="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"
TOOL="$REPO_ROOT/scripts/homebrew-oci-layout.py"
TAP_COMMIT=1111111111111111111111111111111111111111
KANDELO_COMMIT=2222222222222222222222222222222222222222
ROOT_URL=https://ghcr.io/v2/automattic/kandelo-homebrew

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

make_fixture() {
  local label="$1" arch="$2" payload="${3:-hello fixture}"
  local support_payload="${4:-fixture support v1}"
  local archived_formula_mode="${5:-0644}"
  local formula_extra="${6:-}"
  local root="$TMP_ROOT/$label"
  local stage="$root/stage/hello/1.0"
  local bottle="$root/hello--1.0.${arch}_kandelo.bottle.tar.gz"
  local bottle_json="$root/bottle.json" sha
  mkdir -p "$stage/.brew" "$stage/bin" \
    "$root/tap/Formula" "$root/tap/Kandelo/formula_support"
  cat >"$root/tap/Formula/hello.rb" <<'RUBY'
require (Tap.fetch("automattic", "kandelo-homebrew").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class Hello < Formula
  include KandeloFormulaSupport
  desc "OCI fixture"
end
RUBY
  [ -z "$formula_extra" ] || printf '%s\n' "$formula_extra" \
    >>"$root/tap/Formula/hello.rb"
  cp "$root/tap/Formula/hello.rb" "$stage/.brew/hello.rb"
  chmod "$archived_formula_mode" "$stage/.brew/hello.rb"
  printf 'module KandeloFormulaSupport\n  VALUE = %q{%s}\nend\n' \
    "$support_payload" \
    >"$root/tap/Kandelo/formula_support/kandelo_formula_support.rb"
  printf '#!/bin/sh\nprintf %s\\n %s\n' "'$payload'" "'$payload'" >"$stage/bin/hello"
  chmod +x "$stage/bin/hello"
  jq -nS --arg arch "$arch" '{
    homebrew_version: "Homebrew fixture",
    changed_files: [],
    source_modified_time: 0,
    compiler: "clang",
    runtime_dependencies: [],
    source: {scm_revision: "fixture"},
    arch: "x86_64",
    built_on: {os: "Linux", os_version: "fixture"},
    installed_on_request: true,
    built_as_bottle: true,
    poured_from_bottle: false
  }' >"$stage/INSTALL_RECEIPT.json"
  tar -czf "$bottle" -C "$root/stage" hello
  sha="$(sha256_file "$bottle")"
  jq -nS --arg arch "$arch" --arg sha "$sha" '{
    hello: {
      formula: {
        name: "hello",
        path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/hello.rb",
        pkg_version: "1.0"
      },
      bottle: {
        root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
        cellar: "any_skip_relocation",
        rebuild: 0,
        tags: {($arch + "_kandelo"): {sha256: $sha}}
      }
    }
  }' >"$bottle_json"
  printf '%s\n%s\n' "$bottle" "$bottle_json"
}

build_child() {
  local label="$1" arch="$2" payload="${3:-hello fixture}"
  local support_payload="${4:-fixture support v1}"
  local archived_formula_mode="${5:-0644}"
  local formula_extra="${6:-}"
  local paths bottle bottle_json
  mapfile -t paths < <(
    make_fixture "$label" "$arch" "$payload" "$support_payload" \
      "$archived_formula_mode" "$formula_extra"
  )
  bottle="${paths[0]}"
  bottle_json="${paths[1]}"
  python3 "$TOOL" build-child \
    --formula hello \
    --arch "$arch" \
    --abi "$ABI" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$TAP_COMMIT" \
    --kandelo-commit "$KANDELO_COMMIT" \
    --bottle-root-url "$ROOT_URL" \
    --bottle "$bottle" \
    --bottle-json "$bottle_json" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$TMP_ROOT/$label/tap" \
    --out-layout "$TMP_ROOT/$label/layout" \
    --out-receipt "$TMP_ROOT/$label/receipt.json"
}

expect_failure() {
  local label="$1" pattern="$2"
  shift 2
  local err="$TMP_ROOT/$label.err"
  if "$@" >"$TMP_ROOT/$label.out" 2>"$err"; then
    echo "expected failure: $label" >&2
    exit 1
  fi
  grep -F "$pattern" "$err" >/dev/null || {
    echo "wrong failure for $label" >&2
    cat "$err" >&2
    exit 1
  }
}

mutate_child() {
  local source="$1" label="$2" mode="$3"
  local target="$TMP_ROOT/$label"
  cp -a "$source" "$target"
  python3 - "$target/layout" "$target/receipt.json" "$mode" <<'PY'
import hashlib
import json
import pathlib
import sys

layout = pathlib.Path(sys.argv[1])
receipt_path = pathlib.Path(sys.argv[2])
mode = sys.argv[3]
root_path = layout / "index.json"
root = json.loads(root_path.read_text())
descriptor = root["manifests"][0]
digest = descriptor["digest"].removeprefix("sha256:")
manifest_path = layout / "blobs/sha256" / digest
manifest = json.loads(manifest_path.read_text())
if mode == "missing-annotation":
    del manifest["annotations"]["sh.brew.tab"]
elif mode == "extra-annotation":
    manifest["annotations"]["example.unreviewed"] = "value"
elif mode == "noncanonical-size":
    manifest["annotations"]["sh.brew.bottle.size"] = "01"
elif mode == "negative-installed-size":
    manifest["annotations"]["sh.brew.bottle.installed_size"] = "-1"
elif mode == "extra-tab-field":
    tab = json.loads(manifest["annotations"]["sh.brew.tab"])
    tab["unreviewed"] = True
    manifest["annotations"]["sh.brew.tab"] = json.dumps(
        tab, sort_keys=True, separators=(",", ":")
    )
elif mode == "wrong-config-media":
    manifest["config"]["mediaType"] = "application/vnd.example.wrong"
elif mode == "wrong-layer-media":
    manifest["layers"][0]["mediaType"] = "application/vnd.example.wrong"
elif mode == "wrong-layer-digest":
    manifest["layers"][0]["digest"] = "sha256:" + "0" * 64
elif mode == "extra-layer-annotation":
    manifest["layers"][0]["annotations"]["example.unreviewed"] = "value"
elif mode == "noncanonical-manifest":
    pass
else:
    raise SystemExit(f"unknown mutation {mode}")
if mode == "noncanonical-manifest":
    payload = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
else:
    payload = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
new_digest = hashlib.sha256(payload).hexdigest()
(layout / "blobs/sha256" / new_digest).write_bytes(payload)
descriptor["digest"] = "sha256:" + new_digest
descriptor["size"] = len(payload)
descriptor["annotations"]["org.opencontainers.image.ref.name"] = "sha256-" + new_digest
root_path.write_text(json.dumps(root, sort_keys=True, separators=(",", ":")))
receipt = json.loads(receipt_path.read_text())
receipt["oci"]["manifest"] = {"digest": "sha256:" + new_digest, "size": len(payload)}
receipt["oci"]["transport_tag"] = "sha256-" + new_digest
receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
PY
}

SOURCE_IDENTITY_TOOL="$REPO_ROOT/scripts/homebrew-formula-source-digest.rb"
FORMULA_COMPOSER="$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb"
mkdir -p "$TMP_ROOT/source-identity"
printf 'class Hello < Formula\n  desc "fixture"\nend\n' \
  >"$TMP_ROOT/source-identity/no-blank.rb"
printf 'class Hello < Formula\n  desc "fixture"\n\nend\n' \
  >"$TMP_ROOT/source-identity/one-blank.rb"
printf 'class Hello < Formula\n  desc "fixture"\n\n\nend\n' \
  >"$TMP_ROOT/source-identity/two-blanks.rb"
identity_no_blank="$(ruby "$SOURCE_IDENTITY_TOOL" --identity-excluding-bottle \
  "$TMP_ROOT/source-identity/no-blank.rb")"
identity_one_blank="$(ruby "$SOURCE_IDENTITY_TOOL" --identity-excluding-bottle \
  "$TMP_ROOT/source-identity/one-blank.rb")"
identity_two_blanks="$(ruby "$SOURCE_IDENTITY_TOOL" --identity-excluding-bottle \
  "$TMP_ROOT/source-identity/two-blanks.rb")"
[ "$identity_no_blank" = "$identity_one_blank" ] || {
  echo "Formula identity did not normalize the composer's ambiguous separator" >&2
  exit 1
}
[ "$identity_two_blanks" != "$identity_one_blank" ] || {
  echo "Formula identity ignored provenance-bearing extra whitespace" >&2
  exit 1
}
for source in no-blank two-blanks; do
  ruby "$FORMULA_COMPOSER" \
    "$TMP_ROOT/source-identity/$source.rb" \
    "$TMP_ROOT/source-identity/$source.rb" \
    https://ghcr.io/v2/automattic/kandelo-homebrew 0 wasm32_kandelo \
    any_skip_relocation "$(printf '0%.0s' {1..64})" discard \
    "$TMP_ROOT/source-identity/$source-composed.rb"
  original_identity="$(ruby "$SOURCE_IDENTITY_TOOL" --identity-excluding-bottle \
    "$TMP_ROOT/source-identity/$source.rb")"
  composed_identity="$(ruby "$SOURCE_IDENTITY_TOOL" --identity-excluding-bottle \
    "$TMP_ROOT/source-identity/$source-composed.rb")"
  [ "$original_identity" = "$composed_identity" ] || {
    echo "Formula identity changed after canonical bottle composition: $source" >&2
    exit 1
  }
done

build_child child32 wasm32
build_child child64 wasm64
expect_failure archived-formula-mode "tap Formula mode differs from the archived" \
  build_child archived-formula-mode wasm32 "hello fixture" "fixture support v1" 0755
expect_failure require-relative "not a bounded canonical closure" \
  build_child require-relative wasm32 "hello fixture" "fixture support v1" 0644 \
    'require_relative "../other"'
python3 "$TOOL" validate-child \
  --layout "$TMP_ROOT/child32/layout" --receipt "$TMP_ROOT/child32/receipt.json"

python3 "$TOOL" merge-index \
  --child-layout "$TMP_ROOT/child32/layout" \
  --child-receipt "$TMP_ROOT/child32/receipt.json" \
  --child-layout "$TMP_ROOT/child64/layout" \
  --child-receipt "$TMP_ROOT/child64/receipt.json" \
  --out-layout "$TMP_ROOT/combined/layout" \
  --out-receipt "$TMP_ROOT/combined/receipt.json"
python3 "$TOOL" validate-index \
  --layout "$TMP_ROOT/combined/layout" --receipt "$TMP_ROOT/combined/receipt.json"
jq -e '
  [.children[].arch] == ["wasm32", "wasm64"] and
  (.children | map(.homebrew_ref)) == ["1.0.wasm32_kandelo", "1.0.wasm64_kandelo"]
' "$TMP_ROOT/combined/receipt.json" >/dev/null

# Re-merging one identical child preserves the compatible sibling and is idempotent.
python3 "$TOOL" merge-index \
  --existing-layout "$TMP_ROOT/combined/layout" \
  --child-layout "$TMP_ROOT/child32/layout" \
  --child-receipt "$TMP_ROOT/child32/receipt.json" \
  --out-layout "$TMP_ROOT/retry/layout" \
  --out-receipt "$TMP_ROOT/retry/receipt.json"
cmp "$TMP_ROOT/combined/layout/index.json" "$TMP_ROOT/retry/layout/index.json"
jq -e '[.children[].arch] == ["wasm32", "wasm64"]' \
  "$TMP_ROOT/retry/receipt.json" >/dev/null

cp -a "$TMP_ROOT/child32" "$TMP_ROOT/wrong-root-media"
jq '.mediaType = "application/vnd.example.wrong"' \
  "$TMP_ROOT/wrong-root-media/layout/index.json" \
  >"$TMP_ROOT/wrong-root-media/layout/index.json.tmp"
mv "$TMP_ROOT/wrong-root-media/layout/index.json.tmp" \
  "$TMP_ROOT/wrong-root-media/layout/index.json"
expect_failure wrong-root-media "OCI layout index has invalid media type" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/wrong-root-media/layout" \
    --receipt "$TMP_ROOT/wrong-root-media/receipt.json"

mutate_child "$TMP_ROOT/child32" missing-annotation missing-annotation
expect_failure missing-annotation "Homebrew child descriptor annotations must contain exactly" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/missing-annotation/layout" \
    --receipt "$TMP_ROOT/missing-annotation/receipt.json"
mutate_child "$TMP_ROOT/child32" wrong-config-media wrong-config-media
expect_failure wrong-config-media "config has the wrong media type" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/wrong-config-media/layout" \
    --receipt "$TMP_ROOT/wrong-config-media/receipt.json"
mutate_child "$TMP_ROOT/child32" wrong-layer-media wrong-layer-media
expect_failure wrong-layer-media "layer media type or digest is invalid" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/wrong-layer-media/layout" \
    --receipt "$TMP_ROOT/wrong-layer-media/receipt.json"
mutate_child "$TMP_ROOT/child32" wrong-layer-digest wrong-layer-digest
expect_failure wrong-layer-digest "layer media type or digest is invalid" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/wrong-layer-digest/layout" \
    --receipt "$TMP_ROOT/wrong-layer-digest/receipt.json"
mutate_child "$TMP_ROOT/child32" extra-annotation extra-annotation
expect_failure extra-annotation "exact Formula schema" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/extra-annotation/layout" \
    --receipt "$TMP_ROOT/extra-annotation/receipt.json"
mutate_child "$TMP_ROOT/child32" noncanonical-size noncanonical-size
expect_failure noncanonical-size "bottle size has an invalid value" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/noncanonical-size/layout" \
    --receipt "$TMP_ROOT/noncanonical-size/receipt.json"
mutate_child "$TMP_ROOT/child32" negative-installed-size negative-installed-size
expect_failure negative-installed-size "installed size has an invalid value" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/negative-installed-size/layout" \
    --receipt "$TMP_ROOT/negative-installed-size/receipt.json"
mutate_child "$TMP_ROOT/child32" extra-tab-field extra-tab-field
expect_failure extra-tab-field "tab annotation has an unexpected schema" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/extra-tab-field/layout" \
    --receipt "$TMP_ROOT/extra-tab-field/receipt.json"
mutate_child "$TMP_ROOT/child32" extra-layer-annotation extra-layer-annotation
expect_failure extra-layer-annotation "layer annotations must contain exactly" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/extra-layer-annotation/layout" \
    --receipt "$TMP_ROOT/extra-layer-annotation/receipt.json"
mutate_child "$TMP_ROOT/child32" noncanonical-manifest noncanonical-manifest
expect_failure noncanonical-manifest "child transport manifest is not canonical JSON" \
  python3 "$TOOL" validate-child --layout "$TMP_ROOT/noncanonical-manifest/layout" \
    --receipt "$TMP_ROOT/noncanonical-manifest/receipt.json"

cp -a "$TMP_ROOT/combined" "$TMP_ROOT/extra-receipt-child"
jq '.children[0].unreviewed = true' \
  "$TMP_ROOT/extra-receipt-child/receipt.json" \
  >"$TMP_ROOT/extra-receipt-child/receipt.json.tmp"
mv "$TMP_ROOT/extra-receipt-child/receipt.json.tmp" \
  "$TMP_ROOT/extra-receipt-child/receipt.json"
expect_failure extra-receipt-child "index receipt child 0 must contain exactly" \
  python3 "$TOOL" validate-index \
    --layout "$TMP_ROOT/extra-receipt-child/layout" \
    --receipt "$TMP_ROOT/extra-receipt-child/receipt.json"

cp -a "$TMP_ROOT/combined" "$TMP_ROOT/extra-top-annotation"
python3 - "$TMP_ROOT/extra-top-annotation/layout" \
  "$TMP_ROOT/extra-top-annotation/receipt.json" <<'PY'
import hashlib
import json
import pathlib
import sys

layout = pathlib.Path(sys.argv[1])
receipt_path = pathlib.Path(sys.argv[2])
root_path = layout / "index.json"
root = json.loads(root_path.read_text())
descriptor = root["manifests"][0]
old_digest = descriptor["digest"].removeprefix("sha256:")
top = json.loads((layout / "blobs/sha256" / old_digest).read_text())
top["annotations"]["example.unreviewed"] = "value"
payload = json.dumps(top, sort_keys=True, separators=(",", ":")).encode()
digest = hashlib.sha256(payload).hexdigest()
(layout / "blobs/sha256" / digest).write_bytes(payload)
descriptor["digest"] = "sha256:" + digest
descriptor["size"] = len(payload)
root_path.write_text(json.dumps(root, sort_keys=True, separators=(",", ":")))
receipt = json.loads(receipt_path.read_text())
receipt["top"]["digest"] = "sha256:" + digest
receipt["top"]["size"] = len(payload)
receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
PY
expect_failure extra-top-annotation "top index semantic identity does not match" \
  python3 "$TOOL" validate-index \
    --layout "$TMP_ROOT/extra-top-annotation/layout" \
    --receipt "$TMP_ROOT/extra-top-annotation/receipt.json"

expect_failure duplicate-ref "duplicate Homebrew refs" \
  python3 "$TOOL" merge-index \
    --child-layout "$TMP_ROOT/child32/layout" --child-receipt "$TMP_ROOT/child32/receipt.json" \
    --child-layout "$TMP_ROOT/child32/layout" --child-receipt "$TMP_ROOT/child32/receipt.json" \
    --out-layout "$TMP_ROOT/duplicate/layout" --out-receipt "$TMP_ROOT/duplicate/receipt.json"

# Same semantic ref with changed bytes requires a bottle rebuild.
build_child changed32 wasm32 "changed fixture"
expect_failure conflicting-ref "already names different bytes" \
  python3 "$TOOL" merge-index \
    --existing-layout "$TMP_ROOT/combined/layout" \
    --child-layout "$TMP_ROOT/changed32/layout" --child-receipt "$TMP_ROOT/changed32/receipt.json" \
    --out-layout "$TMP_ROOT/conflict/layout" --out-receipt "$TMP_ROOT/conflict/receipt.json"

# Formula source drift at the same version/rebuild is a stale transition.
cp -a "$TMP_ROOT/child32" "$TMP_ROOT/stale32"
python3 - "$TMP_ROOT/stale32/receipt.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["formula_source_identity_sha256"] = "f" * 64
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
expect_failure stale-transition "semantic annotation" \
  python3 "$TOOL" merge-index \
    --existing-layout "$TMP_ROOT/combined/layout" \
    --child-layout "$TMP_ROOT/stale32/layout" --child-receipt "$TMP_ROOT/stale32/receipt.json" \
    --out-layout "$TMP_ROOT/stale/layout" --out-receipt "$TMP_ROOT/stale/receipt.json"

# Shared Formula support is part of the recipe identity even when Formula bytes match.
build_child changed-support32 wasm32 "hello fixture" "fixture support v2"
expect_failure changed-support "stale Formula identity" \
  python3 "$TOOL" merge-index \
    --existing-layout "$TMP_ROOT/combined/layout" \
    --child-layout "$TMP_ROOT/changed-support32/layout" \
    --child-receipt "$TMP_ROOT/changed-support32/receipt.json" \
    --out-layout "$TMP_ROOT/changed-support/layout" \
    --out-receipt "$TMP_ROOT/changed-support/receipt.json"

# A synthetic child-only layout cannot satisfy the Homebrew version-index contract.
expect_failure synthetic-only "top root" \
  python3 "$TOOL" validate-index \
    --layout "$TMP_ROOT/child32/layout" --receipt "$TMP_ROOT/combined/receipt.json"

source "$REPO_ROOT/scripts/homebrew-publication-limits.sh"
[ "$HOMEBREW_MAX_BOTTLE_BYTES" -lt "$HOMEBREW_MAX_EXPANDED_BOTTLE_BYTES" ] || {
  echo "compressed bottle limit must be smaller than the expanded bottle limit" >&2
  exit 1
}

make_import_fixture() {
  local label="$1" mode="$2"
  local root="$TMP_ROOT/import-$label"
  mkdir -p "$root"
  cp -a "$TMP_ROOT/combined/layout" "$root/remote-layout"
  python3 - "$root/remote-layout" "$root/descriptor.json" "$mode" \
    "$HOMEBREW_MAX_BOTTLE_JSON_BYTES" "$HOMEBREW_MAX_BOTTLE_BYTES" <<'PY'
import hashlib
import json
import pathlib
import sys

layout = pathlib.Path(sys.argv[1])
descriptor_path = pathlib.Path(sys.argv[2])
mode = sys.argv[3]
max_json = int(sys.argv[4])
max_bottle = int(sys.argv[5])
root_path = layout / "index.json"
root = json.loads(root_path.read_text())
top_descriptor = root["manifests"][0]

def read_blob(descriptor):
    digest = descriptor["digest"].removeprefix("sha256:")
    return json.loads((layout / "blobs/sha256" / digest).read_text())

def replace_blob(descriptor, document):
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(payload).hexdigest()
    (layout / "blobs/sha256" / digest).write_bytes(payload)
    descriptor["digest"] = "sha256:" + digest
    descriptor["size"] = len(payload)

top = read_blob(top_descriptor)
if mode == "top-size":
    top_descriptor["size"] = max_json + 1
elif mode == "top-response-size":
    top_descriptor["size"] = 1
elif mode == "child-size":
    top["manifests"][0]["size"] = max_json + 1
    replace_blob(top_descriptor, top)
elif mode in ("config-size", "layer-size"):
    child_descriptor = top["manifests"][0]
    child = read_blob(child_descriptor)
    if mode == "config-size":
        child["config"]["size"] = max_json + 1
    else:
        child["layers"][0]["size"] = max_bottle + 1
    replace_blob(child_descriptor, child)
    replace_blob(top_descriptor, top)
elif mode != "valid":
    raise SystemExit(f"unknown import fixture mode: {mode}")

root_path.write_text(json.dumps(root, sort_keys=True, separators=(",", ":")))
descriptor_path.write_text(json.dumps(top_descriptor, sort_keys=True) + "\n")
PY
}

IMPORT_MOCK_BIN="$TMP_ROOT/import-mock-bin"
mkdir -p "$IMPORT_MOCK_BIN"
cat >"$IMPORT_MOCK_BIN/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$ORAS_LOG"
for credential in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  [ -z "${!credential:-}" ] || {
    echo "credential leaked into anonymous import: $credential" >&2
    exit 9
  }
done
case "${1:-} ${2:-}" in
  "manifest fetch")
    target="${!#}"
    if [[ " $* " == *" --descriptor "* ]]; then
      case "${IMPORT_MODE:-present}" in
        present)
          if [ -n "${IMPORT_MUTATED_DESCRIPTOR:-}" ]; then
            : "${IMPORT_STATE:?IMPORT_STATE is required for tag mutation}"
            count=0
            [ ! -f "$IMPORT_STATE" ] || count="$(cat "$IMPORT_STATE")"
            count="$((count + 1))"
            printf '%s\n' "$count" >"$IMPORT_STATE"
            if [ "$count" -gt 1 ]; then
              cat "$IMPORT_MUTATED_DESCRIPTOR"
            else
              cat "$IMPORT_DESCRIPTOR"
            fi
          else
            cat "$IMPORT_DESCRIPTOR"
          fi
          ;;
        missing) echo "manifest unknown" >&2; exit 1 ;;
        private) echo "unauthorized: authentication required" >&2; exit 1 ;;
        broken) echo "registry transport unavailable" >&2; exit 1 ;;
        *) exit 2 ;;
      esac
    elif [[ "$target" == *@sha256:* ]]; then
      digest="${target##*@sha256:}"
      if [ -n "${IMPORT_SLOW_OVERRUN:-}" ]; then
        printf '{}'
        sleep 30
      else
        cat "$IMPORT_LAYOUT/blobs/sha256/$digest"
      fi
    else
      echo "mutable tag used after descriptor lookup" >&2
      exit 8
    fi
    ;;
  "blob fetch")
    target="${!#}"
    [[ "$target" == *@sha256:* ]] || exit 8
    digest="${target##*@sha256:}"
    resolved_size="${IMPORT_BLOB_SIZE:-}"
    if [ -z "$resolved_size" ]; then
      resolved_size="$(wc -c <"$IMPORT_LAYOUT/blobs/sha256/$digest" | tr -d '[:space:]')"
    fi
    jq -n --arg digest "sha256:$digest" --argjson size "$resolved_size" \
      '{digest: $digest, size: $size}'
    ;;
  "cp --from-registry-config")
    source_ref="${@: -2:1}"
    destination_ref="${@: -1}"
    [[ "$source_ref" == *@sha256:* ]] || {
      echo "mutable tag used for OCI copy" >&2
      exit 8
    }
    destination="${destination_ref%:*}"
    cp -a "$IMPORT_LAYOUT" "$destination"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$IMPORT_MOCK_BIN/oras"

run_import() {
  local label="$1" fixture="$2"
  local root="$TMP_ROOT/import-$fixture"
  env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    ORAS_LOG="$TMP_ROOT/import-$label.log" \
    IMPORT_MODE="${IMPORT_MODE:-present}" \
    IMPORT_DESCRIPTOR="$root/descriptor.json" IMPORT_LAYOUT="$root/remote-layout" \
    IMPORT_BLOB_SIZE="${IMPORT_BLOB_SIZE:-}" \
    IMPORT_MUTATED_DESCRIPTOR="${IMPORT_MUTATED_DESCRIPTOR:-}" \
    IMPORT_SLOW_OVERRUN="${IMPORT_SLOW_OVERRUN:-}" \
    IMPORT_STATE="$TMP_ROOT/import-$label-state" \
    PATH="$IMPORT_MOCK_BIN:$PATH" python3 "$TOOL" import-public-index \
      --remote ghcr.io/automattic/kandelo-homebrew/hello --reference 1.0 \
      --registry-config "$TMP_ROOT/anonymous-oras.json" \
      --out-layout "$TMP_ROOT/import-$label-output/layout" \
      --out-result "$TMP_ROOT/import-$label-result.json"
}

printf '{"auths":{}}\n' >"$TMP_ROOT/anonymous-oras.json"
make_import_fixture valid valid
run_import valid valid
jq -e '
  .schema == 1 and .status == "present" and
  (.digest | test("^sha256:[0-9a-f]{64}$"))
' "$TMP_ROOT/import-valid-result.json" >/dev/null
python3 "$TOOL" validate-index \
  --layout "$TMP_ROOT/import-valid-output/layout" \
  --receipt "$TMP_ROOT/combined/receipt.json"
grep -F "manifest fetch --descriptor" "$TMP_ROOT/import-valid.log" >/dev/null
grep -F "ghcr.io/automattic/kandelo-homebrew/hello@sha256:" \
  "$TMP_ROOT/import-valid.log" >/dev/null
grep -F "blob fetch --descriptor" "$TMP_ROOT/import-valid.log" >/dev/null
grep -E '^cp .*ghcr\.io/automattic/kandelo-homebrew/hello@sha256:' \
  "$TMP_ROOT/import-valid.log" >/dev/null || {
  echo "public index copy was not pinned to the validated digest" >&2
  exit 1
}
! grep -E '^cp .*ghcr\.io/automattic/kandelo-homebrew/hello:1\.0([[:space:]]|$)' \
  "$TMP_ROOT/import-valid.log" >/dev/null || {
  echo "public index copy reused a mutable tag" >&2
  exit 1
}

# A tag mutation after graph validation is detected before any layer transport.
jq '.digest = ("sha256:" + ("f" * 64)) | .size = 1' \
  "$TMP_ROOT/import-valid/descriptor.json" \
  >"$TMP_ROOT/import-mutated-descriptor.json"
: >"$TMP_ROOT/import-tag-mutation.log"
IMPORT_MUTATED_DESCRIPTOR="$TMP_ROOT/import-mutated-descriptor.json" \
  expect_failure import-tag-mutation \
    "public top reference changed during descriptor validation" \
    run_import tag-mutation valid
! grep -E '^cp ' "$TMP_ROOT/import-tag-mutation.log" >/dev/null || {
  echo "mutated public tag reached oras cp" >&2
  exit 1
}

# A registry response exceeding its descriptor is terminated at the first extra byte.
make_import_fixture top-response-size top-response-size
: >"$TMP_ROOT/import-top-response-size.log"
response_started="$(date +%s)"
IMPORT_SLOW_OVERRUN=1 expect_failure import-top-response-size \
  "anonymous registry response exceeds 1 bytes" \
  run_import top-response-size top-response-size
response_elapsed="$(($(date +%s) - response_started))"
[ "$response_elapsed" -lt 10 ] || {
  echo "over-limit registry response was not terminated promptly" >&2
  exit 1
}
! grep -E '^cp ' "$TMP_ROOT/import-top-response-size.log" >/dev/null || {
  echo "over-limit registry response reached oras cp" >&2
  exit 1
}

# The layer's resolved registry size, not only its manifest claim, is bounded.
: >"$TMP_ROOT/import-resolved-layer-size.log"
IMPORT_BLOB_SIZE="$((HOMEBREW_MAX_BOTTLE_BYTES + 1))" \
  expect_failure import-resolved-layer-size \
    "resolved public bottle layer 0 exceeds $HOMEBREW_MAX_BOTTLE_BYTES bytes" \
    run_import resolved-layer-size valid
! grep -E '^cp ' "$TMP_ROOT/import-resolved-layer-size.log" >/dev/null || {
  echo "oversized resolved layer reached oras cp" >&2
  exit 1
}

for mode in top-size child-size config-size layer-size; do
  make_import_fixture "$mode" "$mode"
  : >"$TMP_ROOT/import-$mode.log"
  case "$mode" in
    top-size) pattern="public top descriptor exceeds $HOMEBREW_MAX_BOTTLE_JSON_BYTES bytes" ;;
    child-size) pattern="public child descriptor 0 exceeds $HOMEBREW_MAX_BOTTLE_JSON_BYTES bytes" ;;
    config-size) pattern="public child config descriptor 0 exceeds $HOMEBREW_MAX_BOTTLE_JSON_BYTES bytes" ;;
    layer-size) pattern="public bottle layer descriptor 0 exceeds $HOMEBREW_MAX_BOTTLE_BYTES bytes" ;;
  esac
  expect_failure "import-$mode" "$pattern" run_import "$mode" "$mode"
  ! grep -E '^cp ' "$TMP_ROOT/import-$mode.log" >/dev/null || {
    echo "oversized $mode graph reached oras cp" >&2
    exit 1
  }
done

: >"$TMP_ROOT/import-missing.log"
IMPORT_MODE=missing run_import missing valid
jq -e 'keys == ["schema", "status"] and .status == "missing"' \
  "$TMP_ROOT/import-missing-result.json" >/dev/null
! grep -E '^cp ' "$TMP_ROOT/import-missing.log" >/dev/null
: >"$TMP_ROOT/import-private.log"
IMPORT_MODE=private expect_failure import-private \
  "authorized owner must make the GHCR package public" run_import private valid
! grep -E '^cp ' "$TMP_ROOT/import-private.log" >/dev/null
: >"$TMP_ROOT/import-broken.log"
IMPORT_MODE=broken expect_failure import-broken \
  "could not classify anonymous Homebrew index import" run_import broken valid
! grep -E '^cp ' "$TMP_ROOT/import-broken.log" >/dev/null

MOCK_BIN="$TMP_ROOT/mock-bin"
ORAS_LOG="$TMP_ROOT/oras.log"
mkdir -p "$MOCK_BIN"
cat >"$MOCK_BIN/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$ORAS_LOG"
case "${1:-}" in
  manifest)
    for credential in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
      HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN; do
      [ -z "${!credential:-}" ] || {
        echo "credential leaked into anonymous preflight: $credential" >&2
        exit 9
      }
    done
    mode="${ORAS_PREFLIGHT:-missing}"
    if [[ "$mode" == *-* ]]; then
      : "${ORAS_STATE:?ORAS_STATE is required for sequenced mock responses}"
      count=0
      [ ! -f "$ORAS_STATE" ] || count="$(cat "$ORAS_STATE")"
      count="$((count + 1))"
      printf '%s\n' "$count" >"$ORAS_STATE"
      case "$mode:$count" in
        missing-present:1|missing-private:1|missing-missing:*) mode=missing ;;
        missing-present:*) mode=present ;;
        missing-private:*) mode=private ;;
        *) exit 2 ;;
      esac
    fi
    case "$mode" in
      missing) echo "manifest unknown" >&2; exit 1 ;;
      present) cat "$ORAS_DESCRIPTOR" ;;
      private) echo "unauthorized: authentication required" >&2; exit 1 ;;
      broken) echo "registry transport unavailable" >&2; exit 1 ;;
      *) exit 2 ;;
    esac
    ;;
  login) cat >/dev/null ;;
  cp) ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$MOCK_BIN/oras"

ORAS_LOG="$ORAS_LOG" PATH="$MOCK_BIN:$PATH" \
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --layout "$TMP_ROOT/child32/layout" \
    --layout-receipt "$TMP_ROOT/child32/receipt.json" \
    --tap-repository Automattic/kandelo-homebrew \
    --formula hello \
    --out-json "$TMP_ROOT/child32/dry-upload.json" \
    --dry-run >/dev/null
jq -e '.kind == "child" and .publication.status == "dry-run"' \
  "$TMP_ROOT/child32/dry-upload.json" >/dev/null
python3 "$TOOL" validate-publication-receipt \
  --receipt "$TMP_ROOT/child32/dry-upload.json" \
  --layout-receipt "$TMP_ROOT/child32/receipt.json" \
  --kind child --formula hello \
  --tap-repository Automattic/kandelo-homebrew --allow-dry-run
expect_failure dry-publication-as-public \
  "publication receipt lacks exact anonymous public readback evidence" \
  python3 "$TOOL" validate-publication-receipt \
    --receipt "$TMP_ROOT/child32/dry-upload.json" \
    --layout-receipt "$TMP_ROOT/child32/receipt.json" \
    --kind child --formula hello \
    --tap-repository Automattic/kandelo-homebrew

jq -nS --arg digest "$(jq -r '.oci.manifest.digest' "$TMP_ROOT/child32/receipt.json")" \
  '{mediaType: "application/vnd.oci.image.manifest.v1+json", digest: $digest, size: 1}' \
  >"$TMP_ROOT/present-descriptor.json"
: >"$ORAS_LOG"
ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=missing-present \
  ORAS_STATE="$TMP_ROOT/upload-oras-state" \
  ORAS_DESCRIPTOR="$TMP_ROOT/present-descriptor.json" \
  KANDELO_GHCR_PUBLIC_READ_ATTEMPTS=2 KANDELO_GHCR_PUBLIC_READ_DELAY_SECONDS=0 \
  PATH="$MOCK_BIN:$PATH" GH_TOKEN=test-token GITHUB_ACTOR=tester \
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --layout "$TMP_ROOT/child32/layout" \
    --layout-receipt "$TMP_ROOT/child32/receipt.json" \
    --tap-repository Automattic/kandelo-homebrew \
    --formula hello \
    --out-json "$TMP_ROOT/child32/upload.json" >/dev/null
jq -e '
  .publication.status == "uploaded" and
  .publication.public_readback_digest == .publication.digest
' "$TMP_ROOT/child32/upload.json" >/dev/null
python3 "$TOOL" validate-publication-receipt \
  --receipt "$TMP_ROOT/child32/upload.json" \
  --layout-receipt "$TMP_ROOT/child32/receipt.json" \
  --kind child --formula hello \
  --tap-repository Automattic/kandelo-homebrew
jq '.unreviewed = true' "$TMP_ROOT/child32/upload.json" \
  >"$TMP_ROOT/child32/extra-publication-field.json"
expect_failure publication-extra-field "OCI publication receipt must contain exactly" \
  python3 "$TOOL" validate-publication-receipt \
    --receipt "$TMP_ROOT/child32/extra-publication-field.json" \
    --layout-receipt "$TMP_ROOT/child32/receipt.json" \
    --kind child --formula hello \
    --tap-repository Automattic/kandelo-homebrew
jq '.layout_receipt_sha256 = ("0" * 64)' "$TMP_ROOT/child32/upload.json" \
  >"$TMP_ROOT/child32/bad-publication-layout-hash.json"
expect_failure publication-layout-hash "layout hash does not match" \
  python3 "$TOOL" validate-publication-receipt \
    --receipt "$TMP_ROOT/child32/bad-publication-layout-hash.json" \
    --layout-receipt "$TMP_ROOT/child32/receipt.json" \
    --kind child --formula hello \
    --tap-repository Automattic/kandelo-homebrew
grep -F "cp --from-oci-layout --to-registry-config" "$ORAS_LOG" >/dev/null || {
  echo "OCI transport did not copy from the explicit local layout" >&2
  exit 1
}
grep -F "sha256-" "$ORAS_LOG" >/dev/null || {
  echo "child OCI transport did not use a content-derived tag" >&2
  exit 1
}
auth_config="$(awk '
  $1 == "login" {
    for (i = 1; i <= NF; i += 1) {
      if ($i == "--registry-config") print $(i + 1)
    }
  }
' "$ORAS_LOG")"
[ -n "$auth_config" ] && [ ! -e "$auth_config" ] || {
  echo "isolated ORAS authentication state was not retired" >&2
  exit 1
}

ORAS_LOG="$ORAS_LOG" PATH="$MOCK_BIN:$PATH" \
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --layout "$TMP_ROOT/combined/layout" \
    --layout-receipt "$TMP_ROOT/combined/receipt.json" \
    --tap-repository Automattic/kandelo-homebrew \
    --formula hello \
    --out-json "$TMP_ROOT/combined/dry-upload.json" \
    --dry-run >/dev/null
python3 "$TOOL" validate-publication-receipt \
  --receipt "$TMP_ROOT/combined/dry-upload.json" \
  --layout-receipt "$TMP_ROOT/combined/receipt.json" \
  --kind index --formula hello \
  --tap-repository Automattic/kandelo-homebrew --allow-dry-run
jq '.publication.status = "uploaded" |
    .publication.public_readback_digest = .publication.digest' \
  "$TMP_ROOT/combined/dry-upload.json" >"$TMP_ROOT/combined/public-upload.json"
python3 "$TOOL" validate-publication-receipt \
  --receipt "$TMP_ROOT/combined/public-upload.json" \
  --layout-receipt "$TMP_ROOT/combined/receipt.json" \
  --kind index --formula hello \
  --tap-repository Automattic/kandelo-homebrew

: >"$ORAS_LOG"
ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=present \
  ORAS_DESCRIPTOR="$TMP_ROOT/present-descriptor.json" PATH="$MOCK_BIN:$PATH" \
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --layout "$TMP_ROOT/child32/layout" \
    --layout-receipt "$TMP_ROOT/child32/receipt.json" \
    --tap-repository Automattic/kandelo-homebrew \
    --formula hello \
    --out-json "$TMP_ROOT/child32/retry-upload.json" >/dev/null
jq -e '.publication.status == "already-present"' \
  "$TMP_ROOT/child32/retry-upload.json" >/dev/null
! grep -E '^(login|cp) ' "$ORAS_LOG" >/dev/null || {
  echo "identical OCI retry performed an authenticated transport" >&2
  exit 1
}

jq -nS '{mediaType: "application/vnd.oci.image.manifest.v1+json", digest: ("sha256:" + "9" * 64), size: 1}' \
  >"$TMP_ROOT/conflicting-descriptor.json"
expect_failure transport-conflict "content-derived child tag resolves to different bytes" \
  env ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=present \
    ORAS_DESCRIPTOR="$TMP_ROOT/conflicting-descriptor.json" PATH="$MOCK_BIN:$PATH" \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --layout "$TMP_ROOT/child32/layout" \
      --layout-receipt "$TMP_ROOT/child32/receipt.json" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello --out-json "$TMP_ROOT/conflict-upload.json"
expect_failure transport-unclassified "could not classify anonymous destination preflight" \
  env ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=broken PATH="$MOCK_BIN:$PATH" \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --layout "$TMP_ROOT/child32/layout" \
      --layout-receipt "$TMP_ROOT/child32/receipt.json" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello --out-json "$TMP_ROOT/broken-upload.json"

expect_failure transport-race "different digest after upload" \
  env ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=missing-present \
    ORAS_STATE="$TMP_ROOT/race-oras-state" \
    ORAS_DESCRIPTOR="$TMP_ROOT/conflicting-descriptor.json" \
    KANDELO_GHCR_PUBLIC_READ_ATTEMPTS=2 KANDELO_GHCR_PUBLIC_READ_DELAY_SECONDS=0 \
    PATH="$MOCK_BIN:$PATH" GH_TOKEN=test-token GITHUB_ACTOR=tester \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --layout "$TMP_ROOT/child32/layout" \
      --layout-receipt "$TMP_ROOT/child32/receipt.json" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello --out-json "$TMP_ROOT/race-upload.json"
expect_failure transport-private "authorized owner must make the GHCR package public" \
  env ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=missing-private \
    ORAS_STATE="$TMP_ROOT/private-oras-state" \
    KANDELO_GHCR_PUBLIC_READ_ATTEMPTS=2 KANDELO_GHCR_PUBLIC_READ_DELAY_SECONDS=0 \
    PATH="$MOCK_BIN:$PATH" GH_TOKEN=test-token GITHUB_ACTOR=tester \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --layout "$TMP_ROOT/child32/layout" \
      --layout-receipt "$TMP_ROOT/child32/receipt.json" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello --out-json "$TMP_ROOT/private-upload.json"
expect_failure transport-not-public "did not become anonymously readable" \
  env ORAS_LOG="$ORAS_LOG" ORAS_PREFLIGHT=missing-missing \
    ORAS_STATE="$TMP_ROOT/missing-oras-state" \
    KANDELO_GHCR_PUBLIC_READ_ATTEMPTS=1 KANDELO_GHCR_PUBLIC_READ_DELAY_SECONDS=0 \
    PATH="$MOCK_BIN:$PATH" GH_TOKEN=test-token GITHUB_ACTOR=tester \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --layout "$TMP_ROOT/child32/layout" \
      --layout-receipt "$TMP_ROOT/child32/receipt.json" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello --out-json "$TMP_ROOT/not-public-upload.json"

echo "test-homebrew-oci-layout.sh: ok"
