#!/usr/bin/env bash
# Verify that a built Formula still has the reviewed local source closure.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"

TAP_ROOT=""
TAP_REPOSITORY=""
FORMULA=""
BASE_REF=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-validate-formula-source-closure.sh --tap-root <dir> --tap-repository <owner/repo> --formula <name> --base-ref <commit>

Compares the working tap against the reviewed Formula source at base-ref.
Canonical bottle metadata may differ. Formula code and every file in the
required Kandelo/formula_support tree must remain unchanged.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --base-ref) BASE_REF="${2:-}"; shift 2 ;;
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
BASE_COMMIT="$(git -C "$TAP_ROOT" rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null || true)"
if ! [[ "$BASE_COMMIT" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "homebrew-validate-formula-source-closure.sh: base ref is not a commit: $BASE_REF" >&2
  exit 2
fi

FORMULA_RELATIVE="Formula/$FORMULA.rb"
FORMULA_PATH="$TAP_ROOT/$FORMULA_RELATIVE"
if [ ! -f "$FORMULA_PATH" ] || [ -L "$FORMULA_PATH" ]; then
  echo "homebrew-validate-formula-source-closure.sh: current Formula must be a regular non-symlink file" >&2
  exit 1
fi
BASE_FORMULA_MODE="$(git -C "$TAP_ROOT" ls-tree "$BASE_COMMIT" -- "$FORMULA_RELATIVE" | awk '{print $1 " " $2}')"
case "$BASE_FORMULA_MODE" in
  "100644 blob"|"100755 blob") ;;
  *)
    echo "homebrew-validate-formula-source-closure.sh: reviewed Formula is not a regular file" >&2
    exit 1
    ;;
esac

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
BASE_FORMULA="$WORK_DIR/reviewed.rb"
git -C "$TAP_ROOT" show "$BASE_COMMIT:$FORMULA_RELATIVE" >"$BASE_FORMULA"

reviewed_digest="$(ruby "$SCRIPT_ROOT/homebrew-formula-source-digest.rb" "$BASE_FORMULA")"
current_digest="$(ruby "$SCRIPT_ROOT/homebrew-formula-source-digest.rb" "$FORMULA_PATH")"
if [ "$reviewed_digest" != "$current_digest" ]; then
  echo "homebrew-validate-formula-source-closure.sh: Formula source changed after the bottle build" >&2
  exit 1
fi

owner="$(printf '%s' "${TAP_REPOSITORY%%/*}" | tr '[:upper:]' '[:lower:]')"
repository="$(printf '%s' "${TAP_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]')"
support_require="require (Tap.fetch(\"$owner\", \"$repository\").path/\"Kandelo/formula_support/kandelo_formula_support\").to_s"
support_marker="Kandelo/formula_support/kandelo_formula_support"

if grep -Fq "$support_marker" "$BASE_FORMULA"; then
  if [ "$(grep -Fxc "$support_require" "$BASE_FORMULA" || true)" != "1" ]; then
    echo "homebrew-validate-formula-source-closure.sh: Formula support require is not canonical" >&2
    exit 1
  fi

  SUPPORT_RELATIVE="Kandelo/formula_support"
  SUPPORT_PATH="$TAP_ROOT/$SUPPORT_RELATIVE"
  SUPPORT_HELPER="$SUPPORT_RELATIVE/kandelo_formula_support.rb"
  BASE_HELPER_MODE="$(git -C "$TAP_ROOT" ls-tree "$BASE_COMMIT" -- "$SUPPORT_HELPER" | awk '{print $1 " " $2}')"
  case "$BASE_HELPER_MODE" in
    "100644 blob"|"100755 blob") ;;
    *)
      echo "homebrew-validate-formula-source-closure.sh: reviewed Formula support helper is not a regular file" >&2
      exit 1
      ;;
  esac

  unsafe_entry="$(git -C "$TAP_ROOT" ls-tree -r "$BASE_COMMIT" -- "$SUPPORT_RELATIVE" |
    awk '$1 != "100644" && $1 != "100755" { print; exit }')"
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-validate-formula-source-closure.sh: reviewed Formula support contains an unsafe Git object: $unsafe_entry" >&2
    exit 1
  fi
  if [ ! -d "$SUPPORT_PATH" ] || [ -L "$SUPPORT_PATH" ]; then
    echo "homebrew-validate-formula-source-closure.sh: current Formula support must be a real directory" >&2
    exit 1
  fi
  unsafe_path="$(find "$SUPPORT_PATH" -mindepth 1 \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit)"
  if [ -n "$unsafe_path" ]; then
    echo "homebrew-validate-formula-source-closure.sh: current Formula support contains a symlink or special file: ${unsafe_path#"$TAP_ROOT/"}" >&2
    exit 1
  fi
  if ! git -C "$TAP_ROOT" diff --quiet "$BASE_COMMIT" -- "$SUPPORT_RELATIVE"; then
    echo "homebrew-validate-formula-source-closure.sh: Formula support source changed after the bottle build" >&2
    exit 1
  fi
  if [ -n "$(git -C "$TAP_ROOT" status --short --untracked-files=all --ignored -- "$SUPPORT_RELATIVE")" ]; then
    echo "homebrew-validate-formula-source-closure.sh: Formula support working tree changed after the bottle build" >&2
    exit 1
  fi
elif grep -Eq 'Tap\.fetch|require_relative|KandeloFormulaSupport' "$BASE_FORMULA"; then
  echo "homebrew-validate-formula-source-closure.sh: Formula has an unsupported local source reference" >&2
  exit 1
fi

echo "homebrew-validate-formula-source-closure.sh: validated $FORMULA at $BASE_COMMIT"
