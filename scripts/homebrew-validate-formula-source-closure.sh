#!/usr/bin/env bash
# Verify that a built Formula still has the reviewed local source closure.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"

TAP_ROOT=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
FORMULA=""
BASE_REF=""
REVIEWED_TAP_ROOT=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-validate-formula-source-closure.sh --tap-root <dir> --tap-repository <owner/repo> [--tap-name <owner/name>] --formula <name> --base-ref <commit> [--reviewed-tap-root <dir>]

Compares the working tap against the reviewed Formula source at base-ref.
Canonical bottle metadata may differ. Formula code and every publisher input
in Kandelo/formula_support must remain unchanged. Only the real top-level test
directory is excluded from identity; the publisher removes that reserved
validation-only subtree from disposable tap clones before Formula execution.
When --reviewed-tap-root is supplied, base-ref must be its exact clean HEAD;
this keeps the comparison independent from Git state exposed to Formula
execution.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --base-ref) BASE_REF="${2:-}"; shift 2 ;;
    --reviewed-tap-root) REVIEWED_TAP_ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "homebrew-validate-formula-source-closure.sh: unknown flag $1" >&2
      usage
      exit 2
      ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-validate-formula-source-closure.sh: --$name is required" >&2
    exit 2
  fi
}

require tap-root "$TAP_ROOT"
require tap-repository "$TAP_REPOSITORY"
require formula "$FORMULA"
require base-ref "$BASE_REF"

if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-validate-formula-source-closure.sh: invalid tap repository: $TAP_REPOSITORY" >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-validate-formula-source-closure.sh: invalid formula: $FORMULA" >&2
  exit 2
fi
if [ ! -d "$TAP_ROOT" ] || [ -L "$TAP_ROOT" ]; then
  echo "homebrew-validate-formula-source-closure.sh: tap root must be a real directory" >&2
  exit 2
fi
TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
if ! git -C "$TAP_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "homebrew-validate-formula-source-closure.sh: tap root must be a git checkout" >&2
  exit 2
fi
BASE_GIT_ROOT="$TAP_ROOT"
if [ -n "$REVIEWED_TAP_ROOT" ]; then
  if [ ! -d "$REVIEWED_TAP_ROOT" ] || [ -L "$REVIEWED_TAP_ROOT" ]; then
    echo "homebrew-validate-formula-source-closure.sh: reviewed tap root must be a real directory" >&2
    exit 2
  fi
  REVIEWED_TAP_ROOT="$(cd "$REVIEWED_TAP_ROOT" && pwd -P)"
  if ! git -C "$REVIEWED_TAP_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "homebrew-validate-formula-source-closure.sh: reviewed tap root must be a git checkout" >&2
    exit 2
  fi
  if [ -n "$(git -C "$REVIEWED_TAP_ROOT" status --short --untracked-files=all)" ]; then
    echo "homebrew-validate-formula-source-closure.sh: reviewed tap root must be clean" >&2
    exit 2
  fi
  BASE_GIT_ROOT="$REVIEWED_TAP_ROOT"
fi
BASE_COMMIT="$(git -C "$BASE_GIT_ROOT" rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null || true)"
if ! [[ "$BASE_COMMIT" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "homebrew-validate-formula-source-closure.sh: base ref is not a commit: $BASE_REF" >&2
  exit 2
fi
if [ -n "$REVIEWED_TAP_ROOT" ] && [ "$(git -C "$REVIEWED_TAP_ROOT" rev-parse HEAD)" != "$BASE_COMMIT" ]; then
  echo "homebrew-validate-formula-source-closure.sh: reviewed tap HEAD differs from base ref" >&2
  exit 2
fi

FORMULA_RELATIVE="Formula/$FORMULA.rb"
FORMULA_PATH="$TAP_ROOT/$FORMULA_RELATIVE"
if [ ! -f "$FORMULA_PATH" ] || [ -L "$FORMULA_PATH" ]; then
  echo "homebrew-validate-formula-source-closure.sh: current Formula must be a regular non-symlink file" >&2
  exit 1
fi
BASE_FORMULA_MODE="$(git -C "$BASE_GIT_ROOT" ls-tree "$BASE_COMMIT" -- "$FORMULA_RELATIVE" | awk '{print $1 " " $2}')"
case "$BASE_FORMULA_MODE" in
  "100644 blob"|"100755 blob") ;;
  *)
    echo "homebrew-validate-formula-source-closure.sh: reviewed Formula is not a regular file" >&2
    exit 1
    ;;
esac
if [ -x "$FORMULA_PATH" ]; then
  CURRENT_FORMULA_MODE="100755 blob"
else
  CURRENT_FORMULA_MODE="100644 blob"
fi
if [ "$CURRENT_FORMULA_MODE" != "$BASE_FORMULA_MODE" ]; then
  echo "homebrew-validate-formula-source-closure.sh: Formula file mode changed after the bottle build" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
BASE_FORMULA="$WORK_DIR/reviewed.rb"
git -C "$BASE_GIT_ROOT" show "$BASE_COMMIT:$FORMULA_RELATIVE" >"$BASE_FORMULA"

if ! ruby "$SCRIPT_ROOT/homebrew-formula-source-digest.rb" \
  --equivalent-excluding-bottle "$BASE_FORMULA" "$FORMULA_PATH" >/dev/null; then
  echo "homebrew-validate-formula-source-closure.sh: Formula source changed after the bottle build" >&2
  exit 1
fi

owner="${TAP_NAME%%/*}"
repository="${TAP_NAME#*/}"
support_require="require (Tap.fetch(\"$owner\", \"$repository\").path/\"Kandelo/formula_support/kandelo_formula_support\").to_s"
support_marker="Kandelo/formula_support/kandelo_formula_support"

if grep -Fq "$support_marker" "$BASE_FORMULA"; then
  if [ "$(grep -Fxc "$support_require" "$BASE_FORMULA" || true)" != "1" ]; then
    echo "homebrew-validate-formula-source-closure.sh: Formula support require is not canonical" >&2
    exit 1
  fi
  tap_fetch_count="$({ grep -Fo 'Tap.fetch' "$BASE_FORMULA" || true; } | wc -l | tr -d '[:space:]')"
  support_constant_count="$({ grep -Fo 'KandeloFormulaSupport' "$BASE_FORMULA" || true; } | wc -l | tr -d '[:space:]')"
  if [ "$tap_fetch_count" != "1" ] || \
     [ "$(grep -Fxc '  include KandeloFormulaSupport' "$BASE_FORMULA" || true)" != "1" ] || \
     [ "$support_constant_count" != "1" ] || \
     grep -Fq 'require_relative' "$BASE_FORMULA"; then
    echo "homebrew-validate-formula-source-closure.sh: Formula has an unsupported local source reference" >&2
    exit 1
  fi

  SUPPORT_RELATIVE="Kandelo/formula_support"
  SUPPORT_TEST_RELATIVE="$SUPPORT_RELATIVE/test"
  SUPPORT_PATH="$TAP_ROOT/$SUPPORT_RELATIVE"
  SUPPORT_HELPER="$SUPPORT_RELATIVE/kandelo_formula_support.rb"
  BASE_HELPER_MODE="$(git -C "$BASE_GIT_ROOT" ls-tree "$BASE_COMMIT" -- "$SUPPORT_HELPER" | awk '{print $1 " " $2}')"
  case "$BASE_HELPER_MODE" in
    "100644 blob"|"100755 blob") ;;
    *)
      echo "homebrew-validate-formula-source-closure.sh: reviewed Formula support helper is not a regular file" >&2
      exit 1
      ;;
  esac

  unsafe_entry="$(git -C "$BASE_GIT_ROOT" ls-tree -r "$BASE_COMMIT" -- "$SUPPORT_RELATIVE" |
    awk '$1 != "100644" && $1 != "100755" { print; exit }')"
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-validate-formula-source-closure.sh: reviewed Formula support contains an unsafe Git object: $unsafe_entry" >&2
    exit 1
  fi
  if [ ! -d "$SUPPORT_PATH" ] || [ -L "$SUPPORT_PATH" ]; then
    echo "homebrew-validate-formula-source-closure.sh: current Formula support must be a real directory" >&2
    exit 1
  fi
  unsafe_path="$(find "$SUPPORT_PATH" -mindepth 1 \
    \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit)"
  if [ -n "$unsafe_path" ]; then
    echo "homebrew-validate-formula-source-closure.sh: current Formula support contains a symlink or special file: ${unsafe_path#"$TAP_ROOT/"}" >&2
    exit 1
  fi
  if [ -n "$REVIEWED_TAP_ROOT" ]; then
    REVIEWED_SUPPORT_PATH="$REVIEWED_TAP_ROOT/$SUPPORT_RELATIVE"
    if [ ! -d "$REVIEWED_SUPPORT_PATH" ] || [ -L "$REVIEWED_SUPPORT_PATH" ]; then
      echo "homebrew-validate-formula-source-closure.sh: reviewed Formula support must be a real directory" >&2
      exit 1
    fi
    reviewed_unsafe_path="$(find "$REVIEWED_SUPPORT_PATH" -mindepth 1 \
      \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit)"
    if [ -n "$reviewed_unsafe_path" ]; then
      echo "homebrew-validate-formula-source-closure.sh: reviewed Formula support checkout is unsafe" >&2
      exit 1
    fi
    support_manifest() {
      local root="$1" entry relative mode digest
      (
        cd "$root"
        while IFS= read -r -d '' entry; do
          relative="${entry#./}"
          if [ -d "$entry" ]; then
            printf 'directory\0%s\0' "$relative"
          else
            mode=100644
            [ -x "$entry" ] && mode=100755
            digest="$(
              if command -v sha256sum >/dev/null 2>&1; then
                sha256sum "$entry" | awk '{print $1}'
              else
                shasum -a 256 "$entry" | awk '{print $1}'
              fi
            )"
            printf 'file\0%s\0%s\0%s\0' "$relative" "$mode" "$digest"
          fi
        done < <(find . -mindepth 1 \
          \( -path './test' -type d -prune \) -o -print0 | sort -z)
      )
    }
    if ! cmp -s <(support_manifest "$REVIEWED_SUPPORT_PATH") <(support_manifest "$SUPPORT_PATH"); then
      echo "homebrew-validate-formula-source-closure.sh: Formula support working tree changed after the bottle build" >&2
      exit 1
    fi
  else
    if ! git -C "$TAP_ROOT" diff --quiet "$BASE_COMMIT" -- \
      "$SUPPORT_RELATIVE" ":(exclude)$SUPPORT_TEST_RELATIVE/**"; then
      echo "homebrew-validate-formula-source-closure.sh: Formula support source changed after the bottle build" >&2
      exit 1
    fi
    if [ -n "$(git -C "$TAP_ROOT" status --short --untracked-files=all --ignored -- \
      "$SUPPORT_RELATIVE" ":(exclude)$SUPPORT_TEST_RELATIVE/**")" ]; then
      echo "homebrew-validate-formula-source-closure.sh: Formula support working tree changed after the bottle build" >&2
      exit 1
    fi
  fi
elif grep -Eq 'Tap\.fetch|require_relative|KandeloFormulaSupport' "$BASE_FORMULA"; then
  echo "homebrew-validate-formula-source-closure.sh: Formula has an unsupported local source reference" >&2
  exit 1
fi

CURRENT_CLOSURE="$WORK_DIR/current-source-closure.json"
python3 "$SCRIPT_ROOT/homebrew-oci-layout.py" source-closure \
  --tap-root "$TAP_ROOT" \
  --kandelo-root "$(dirname "$SCRIPT_ROOT")" \
  --tap-repository "$TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --formula "$FORMULA" \
  --out "$CURRENT_CLOSURE"
if [ -n "$REVIEWED_TAP_ROOT" ]; then
  REVIEWED_CLOSURE="$WORK_DIR/reviewed-source-closure.json"
  python3 "$SCRIPT_ROOT/homebrew-oci-layout.py" source-closure \
    --tap-root "$REVIEWED_TAP_ROOT" \
    --kandelo-root "$(dirname "$SCRIPT_ROOT")" \
    --tap-repository "$TAP_REPOSITORY" \
    --tap-name "$TAP_NAME" \
    --formula "$FORMULA" \
    --out "$REVIEWED_CLOSURE"
  if ! cmp -s "$CURRENT_CLOSURE" "$REVIEWED_CLOSURE"; then
    echo "homebrew-validate-formula-source-closure.sh: canonical Formula source-closure digest differs from the reviewed tap" >&2
    exit 1
  fi
fi

ruby "$SCRIPT_ROOT/homebrew-formula-runtime-closure.rb" \
  "$TAP_ROOT" "$TAP_NAME" "$FORMULA" --declarations-json \
  >/dev/null

echo "homebrew-validate-formula-source-closure.sh: validated $FORMULA at $BASE_COMMIT"
