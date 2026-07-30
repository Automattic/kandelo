#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/require-repository-main-contains.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

SOURCE="1111111111111111111111111111111111111111"
CURRENT_MAIN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
FAKE_BIN="$TMP_ROOT/bin"
mkdir "$FAKE_BIN"

cat >"$FAKE_BIN/git" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ] || exit 90
[ "${GIT_CONFIG_NOSYSTEM:-}" = 1 ] &&
  [ "${GIT_CONFIG_GLOBAL:-}" = /dev/null ] &&
  [ "${GIT_TERMINAL_PROMPT:-}" = 0 ] || exit 91
[ "$1" = -c ] && [ "$2" = credential.helper= ] &&
  [ "$3" = -c ] &&
  [ "$4" = http.https://github.com/.extraheader= ] &&
  [ "$5" = ls-remote ] &&
  [ "$6" = https://github.com/Automattic/kandelo.git ] &&
  [ "$7" = refs/heads/main ] || exit 92
case "${TEST_GIT_MODE:-ok}" in
  ok) printf '%s\trefs/heads/main\n' "${TEST_MAIN_SHA:?}" ;;
  wrong-ref) printf '%s\trefs/heads/release\n' "${TEST_MAIN_SHA:?}" ;;
  duplicate)
    printf '%s\trefs/heads/main\n' "${TEST_MAIN_SHA:?}"
    printf '%s\trefs/heads/main\n' "${TEST_SOURCE_SHA:?}"
    ;;
  malformed) printf 'main\trefs/heads/main\n' ;;
  fail) exit 93 ;;
  *) exit 94 ;;
esac
BASH
chmod 0755 "$FAKE_BIN/git"

cat >"$FAKE_BIN/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ -n "${GH_TOKEN:-}" ] || exit 90
[ "${TEST_GH_FAILURE:-none}" != all ] || exit 92
[ "$#" -eq 4 ] && [ "$1" = api ] && [ "$3" = --jq ] || exit 91
case "$2" in
  "/repos/Automattic/kandelo/compare/${TEST_SOURCE_SHA:?}...${TEST_MAIN_SHA:?}")
    [ "${TEST_GH_FAILURE:-none}" != compare ] || exit 92
    [ "$4" = \
      '[.status, .base_commit.sha, .merge_base_commit.sha] | @tsv' ] ||
      exit 91
    printf '%s\t%s\t%s\n' \
      "${TEST_STATUS:?}" \
      "${TEST_BASE_SHA:-$TEST_SOURCE_SHA}" \
      "${TEST_MERGE_BASE_SHA:-$TEST_SOURCE_SHA}"
    ;;
  *) exit 91 ;;
esac
BASH
chmod 0755 "$FAKE_BIN/gh"

run_check() {
  env \
    GH_TOKEN=test-token \
    GITHUB_SERVER_URL=https://github.com \
    PATH="$FAKE_BIN:$PATH" \
    TEST_BASE_SHA="${TEST_BASE_SHA:-$SOURCE}" \
    TEST_GIT_MODE="${TEST_GIT_MODE:-ok}" \
    TEST_GH_FAILURE="${TEST_GH_FAILURE:-none}" \
    TEST_MAIN_SHA="${TEST_MAIN_SHA:-$CURRENT_MAIN}" \
    TEST_MERGE_BASE_SHA="${TEST_MERGE_BASE_SHA:-$SOURCE}" \
    TEST_SOURCE_SHA="$1" \
    TEST_STATUS="${TEST_STATUS:-ahead}" \
    bash "$CHECK" \
      --repository Automattic/kandelo \
      --source-sha "$1"
}

[ "$(run_check "$SOURCE")" = "$CURRENT_MAIN" ]
TEST_MAIN_SHA="$SOURCE" TEST_STATUS=identical \
  run_check "$SOURCE" >/dev/null

for status in behind diverged; do
  if TEST_STATUS="$status" run_check "$SOURCE" >/dev/null 2>&1; then
    echo "main-contains test accepted comparison status $status" >&2
    exit 1
  fi
done
if TEST_BASE_SHA="2222222222222222222222222222222222222222" \
  run_check "$SOURCE" >/dev/null 2>&1; then
  echo "main-contains test accepted a different comparison base" >&2
  exit 1
fi
if TEST_MERGE_BASE_SHA="3333333333333333333333333333333333333333" \
  run_check "$SOURCE" >/dev/null 2>&1; then
  echo "main-contains test accepted a different merge base" >&2
  exit 1
fi
for mode in wrong-ref duplicate malformed fail; do
  if TEST_GIT_MODE="$mode" run_check "$SOURCE" >/dev/null 2>&1; then
    echo "main-contains test accepted public main mode $mode" >&2
    exit 1
  fi
done
for failure in compare; do
  if TEST_GH_FAILURE="$failure" run_check "$SOURCE" >/dev/null 2>&1; then
    echo "main-contains test accepted unavailable $failure evidence" >&2
    exit 1
  fi
done
for unsafe_repository in \
  ../unsafe \
  owner/.. \
  -owner/repository \
  owner--name/repository \
  owner/repository/extra
do
  if env GH_TOKEN=test-token PATH="$FAKE_BIN:$PATH" \
    bash "$CHECK" \
      --repository "$unsafe_repository" \
      --source-sha "$SOURCE" >/dev/null 2>&1; then
    echo "main-contains test accepted unsafe repository" >&2
    exit 1
  fi
done
for invalid in main refs/heads/main AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; do
  if run_check "$invalid" >/dev/null 2>&1; then
    echo "main-contains test accepted invalid source $invalid" >&2
    exit 1
  fi
done
if env -u GH_TOKEN -u GITHUB_TOKEN \
  GITHUB_SERVER_URL=https://github.com \
  PATH="$FAKE_BIN:$PATH" \
  bash "$CHECK" \
    --repository Automattic/kandelo \
    --source-sha "$SOURCE" >/dev/null 2>&1; then
  echo "main-contains test accepted missing credentials" >&2
  exit 1
fi
if GH_TOKEN=test-token \
  GITHUB_SERVER_URL=https://example.invalid \
  PATH="$FAKE_BIN:$PATH" \
  bash "$CHECK" \
    --repository Automattic/kandelo \
    --source-sha "$SOURCE" >/dev/null 2>&1; then
  echo "main-contains test accepted a non-GitHub authority" >&2
  exit 1
fi

echo "test-require-repository-main-contains.sh: ok"
