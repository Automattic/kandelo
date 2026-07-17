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
  local repository="${1:-}" requested_name="${2:-}" tap_name

  tap_name="$(homebrew_resolve_tap_name "$repository" "$requested_name")" || return
  printf 'https://ghcr.io/v2/%s\n' "$tap_name"
}
