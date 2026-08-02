#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "test-publish-homebrew-closed-selection-release.sh: $*" >&2
  exit 1
}

tool_root="$TEST_ROOT/tools"
prepared="$TEST_ROOT/prepared"
lock_root="$TEST_ROOT/lock"
receipt="$TEST_ROOT/receipt.json"
mkdir -p "$tool_root" "$prepared/assets" "$lock_root"
cp "$REPO_ROOT/scripts/publish-homebrew-closed-selection-release.sh" \
  "$tool_root/"

cat >"$prepared/assets/closed-selection.json" <<'JSON'
{
  "selection_manifest": {
    "value": {
      "campaign": {
        "kandelo_commit": "1111111111111111111111111111111111111111"
      },
      "roots": [
        "bash"
      ],
      "tap": {
        "prepared_tree_git_oid": "3333333333333333333333333333333333333333",
        "repository": "kandelo-dev/homebrew-tap-core",
        "source_commit": "2222222222222222222222222222222222222222"
      }
    }
  }
}
JSON
printf 'deterministic archive fixture\n' \
  >"$prepared/assets/closed-selection.zip"
cat >"$prepared/release-manifest.json" <<'JSON'
{
  "repository": "kandelo-dev/homebrew-tap-core",
  "tag": "homebrew-prefix-selection-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
JSON

cat >"$tool_root/homebrew-prefix-campaign-executor.py" <<'PY'
#!/usr/bin/env python3
import json
import os
import pathlib
import shutil
import sys

args = sys.argv[1:]
command = args[0]


def value(flag):
    return pathlib.Path(args[args.index(flag) + 1])


if command == "snapshot-selection-release":
    shutil.copytree(value("--prepared-release"), value("--out"))
elif command == "fetch-selection-release":
    state = pathlib.Path(os.environ["FAKE_READBACK_STATE"])
    attempt = int(state.read_text()) if state.exists() else 0
    state.write_text(str(attempt + 1))
    prepared = pathlib.Path(os.environ["FAKE_PREPARED_RELEASE"])
    descriptor = json.loads(
        (prepared / "assets/closed-selection.json").read_text()
    )
    selection = descriptor["selection_manifest"]["value"]
    if attempt == 0:
        selection = json.loads(json.dumps(selection))
        selection["roots"] = ["substituted"]
    output = value("--out")
    output.mkdir()
    (output / "selection.json").write_text(
        json.dumps(selection, indent=2, sort_keys=True) + "\n"
    )
    receipt = {
        "prepared_tree_git_oid": selection["tap"][
            "prepared_tree_git_oid"
        ]
    }
    value("--receipt-out").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    )
else:
    raise SystemExit(f"unexpected executor command: {command}")
PY

cat >"$tool_root/homebrew-closed-selection-controller.py" <<'PY'
#!/usr/bin/env python3
import sys

required = {
    "--selection-plan",
    "--selection-plan-sha256",
    "--prepared-release",
    "--executor",
}
if sys.argv[1] != "verify" or not required.issubset(sys.argv):
    raise SystemExit("controller did not receive the bound plan contract")
PY

cat >"$tool_root/publish-immutable-github-release.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
required=(
  --exact-execution-kandelo-main-sha
  --exact-execution-target-main-sha
  --kandelo-main-contains-sha
  --target-main-contains-sha
)
for flag in "${required[@]}"; do
  [[ " $* " == *" $flag "* ]] || {
    echo "missing dual authority $flag" >&2
    exit 2
  }
done
while [ "$#" -gt 0 ]; do
  case "$1" in
    --receipt) receipt="$2"; shift 2 ;;
    *) shift 2 ;;
  esac
done
printf '{"status":"success"}\n' >"$receipt"
printf 'published\n' >>"$FAKE_PUBLICATION_LOG"
SH
chmod +x "$tool_root"/*

run_wrapper() {
  FAKE_PREPARED_RELEASE="$prepared" \
  FAKE_READBACK_STATE="$TEST_ROOT/readback-state" \
  FAKE_PUBLICATION_LOG="$TEST_ROOT/publication.log" \
  GITHUB_REPOSITORY=Kandelo-dev/homebrew-tap-core \
    bash "$tool_root/publish-homebrew-closed-selection-release.sh" \
      --prepared-release "$prepared" \
      --lock-root "$lock_root" \
      --receipt "$receipt" \
      --selection-plan '{"fixture":true}' \
      --selection-plan-sha256 \
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --exact-execution-kandelo-main-sha \
        4444444444444444444444444444444444444444 \
      --exact-execution-target-main-sha \
        5555555555555555555555555555555555555555 \
      --kandelo-main-contains-sha \
        1111111111111111111111111111111111111111 \
      --target-main-contains-sha \
        2222222222222222222222222222222222222222
}

if run_wrapper >"$TEST_ROOT/first.out" 2>"$TEST_ROOT/first.err"; then
  fail "semantic readback substitution was accepted"
fi
[ ! -e "$receipt" ] ||
  fail "failed semantic readback exposed a success receipt"
[ "$(wc -l <"$TEST_ROOT/publication.log" | tr -d '[:space:]')" = 1 ] ||
  fail "first attempt did not reach the already durable publication"

run_wrapper >/dev/null
[ -s "$receipt" ] ||
  fail "unchanged retry did not install the verified readback receipt"
[ "$(wc -l <"$TEST_ROOT/publication.log" | tr -d '[:space:]')" = 2 ] ||
  fail "retry did not reconcile through the publisher"

echo "test-publish-homebrew-closed-selection-release.sh: ok"
