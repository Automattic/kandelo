#!/usr/bin/env bash
# shellcheck disable=SC2329 # Test fixtures are invoked through extracted helper names.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREPARE_WORKFLOW="$REPO_ROOT/.github/workflows/prepare-merge.yml"
INDEX_UPDATE_SCRIPT="$REPO_ROOT/scripts/index-update.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "prepare-merge retry contract: $*" >&2
  exit 1
}

# Execute the publication helpers from their authoritative source. A
# source-text assertion would miss the shell rule that caused this regression:
# after a failed `if` with no else branch, `$?` describes the compound `if`,
# not its condition.
python3 - "$PREPARE_WORKFLOW" "$INDEX_UPDATE_SCRIPT" "$TMP_ROOT" <<'PY'
import re
import sys
from pathlib import Path

sources = [Path(argument) for argument in sys.argv[1:-1]]
output_dir = Path(sys.argv[-1])
start_pattern = re.compile(
    r"^(?P<indent> *)(?P<name>[A-Za-z_][A-Za-z0-9_]*retry[A-Za-z0-9_]*)\(\) \{$"
)
definitions: list[tuple[str, str, list[str]]] = []

for source in sources:
    lines = source.read_text(encoding="utf-8").splitlines()
    line_index = 0
    while line_index < len(lines):
        match = start_pattern.fullmatch(lines[line_index])
        if match is None:
            line_index += 1
            continue

        indent = match.group("indent")
        name = match.group("name")
        body: list[str] = []
        while line_index < len(lines):
            line = lines[line_index]
            if line == "":
                unindented = ""
            elif line.startswith(indent):
                unindented = line[len(indent) :]
            else:
                raise SystemExit(f"{source}:{name}: malformed indentation")
            body.append(unindented)
            line_index += 1
            if unindented == "}":
                break
        else:
            raise SystemExit(f"{source}:{name}: unterminated function")
        definitions.append((source.name, name, body))

manifest = output_dir / "definitions.tsv"
with manifest.open("w", encoding="utf-8") as stream:
    for index, (source_name, name, body) in enumerate(definitions, start=1):
        definition = output_dir / f"{index:02d}-{name}.sh"
        definition.write_text("\n".join(body) + "\n", encoding="utf-8")
        stream.write(f"{source_name}:{name}\t{name}\t{definition}\n")
PY

run_retry_contract() (
  set -euo pipefail
  local helper_label="$1"
  local helper_name="$2"
  local definition="$3"
  local expected_attempts="$4"
  local output_stem
  output_stem="$(basename "$definition")"
  local stdout_file="$TMP_ROOT/${output_stem}-stdout"
  local stderr_file="$TMP_ROOT/${output_stem}-stderr"
  local rc
  local call_count=0
  local expected_terminal_status

  # Avoid real exponential waits while preserving the helper control flow.
  sleep() {
    :
  }

  if [ "$helper_name" = "git_fetch_retry" ]; then
    # git_fetch_retry fixes the command prefix to `git fetch`; this shim lets
    # the same behavioral fixture control only the fetch operation.
    git() {
      [ "${1:-}" = "fetch" ] || return 91
      shift
      "$@"
    }
  fi

  # shellcheck source=/dev/null
  source "$definition"

  always_fail() {
    call_count=$((call_count + 1))
    printf 'failure-stdout-%s\n' "$call_count"
    printf 'failure-stderr-%s\n' "$call_count" >&2
    return $((20 + call_count))
  }

  set +e
  "$helper_name" always_fail >"$stdout_file" 2>"$stderr_file"
  rc=$?
  set -e
  expected_terminal_status=$((20 + expected_attempts))
  [ "$rc" -eq "$expected_terminal_status" ] ||
    fail "$helper_label converted terminal status $expected_terminal_status into status $rc"
  [ "$call_count" -eq "$expected_attempts" ] ||
    fail "$helper_label attempted a terminal failure $call_count times, expected $expected_attempts"
  grep -Fxq "failure-stderr-$expected_attempts" "$stderr_file" ||
    fail "$helper_label did not preserve the terminal attempt's stderr"
  if [ "$helper_name" = "gh_retry" ]; then
    [ ! -s "$stdout_file" ] ||
      fail "$helper_label leaked failed-command output onto stdout"
    grep -Fxq "failure-stdout-$expected_attempts" "$stderr_file" ||
      fail "$helper_label did not route terminal failed-command stdout to diagnostics"
    if grep -Fq "failure-stdout-1" "$stderr_file"; then
      fail "$helper_label retained stale stdout from an earlier failed attempt"
    fi
  else
    grep -Fxq "failure-stdout-$expected_attempts" "$stdout_file" ||
      fail "$helper_label did not preserve terminal git fetch stdout"
  fi

  call_count=0
  succeeds_after_retry() {
    call_count=$((call_count + 1))
    if [ "$call_count" -lt 3 ]; then
      return 17
    fi
    printf '%s\n' "success-after-retry"
  }

  "$helper_name" succeeds_after_retry >"$stdout_file" 2>"$stderr_file" ||
    fail "$helper_label did not return success after a successful retry"
  [ "$call_count" -eq 3 ] ||
    fail "$helper_label stopped after $call_count attempts instead of the third-attempt success"
  [ "$(cat "$stdout_file")" = "success-after-retry" ] ||
    fail "$helper_label did not preserve successful command output"
)

definition_count=0
git_fetch_retry_count=0
gh_retry_count=0
while IFS=$'\t' read -r helper_label helper_name definition; do
  case "$helper_name" in
    git_fetch_retry)
      expected_attempts=5
      git_fetch_retry_count=$((git_fetch_retry_count + 1))
      ;;
    gh_retry)
      expected_attempts=4
      gh_retry_count=$((gh_retry_count + 1))
      ;;
    *)
      fail "new publication retry helper $helper_label needs an explicit behavioral contract"
      ;;
  esac
  run_retry_contract "$helper_label" "$helper_name" "$definition" "$expected_attempts"
  definition_count=$((definition_count + 1))
done <"$TMP_ROOT/definitions.tsv"

[ "$definition_count" -eq 5 ] ||
  fail "audited $definition_count publication retry helpers, expected 5"
[ "$git_fetch_retry_count" -eq 1 ] ||
  fail "audited $git_fetch_retry_count git_fetch_retry definitions, expected 1"
[ "$gh_retry_count" -eq 4 ] ||
  fail "audited $gh_retry_count gh_retry definitions, expected 4"

echo "publication retry contract: all helpers passed"
