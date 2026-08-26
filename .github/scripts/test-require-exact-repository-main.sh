#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/require-exact-repository-main.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/bin"

cat >"$TMP_ROOT/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ -n "${FAKE_GIT_LOG:-}" ]
printf 'called\n' >>"$FAKE_GIT_LOG"
[ -z "${GH_TOKEN:-}" ]
[ -z "${GITHUB_TOKEN:-}" ]
[ "${GIT_CONFIG_NOSYSTEM:-}" = 1 ]
[ "${GIT_CONFIG_GLOBAL:-}" = /dev/null ]
[ "${GIT_TERMINAL_PROMPT:-}" = 0 ]
[ "$1" = -c ]
[ "$2" = credential.helper= ]
[ "$3" = -c ]
[ "$4" = http.https://github.com/.extraheader= ]
[ "$5" = ls-remote ]
[ "$6" = "https://github.com/Kandelo-dev/sample-tap-core.git" ]
[ "$7" = refs/heads/main ]
case "${FAKE_GIT_MODE:-ok}" in
  ok) printf '%s\trefs/heads/main\n' "2222222222222222222222222222222222222222" ;;
  wrong-ref) printf '%s\trefs/heads/release\n' "2222222222222222222222222222222222222222" ;;
  duplicate)
    printf '%s\trefs/heads/main\n' "2222222222222222222222222222222222222222"
    printf '%s\trefs/heads/main\n' "3333333333333333333333333333333333333333"
    ;;
  fail) exit 1 ;;
esac
EOF
chmod +x "$TMP_ROOT/bin/git"

run_check() {
  FAKE_GIT_LOG="$TMP_ROOT/git.log" PATH="$TMP_ROOT/bin:$PATH" \
    bash "$CHECK" \
      --repository Kandelo-dev/sample-tap-core \
      --source-sha 2222222222222222222222222222222222222222
}

[ "$(run_check)" = 2222222222222222222222222222222222222222 ]

for mode in wrong-ref duplicate fail; do
  if FAKE_GIT_MODE="$mode" run_check >/dev/null 2>&1; then
    echo "test-require-exact-repository-main: accepted $mode" >&2
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
  : >"$TMP_ROOT/git.log"
  if FAKE_GIT_LOG="$TMP_ROOT/git.log" PATH="$TMP_ROOT/bin:$PATH" bash "$CHECK" \
      --repository "$unsafe_repository" \
      --source-sha 2222222222222222222222222222222222222222 \
      >/dev/null 2>&1; then
    echo "test-require-exact-repository-main: accepted unsafe repository" >&2
    exit 1
  fi
  if [ -s "$TMP_ROOT/git.log" ]; then
    echo "test-require-exact-repository-main: invoked git for unsafe repository" >&2
    exit 1
  fi
done
if FAKE_GIT_LOG="$TMP_ROOT/git.log" PATH="$TMP_ROOT/bin:$PATH" bash "$CHECK" \
    --repository Kandelo-dev/sample-tap-core \
    --source-sha 3333333333333333333333333333333333333333 \
    >/dev/null 2>&1; then
  echo "test-require-exact-repository-main: accepted stale main" >&2
  exit 1
fi

echo "test-require-exact-repository-main.sh: ok"
