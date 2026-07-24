#!/usr/bin/env bash
# Detach Cargo's release xtask before it becomes Formula policy authority.
set -euo pipefail

ROOT=""
CHECKER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --checker) CHECKER="$2"; shift 2 ;;
    *)
      echo "seal-homebrew-formula-checker: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$ROOT" ] || [ -z "$CHECKER" ] ||
   [ "${ROOT#/}" = "$ROOT" ] || [ "${CHECKER#/}" = "$CHECKER" ] ||
   [ ! -d "$ROOT" ] || [ -L "$ROOT" ] ||
   [ ! -f "$CHECKER" ] || [ -L "$CHECKER" ] || [ ! -x "$CHECKER" ] ||
   [ "$(realpath -- "$ROOT" 2>/dev/null || true)" != "$ROOT" ] ||
   [ "$(realpath -- "$CHECKER" 2>/dev/null || true)" != "$CHECKER" ]; then
  echo "seal-homebrew-formula-checker: exact root and release checker are required" >&2
  exit 2
fi

case "$CHECKER" in
  "$ROOT"/target/*/release/xtask)
    relative="${CHECKER#"$ROOT"/}"
    ;;
  *)
    echo "seal-homebrew-formula-checker: checker is not Cargo's top-level release xtask" >&2
    exit 2
    ;;
esac
IFS=/ read -r -a parts <<<"$relative"
if [ "${#parts[@]}" -ne 4 ] || [ "${parts[0]}" != "target" ] ||
   ! [[ "${parts[1]}" =~ ^[A-Za-z0-9_.+-]+$ ]] ||
   [ "${parts[2]}" != "release" ] || [ "${parts[3]}" != "xtask" ]; then
  echo "seal-homebrew-formula-checker: checker has an invalid release path" >&2
  exit 2
fi

source_mode="$(stat -c '%a' "$CHECKER" 2>/dev/null || true)"
source_uid="$(stat -c '%u' "$CHECKER" 2>/dev/null || true)"
source_size="$(stat -c '%s' "$CHECKER" 2>/dev/null || true)"
source_sha256="$(sha256sum "$CHECKER" 2>/dev/null || true)"
source_sha256="${source_sha256%% *}"
if ! [[ "$source_mode" =~ ^[0-7]{3,4}$ ]] ||
   [ $((8#$source_mode & 06022)) -ne 0 ] ||
   ! [[ "$source_uid" =~ ^[0-9]+$ ]] ||
   ! [[ "$source_size" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$source_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "seal-homebrew-formula-checker: source checker is unsafe" >&2
  exit 2
fi

sealed="$CHECKER.formula-seal"
if [ -e "$sealed" ] || [ -L "$sealed" ]; then
  echo "seal-homebrew-formula-checker: seal destination already exists" >&2
  exit 2
fi
cleanup() {
  rm -f -- "$sealed"
}
trap cleanup EXIT

# WHY: on Linux, Cargo hard-links target/<host>/release/xtask to the hashed
# release/deps artifact. The Formula boundary must not inherit any alternate
# inode alias, even when Cargo's second path is currently protected. Installing
# exact bytes to a new inode keeps the stronger single-link invariant without
# weakening normal Cargo builds.
install -m 0555 -- "$CHECKER" "$sealed"
sealed_mode="$(stat -c '%a' "$sealed" 2>/dev/null || true)"
sealed_links="$(stat -c '%h' "$sealed" 2>/dev/null || true)"
sealed_uid="$(stat -c '%u' "$sealed" 2>/dev/null || true)"
sealed_size="$(stat -c '%s' "$sealed" 2>/dev/null || true)"
sealed_sha256="$(sha256sum "$sealed" 2>/dev/null || true)"
sealed_sha256="${sealed_sha256%% *}"
if [ ! -f "$sealed" ] || [ -L "$sealed" ] || [ ! -x "$sealed" ] ||
   [ "$(realpath -- "$sealed" 2>/dev/null || true)" != "$sealed" ] ||
   [ "$sealed_mode" != "555" ] || [ "$sealed_links" != "1" ] ||
   [ "$sealed_uid" != "$source_uid" ] || [ "$sealed_size" != "$source_size" ] ||
   [ "$sealed_sha256" != "$source_sha256" ]; then
  echo "seal-homebrew-formula-checker: detached checker seal is invalid" >&2
  exit 2
fi

mv -f -- "$sealed" "$CHECKER"
trap - EXIT
final_mode="$(stat -c '%a' "$CHECKER" 2>/dev/null || true)"
final_links="$(stat -c '%h' "$CHECKER" 2>/dev/null || true)"
final_uid="$(stat -c '%u' "$CHECKER" 2>/dev/null || true)"
final_size="$(stat -c '%s' "$CHECKER" 2>/dev/null || true)"
final_sha256="$(sha256sum "$CHECKER" 2>/dev/null || true)"
final_sha256="${final_sha256%% *}"
if [ ! -f "$CHECKER" ] || [ -L "$CHECKER" ] || [ ! -x "$CHECKER" ] ||
   [ "$(realpath -- "$CHECKER" 2>/dev/null || true)" != "$CHECKER" ] ||
   [ "$final_mode" != "555" ] || [ "$final_links" != "1" ] ||
   [ "$final_uid" != "$source_uid" ] || [ "$final_size" != "$source_size" ] ||
   [ "$final_sha256" != "$source_sha256" ]; then
  echo "seal-homebrew-formula-checker: installed checker seal is invalid" >&2
  exit 2
fi

printf '%s\n' "$CHECKER"
