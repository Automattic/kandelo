#!/usr/bin/env bash
# Create the minimal, credential-free output of one Homebrew bottle build.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-publication-limits.sh"

FORMULA=""
ARCH=""
RELEASE_TAG=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
TAP_COMMIT=""
KANDELO_COMMIT=""
BOTTLE_ROOT_URL=""
BOTTLE=""
BOTTLE_JSON=""
DEPENDENCY_PROVENANCE=""
OUT_DIR=""
FORBIDDEN_ROOTS=()

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-create-build-handoff.sh --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --tap-repository <owner/repo> [--tap-name <owner/name>] --tap-commit <sha> --kandelo-commit <sha> --bottle-root-url <url> --bottle <path> --bottle-json <path> --dependency-provenance <path> --out <dir> --forbidden-root <absolute-path> [--forbidden-root <absolute-path> ...]

Creates a handoff containing only manifest.json, bottle.json, one bottle
archive, and bounded dependency-pour provenance. Formula sources, environment
files, scripts, credentials, and raw logs are not part of this artifact.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --bottle) BOTTLE="${2:-}"; shift 2 ;;
    --bottle-json) BOTTLE_JSON="${2:-}"; shift 2 ;;
    --dependency-provenance) DEPENDENCY_PROVENANCE="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --forbidden-root)
      [ "$#" -ge 2 ] && [ -n "$2" ] || {
        echo "homebrew-create-build-handoff.sh: --forbidden-root requires a value" >&2
        exit 2
      }
      FORBIDDEN_ROOTS+=("$2")
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-create-build-handoff.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

if [ "${#FORBIDDEN_ROOTS[@]}" -eq 0 ]; then
  echo "homebrew-create-build-handoff.sh: at least one --forbidden-root is required" >&2
  exit 2
fi

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-create-build-handoff.sh: --$name is required" >&2
    exit 2
  fi
}

for requirement in \
  "formula:$FORMULA" \
  "arch:$ARCH" \
  "release-tag:$RELEASE_TAG" \
  "tap-repository:$TAP_REPOSITORY" \
  "tap-commit:$TAP_COMMIT" \
  "kandelo-commit:$KANDELO_COMMIT" \
  "bottle-root-url:$BOTTLE_ROOT_URL" \
  "bottle:$BOTTLE" \
  "bottle-json:$BOTTLE_JSON" \
  "dependency-provenance:$DEPENDENCY_PROVENANCE" \
  "out:$OUT_DIR"; do
  require "${requirement%%:*}" "${requirement#*:}"
done

if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-create-build-handoff.sh: invalid formula: $FORMULA" >&2
  exit 2
fi
if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-create-build-handoff.sh: invalid tap repository: $TAP_REPOSITORY" >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
EXPECTED_BOTTLE_ROOT_URL="$(homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME")"
if [ "$BOTTLE_ROOT_URL" != "$EXPECTED_BOTTLE_ROOT_URL" ]; then
  echo "homebrew-create-build-handoff.sh: bottle root URL does not match Homebrew tap name" >&2
  exit 2
fi
case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-create-build-handoff.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac
if ! [[ "$RELEASE_TAG" =~ ^bottles-abi-v[0-9]+$ ]]; then
  echo "homebrew-create-build-handoff.sh: invalid release tag: $RELEASE_TAG" >&2
  exit 2
fi
if ! [[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-create-build-handoff.sh: invalid tap commit: $TAP_COMMIT" >&2
  exit 2
fi
if ! [[ "$KANDELO_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-create-build-handoff.sh: invalid Kandelo commit: $KANDELO_COMMIT" >&2
  exit 2
fi
if ! [[ "$BOTTLE_ROOT_URL" =~ ^https://[^[:space:]]+$ ]] || [[ "$BOTTLE_ROOT_URL" == */ ]]; then
  echo "homebrew-create-build-handoff.sh: invalid bottle root URL: $BOTTLE_ROOT_URL" >&2
  exit 2
fi
if [ ! -f "$BOTTLE" ] || [ -L "$BOTTLE" ]; then
  echo "homebrew-create-build-handoff.sh: bottle must be a regular non-symlink file: $BOTTLE" >&2
  exit 2
fi
if [ ! -f "$BOTTLE_JSON" ] || [ -L "$BOTTLE_JSON" ]; then
  echo "homebrew-create-build-handoff.sh: bottle JSON must be a regular non-symlink file: $BOTTLE_JSON" >&2
  exit 2
fi
if [ ! -f "$DEPENDENCY_PROVENANCE" ] || [ -L "$DEPENDENCY_PROVENANCE" ]; then
  echo "homebrew-create-build-handoff.sh: dependency provenance must be a regular non-symlink file: $DEPENDENCY_PROVENANCE" >&2
  exit 2
fi

file_size() {
  wc -c <"$1" | tr -d '[:space:]'
}

require_max_size() {
  local label="$1" path="$2" maximum="$3" size
  size="$(file_size "$path")"
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" -gt "$maximum" ]; then
    echo "homebrew-create-build-handoff.sh: $label exceeds $maximum bytes" >&2
    exit 2
  fi
}

require_max_size "bottle JSON" "$BOTTLE_JSON" "$HOMEBREW_MAX_BOTTLE_JSON_BYTES"
require_max_size "dependency provenance" "$DEPENDENCY_PROVENANCE" "$HOMEBREW_MAX_DEPENDENCY_PROVENANCE_BYTES"
require_max_size "compressed bottle" "$BOTTLE" "$HOMEBREW_MAX_BOTTLE_BYTES"

python3 "$SCRIPT_ROOT/homebrew-dependency-provenance.py" validate \
  --input "$DEPENDENCY_PROVENANCE" \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --bottle-root-url "$BOTTLE_ROOT_URL"

case "$(basename "$BOTTLE")" in
  *.bottle.tar.gz) ARCHIVE_NAME="bottle.tar.gz" ;;
  *)
    echo "homebrew-create-build-handoff.sh: bottle name must end in .bottle.tar.gz" >&2
    exit 2
    ;;
esac
if ! timeout 120s gzip -t "$BOTTLE"; then
  echo "homebrew-create-build-handoff.sh: bottle is not a valid gzip stream" >&2
  exit 2
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

BOTTLE_SHA256="$(sha256_file "$BOTTLE")"
BOTTLE_BYTES="$(wc -c <"$BOTTLE" | tr -d '[:space:]')"
BOTTLE_TAG="${ARCH}_kandelo"
OWNER_LOWER="${TAP_NAME%%/*}"
REPO_LOWER="${TAP_NAME#*/}"
FORMULA_KEY="${OWNER_LOWER}/${REPO_LOWER}/${FORMULA}"
FORMULA_PATH="Library/Taps/${OWNER_LOWER}/homebrew-${REPO_LOWER}/Formula/${FORMULA}.rb"
BOTTLE_INSTALL_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
if ! jq -e \
  --arg formula "$FORMULA" \
  --arg formula_key "$FORMULA_KEY" \
  --arg formula_path "$FORMULA_PATH" \
  --arg bottle_root_url "$BOTTLE_ROOT_URL" \
  --arg bottle_tag "$BOTTLE_TAG" \
  --arg bottle_install_cellar "$BOTTLE_INSTALL_CELLAR" \
  --arg sha256 "$BOTTLE_SHA256" '
    type == "object" and length == 1 and
    to_entries[0].key == $formula_key and
    (to_entries[0].value | type == "object") and
    (to_entries[0].value.formula | type == "object") and
    to_entries[0].value.formula.name == $formula and
    to_entries[0].value.formula.path == $formula_path and
    (to_entries[0].value.formula.pkg_version |
      type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")) and
    (to_entries[0].value.bottle | type == "object") and
    to_entries[0].value.bottle.root_url == $bottle_root_url and
    (to_entries[0].value.bottle.cellar |
      . == "any" or . == "any_skip_relocation" or . == $bottle_install_cellar) and
    (to_entries[0].value.bottle.rebuild |
      type == "number" and . >= 0 and floor == .) and
    (to_entries[0].value.bottle.tags | type == "object" and keys == [$bottle_tag]) and
    (to_entries[0].value.bottle.tags[$bottle_tag] | type == "object") and
    ((to_entries[0].value.bottle.tags[$bottle_tag].cellar //
      to_entries[0].value.bottle.cellar) == to_entries[0].value.bottle.cellar) and
    to_entries[0].value.bottle.tags[$bottle_tag].sha256 == $sha256
  ' "$BOTTLE_JSON" >/dev/null; then
  echo "homebrew-create-build-handoff.sh: bottle JSON does not identify the selected formula, root URL, tag, and archive SHA-256" >&2
  exit 1
fi
BOTTLE_RELOCATION_CELLAR="$(jq -r --arg key "$FORMULA_KEY" '.[$key].bottle.cellar' "$BOTTLE_JSON")"

if [ -e "$OUT_DIR" ] || [ -L "$OUT_DIR" ]; then
  if [ ! -d "$OUT_DIR" ] || [ -L "$OUT_DIR" ]; then
    echo "homebrew-create-build-handoff.sh: output must be a real directory: $OUT_DIR" >&2
    exit 2
  fi
  if find "$OUT_DIR" -mindepth 1 -print -quit | grep -q .; then
    echo "homebrew-create-build-handoff.sh: output directory must be empty: $OUT_DIR" >&2
    exit 2
  fi
else
  mkdir -p "$OUT_DIR"
fi
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"

cp "$BOTTLE" "$OUT_DIR/$ARCHIVE_NAME"
cp "$BOTTLE_JSON" "$OUT_DIR/bottle.json"
cp "$DEPENDENCY_PROVENANCE" "$OUT_DIR/dependency-provenance.json"
DEPENDENCY_PROVENANCE_SHA256="$(sha256_file "$DEPENDENCY_PROVENANCE")"
DEPENDENCY_PROVENANCE_BYTES="$(wc -c <"$DEPENDENCY_PROVENANCE" | tr -d '[:space:]')"
jq -nS \
  --arg formula "$FORMULA" \
  --arg arch "$ARCH" \
  --arg release_tag "$RELEASE_TAG" \
  --arg tap_repository "$TAP_REPOSITORY" \
  --arg tap_name "$TAP_NAME" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" \
  --arg bottle_root_url "$BOTTLE_ROOT_URL" \
  --arg archive "$ARCHIVE_NAME" \
  --arg json "bottle.json" \
  --arg tag "$BOTTLE_TAG" \
  --arg cellar "$BOTTLE_RELOCATION_CELLAR" \
  --arg sha256 "$BOTTLE_SHA256" \
  --arg bytes "$BOTTLE_BYTES" \
  --arg dependency_json "dependency-provenance.json" \
  --arg dependency_sha256 "$DEPENDENCY_PROVENANCE_SHA256" \
  --arg dependency_bytes "$DEPENDENCY_PROVENANCE_BYTES" '
    {
      schema: 3,
      formula: $formula,
      arch: $arch,
      release_tag: $release_tag,
      tap_repository: $tap_repository,
      tap_name: $tap_name,
      tap_commit: $tap_commit,
      kandelo_commit: $kandelo_commit,
      bottle_root_url: $bottle_root_url,
      bottle: {
        archive: $archive,
        json: $json,
        tag: $tag,
        cellar: $cellar,
        sha256: $sha256,
        bytes: ($bytes | tonumber)
      },
      dependency_provenance: {
        json: $dependency_json,
        sha256: $dependency_sha256,
        bytes: ($dependency_bytes | tonumber)
      }
    }
  ' >"$OUT_DIR/manifest.json"

validation_args=()
for forbidden_root in "${FORBIDDEN_ROOTS[@]}"; do
  validation_args+=(--forbidden-root "$forbidden_root")
done
bash "$SCRIPT_ROOT/homebrew-validate-build-handoff.sh" \
  --handoff "$OUT_DIR" \
  --formula "$FORMULA" \
  --arch "$ARCH" \
  --release-tag "$RELEASE_TAG" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --kandelo-commit "$KANDELO_COMMIT" \
  --bottle-root-url "$BOTTLE_ROOT_URL" \
  "${validation_args[@]}" >/dev/null

echo "homebrew-create-build-handoff.sh: created $OUT_DIR"
