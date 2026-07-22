#!/usr/bin/env bash
# Publish one exact browser-proven Homebrew VFS bundle as immutable public releases.
set -euo pipefail

HANDOFF=""
TAP_ROOT=""
DEPENDENCY_TAP_ROOTS=()
TAP_REPOSITORY=""
TAP_NAME=""
TAP_COMMIT=""
FORMULA=""
KANDELO_COMMIT=""
ABI=""
BOTTLE_RELEASE_TAG=""
RECEIPT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="$2"; shift 2 ;;
    --tap-root) TAP_ROOT="$2"; shift 2 ;;
    --dependency-tap-root) DEPENDENCY_TAP_ROOTS+=("$2"); shift 2 ;;
    --tap-repository) TAP_REPOSITORY="$2"; shift 2 ;;
    --tap-name) TAP_NAME="$2"; shift 2 ;;
    --tap-commit) TAP_COMMIT="$2"; shift 2 ;;
    --formula) FORMULA="$2"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="$2"; shift 2 ;;
    --abi) ABI="$2"; shift 2 ;;
    --bottle-release-tag) BOTTLE_RELEASE_TAG="$2"; shift 2 ;;
    --receipt) RECEIPT="$2"; shift 2 ;;
    *) echo "homebrew-publish-vfs-release: unknown flag $1" >&2; exit 2 ;;
  esac
done

for required in HANDOFF TAP_ROOT TAP_REPOSITORY TAP_NAME TAP_COMMIT FORMULA KANDELO_COMMIT ABI BOTTLE_RELEASE_TAG RECEIPT; do
  if [ -z "${!required}" ]; then
    echo "homebrew-publish-vfs-release: missing ${required,,}" >&2
    exit 2
  fi
done

[ "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" = "$TAP_REPOSITORY" ] ||
  [ "${GITHUB_REPOSITORY,,}" = "${TAP_REPOSITORY,,}" ] || {
  echo "homebrew-publish-vfs-release: workflow repository differs from target tap" >&2
  exit 2
}
[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || {
  echo "homebrew-publish-vfs-release: a GitHub token is required" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_ROOT="$(mktemp -d)"
FINAL_RECEIPT_TMP=""

cleanup() {
  if [ -n "$FINAL_RECEIPT_TMP" ]; then
    rm -f -- "$FINAL_RECEIPT_TMP" || true
  fi
  rm -rf "$TMP_ROOT" || true
}
trap cleanup EXIT

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

validator_args=(
  validate
  --handoff "$HANDOFF"
  --tap-root "$TAP_ROOT"
  --tap-repository "$TAP_REPOSITORY"
  --tap-name "$TAP_NAME"
  --tap-commit "$TAP_COMMIT"
  --formula "$FORMULA"
  --kandelo-commit "$KANDELO_COMMIT"
  --abi "$ABI"
  --bottle-release-tag "$BOTTLE_RELEASE_TAG"
)
for dependency_tap_root in "${DEPENDENCY_TAP_ROOTS[@]}"; do
  validator_args+=(--dependency-tap-root "$dependency_tap_root")
done
# The credentialed finalizer treats the handoff only as inert data. The exact
# validator runs again with token variables removed before any GitHub write.
env -u GH_TOKEN -u GITHUB_TOKEN python3 "$SCRIPT_DIR/homebrew-vfs-release.py" \
  "${validator_args[@]}" >/dev/null

descriptor="$HANDOFF/kandelo-homebrew-vfs.json"
lazy_layer_asset="kandelo-homebrew-${FORMULA}-layer.bin"
lazy_layer_descriptor_asset="kandelo-homebrew-${FORMULA}-layer.json"
lazy_descriptor="$HANDOFF/$lazy_layer_descriptor_asset"
acceptance_tag="$(jq -er '.release.tag' "$descriptor")"
[ "$acceptance_tag" = "homebrew-vfs-sha256-$(jq -er '.image.sha256' "$descriptor")" ] || {
  echo "homebrew-publish-vfs-release: descriptor release tag is not content-addressed" >&2
  exit 2
}
runtime_tag="$(jq -er '.release.tag' "$lazy_descriptor")"
[ "$runtime_tag" = "homebrew-runtime-layer-sha256-$(jq -er '.bundle.sha256' "$lazy_descriptor")" ] || {
  echo "homebrew-publish-vfs-release: lazy layer release tag is not content-addressed" >&2
  exit 2
}
[ "$runtime_tag" != "$acceptance_tag" ] || {
  echo "homebrew-publish-vfs-release: VFS and runtime layer share a release identity" >&2
  exit 2
}

acceptance_expected="$TMP_ROOT/acceptance-expected.json"
printf '%s\n' \
  kandelo-homebrew.vfs.zst \
  kandelo-homebrew-vfs-report.json \
  kandelo-homebrew-node-evidence.json \
  kandelo-homebrew-browser-evidence.json \
  kandelo-homebrew-vfs.json \
  | jq -Rsc 'split("\n")[:-1] | sort' >"$acceptance_expected"
runtime_expected="$TMP_ROOT/runtime-expected.json"
jq -e --arg descriptor "$lazy_layer_descriptor_asset" '
  [.bundle.assets.deferred_trees[].asset, $descriptor] |
  if length == (unique | length) then sort
  else error("duplicate runtime-layer asset") end
' "$lazy_descriptor" >"$runtime_expected"
legacy_acceptance_expected="$TMP_ROOT/legacy-acceptance-expected.json"
printf '%s\n' \
  kandelo-homebrew.vfs.zst \
  kandelo-homebrew-vfs-report.json \
  kandelo-homebrew-node-evidence.json \
  kandelo-homebrew-browser-evidence.json \
  kandelo-homebrew-vfs.json \
  "$lazy_layer_asset" \
  "$lazy_layer_descriptor_asset" \
  | jq -Rsc 'split("\n")[:-1] | sort' >"$legacy_acceptance_expected"

# Old schema-3 publications placed both lazy assets in the VFS release. They
# are immutable and cannot be removed. An existing release may retain that
# exact complete legacy name set, but new VFS releases contain only acceptance
# assets and no unknown or partial legacy set is accepted.
acceptance_allowed="$legacy_acceptance_expected"

write_release_manifest() {
  local output="$1" tag="$2" title="$3" body="$4"
  local preferred_names="$5" allowed_names="$6" allow_legacy="$7"
  local root="$TMP_ROOT/manifest-$(basename "$output" .json)"
  local union_names="$root/union.json" assets="$root/assets.jsonl"
  local accepted_sets="$root/accepted.json"
  local name path
  mkdir -p "$root"

  jq -n --slurpfile preferred "$preferred_names" --slurpfile allowed "$allowed_names" \
    '($preferred[0] + $allowed[0]) | unique | sort' >"$union_names"
  : >"$assets"
  while IFS= read -r name; do
    path="$HANDOFF/$name"
    jq -cn \
      --arg name "$name" \
      --arg sha256 "$(sha256_file "$path")" \
      --argjson bytes "$(file_bytes "$path")" \
      '{name: $name, sha256: $sha256, bytes: $bytes}' >>"$assets"
  done < <(jq -r '.[]' "$union_names")

  if [ "$allow_legacy" = true ] &&
     [ "$(jq -c . "$preferred_names")" != "$(jq -c . "$allowed_names")" ]; then
    jq -n --slurpfile allowed "$allowed_names" '$allowed' >"$accepted_sets"
  else
    printf '[]\n' >"$accepted_sets"
  fi

  jq -nS \
    --arg repository "$TAP_REPOSITORY" \
    --arg tag "$tag" \
    --arg target_commitish "$TAP_COMMIT" \
    --arg title "$title" \
    --arg body "$body" \
    --slurpfile assets "$assets" \
    --slurpfile preferred "$preferred_names" \
    --slurpfile accepted "$accepted_sets" '
      {
        schema: 1,
        repository: $repository,
        tag: $tag,
        target_commitish: $target_commitish,
        title: $title,
        body: $body,
        assets: $assets,
        preferred_asset_names: $preferred[0],
        accepted_existing_asset_sets: $accepted[0]
      }
    ' >"$output"
}

publish_bundle() {
  local tag="$1" label="$2" title="$3" body="$4"
  local preferred_names="$5" allowed_names="$6" allow_legacy="$7" receipt="$8"
  local release_manifest="$TMP_ROOT/$label-release-manifest.json"
  write_release_manifest "$release_manifest" "$tag" "$title" "$body" \
    "$preferred_names" "$allowed_names" "$allow_legacy"
  STATE_LOCK_OWNER_DETAIL="immutable Homebrew ${label} ${FORMULA}/wasm32" \
    bash "$SCRIPT_DIR/publish-immutable-github-release.sh" \
      --manifest "$release_manifest" \
      --asset-root "$HANDOFF" \
      --lock-root "$TAP_ROOT" \
      --receipt "$receipt"
}

acceptance_publication="$TMP_ROOT/acceptance-publication.json"
runtime_publication="$TMP_ROOT/runtime-publication.json"
publish_bundle \
  "$acceptance_tag" acceptance \
  "Browser-proven Homebrew VFS ${FORMULA}" \
  "Content-addressed Kandelo Homebrew VFS image. Provenance and exact Node/Chromium acceptance evidence are attached." \
  "$acceptance_expected" "$acceptance_allowed" true "$acceptance_publication"
publish_bundle \
  "$runtime_tag" runtime-layer \
  "Bottle-backed Homebrew runtime layer ${FORMULA}" \
  "Closed lazy runtime-layer bundle bound to its base shell, bottle provenance, payload inventory, and exact acceptance evidence." \
  "$runtime_expected" "$runtime_expected" false "$runtime_publication"

receipt_dir="$(dirname "$RECEIPT")"
mkdir -p "$receipt_dir"
FINAL_RECEIPT_TMP="$(mktemp "$receipt_dir/.homebrew-vfs-release-receipt.XXXXXX")"
lazy_descriptor="$HANDOFF/$lazy_layer_descriptor_asset"
jq -nS \
  --arg repository "$TAP_REPOSITORY" \
  --arg tag "$acceptance_tag" \
  --arg runtime_tag "$runtime_tag" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg formula "$FORMULA" \
  --arg descriptor_url "https://github.com/${TAP_REPOSITORY}/releases/download/${acceptance_tag}/kandelo-homebrew-vfs.json" \
  --arg image_url "$(jq -er '.image.url' "$descriptor")" \
  --arg image_sha256 "$(jq -er '.image.sha256' "$descriptor")" \
  --argjson image_bytes "$(jq -er '.image.bytes' "$descriptor")" \
  --arg lazy_descriptor_url "https://github.com/${TAP_REPOSITORY}/releases/download/${runtime_tag}/${lazy_layer_descriptor_asset}" \
  --argjson receipt_schema "$(jq -er '
    if (.deferred_trees | length) == 1 and
       (.deferred_trees[0] | has("package") | not)
    then 2 else 3 end
  ' "$lazy_descriptor")" \
  --slurpfile lazy_descriptor "$lazy_descriptor" \
  --slurpfile acceptance_publication "$acceptance_publication" \
  --slurpfile runtime_publication "$runtime_publication" '
    {
      schema: $receipt_schema,
      status: "success",
      visibility: "public-anonymous-readback",
      repository: $repository,
      tag: $tag,
      acceptance_release: {tag: $tag, descriptor_url: $descriptor_url},
      tap_commit: $tap_commit,
      formula: $formula,
      arch: "wasm32",
      descriptor_url: $descriptor_url,
      image: {url: $image_url, sha256: $image_sha256, bytes: $image_bytes},
      lazy_layer: {
        release_tag: $runtime_tag,
        descriptor_url: $lazy_descriptor_url,
        deferred_trees: [
          $lazy_descriptor[0].deferred_trees[] |
          ([.transports[] | select(.kind == "bundle-release")] |
            if length == 1 then .[0]
            else error("missing bundle release transport") end) as $transport |
          {
            content: .content,
            transport: $transport,
            entry_count: .inventory.entry_count
          } + (
            if $receipt_schema == 3
            then {id: .id} + (if has("package") then {package: .package} else {} end)
            else {}
            end
          )
        ]
      },
      acceptance_assets: [
        $acceptance_publication[0].assets[] |
        {name, url, sha256, bytes}
      ],
      assets: [
        $runtime_publication[0].assets[] |
        {name, url, sha256, bytes}
      ]
    }
  ' >"$FINAL_RECEIPT_TMP"
chmod 600 "$FINAL_RECEIPT_TMP"
mv "$FINAL_RECEIPT_TMP" "$RECEIPT"
FINAL_RECEIPT_TMP=""

echo "Published immutable Homebrew VFS descriptor: https://github.com/${TAP_REPOSITORY}/releases/download/${acceptance_tag}/kandelo-homebrew-vfs.json"
echo "Published immutable Homebrew lazy layer descriptor: https://github.com/${TAP_REPOSITORY}/releases/download/${runtime_tag}/${lazy_layer_descriptor_asset}"
