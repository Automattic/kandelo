#!/usr/bin/env bash
# Validate the complete, credential-free output of one Homebrew bottle build.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-publication-limits.sh"

HANDOFF=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
TAP_COMMIT=""
KANDELO_COMMIT=""
BOTTLE_ROOT_URL=""
OUT_ENV=""
OUT_BOTTLE_JSON=""
TAP_ROOT=""
FORBIDDEN_ROOTS=()

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-validate-build-handoff.sh --handoff <dir> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --tap-repository <owner/repo> [--tap-name <owner/name>] --tap-commit <sha> --kandelo-commit <sha> --bottle-root-url <url> --forbidden-root <absolute-path> [--forbidden-root <absolute-path> ...] [--tap-root <dir>] [--out-env <path>] [--out-bottle-json <path>]

Validates an untrusted build handoff against values from the publisher plan.
The handoff must contain exactly manifest.json, bottle.json,
dependency-provenance.json, and the bottle archive named by the manifest.
--out-env, when provided, is written outside the handoff only after every check
succeeds. --out-bottle-json reconstructs the minimal metadata accepted by
Homebrew; raw artifact JSON is never copied.
Forbidden roots are trusted publisher inputs, not handoff data. Every regular
archive member is scanned for each exact root before validated output is made.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --bottle-root-url) BOTTLE_ROOT_URL="${2:-}"; shift 2 ;;
    --forbidden-root)
      [ "$#" -ge 2 ] && [ -n "$2" ] || {
        echo "homebrew-validate-build-handoff.sh: --forbidden-root requires a value" >&2
        exit 2
      }
      FORBIDDEN_ROOTS+=("$2")
      shift 2
      ;;
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --out-env) OUT_ENV="${2:-}"; shift 2 ;;
    --out-bottle-json) OUT_BOTTLE_JSON="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-validate-build-handoff.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

if [ "${#FORBIDDEN_ROOTS[@]}" -eq 0 ]; then
  echo "homebrew-validate-build-handoff.sh: at least one --forbidden-root is required" >&2
  exit 2
fi

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-validate-build-handoff.sh: --$name is required" >&2
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
  "bottle-root-url:$BOTTLE_ROOT_URL"; do
  require "${requirement%%:*}" "${requirement#*:}"
done

if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-validate-build-handoff.sh: invalid formula: $FORMULA" >&2
  exit 2
fi
if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-validate-build-handoff.sh: invalid tap repository: $TAP_REPOSITORY" >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
EXPECTED_BOTTLE_ROOT_URL="$(homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME")"
if [ "$BOTTLE_ROOT_URL" != "$EXPECTED_BOTTLE_ROOT_URL" ]; then
  echo "homebrew-validate-build-handoff.sh: bottle root URL does not match Homebrew tap name" >&2
  exit 2
fi
case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-validate-build-handoff.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac
if ! [[ "$RELEASE_TAG" =~ ^bottles-abi-v[0-9]+$ ]]; then
  echo "homebrew-validate-build-handoff.sh: invalid release tag: $RELEASE_TAG" >&2
  exit 2
fi
if ! [[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-validate-build-handoff.sh: invalid tap commit: $TAP_COMMIT" >&2
  exit 2
fi
if ! [[ "$KANDELO_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-validate-build-handoff.sh: invalid Kandelo commit: $KANDELO_COMMIT" >&2
  exit 2
fi
if ! [[ "$BOTTLE_ROOT_URL" =~ ^https://[^[:space:]]+$ ]] || [[ "$BOTTLE_ROOT_URL" == */ ]]; then
  echo "homebrew-validate-build-handoff.sh: invalid bottle root URL: $BOTTLE_ROOT_URL" >&2
  exit 2
fi
if [ ! -d "$HANDOFF" ] || [ -L "$HANDOFF" ]; then
  echo "homebrew-validate-build-handoff.sh: handoff must be a real directory: $HANDOFF" >&2
  exit 1
fi
if [ -n "$TAP_ROOT" ] && { [ ! -d "$TAP_ROOT" ] || [ -L "$TAP_ROOT" ]; }; then
  echo "homebrew-validate-build-handoff.sh: --tap-root must be a real directory" >&2
  exit 2
fi

HANDOFF="$(cd "$HANDOFF" && pwd -P)"
entries=()
while IFS= read -r -d '' entry; do
  entries+=("$entry")
done < <(find "$HANDOFF" -mindepth 1 -maxdepth 1 -print0)

if [ "${#entries[@]}" -ne 4 ]; then
  echo "homebrew-validate-build-handoff.sh: handoff must contain exactly four files" >&2
  exit 1
fi
for entry in "${entries[@]}"; do
  if [ ! -f "$entry" ] || [ -L "$entry" ]; then
    echo "homebrew-validate-build-handoff.sh: handoff entry is not a regular non-symlink file: $(basename "$entry")" >&2
    exit 1
  fi
done

MANIFEST="$HANDOFF/manifest.json"
BOTTLE_JSON="$HANDOFF/bottle.json"
DEPENDENCY_PROVENANCE="$HANDOFF/dependency-provenance.json"
BOTTLE_ARCHIVE="$HANDOFF/bottle.tar.gz"
if [ ! -f "$MANIFEST" ] || [ -L "$MANIFEST" ] || \
   [ ! -f "$BOTTLE_JSON" ] || [ -L "$BOTTLE_JSON" ] || \
   [ ! -f "$DEPENDENCY_PROVENANCE" ] || [ -L "$DEPENDENCY_PROVENANCE" ] || \
   [ ! -f "$BOTTLE_ARCHIVE" ] || [ -L "$BOTTLE_ARCHIVE" ]; then
  echo "homebrew-validate-build-handoff.sh: manifest.json, bottle.json, dependency-provenance.json, and bottle.tar.gz are required regular files" >&2
  exit 1
fi

file_size() {
  wc -c <"$1" | tr -d '[:space:]'
}

require_max_size() {
  local label="$1" path="$2" maximum="$3" size
  size="$(file_size "$path")"
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" -gt "$maximum" ]; then
    echo "homebrew-validate-build-handoff.sh: $label exceeds $maximum bytes" >&2
    exit 1
  fi
}

require_max_size "manifest.json" "$MANIFEST" "$HOMEBREW_MAX_MANIFEST_BYTES"
require_max_size "bottle.json" "$BOTTLE_JSON" "$HOMEBREW_MAX_BOTTLE_JSON_BYTES"
require_max_size "dependency-provenance.json" "$DEPENDENCY_PROVENANCE" "$HOMEBREW_MAX_DEPENDENCY_PROVENANCE_BYTES"
require_max_size "compressed bottle" "$BOTTLE_ARCHIVE" "$HOMEBREW_MAX_BOTTLE_BYTES"

manifest_error="$(mktemp)"
inspection_json="$(mktemp)"
trap 'rm -f "$manifest_error" "$inspection_json"' EXIT
if ! jq -e \
  --arg formula "$FORMULA" \
  --arg arch "$ARCH" \
  --arg release_tag "$RELEASE_TAG" \
  --arg tap_repository "$TAP_REPOSITORY" \
  --arg tap_name "$TAP_NAME" \
  --arg tap_commit "$TAP_COMMIT" \
  --arg kandelo_commit "$KANDELO_COMMIT" \
  --arg bottle_root_url "$BOTTLE_ROOT_URL" '
    def exact_keys($expected):
      type == "object" and keys == ($expected | sort);
    exact_keys([
      "arch", "bottle", "bottle_root_url", "dependency_provenance", "formula",
      "kandelo_commit", "release_tag", "schema", "tap_commit", "tap_name", "tap_repository"
    ]) and
    .schema == 3 and
    .formula == $formula and
    .arch == $arch and
    .release_tag == $release_tag and
    .tap_repository == $tap_repository and
    .tap_name == $tap_name and
    .tap_commit == $tap_commit and
    .kandelo_commit == $kandelo_commit and
    .bottle_root_url == $bottle_root_url and
    (.bottle | exact_keys(["archive", "bytes", "cellar", "json", "sha256", "tag"])) and
    .bottle.json == "bottle.json" and
    .bottle.tag == ($arch + "_kandelo") and
    (.bottle.cellar |
      . == "any" or . == "any_skip_relocation" or
      . == "/home/linuxbrew/.linuxbrew/Cellar") and
    (.bottle.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bottle.bytes | type == "number" and . >= 0 and floor == .) and
    .bottle.archive == "bottle.tar.gz" and
    (.dependency_provenance | exact_keys(["bytes", "json", "sha256"])) and
    .dependency_provenance.json == "dependency-provenance.json" and
    (.dependency_provenance.sha256 |
      type == "string" and test("^[0-9a-f]{64}$")) and
    (.dependency_provenance.bytes |
      type == "number" and . >= 0 and floor == .)
  ' "$MANIFEST" >/dev/null 2>"$manifest_error"; then
  echo "homebrew-validate-build-handoff.sh: manifest.json violates the strict build-handoff schema" >&2
  sed -n '1,3p' "$manifest_error" >&2
  exit 1
fi

ARCHIVE_NAME="$(jq -r '.bottle.archive' "$MANIFEST")"
EXPECTED_SHA256="$(jq -r '.bottle.sha256' "$MANIFEST")"
EXPECTED_BYTES="$(jq -r '.bottle.bytes' "$MANIFEST")"
EXPECTED_DEPENDENCY_SHA256="$(jq -r '.dependency_provenance.sha256' "$MANIFEST")"
EXPECTED_DEPENDENCY_BYTES="$(jq -r '.dependency_provenance.bytes' "$MANIFEST")"
BOTTLE_RELOCATION_CELLAR="$(jq -r '.bottle.cellar' "$MANIFEST")"
BOTTLE_TAG="${ARCH}_kandelo"
BOTTLE_ARCHIVE="$HANDOFF/$ARCHIVE_NAME"
OWNER_LOWER="${TAP_NAME%%/*}"
REPO_LOWER="${TAP_NAME#*/}"
FORMULA_KEY="${OWNER_LOWER}/${REPO_LOWER}/${FORMULA}"
FORMULA_PATH="Library/Taps/${OWNER_LOWER}/homebrew-${REPO_LOWER}/Formula/${FORMULA}.rb"
BOTTLE_INSTALL_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"

for entry in "${entries[@]}"; do
  case "$(basename "$entry")" in
    manifest.json|bottle.json|dependency-provenance.json|"$ARCHIVE_NAME") ;;
    *) echo "homebrew-validate-build-handoff.sh: unexpected handoff file: $(basename "$entry")" >&2; exit 1 ;;
  esac
done
if [ ! -f "$BOTTLE_ARCHIVE" ] || [ -L "$BOTTLE_ARCHIVE" ]; then
  echo "homebrew-validate-build-handoff.sh: manifest archive is not a regular file: $ARCHIVE_NAME" >&2
  exit 1
fi
if ! timeout 120s gzip -t "$BOTTLE_ARCHIVE"; then
  echo "homebrew-validate-build-handoff.sh: bottle archive is not a valid gzip stream" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

ACTUAL_SHA256="$(sha256_file "$BOTTLE_ARCHIVE")"
ACTUAL_BYTES="$(wc -c <"$BOTTLE_ARCHIVE" | tr -d '[:space:]')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "homebrew-validate-build-handoff.sh: bottle archive SHA-256 does not match manifest" >&2
  exit 1
fi
if [ "$ACTUAL_BYTES" != "$EXPECTED_BYTES" ]; then
  echo "homebrew-validate-build-handoff.sh: bottle archive byte count does not match manifest" >&2
  exit 1
fi
ACTUAL_DEPENDENCY_SHA256="$(sha256_file "$DEPENDENCY_PROVENANCE")"
ACTUAL_DEPENDENCY_BYTES="$(wc -c <"$DEPENDENCY_PROVENANCE" | tr -d '[:space:]')"
if [ "$ACTUAL_DEPENDENCY_SHA256" != "$EXPECTED_DEPENDENCY_SHA256" ]; then
  echo "homebrew-validate-build-handoff.sh: dependency provenance SHA-256 does not match manifest" >&2
  exit 1
fi
if [ "$ACTUAL_DEPENDENCY_BYTES" != "$EXPECTED_DEPENDENCY_BYTES" ]; then
  echo "homebrew-validate-build-handoff.sh: dependency provenance byte count does not match manifest" >&2
  exit 1
fi

dependency_validation_args=(
  validate
  --input "$DEPENDENCY_PROVENANCE"
  --formula "$FORMULA"
  --arch "$ARCH"
  --tap-repository "$TAP_REPOSITORY"
  --tap-name "$TAP_NAME"
  --tap-commit "$TAP_COMMIT"
  --bottle-root-url "$BOTTLE_ROOT_URL"
)
if [ -n "$TAP_ROOT" ]; then
  dependency_validation_args+=(--tap-root "$TAP_ROOT")
fi
python3 "$SCRIPT_ROOT/homebrew-dependency-provenance.py" "${dependency_validation_args[@]}"

if ! jq -e \
  --arg formula "$FORMULA" \
  --arg formula_key "$FORMULA_KEY" \
  --arg formula_path "$FORMULA_PATH" \
  --arg bottle_root_url "$BOTTLE_ROOT_URL" \
  --arg bottle_tag "$BOTTLE_TAG" \
  --arg bottle_install_cellar "$BOTTLE_INSTALL_CELLAR" \
  --arg bottle_relocation_cellar "$BOTTLE_RELOCATION_CELLAR" \
  --arg sha256 "$ACTUAL_SHA256" '
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
    to_entries[0].value.bottle.cellar == $bottle_relocation_cellar and
    (to_entries[0].value.bottle.rebuild |
      type == "number" and . >= 0 and floor == .) and
    (to_entries[0].value.bottle.tags | type == "object" and keys == [$bottle_tag]) and
    (to_entries[0].value.bottle.tags[$bottle_tag] | type == "object") and
    ((to_entries[0].value.bottle.tags[$bottle_tag].cellar //
      to_entries[0].value.bottle.cellar) == $bottle_relocation_cellar) and
    to_entries[0].value.bottle.tags[$bottle_tag].sha256 == $sha256
  ' "$BOTTLE_JSON" >/dev/null; then
  echo "homebrew-validate-build-handoff.sh: bottle.json identity, root URL, selected tag, or SHA-256 is invalid" >&2
  exit 1
fi

PKG_VERSION="$(jq -r --arg key "$FORMULA_KEY" '.[$key].formula.pkg_version' "$BOTTLE_JSON")"
BOTTLE_REBUILD="$(jq -r --arg key "$FORMULA_KEY" '.[$key].bottle.rebuild' "$BOTTLE_JSON")"
EXPECTED_ABI="${RELEASE_TAG#bottles-abi-v}"
inspection_args=()
for forbidden_root in "${FORBIDDEN_ROOTS[@]}"; do
  inspection_args+=(--forbidden-root "$forbidden_root")
done
python3 "$SCRIPT_ROOT/homebrew-inspect-bottle.py" \
  --archive "$BOTTLE_ARCHIVE" \
  --formula "$FORMULA" \
  --version "$PKG_VERSION" \
  --expected-abi "$EXPECTED_ABI" \
  --expected-arch "$ARCH" \
  "${inspection_args[@]}" \
  --out "$inspection_json"

if ! jq -e -s '
  def normalized_dependencies:
    map({
      declared_directly,
      full_name: (.full_name | ascii_downcase),
      version
    }) |
    sort_by(.full_name);
  (.[0].runtime_dependencies | normalized_dependencies) ==
  (.[1].dependencies | normalized_dependencies)
' "$inspection_json" "$DEPENDENCY_PROVENANCE" >/dev/null; then
  echo "homebrew-validate-build-handoff.sh: bottle receipt runtime dependencies do not match validated dependency provenance" >&2
  exit 1
fi

CANONICAL_BOTTLE_JSON=""
if [ -n "$OUT_BOTTLE_JSON" ]; then
  bottle_json_parent="$(dirname "$OUT_BOTTLE_JSON")"
  mkdir -p "$bottle_json_parent"
  bottle_json_parent="$(cd "$bottle_json_parent" && pwd -P)"
  CANONICAL_BOTTLE_JSON="$bottle_json_parent/$(basename "$OUT_BOTTLE_JSON")"
  case "$CANONICAL_BOTTLE_JSON" in
    "$HANDOFF"/*)
      echo "homebrew-validate-build-handoff.sh: --out-bottle-json must be outside the handoff" >&2
      exit 2
      ;;
  esac
  if [ -L "$CANONICAL_BOTTLE_JSON" ]; then
    echo "homebrew-validate-build-handoff.sh: refusing to replace symlink output: $CANONICAL_BOTTLE_JSON" >&2
    exit 2
  fi
  bottle_json_tmp="$(mktemp "$bottle_json_parent/.homebrew-canonical-bottle.XXXXXX")"
  jq -nS \
    --arg formula "$FORMULA" \
    --arg formula_path "$FORMULA_PATH" \
    --arg pkg_version "$PKG_VERSION" \
    --arg root_url "$BOTTLE_ROOT_URL" \
    --arg rebuild "$BOTTLE_REBUILD" \
    --arg tag "$BOTTLE_TAG" \
    --arg cellar "$BOTTLE_RELOCATION_CELLAR" \
    --arg sha256 "$ACTUAL_SHA256" '
      {
        ($formula): {
          formula: {
            name: $formula,
            path: $formula_path,
            pkg_version: $pkg_version
          },
          bottle: {
            root_url: $root_url,
            cellar: $cellar,
            rebuild: ($rebuild | tonumber),
            tags: {
              ($tag): {
                sha256: $sha256
              }
            }
          }
        }
      }
    ' >"$bottle_json_tmp"
  mv "$bottle_json_tmp" "$CANONICAL_BOTTLE_JSON"
fi

if [ -n "$OUT_ENV" ]; then
  out_parent="$(dirname "$OUT_ENV")"
  mkdir -p "$out_parent"
  out_parent="$(cd "$out_parent" && pwd -P)"
  out_path="$out_parent/$(basename "$OUT_ENV")"
  case "$out_path" in
    "$HANDOFF"/*)
      echo "homebrew-validate-build-handoff.sh: --out-env must be outside the handoff" >&2
      exit 2
      ;;
  esac
  if [ -L "$out_path" ]; then
    echo "homebrew-validate-build-handoff.sh: refusing to replace symlink output: $out_path" >&2
    exit 2
  fi
  if [ -n "$CANONICAL_BOTTLE_JSON" ] && [ "$out_path" = "$CANONICAL_BOTTLE_JSON" ]; then
    echo "homebrew-validate-build-handoff.sh: --out-env and --out-bottle-json must differ" >&2
    exit 2
  fi
  out_tmp="$(mktemp "$out_parent/.homebrew-build-handoff.XXXXXX")"
  {
    printf 'FORMULA=%q\n' "$FORMULA"
    printf 'ARCH=%q\n' "$ARCH"
    printf 'RELEASE_TAG=%q\n' "$RELEASE_TAG"
    printf 'TAP_REPOSITORY=%q\n' "$TAP_REPOSITORY"
    printf 'TAP_NAME=%q\n' "$TAP_NAME"
    printf 'TAP_COMMIT=%q\n' "$TAP_COMMIT"
    printf 'KANDELO_COMMIT=%q\n' "$KANDELO_COMMIT"
    printf 'BOTTLE_ROOT_URL=%q\n' "$BOTTLE_ROOT_URL"
    printf 'BOTTLE_ARCHIVE=%q\n' "$BOTTLE_ARCHIVE"
    if [ -n "$CANONICAL_BOTTLE_JSON" ]; then
      printf 'BOTTLE_JSON=%q\n' "$CANONICAL_BOTTLE_JSON"
    fi
    printf 'BOTTLE_SHA256=%q\n' "$ACTUAL_SHA256"
    printf 'BOTTLE_BYTES=%q\n' "$ACTUAL_BYTES"
    printf 'BOTTLE_RELOCATION_CELLAR=%q\n' "$BOTTLE_RELOCATION_CELLAR"
    printf 'DEPENDENCY_PROVENANCE=%q\n' "$DEPENDENCY_PROVENANCE"
  } >"$out_tmp"
  mv "$out_tmp" "$out_path"
fi

echo "homebrew-validate-build-handoff.sh: validated $FORMULA/$ARCH"
