#!/usr/bin/env bash
# Verify that a Brew executable belongs to the exact clean reviewed checkout.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 BREW ROOT-POLICY [ATTESTATION-OUTPUT]" >&2
  exit 2
fi

BREW_BIN="$1"
POLICY="$2"
ATTESTATION_OUTPUT="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ORACLE="$SCRIPT_DIR/homebrew-native-api-contract.rb"

clean_git() {
  /usr/bin/env -i \
    HOME=/nonexistent \
    PATH=/usr/bin:/bin \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    /usr/bin/git "$@"
}

[ -x "$BREW_BIN" ] || {
  echo "homebrew-native-check-brew-source: brew must be executable" >&2
  exit 2
}
[ -f "$POLICY" ] && [ ! -L "$POLICY" ] || {
  echo "homebrew-native-check-brew-source: root policy must be a regular file" >&2
  exit 2
}

EXPECTED_COMMIT="$(
  jq -er '
    if .schema == 1 and
       .kind == "kandelo-homebrew-native-roots" and
       .architecture == "x86_64_linux" and
       (.homebrew_commit | type == "string" and
         test("^[0-9a-f]{40}$"))
    then .homebrew_commit
    else empty
    end
  ' "$POLICY"
)"

# WHY: do not ask executable Homebrew code where its trusted source lives.
# Derive the checkout from the canonical executable itself, then run Git with
# no caller Git configuration. Inherited Homebrew, Ruby, and Git settings must
# not participate in source provenance.
RESOLVED_BREW="$(readlink -f -- "$BREW_BIN")"
case "$RESOLVED_BREW" in
  */bin/brew)
    BREW_REPOSITORY="${RESOLVED_BREW%/bin/brew}"
    ;;
  *)
    echo "homebrew-native-check-brew-source: brew executable is outside the reviewed checkout" >&2
    exit 2
    ;;
esac
[ -d "$BREW_REPOSITORY" ] &&
  clean_git -C "$BREW_REPOSITORY" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "homebrew-native-check-brew-source: brew executable is outside the reviewed checkout" >&2
  exit 2
}
BREW_REPOSITORY="$(cd "$BREW_REPOSITORY" && pwd -P)"
[ "$RESOLVED_BREW" = "$BREW_REPOSITORY/bin/brew" ] || {
  echo "homebrew-native-check-brew-source: brew executable is outside the reviewed checkout" >&2
  exit 2
}
[ "$(clean_git -C "$BREW_REPOSITORY" rev-parse --show-toplevel)" = \
    "$BREW_REPOSITORY" ] &&
  [ "$(clean_git -C "$BREW_REPOSITORY" rev-parse HEAD)" = \
    "$EXPECTED_COMMIT" ] || {
  echo "homebrew-native-check-brew-source: brew is not the reviewed checkout" >&2
  exit 2
}
[ "$(clean_git -C "$BREW_REPOSITORY" config --local --bool core.filemode)" = \
    "true" ] || {
  echo "homebrew-native-check-brew-source: brew checkout does not track executable modes" >&2
  exit 2
}
UNSAFE_CONFIG="$(
  clean_git -C "$BREW_REPOSITORY" config --local --name-only \
    --get-regexp \
    '^(core\.(attributesfile|excludesfile|fsmonitor|hookspath|ignorestat|sparsecheckout|sparsecheckoutcone|worktree)|diff\.(external|.*\.(command|textconv))|extensions\.worktreeconfig|filter\..*|include(if\..*)?\..*|status\.showuntrackedfiles|submodule\..*\.ignore)$' \
    || true
)"
[ -z "$UNSAFE_CONFIG" ] || {
  echo "homebrew-native-check-brew-source: brew checkout has source-affecting local Git configuration" >&2
  exit 2
}
[ -z "$(
  clean_git -C "$BREW_REPOSITORY" ls-files --unmerged
)" ] && clean_git -C "$BREW_REPOSITORY" ls-files --debug |
  awk '/[[:space:]]flags:/ && $NF != "0" { unsafe = 1 }
       END { exit unsafe }' || {
  echo "homebrew-native-check-brew-source: brew checkout index has nonordinary entries" >&2
  exit 2
}
[ -z "$(
  clean_git -C "$BREW_REPOSITORY" status --porcelain=v1 \
    --ignore-submodules=none --untracked-files=all
)" ] || {
  echo "homebrew-native-check-brew-source: brew checkout is not clean" >&2
  exit 2
}

# Homebrew's pinned shell bootstrap may extract its checksum-pinned portable
# Ruby below this one ignored directory. No other ignored state is executable
# authority, so reject it and attest the complete portable runtime before and
# after every native compatibility operation.
while IFS= read -r -d '' ignored_path; do
  case "$ignored_path" in
    Library/Homebrew/vendor/portable-ruby|\
    Library/Homebrew/vendor/portable-ruby/*) ;;
    *)
      echo "homebrew-native-check-brew-source: brew checkout has unreviewed ignored state" >&2
      exit 2
      ;;
  esac
done < <(
  clean_git -C "$BREW_REPOSITORY" ls-files --others --ignored \
    --exclude-standard -z
)
while IFS= read -r -d '' ignored_directory; do
  case "$ignored_directory" in
    Library/Homebrew/vendor/portable-ruby/|\
    Library/Homebrew/vendor/portable-ruby/*) ;;
    *)
      echo "homebrew-native-check-brew-source: brew checkout has an unreviewed ignored directory: $ignored_directory" >&2
      exit 2
      ;;
  esac
done < <(
  clean_git -C "$BREW_REPOSITORY" ls-files --others --ignored \
    --exclude-standard --directory -z
)

temporary_attestation=""
if [ -z "$ATTESTATION_OUTPUT" ]; then
  temporary_attestation="$(mktemp "${TMPDIR:-/tmp}/kandelo-brew-source.XXXXXX")"
  rm -f "$temporary_attestation"
  ATTESTATION_OUTPUT="$temporary_attestation"
fi
cleanup() {
  if [ -n "$temporary_attestation" ]; then
    rm -f -- "$temporary_attestation"
  fi
}
trap cleanup EXIT
RUBY_BIN="$(command -v ruby)"
/usr/bin/env -i \
  HOME=/nonexistent \
  PATH=/usr/bin:/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  "$RUBY_BIN" --disable=gems,rubyopt "$ORACLE" \
    attest-source "$EXPECTED_COMMIT" "$BREW_REPOSITORY" \
    "$ATTESTATION_OUTPUT"

printf '%s\n' "$BREW_REPOSITORY"
