#!/usr/bin/env bash
# Shared validation for GitHub tap repositories and canonical Homebrew tap names.

homebrew_resolve_tap_name() {
  local repository="${1:-}" requested_name="${2:-}" normalized_repository
  local normalized_name owner repository_name expected_name

  if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "homebrew-tap-identity.sh: invalid tap repository: $repository" >&2
    return 2
  fi
  normalized_repository="$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')"
  owner="${normalized_repository%%/*}"
  repository_name="${normalized_repository#*/}"
  case "$repository_name" in
    homebrew-?*) expected_name="$owner/${repository_name#homebrew-}" ;;
    *)
      echo "homebrew-tap-identity.sh: tap repositories must use owner/homebrew-name" >&2
      return 2
      ;;
  esac
  if [ -z "$requested_name" ]; then
    if [ "$normalized_repository" != "kandelo-dev/homebrew-tap-core" ]; then
      echo "homebrew-tap-identity.sh: tap name is required outside the protected default tap" >&2
      return 2
    fi
    requested_name="$expected_name"
  fi
  if ! [[ "$requested_name" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "homebrew-tap-identity.sh: invalid tap name: $requested_name" >&2
    return 2
  fi
  normalized_name="$(printf '%s' "$requested_name" | tr '[:upper:]' '[:lower:]')"
  if [ "$normalized_name" != "$expected_name" ]; then
    echo "homebrew-tap-identity.sh: tap name $requested_name does not match repository $repository" >&2
    return 2
  fi
  printf '%s\n' "$normalized_name"
}

homebrew_bottle_root_url() {
  local repository="${1:-}" requested_name="${2:-}" normalized_repository

  homebrew_resolve_tap_name "$repository" "$requested_name" >/dev/null || return
  normalized_repository="$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')"
  printf 'https://ghcr.io/v2/%s\n' "$normalized_repository"
}

homebrew_candidate_bottle_root_url() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_candidate_bottle_root_url: expected REPOSITORY TARGET_ABI FORMULA" >&2
    return 2
  fi
  local repository="$1" target_abi="$2" formula="$3"
  local normalized_repository owner repository_name tap_name

  if ! [[ "$target_abi" =~ ^[1-9][0-9]*$ ]]; then
    echo "homebrew-tap-identity.sh: target ABI must be a positive integer" >&2
    return 2
  fi
  if ! [[ "$formula" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
     [ "${#formula}" -gt 128 ]; then
    echo "homebrew-tap-identity.sh: invalid candidate Formula name: $formula" >&2
    return 2
  fi
  if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "homebrew-tap-identity.sh: invalid tap repository: $repository" >&2
    return 2
  fi
  normalized_repository="$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')"
  owner="${normalized_repository%%/*}"
  repository_name="${normalized_repository#*/}"
  case "$repository_name" in
    homebrew-?*) tap_name="$owner/${repository_name#homebrew-}" ;;
    *)
      echo "homebrew-tap-identity.sh: tap repositories must use owner/homebrew-name" >&2
      return 2
      ;;
  esac
  homebrew_resolve_tap_name "$repository" "$tap_name" >/dev/null || return
  printf 'https://ghcr.io/v2/%s-abi-%s-candidates/%s\n' \
    "$normalized_repository" "$target_abi" "$formula"
}

homebrew_formula_bottle_root_matches_build_authority() {
  if [ "$#" -ne 6 ]; then
    echo "homebrew_formula_bottle_root_matches_build_authority: expected REPOSITORY TAP_NAME FORMULA TARGET_ABI BUILD_ROOT FORMULA_ROOT" >&2
    return 2
  fi
  local repository="$1" tap_name="$2" formula="$3" target_abi="$4"
  local build_root="$5" formula_root="$6"
  local normalized_repository canonical_root candidate_root prefix suffix source_abi

  homebrew_resolve_tap_name "$repository" "$tap_name" >/dev/null || return
  if ! [[ "$formula" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
     [ "${#formula}" -gt 128 ]; then
    return 1
  fi
  canonical_root="$(homebrew_bottle_root_url "$repository" "$tap_name")" || return
  if [ -z "$target_abi" ]; then
    [ "$build_root" = "$canonical_root" ] &&
      { [ -z "$formula_root" ] || [ "$formula_root" = "$build_root" ]; }
    return
  fi
  if ! [[ "$target_abi" =~ ^[1-9][0-9]*$ ]]; then
    return 1
  fi
  candidate_root="$(homebrew_candidate_bottle_root_url \
    "$repository" "$target_abi" "$formula")" || return
  [ "$build_root" = "$candidate_root" ] || return 1
  case "$formula_root" in
    ""|"$canonical_root"|"$candidate_root") return 0 ;;
  esac

  normalized_repository="$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')"
  prefix="https://ghcr.io/v2/${normalized_repository}-abi-"
  case "$formula_root" in
    "$prefix"*) ;;
    *) return 1 ;;
  esac
  suffix="${formula_root#"$prefix"}"
  source_abi="${suffix%%/*}"
  [ "$suffix" = "$source_abi/$formula" ] || return 1
  [[ "$source_abi" =~ ^[1-9][0-9]*$ ]] || return 1
  if [ "${#source_abi}" -lt "${#target_abi}" ]; then
    return 0
  fi
  [ "${#source_abi}" -eq "${#target_abi}" ] &&
    { [ "$source_abi" = "$target_abi" ] || [[ "$source_abi" < "$target_abi" ]]; }
}

homebrew_local_tap_clone_url() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_local_tap_clone_url: expected CHECKOUT" >&2
    return 2
  fi
  local checkout="$1" physical

  case "$checkout" in
    /*) ;;
    *)
      echo "homebrew-tap-identity.sh: local tap checkout must be absolute" >&2
      return 2
      ;;
  esac
  if [ ! -d "$checkout" ] || [ -L "$checkout" ]; then
    echo "homebrew-tap-identity.sh: local tap checkout must be a real directory" >&2
    return 2
  fi
  physical="$(cd -- "$checkout" && pwd -P)" || return
  if [ "$physical" != "$checkout" ]; then
    echo "homebrew-tap-identity.sh: local tap checkout must be canonical" >&2
    return 2
  fi

  # WHY: `brew tap NAME /local/path` lets Git optimize the clone by hard-
  # linking object files. The isolated publisher later seals the complete
  # Homebrew tree and must reject any inode that is also mutable through a
  # path outside that tree. A file URL uses Git's normal transport instead,
  # producing independent object files while keeping the exact local checkout
  # as the only source. Path.as_uri also quotes spaces and URL delimiters.
  python3 - "$physical" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).as_uri())
PY
}

homebrew_clone_tap() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_clone_tap: expected BREW TAP URL" >&2
    return 2
  fi
  local brew_bin="$1" tap_name="$2" clone_url="$3"
  local original_umask status

  original_umask="$(umask)"
  umask 022
  if "$brew_bin" tap "$tap_name" "$clone_url"; then
    status=0
  else
    status="$?"
  fi
  umask "$original_umask"
  return "$status"
}
