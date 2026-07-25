#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/require-exact-kandelo-main.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

CURRENT_MAIN="a351fc9b18da032c09160c95f1da672374ade700"
REHEARSAL="461d3f1450025bb2cd5392900abfd248eee5e028"
FAKE_BIN="$TMP_ROOT/bin"
mkdir "$FAKE_BIN"

cat >"$FAKE_BIN/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ "${TEST_GH_FAILURE:-false}" = "false" ] || exit 92
[ "$#" -eq 4 ] &&
  [ "$1" = api ] &&
  [ "$2" = "/repos/Automattic/kandelo/git/ref/heads/main" ] &&
  [ "$3" = --jq ] &&
  [ "$4" = .object.sha ] || exit 91
printf '%s\n' "${TEST_MAIN_SHA:?}"
BASH
chmod 0755 "$FAKE_BIN/gh"

run_check() {
  env \
    GH_TOKEN=test-token \
    GITHUB_SERVER_URL=https://github.com \
    PATH="$FAKE_BIN:$PATH" \
    TEST_GH_FAILURE="${TEST_GH_FAILURE:-false}" \
    TEST_MAIN_SHA="${TEST_MAIN_SHA:-$CURRENT_MAIN}" \
    bash "$CHECK" \
      --repository Automattic/kandelo \
      --source-sha "$1"
}

[ "$(run_check "$CURRENT_MAIN")" = "$CURRENT_MAIN" ]

for label_and_sha in \
  "ancestor:1111111111111111111111111111111111111111" \
  "descendant:2222222222222222222222222222222222222222" \
  "same-tree:3333333333333333333333333333333333333333" \
  "tag-target:4444444444444444444444444444444444444444" \
  "pull-request-head:5555555555555555555555555555555555555555" \
  "activation-rehearsal:$REHEARSAL"
do
  label="${label_and_sha%%:*}"
  sha="${label_and_sha#*:}"
  if run_check "$sha" >"$TMP_ROOT/$label.out" 2>"$TMP_ROOT/$label.err"; then
    echo "exact-main test accepted $label as current main" >&2
    exit 1
  fi
  grep -F "source SHA must equal the current refs/heads/main commit" \
    "$TMP_ROOT/$label.err" >/dev/null
done

for invalid in \
  main \
  refs/heads/main \
  A351FC9B18DA032C09160C95F1DA672374ADE700 \
  a351fc9b18da032c09160c95f1da672374ade70
do
  if run_check "$invalid" >/dev/null 2>&1; then
    echo "exact-main test accepted noncanonical source $invalid" >&2
    exit 1
  fi
done

if TEST_GH_FAILURE=true run_check "$CURRENT_MAIN" >/dev/null 2>&1; then
  echo "exact-main test accepted an unavailable main ref" >&2
  exit 1
fi
for invalid_main in \
  main \
  A351FC9B18DA032C09160C95F1DA672374ADE700 \
  a351fc9b18da032c09160c95f1da672374ade70
do
  if TEST_MAIN_SHA="$invalid_main" run_check "$CURRENT_MAIN" >/dev/null 2>&1; then
    echo "exact-main test accepted noncanonical main identity $invalid_main" >&2
    exit 1
  fi
done
if env -u GH_TOKEN \
  GITHUB_SERVER_URL=https://github.com \
  PATH="$FAKE_BIN:$PATH" \
  TEST_MAIN_SHA="$CURRENT_MAIN" \
  bash "$CHECK" --repository Automattic/kandelo --source-sha "$CURRENT_MAIN" \
  >/dev/null 2>&1; then
  echo "exact-main test accepted a missing API credential" >&2
  exit 1
fi
if GH_TOKEN=test-token \
  GITHUB_SERVER_URL=https://example.test \
  PATH="$FAKE_BIN:$PATH" \
  TEST_MAIN_SHA="$CURRENT_MAIN" \
  bash "$CHECK" --repository Automattic/kandelo --source-sha "$CURRENT_MAIN" \
  >/dev/null 2>&1; then
  echo "exact-main test accepted a non-GitHub authority" >&2
  exit 1
fi

echo "test-require-exact-kandelo-main.sh: ok"
