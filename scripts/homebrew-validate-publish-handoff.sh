#!/usr/bin/env bash
# Validate the final Homebrew publication payload as inert data.
set -euo pipefail

HANDOFF=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
TAP_REPOSITORY=""
TAP_COMMIT=""
KANDELO_COMMIT=""
BOTTLE_ROOT_URL=""
TAP_ROOT=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-validate-publish-handoff.sh --handoff <dir> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --tap-repository <owner/repo> --tap-commit <sha> --kandelo-commit <sha> --bottle-root-url <url> --tap-root <dir>

Checks the exact build/receipt/sidecar artifact grammar and cross-validates
all publication data without loading Formula Ruby or executing package code.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-validate-publish-handoff.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-validate-publish-handoff.sh: --$name is required" >&2
    exit 2
  fi
}

for requirement in \
  "handoff:$HANDOFF" \
  "formula:$FORMULA" \
  "arch:$ARCH" \
  "release-tag:$RELEASE_TAG" \
  "tap-repository:$TAP_REPOSITORY" \
  "tap-commit:$TAP_COMMIT" \
  "kandelo-commit:$KANDELO_COMMIT" \
  "bottle-root-url:$BOTTLE_ROOT_URL" \
  "tap-root:$TAP_ROOT"; do
  require "${requirement%%:*}" "${requirement#*:}"
done

if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-validate-publish-handoff.sh: invalid formula: $FORMULA" >&2
  exit 2
fi
case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-validate-publish-handoff.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac
if ! [[ "$RELEASE_TAG" =~ ^bottles-abi-v[0-9]+$ ]]; then
  echo "homebrew-validate-publish-handoff.sh: invalid release tag: $RELEASE_TAG" >&2
  exit 2
fi
if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-validate-publish-handoff.sh: invalid tap repository: $TAP_REPOSITORY" >&2
  exit 2
fi
if ! [[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || ! [[ "$KANDELO_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-validate-publish-handoff.sh: invalid source commit" >&2
  exit 2
fi
if ! [[ "$BOTTLE_ROOT_URL" =~ ^https://[^[:space:]]+$ ]] || [[ "$BOTTLE_ROOT_URL" == */ ]]; then
  echo "homebrew-validate-publish-handoff.sh: invalid bottle root URL: $BOTTLE_ROOT_URL" >&2
  exit 2
fi
if [ ! -d "$HANDOFF" ] || [ -L "$HANDOFF" ]; then
  echo "homebrew-validate-publish-handoff.sh: handoff must be a real directory" >&2
  exit 1
fi
if [ ! -d "$TAP_ROOT" ] || [ -L "$TAP_ROOT" ]; then
  echo "homebrew-validate-publish-handoff.sh: tap root must be a real directory" >&2
  exit 1
fi

HANDOFF="$(cd "$HANDOFF" && pwd -P)"
TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
BUILD_ROOT="$HANDOFF/build"
RECEIPT="$HANDOFF/receipt.json"
SIDECAR_ROOT="$HANDOFF/sidecars"

top_entries=()
while IFS= read -r -d '' entry; do
  top_entries+=("$entry")
done < <(find "$HANDOFF" -mindepth 1 -maxdepth 1 -print0)
if [ "${#top_entries[@]}" -ne 3 ]; then
  echo "homebrew-validate-publish-handoff.sh: handoff must contain exactly build, receipt.json, and sidecars" >&2
  exit 1
fi
for entry in "${top_entries[@]}"; do
  case "$(basename "$entry")" in
    build|sidecars)
      [ -d "$entry" ] && [ ! -L "$entry" ] || {
        echo "homebrew-validate-publish-handoff.sh: $(basename "$entry") must be a real directory" >&2
        exit 1
      }
      ;;
    receipt.json)
      [ -f "$entry" ] && [ ! -L "$entry" ] || {
        echo "homebrew-validate-publish-handoff.sh: receipt.json must be a regular file" >&2
        exit 1
      }
      ;;
    *)
      echo "homebrew-validate-publish-handoff.sh: unexpected top-level entry: $(basename "$entry")" >&2
      exit 1
      ;;
  esac
done

while IFS= read -r -d '' entry; do
  if [ -L "$entry" ] || { [ ! -f "$entry" ] && [ ! -d "$entry" ]; }; then
    echo "homebrew-validate-publish-handoff.sh: payload contains a symlink or special file: ${entry#"$HANDOFF"/}" >&2
    exit 1
  fi
done < <(find "$HANDOFF" -mindepth 1 -print0)

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
bash "$SCRIPT_ROOT/homebrew-validate-upload-receipt.sh" \
  --receipt "$RECEIPT" \
  --handoff "$BUILD_ROOT" \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --release-tag "$RELEASE_TAG" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-commit "$TAP_COMMIT" \
  --kandelo-commit "$KANDELO_COMMIT" \
  --bottle-root-url "$BOTTLE_ROOT_URL" >/dev/null

expected_dirs=$'Formula\nKandelo\nKandelo/formula\nKandelo/link\nKandelo/reports'
actual_dirs="$(
  find "$SIDECAR_ROOT" -mindepth 1 -type d -print |
    sed "s|^$SIDECAR_ROOT/||" |
    sort
)"
if [ "$actual_dirs" != "$expected_dirs" ]; then
  echo "homebrew-validate-publish-handoff.sh: sidecar directory layout is not exact" >&2
  exit 1
fi

FORMULA_RB="$SIDECAR_ROOT/Formula/$FORMULA.rb"
FORMULA_JSON="$SIDECAR_ROOT/Kandelo/formula/$FORMULA.json"
METADATA_JSON="$SIDECAR_ROOT/Kandelo/metadata.json"
TAP_FORMULA="$TAP_ROOT/Formula/$FORMULA.rb"
for file in "$FORMULA_RB" "$FORMULA_JSON" "$METADATA_JSON" "$TAP_FORMULA"; do
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    echo "homebrew-validate-publish-handoff.sh: required regular file is missing: $file" >&2
    exit 1
  fi
done

link_files=()
while IFS= read -r -d '' file; do link_files+=("$file"); done \
  < <(find "$SIDECAR_ROOT/Kandelo/link" -mindepth 1 -maxdepth 1 -type f -print0)
provenance_files=()
while IFS= read -r -d '' file; do provenance_files+=("$file"); done \
  < <(find "$SIDECAR_ROOT/Kandelo/reports" -mindepth 1 -maxdepth 1 -type f -print0)
if [ "${#link_files[@]}" -ne 1 ] || [ "${#provenance_files[@]}" -ne 1 ]; then
  echo "homebrew-validate-publish-handoff.sh: sidecars require exactly one link and one provenance file" >&2
  exit 1
fi
LINK_JSON="${link_files[0]}"
PROVENANCE_JSON="${provenance_files[0]}"

sidecar_files=()
while IFS= read -r -d '' file; do sidecar_files+=("$file"); done \
  < <(find "$SIDECAR_ROOT" -mindepth 1 -type f -print0)
if [ "${#sidecar_files[@]}" -ne 5 ]; then
  echo "homebrew-validate-publish-handoff.sh: sidecars must contain exactly five data files" >&2
  exit 1
fi

file_size() { wc -c <"$1" | tr -d '[:space:]'; }
require_max_size() {
  local label="$1" path="$2" maximum="$3" size
  size="$(file_size "$path")"
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" -gt "$maximum" ]; then
    echo "homebrew-validate-publish-handoff.sh: $label exceeds $maximum bytes" >&2
    exit 1
  fi
}
require_max_size "Formula" "$FORMULA_RB" 1048576
require_max_size "tap Formula" "$TAP_FORMULA" 1048576
require_max_size "metadata.json" "$METADATA_JSON" 16777216
require_max_size "formula JSON" "$FORMULA_JSON" 2097152
require_max_size "link JSON" "$LINK_JSON" 2097152
require_max_size "provenance JSON" "$PROVENANCE_JSON" 4194304

OWNER_LOWER="$(printf '%s' "${TAP_REPOSITORY%%/*}" | tr '[:upper:]' '[:lower:]')"
REPO_LOWER="$(printf '%s' "${TAP_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]')"
TAP_NAME="${OWNER_LOWER}/${REPO_LOWER}"
FULL_NAME="${TAP_NAME}/${FORMULA}"
ABI_VERSION="${RELEASE_TAG#bottles-abi-v}"
BOTTLE_TAG="${ARCH}_kandelo"
BOTTLE_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
BOTTLE_SHA256="$(jq -r '.bottle.sha256' "$RECEIPT")"
BOTTLE_BYTES="$(jq -r '.bottle.bytes' "$RECEIPT")"
BOTTLE_URL="$(jq -r '.bottle.url' "$RECEIPT")"
BOTTLE_RELOCATION_CELLAR="$(jq -r '.bottle.cellar' "$BUILD_ROOT/manifest.json")"
case "$BOTTLE_RELOCATION_CELLAR" in
  any) BOTTLE_RELOCATION_CELLAR_DSL=":any" ;;
  any_skip_relocation) BOTTLE_RELOCATION_CELLAR_DSL=":any_skip_relocation" ;;
  /home/linuxbrew/.linuxbrew/Cellar)
    BOTTLE_RELOCATION_CELLAR_DSL="\"/home/linuxbrew/.linuxbrew/Cellar\""
    ;;
  *) echo "homebrew-validate-publish-handoff.sh: invalid relocation cellar" >&2; exit 1 ;;
esac

if ! jq -e \
  --arg formula "$FORMULA" \
  --arg full_name "$FULL_NAME" \
  --arg arch "$ARCH" \
  --arg tag "$BOTTLE_TAG" \
  --arg tap_repository "$TAP_REPOSITORY" \
  --arg tap_name "$TAP_NAME" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" \
  --arg abi "$ABI_VERSION" \
  --arg url "$BOTTLE_URL" \
  --arg sha256 "$BOTTLE_SHA256" \
  --arg bytes "$BOTTLE_BYTES" '
    .schema == 1 and
    .name == $formula and
    .full_name == $full_name and
    .formula_path == ("Formula/" + $formula + ".rb") and
    .tap_repository == $tap_repository and
    .tap_name == $tap_name and
    .tap_commit == $tap_commit and
    .kandelo_abi == ($abi | tonumber) and
    (.version | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")) and
    (.bottle_rebuild | type == "number" and . >= 0 and floor == .) and
    ([.bottles[]? | select(.arch == $arch)] | length) == 1 and
    ([.bottles[]? | select(.arch == $arch)][0] |
      .bottle_tag == $tag and
      .url == $url and
      .sha256 == $sha256 and
      .bytes == ($bytes | tonumber))
  ' "$FORMULA_JSON" >/dev/null; then
  echo "homebrew-validate-publish-handoff.sh: formula sidecar identity or bottle evidence is invalid" >&2
  exit 1
fi

VERSION="$(jq -r '.version' "$FORMULA_JSON")"
BOTTLE_REBUILD="$(jq -r '.bottle_rebuild' "$FORMULA_JSON")"
EXPECTED_STEM="${FORMULA}-${VERSION}-rebuild${BOTTLE_REBUILD}-${ARCH}"
EXPECTED_LINK="${EXPECTED_STEM}.json"
EXPECTED_PROVENANCE="${EXPECTED_STEM}.provenance.json"
if [ "$(basename "$LINK_JSON")" != "$EXPECTED_LINK" ] || \
   [ "$(basename "$PROVENANCE_JSON")" != "$EXPECTED_PROVENANCE" ]; then
  echo "homebrew-validate-publish-handoff.sh: link or provenance filename does not belong to $FORMULA/$ARCH" >&2
  exit 1
fi
if [ "$(jq -r --arg arch "$ARCH" '[.bottles[] | select(.arch == $arch)][0].link_manifest' "$FORMULA_JSON")" != "Kandelo/link/$EXPECTED_LINK" ]; then
  echo "homebrew-validate-publish-handoff.sh: formula sidecar link_manifest does not match its file" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
FORMULA_SHA256="$(sha256_file "$FORMULA_RB")"

if ! jq -e \
  --arg formula "$FORMULA" --arg arch "$ARCH" --arg version "$VERSION" \
  --arg url "$BOTTLE_URL" --arg sha256 "$BOTTLE_SHA256" --arg bytes "$BOTTLE_BYTES" '
    .schema == 1 and .package == $formula and .arch == $arch and .version == $version and
    .bottle.url == $url and .bottle.sha256 == $sha256 and .bottle.bytes == ($bytes | tonumber)
  ' "$LINK_JSON" >/dev/null; then
  echo "homebrew-validate-publish-handoff.sh: link sidecar does not match the bottle" >&2
  exit 1
fi

if ! jq -e \
  --arg formula "$FORMULA" --arg arch "$ARCH" --arg version "$VERSION" \
  --arg rebuild "$BOTTLE_REBUILD" --arg tag "$BOTTLE_TAG" --arg cellar "$BOTTLE_CELLAR" \
  --arg tap_repository "$TAP_REPOSITORY" --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" --arg formula_sha "$FORMULA_SHA256" \
  --arg url "$BOTTLE_URL" --arg sha256 "$BOTTLE_SHA256" --arg bytes "$BOTTLE_BYTES" '
    .schema == 1 and
    .subject.package == $formula and .subject.arch == $arch and .subject.version == $version and
    .subject.bottle_rebuild == ($rebuild | tonumber) and
    .repositories.tap_repository == $tap_repository and .repositories.tap_commit == $tap_commit and
    .repositories.kandelo_commit == $kandelo_commit and
    .formula.path == ("Formula/" + $formula + ".rb") and .formula.sha256 == $formula_sha and
    .bottle.url == $url and .bottle.sha256 == $sha256 and .bottle.bytes == ($bytes | tonumber) and
    .bottle.bottle_tag == $tag and .bottle.cellar == $cellar
  ' "$PROVENANCE_JSON" >/dev/null; then
  echo "homebrew-validate-publish-handoff.sh: provenance sidecar does not match the publication" >&2
  exit 1
fi

if ! jq -e \
  --arg formula "$FORMULA" --arg arch "$ARCH" --arg version "$VERSION" \
  --arg rebuild "$BOTTLE_REBUILD" --arg tag "$BOTTLE_TAG" \
  --arg tap_repository "$TAP_REPOSITORY" --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" --arg release_tag "$RELEASE_TAG" \
  --arg formula_sha "$FORMULA_SHA256" --arg url "$BOTTLE_URL" \
  --arg sha256 "$BOTTLE_SHA256" --arg bytes "$BOTTLE_BYTES" '
    .schema == 1 and .tap_repository == $tap_repository and .tap_commit == $tap_commit and
    .kandelo_commit == $kandelo_commit and .release_tag == $release_tag and
    ([.packages[]? | select(.name == $formula)] | length) == 1 and
    ([.packages[]? | select(.name == $formula)][0] |
      .version == $version and .bottle_rebuild == ($rebuild | tonumber) and
      .formula_path == ("Formula/" + $formula + ".rb") and
      ([.bottles[]? | select(.arch == $arch)] | length) == 1 and
      ([.bottles[]? | select(.arch == $arch)][0] |
        .bottle_tag == $tag and .url == $url and .sha256 == $sha256 and
        .bytes == ($bytes | tonumber) and .built_from.tap_commit == $tap_commit and
        .built_from.kandelo_commit == $kandelo_commit and .built_from.formula_sha256 == $formula_sha))
  ' "$METADATA_JSON" >/dev/null; then
  echo "homebrew-validate-publish-handoff.sh: metadata sidecar does not match the publication" >&2
  exit 1
fi

formula_check_tmp="$(mktemp -d)"
trap 'rm -rf "$formula_check_tmp"' EXIT
expected_root_line="    root_url \"$BOTTLE_ROOT_URL\""
expected_sha_line="    sha256 cellar: $BOTTLE_RELOCATION_CELLAR_DSL, $BOTTLE_TAG: \"$BOTTLE_SHA256\""
if ! awk -v root_line="$expected_root_line" -v sha_line="$expected_sha_line" -v rebuild="$BOTTLE_REBUILD" -v selected_tag="$BOTTLE_TAG" '
  BEGIN { inside = 0; blocks = 0; roots = 0; selected = 0; rebuilds = 0; invalid = 0 }
  $0 == "  bottle do" { if (inside) invalid = 1; inside = 1; blocks++; next }
  inside && $0 == "  end" { inside = 0; next }
  inside {
    if ($0 == root_line) { roots++; next }
    if ($0 == sha_line) { selected++; next }
    if ($0 ~ /^    rebuild [0-9]+$/) {
      rebuilds++
      if ($0 != "    rebuild " rebuild) invalid = 1
      next
    }
    if ($0 ~ /^    sha256 cellar: (:[a-z_]+|"[^"]+"), (wasm32|wasm64)_kandelo: "[0-9a-f]{64}"$/) {
      if (index($0, ", " selected_tag ": ") != 0) invalid = 1
      next
    }
    invalid = 1
    next
  }
  END {
    if (inside || blocks != 1 || roots != 1 || selected != 1 || invalid) exit 1
    if ((rebuild == "0" && rebuilds != 0) || (rebuild != "0" && rebuilds != 1)) exit 1
  }
  ' "$FORMULA_RB"; then
  echo "homebrew-validate-publish-handoff.sh: Formula bottle block is not the exact static root/digest data" >&2
  exit 1
fi

sibling_tag="wasm32_kandelo"
if [ "$BOTTLE_TAG" = "$sibling_tag" ]; then
  sibling_tag="wasm64_kandelo"
fi
extract_sibling_lines() {
  local path="$1"
  awk -v sibling_tag="$sibling_tag" '
    $0 ~ /^    sha256 cellar: (:[a-z_]+|"[^"]+"), (wasm32|wasm64)_kandelo: "[0-9a-f]{64}"$/ &&
      index($0, ", " sibling_tag ": ") != 0 { print }
  ' "$path"
}
extract_sibling_lines "$FORMULA_RB" >"$formula_check_tmp/published-sibling.txt"
extract_sibling_lines "$TAP_FORMULA" >"$formula_check_tmp/reviewed-sibling.txt"
if ! cmp -s "$formula_check_tmp/published-sibling.txt" "$formula_check_tmp/reviewed-sibling.txt"; then
  echo "homebrew-validate-publish-handoff.sh: Formula changed the reviewed sibling bottle tag" >&2
  exit 1
fi

strip_bottle_block() {
  awk '
    !inside && $0 == "" { blanks++; next }
    $0 == "  bottle do" {
      inside = 1
      blanks = 0
      next
    }
    inside && $0 == "  end" {
      inside = 0
      after_bottle = 1
      next
    }
    inside { next }
    {
      if (after_bottle) {
        blanks = 0
        after_bottle = 0
      }
      while (blanks > 0) {
        print ""
        blanks--
      }
      print
    }
    END {
      if (inside) exit 1
      while (blanks > 0) {
        print ""
        blanks--
      }
    }
  ' "$1"
}
strip_bottle_block "$FORMULA_RB" >"$formula_check_tmp/published.rb"
strip_bottle_block "$TAP_FORMULA" >"$formula_check_tmp/reviewed.rb"
if ! cmp -s "$formula_check_tmp/published.rb" "$formula_check_tmp/reviewed.rb"; then
  echo "homebrew-validate-publish-handoff.sh: Formula code differs from the reviewed tap outside the bottle block" >&2
  exit 1
fi

echo "homebrew-validate-publish-handoff.sh: validated $FORMULA/$ARCH"
