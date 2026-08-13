#!/usr/bin/env bash
# Derive the protected bottle-first route for one exact pull-request diff.
set -euo pipefail

fail() {
  echo "classify-exact-abi-staging: $*" >&2
  exit 2
}

usage() {
  fail "usage: $0 --authority-root PATH --exact-head-root PATH --base SHA --head SHA --raw-package-staging-required true|false --github-output PATH"
}

authority_root=""
exact_head_root=""
base=""
head=""
raw_package_staging_required=""
github_output=""

[ "$#" -eq 12 ] || usage
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  flag="$1"
  value="$2"
  shift 2
  [ -n "$value" ] || fail "$flag must not be empty"
  case "$flag" in
    --authority-root)
      [ -z "$authority_root" ] || fail "$flag is repeated"
      authority_root="$value"
      ;;
    --exact-head-root)
      [ -z "$exact_head_root" ] || fail "$flag is repeated"
      exact_head_root="$value"
      ;;
    --base)
      [ -z "$base" ] || fail "$flag is repeated"
      base="$value"
      ;;
    --head)
      [ -z "$head" ] || fail "$flag is repeated"
      head="$value"
      ;;
    --raw-package-staging-required)
      [ -z "$raw_package_staging_required" ] || fail "$flag is repeated"
      raw_package_staging_required="$value"
      ;;
    --github-output)
      [ -z "$github_output" ] || fail "$flag is repeated"
      github_output="$value"
      ;;
    *) fail "unknown flag $flag" ;;
  esac
done

[ -n "$authority_root" ] && [ -n "$exact_head_root" ] && \
  [ -n "$base" ] && [ -n "$head" ] && \
  [ -n "$raw_package_staging_required" ] && [ -n "$github_output" ] || usage

case "$raw_package_staging_required" in
  true|false) ;;
  *) fail "--raw-package-staging-required must be true or false" ;;
esac
[[ "$base" =~ ^[0-9a-f]{40}$ ]] ||
  fail "--base must be a full lowercase Git SHA"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] ||
  fail "--head must be a full lowercase Git SHA"
case "$authority_root" in /*) ;; *) fail "--authority-root must be absolute" ;; esac
case "$exact_head_root" in /*) ;; *) fail "--exact-head-root must be absolute" ;; esac
case "$github_output" in /*) ;; *) fail "--github-output must be absolute" ;; esac

[ -d "$authority_root" ] && [ ! -L "$authority_root" ] ||
  fail "authority root is not a directory"
[ -d "$exact_head_root" ] && [ ! -L "$exact_head_root" ] ||
  fail "exact-head root is not a directory"
authority_root="$(cd "$authority_root" && pwd -P)"
exact_head_root="$(cd "$exact_head_root" && pwd -P)"

git_bin=/usr/bin/git
[ -x "$git_bin" ] || fail "reviewed Git executable is unavailable"
git_checked() {
  GIT_NO_REPLACE_OBJECTS=1 "$git_bin" "$@"
}

for root in "$authority_root" "$exact_head_root"; do
  [ "$(git_checked -C "$root" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] ||
    fail "$root is not a Git worktree"
  top="$(git_checked -C "$root" rev-parse --show-toplevel)"
  top="$(cd "$top" && pwd -P)"
  [ "$top" = "$root" ] || fail "$root is not the Git worktree root"
done

[ -z "$(git_checked -C "$authority_root" status --porcelain=v1 --untracked-files=all)" ] ||
  fail "authority checkout is not clean"
git_checked -C "$exact_head_root" cat-file -e "$base^{commit}" 2>/dev/null ||
  fail "base commit is unavailable"
git_checked -C "$exact_head_root" cat-file -e "$head^{commit}" 2>/dev/null ||
  fail "head commit is unavailable"

output_parent="${github_output%/*}"
[ -n "$output_parent" ] || output_parent=/
[ -d "$output_parent" ] && [ ! -L "$output_parent" ] ||
  fail "GitHub output parent is not a directory"
if [ -e "$github_output" ] || [ -L "$github_output" ]; then
  [ -f "$github_output" ] && [ ! -L "$github_output" ] ||
    fail "GitHub output is not a regular file"
fi

private_parent="$(cd /tmp && pwd -P)"
private="$(/usr/bin/mktemp -d "$private_parent/kandelo-exact-abi-route.XXXXXX")"
cleanup() {
  local status="$?"
  trap - EXIT
  case "$private" in
    "$private_parent"/kandelo-exact-abi-route.*)
      /bin/chmod -R u+rwX "$private" 2>/dev/null || true
      /bin/rm -rf "$private"
      ;;
    *)
      echo "classify-exact-abi-staging: refusing unsafe cleanup" >&2
      status=2
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT

changed_paths="$private/changed-paths.nul"
git_checked -C "$exact_head_root" diff --name-only -z "$base...$head" -- \
  >"$changed_paths"
[ -s "$changed_paths" ] || fail "changed-path inventory is empty"

host_target="$( (
  cd "$authority_root"
  scripts/dev-shell.sh rustc -vV
) | while IFS=' ' read -r label value rest; do
  if [ "$label" = host: ] && [ -n "$value" ] && [ -z "${rest:-}" ]; then
    printf '%s\n' "$value"
  fi
done)"
case "$host_target" in
  *[!A-Za-z0-9_.-]*|'') fail "authority host target is invalid" ;;
esac

target_root="$private/target"
(
  cd "$authority_root"
  scripts/dev-shell.sh env CARGO_TARGET_DIR="$target_root" \
    cargo build -p xtask --target "$host_target"
)
xtask="$target_root/$host_target/debug/xtask"
[ -f "$xtask" ] && [ ! -L "$xtask" ] && [ -x "$xtask" ] ||
  fail "authority xtask was not built as one regular executable"

change_classes="$private/change-classes.json"
"$xtask" abi-staging request classify \
  --changed-paths "$changed_paths" \
  --out "$change_classes"
[ -f "$change_classes" ] && [ ! -L "$change_classes" ] ||
  fail "protected classifier did not write a regular result"
classes_compact="$(<"$change_classes")"
case "$classes_compact" in
  '[]'|'["abi"]'|'["kernel"]'|'["host"]'|\
  '["abi","kernel"]'|'["abi","host"]'|'["kernel","host"]'|\
  '["abi","kernel","host"]') ;;
  *) fail "protected classifier result is not a canonical change-class array" ;;
esac

activation="$($xtask abi-staging check-projection activation-mode \
  --activation "$authority_root/abi/staging/required-check-activation.toml")"
case "$activation" in
  observe|enforce) ;;
  *) fail "protected required-Check activation is invalid" ;;
esac

if [[ "$classes_compact" == *'"abi"'* ]] && [ "$activation" = enforce ]; then
  exact_abi_staging_applicable=true
  legacy_package_staging_required=false
  exact_abi_staging_reason=abi-enforced-candidate-bottles
elif [[ "$classes_compact" == *'"abi"'* ]]; then
  exact_abi_staging_applicable=false
  legacy_package_staging_required="$raw_package_staging_required"
  exact_abi_staging_reason=abi-required-check-observe
else
  exact_abi_staging_applicable=false
  legacy_package_staging_required="$raw_package_staging_required"
  exact_abi_staging_reason=no-abi-classified-change
fi

printf '%s\n' \
  "exact_abi_staging_applicable=$exact_abi_staging_applicable" \
  "legacy_package_staging_required=$legacy_package_staging_required" \
  "exact_abi_staging_reason=$exact_abi_staging_reason" \
  >>"$github_output"
