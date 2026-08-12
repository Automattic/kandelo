#!/usr/bin/env bash
# Copy only an exact reconstructed candidate Formula closure into a clean tap.
set -euo pipefail

SOURCE_TAP=""
TARGET_TAP=""
TARGET_FORMULA=""
DEPENDENCY_FORMULAE=()

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-stage-candidate-formulae.sh --source-tap <dir> --target-tap <dir> --target-formula <name> [--dependency-formula <name> ...]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-tap) SOURCE_TAP="${2:-}"; shift 2 ;;
    --target-tap) TARGET_TAP="${2:-}"; shift 2 ;;
    --target-formula) TARGET_FORMULA="${2:-}"; shift 2 ;;
    --dependency-formula) DEPENDENCY_FORMULAE+=("${2:-}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-stage-candidate-formulae.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

for name in SOURCE_TAP TARGET_TAP TARGET_FORMULA; do
  [ -n "${!name}" ] || {
    echo "homebrew-stage-candidate-formulae.sh: $name is required" >&2
    exit 2
  }
done
[[ "$TARGET_FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || {
  echo "homebrew-stage-candidate-formulae.sh: invalid target Formula" >&2
  exit 2
}
for root in "$SOURCE_TAP" "$TARGET_TAP"; do
  [ -d "$root" ] && [ ! -L "$root" ] || {
    echo "homebrew-stage-candidate-formulae.sh: tap roots must be real directories" >&2
    exit 2
  }
done
SOURCE_TAP="$(cd "$SOURCE_TAP" && pwd -P)"
TARGET_TAP="$(cd "$TARGET_TAP" && pwd -P)"
[ "$SOURCE_TAP" != "$TARGET_TAP" ] || {
  echo "homebrew-stage-candidate-formulae.sh: source and target taps must differ" >&2
  exit 2
}
SOURCE_HEAD="$(git -C "$SOURCE_TAP" rev-parse HEAD)"
TARGET_HEAD="$(git -C "$TARGET_TAP" rev-parse HEAD)"
[[ "$SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]] && [ "$TARGET_HEAD" = "$SOURCE_HEAD" ] || {
  echo "homebrew-stage-candidate-formulae.sh: tap Git identities differ" >&2
  exit 2
}
[ -z "$(git -C "$TARGET_TAP" status --short --untracked-files=all)" ] || {
  echo "homebrew-stage-candidate-formulae.sh: target tap must begin clean" >&2
  exit 2
}

declare -A ALLOWED_FORMULAE=(["$TARGET_FORMULA"]=1)
previous=""
for dependency in "${DEPENDENCY_FORMULAE[@]}"; do
  [[ "$dependency" =~ ^[a-z0-9][a-z0-9._-]*$ ]] && \
    [ "$dependency" != "$TARGET_FORMULA" ] && \
    [[ "$dependency" > "$previous" ]] || {
    echo "homebrew-stage-candidate-formulae.sh: dependencies must be sorted, unique, and exclude the target" >&2
    exit 2
  }
  ALLOWED_FORMULAE["$dependency"]=1
  previous="$dependency"
done

mapfile -t source_changes < <(
  git -C "$SOURCE_TAP" status --short --untracked-files=all
)
for change in "${source_changes[@]}"; do
  [[ "$change" =~ ^\ M\ Formula/([a-z0-9][a-z0-9._-]*)\.rb$ ]] && \
    [ -n "${ALLOWED_FORMULAE[${BASH_REMATCH[1]}]:-}" ] || {
    echo "homebrew-stage-candidate-formulae.sh: source tap changed an undeclared Formula: $change" >&2
    exit 2
  }
done

FORMULAE=("$TARGET_FORMULA" "${DEPENDENCY_FORMULAE[@]}")
for formula in "${FORMULAE[@]}"; do
  relative="Formula/$formula.rb"
  [ -f "$SOURCE_TAP/$relative" ] && [ ! -L "$SOURCE_TAP/$relative" ] && \
    [ -f "$TARGET_TAP/$relative" ] && [ ! -L "$TARGET_TAP/$relative" ] || {
    echo "homebrew-stage-candidate-formulae.sh: Formula must be a regular file: $relative" >&2
    exit 2
  }
  cp -- "$SOURCE_TAP/$relative" "$TARGET_TAP/$relative"
done

mapfile -t target_changes < <(
  git -C "$TARGET_TAP" status --short --untracked-files=all
)
for change in "${target_changes[@]}"; do
  [[ "$change" =~ ^\ M\ Formula/([a-z0-9][a-z0-9._-]*)\.rb$ ]] && \
    [ -n "${ALLOWED_FORMULAE[${BASH_REMATCH[1]}]:-}" ] || {
    echo "homebrew-stage-candidate-formulae.sh: staged tap changed an undeclared Formula: $change" >&2
    exit 1
  }
done
for formula in "${FORMULAE[@]}"; do
  cmp -s "$SOURCE_TAP/Formula/$formula.rb" \
    "$TARGET_TAP/Formula/$formula.rb" || {
    echo "homebrew-stage-candidate-formulae.sh: staged Formula differs: $formula" >&2
    exit 1
  }
done
