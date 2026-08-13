#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
CLASSIFIER="$SCRIPT_DIR/classify-exact-abi-staging.sh"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  chmod -R u+rwX "$TMP_ROOT" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "test-classify-exact-abi-staging: $*" >&2
  exit 1
}

expect_failure() {
  local label="$1"
  shift
  local output="$TMP_ROOT/failure-output"
  rm -f "$output"
  if "$@" --github-output "$output" >"$TMP_ROOT/failure.stdout" \
    2>"$TMP_ROOT/failure.stderr"; then
    fail "$label unexpectedly succeeded"
  fi
  [ ! -e "$output" ] || [ ! -s "$output" ] ||
    fail "$label wrote outputs before failing"
}

git_identity() {
  git -C "$1" config user.name "Kandelo Test"
  git -C "$1" config user.email "kandelo-test@example.invalid"
}

AUTHORITY="$TMP_ROOT/authority"
EXACT_HEAD="$TMP_ROOT/exact-head"
mkdir -p "$AUTHORITY" "$EXACT_HEAD"
git init -q "$AUTHORITY"
git init -q "$EXACT_HEAD"
git_identity "$AUTHORITY"
git_identity "$EXACT_HEAD"

mkdir -p \
  "$AUTHORITY/abi/staging" \
  "$AUTHORITY/scripts" \
  "$AUTHORITY/tools/xtask/src"
printf 'fixture\n' >"$AUTHORITY/tools/xtask/src/main.rs"
printf '%s\n' \
  'schema = 1' \
  'kind = "kandelo-abi-staging-required-check-activation"' \
  'mode = "enforce"' \
  >"$AUTHORITY/abi/staging/required-check-activation.toml"

cat >"$AUTHORITY/scripts/test-xtask-fixture" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ge 3 ] && [ "$1 $2 $3" = "abi-staging request classify" ]; then
  [ "${FAIL_CLASSIFY:-0}" = 0 ] || exit 97
  [ "$#" -eq 7 ] && [ "$4" = --changed-paths ] && [ "$6" = --out ] || exit 2
  python3 - "$5" "$7" <<'PY'
import json
import os
import pathlib
import sys

body = pathlib.Path(sys.argv[1]).read_bytes()
malformed = os.environ.get("MALFORM_DIFF")
if malformed == "missing":
    body = b""
elif malformed == "duplicate":
    body = b"abi/change.txt\0abi/change.txt\0"
elif malformed == "extra":
    body = b"abi/change.txt\0\0"
elif malformed == "non-nul":
    body = b"abi/change.txt"
if not body or not body.endswith(b"\0"):
    raise SystemExit(2)
raw_paths = body[:-1].split(b"\0")
if any(not path for path in raw_paths) or len(set(raw_paths)) != len(raw_paths):
    raise SystemExit(2)
paths = [path.decode("utf-8") for path in raw_paths]
if any(path.startswith("/") or ".." in path.split("/") for path in paths):
    raise SystemExit(2)
classes = set()
for path in paths:
    if path.startswith("abi/") or path.startswith("crates/shared/"):
        classes.add("abi")
    if path.startswith("crates/kernel/") or path.startswith("libc/"):
        classes.add("kernel")
    if path.startswith("host/"):
        classes.add("host")
pathlib.Path(sys.argv[2]).write_text(
    json.dumps(sorted(classes), separators=(",", ":"))
)
PY
  exit 0
fi

if [ "$#" -eq 5 ] && \
  [ "$1 $2 $3 $4" = "abi-staging check-projection activation-mode --activation" ]; then
  [ ! -L "$5" ] && [ -f "$5" ] || exit 2
  case "$(cat "$5")" in
    $'schema = 1\nkind = "kandelo-abi-staging-required-check-activation"\nmode = "observe"')
      printf 'observe\n'
      ;;
    $'schema = 1\nkind = "kandelo-abi-staging-required-check-activation"\nmode = "enforce"')
      printf 'enforce\n'
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi

exit 2
FIXTURE
chmod 0755 "$AUTHORITY/scripts/test-xtask-fixture"

cat >"$AUTHORITY/scripts/dev-shell.sh" <<'DEV_SHELL'
#!/usr/bin/env bash
set -euo pipefail
# Model the real dev shell's --ignore-environment boundary. Build-control
# values survive only when the protected caller passes them to the command
# inside the shell.
unset CARGO_TARGET_DIR
if [ "$#" -eq 2 ] && [ "$1" = rustc ] && [ "$2" = -vV ]; then
  printf 'host: fixture-host\n'
  exit 0
fi
if [ "$#" -ge 2 ] && [ "$1" = env ] && \
  [[ "$2" == CARGO_TARGET_DIR=* ]]; then
  export CARGO_TARGET_DIR="${2#CARGO_TARGET_DIR=}"
  shift 2
fi
if [ "$#" -ge 4 ] && [ "$1 $2 $3" = "cargo build -p" ] && [ "$4" = xtask ]; then
  target_root="${CARGO_TARGET_DIR:-target}"
  mkdir -p "$target_root/fixture-host/debug"
  cp scripts/test-xtask-fixture "$target_root/fixture-host/debug/xtask"
  chmod 0755 "$target_root/fixture-host/debug/xtask"
  exit 0
fi
exit 2
DEV_SHELL
chmod 0755 "$AUTHORITY/scripts/dev-shell.sh"

git -C "$AUTHORITY" add .
git -C "$AUTHORITY" commit -q -m "enforced authority"
ENFORCE_AUTHORITY="$(git -C "$AUTHORITY" rev-parse HEAD)"
sed -i.bak 's/mode = "enforce"/mode = "observe"/' \
  "$AUTHORITY/abi/staging/required-check-activation.toml"
rm "$AUTHORITY/abi/staging/required-check-activation.toml.bak"
git -C "$AUTHORITY" add abi/staging/required-check-activation.toml
git -C "$AUTHORITY" commit -q -m "observe authority"
OBSERVE_AUTHORITY="$(git -C "$AUTHORITY" rev-parse HEAD)"
git -C "$AUTHORITY" checkout -q "$ENFORCE_AUTHORITY"

printf 'base\n' >"$EXACT_HEAD/README.md"
git -C "$EXACT_HEAD" add README.md
git -C "$EXACT_HEAD" commit -q -m base
BASE="$(git -C "$EXACT_HEAD" rev-parse HEAD)"

git -C "$EXACT_HEAD" checkout -q -b abi-change "$BASE"
mkdir -p "$EXACT_HEAD/abi"
printf 'abi\n' >"$EXACT_HEAD/abi/change.txt"
git -C "$EXACT_HEAD" add abi/change.txt
git -C "$EXACT_HEAD" commit -q -m abi
ABI_HEAD="$(git -C "$EXACT_HEAD" rev-parse HEAD)"

git -C "$EXACT_HEAD" checkout -q -b kernel-change "$BASE"
mkdir -p "$EXACT_HEAD/crates/kernel"
printf 'kernel\n' >"$EXACT_HEAD/crates/kernel/change.rs"
git -C "$EXACT_HEAD" add crates/kernel/change.rs
git -C "$EXACT_HEAD" commit -q -m kernel
KERNEL_HEAD="$(git -C "$EXACT_HEAD" rev-parse HEAD)"

git -C "$EXACT_HEAD" checkout -q -b package-change "$BASE"
mkdir -p "$EXACT_HEAD/packages/registry/example"
printf 'package\n' >"$EXACT_HEAD/packages/registry/example/package.toml"
git -C "$EXACT_HEAD" add packages/registry/example/package.toml
git -C "$EXACT_HEAD" commit -q -m package
PACKAGE_HEAD="$(git -C "$EXACT_HEAD" rev-parse HEAD)"

run_classifier() {
  local head="$1" raw="$2" output="$3"
  rm -f "$output"
  "$CLASSIFIER" \
    --authority-root "$AUTHORITY" \
    --exact-head-root "$EXACT_HEAD" \
    --base "$BASE" \
    --head "$head" \
    --raw-package-staging-required "$raw" \
    --github-output "$output"
}

assert_output() {
  local output="$1" exact="$2" legacy="$3" reason="$4"
  grep -Fx "exact_abi_staging_applicable=$exact" "$output" >/dev/null ||
    fail "exact ABI output differs"
  grep -Fx "legacy_package_staging_required=$legacy" "$output" >/dev/null ||
    fail "legacy package output differs"
  grep -Fx "exact_abi_staging_reason=$reason" "$output" >/dev/null ||
    fail "exact ABI reason differs"
  [ "$(wc -l <"$output" | tr -d ' ')" = 3 ] ||
    fail "classifier wrote an unexpected output"
}

OUTPUT="$TMP_ROOT/output"
run_classifier "$ABI_HEAD" true "$OUTPUT"
assert_output "$OUTPUT" true false abi-enforced-candidate-bottles

git -C "$AUTHORITY" checkout -q "$OBSERVE_AUTHORITY"
run_classifier "$ABI_HEAD" true "$OUTPUT"
assert_output "$OUTPUT" false true abi-required-check-observe

git -C "$AUTHORITY" checkout -q "$ENFORCE_AUTHORITY"
run_classifier "$KERNEL_HEAD" false "$OUTPUT"
assert_output "$OUTPUT" false false no-abi-classified-change
run_classifier "$PACKAGE_HEAD" true "$OUTPUT"
assert_output "$OUTPUT" false true no-abi-classified-change

common_args=(
  "$CLASSIFIER"
  --authority-root "$AUTHORITY"
  --exact-head-root "$EXACT_HEAD"
  --base "$BASE"
  --head "$ABI_HEAD"
  --raw-package-staging-required true
)

expect_failure "invalid boolean" \
  "$CLASSIFIER" \
  --authority-root "$AUTHORITY" \
  --exact-head-root "$EXACT_HEAD" \
  --base "$BASE" \
  --head "$ABI_HEAD" \
  --raw-package-staging-required yes
expect_failure "unavailable head" \
  "$CLASSIFIER" \
  --authority-root "$AUTHORITY" \
  --exact-head-root "$EXACT_HEAD" \
  --base "$BASE" \
  --head 0000000000000000000000000000000000000000 \
  --raw-package-staging-required true
expect_failure "relative authority" \
  "$CLASSIFIER" \
  --authority-root relative \
  --exact-head-root "$EXACT_HEAD" \
  --base "$BASE" \
  --head "$ABI_HEAD" \
  --raw-package-staging-required true
expect_failure "unknown flag" "${common_args[@]}" --unknown value

printf 'dirty\n' >>"$AUTHORITY/tools/xtask/src/main.rs"
expect_failure "dirty authority" "${common_args[@]}"
git -C "$AUTHORITY" checkout -q -- tools/xtask/src/main.rs

git -C "$AUTHORITY" checkout -q -b symlink-activation "$ENFORCE_AUTHORITY"
rm "$AUTHORITY/abi/staging/required-check-activation.toml"
ln -s /etc/passwd "$AUTHORITY/abi/staging/required-check-activation.toml"
git -C "$AUTHORITY" add abi/staging/required-check-activation.toml
git -C "$AUTHORITY" commit -q -m "symlink activation"
expect_failure "symlink activation" "${common_args[@]}"
git -C "$AUTHORITY" checkout -q "$ENFORCE_AUTHORITY"

for malformed in missing duplicate extra non-nul; do
  expect_failure "$malformed changed-path inventory" \
    env MALFORM_DIFF="$malformed" "${common_args[@]}"
done
expect_failure "classifier failure" env FAIL_CLASSIFY=1 "${common_args[@]}"

echo "test-classify-exact-abi-staging: ok"
