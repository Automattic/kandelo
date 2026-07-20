#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: homebrew-checkout-public-tap.sh REPOSITORY COMMIT DESTINATION" >&2
  exit 2
}

fail() {
  echo "homebrew-checkout-public-tap.sh: $*" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage

repository="$1"
commit="$2"
requested_destination="$3"

# Dependency taps are executable build input. Keep the transport policy as
# narrow as the reviewed dependency-lock policy rather than accepting an
# arbitrary repository from package data.
[ "$repository" = "kandelo-dev/homebrew-tap-core" ] ||
  fail "repository is not an approved public dependency tap"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "commit must be an exact lowercase 40-character SHA"

[ -n "${GITHUB_WORKSPACE:-}" ] || fail "GITHUB_WORKSPACE is required"
[ -d "$GITHUB_WORKSPACE" ] || fail "GITHUB_WORKSPACE is not a directory"
[ ! -L "$GITHUB_WORKSPACE" ] || fail "GITHUB_WORKSPACE must not be a symlink"

workspace_real="$(/usr/bin/realpath -e -- "$GITHUB_WORKSPACE")"
case "$requested_destination" in
  "$GITHUB_WORKSPACE"/dependency-taps/*) ;;
  *) fail "destination must be an immediate child of GITHUB_WORKSPACE/dependency-taps" ;;
esac

destination_name="${requested_destination#"$GITHUB_WORKSPACE"/dependency-taps/}"
[[ "$destination_name" =~ ^[a-z0-9][a-z0-9-]*$ ]] ||
  fail "destination name is invalid"

dependency_root="$workspace_real/dependency-taps"
if [ -e "$dependency_root" ] || [ -L "$dependency_root" ]; then
  [ -d "$dependency_root" ] || fail "dependency-taps path is not a directory"
  [ ! -L "$dependency_root" ] || fail "dependency-taps path must not be a symlink"
else
  /usr/bin/mkdir --mode=0700 -- "$dependency_root"
fi
[ "$(/usr/bin/stat -c '%u' -- "$dependency_root")" = "$(/usr/bin/id -u)" ] ||
  fail "dependency-taps path is not owned by the runner user"
[ "$(/usr/bin/stat -c '%a' -- "$dependency_root")" = "700" ] ||
  fail "dependency-taps path must have mode 0700"

destination="$dependency_root/$destination_name"
[ ! -e "$destination" ] && [ ! -L "$destination" ] ||
  fail "destination already exists"

anonymous_home="$(/usr/bin/mktemp -d /tmp/kandelo-public-tap-home.XXXXXX)"
checkout_root="$(/usr/bin/mktemp -d "$dependency_root/.checkout.XXXXXX")"
cleanup() {
  /usr/bin/rm -rf -- "$anonymous_home"
  if [ -n "${checkout_root:-}" ] && [ -d "$checkout_root" ]; then
    /usr/bin/rm -rf -- "$checkout_root"
  fi
}
trap cleanup EXIT

anonymous_git() {
  /usr/bin/env -i \
    HOME="$anonymous_home" \
    XDG_CONFIG_HOME="$anonymous_home/xdg" \
    PATH=/usr/bin:/bin \
    LANG=C \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    /usr/bin/git \
      -c credential.helper= \
      -c core.askPass= \
      -c http.https://github.com/.extraheader= \
      "$@"
}

origin="https://github.com/$repository.git"
anonymous_git init --quiet "$checkout_root"
anonymous_git -C "$checkout_root" remote add origin "$origin"
anonymous_git -C "$checkout_root" fetch \
  --no-tags --no-recurse-submodules --depth=1 origin "$commit"

fetched_commit="$(anonymous_git -C "$checkout_root" rev-parse --verify 'FETCH_HEAD^{commit}')"
[ "$fetched_commit" = "$commit" ] || fail "public fetch resolved an unexpected commit"
anonymous_git -C "$checkout_root" checkout --quiet --detach "$commit"

head_commit="$(anonymous_git -C "$checkout_root" rev-parse --verify 'HEAD^{commit}')"
[ "$head_commit" = "$commit" ] || fail "checkout HEAD differs from the requested commit"
[ "$(anonymous_git -C "$checkout_root" remote get-url origin)" = "$origin" ] ||
  fail "checkout origin differs from the reviewed public repository"
[ -z "$(anonymous_git -C "$checkout_root" status --porcelain=v1 --untracked-files=all)" ] ||
  fail "public dependency tap checkout is not clean"

/usr/bin/mv -- "$checkout_root" "$destination"
checkout_root=""

echo "Checked out public dependency tap $repository@$commit without credentials"
