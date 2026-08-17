#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "test-seal-homebrew-formula-checker: $*" >&2
  exit 1
}

root="$TMP_ROOT/kandelo"
release="$root/target/x86_64-unknown-linux-gnu/release"
deps="$release/deps"
mkdir -p "$deps"
artifact="$deps/xtask-0123456789abcdef"
checker="$release/xtask"
cat >"$artifact" <<'EOF'
#!/usr/bin/env bash
printf 'sealed checker\n'
EOF
chmod 0755 "$artifact"
ln "$artifact" "$checker"
[ "$(stat -c '%h' "$artifact")" = "2" ] ||
  fail "fixture does not model Cargo's Linux hardlink"
source_sha256="$(sha256sum "$artifact" | awk '{print $1}')"

reported="$(
  bash "$REPO_ROOT/scripts/seal-homebrew-formula-checker.sh" \
    --root "$root" \
    --checker "$checker"
)"
[ "$reported" = "$checker" ] ||
  fail "sealer did not report the exact checker"
[ "$(stat -c '%h:%a' "$checker")" = "1:555" ] ||
  fail "sealed checker is not one read-only inode"
[ "$(stat -c '%h' "$artifact")" = "1" ] ||
  fail "Cargo artifact retained the sealed checker inode"
[ "$(stat -c '%d:%i' "$artifact")" != "$(stat -c '%d:%i' "$checker")" ] ||
  fail "sealed checker still aliases Cargo's deps artifact"
[ "$(sha256sum "$checker" | awk '{print $1}')" = "$source_sha256" ] ||
  fail "sealed checker bytes differ from Cargo's output"
printf 'changed deps artifact\n' >"$artifact"
[ "$(sha256sum "$checker" | awk '{print $1}')" = "$source_sha256" ] ||
  fail "Cargo's alternate path can mutate the sealed checker"

# A batched local build can run trusted Cargo tooling between Formulae. Model
# Cargo rematerializing the same authenticated bytes as its normal 0755,
# two-link release output, then require the shared sealer to restore the exact
# next-Formula boundary without accepting changed bytes.
rm "$artifact"
cp "$checker" "$artifact"
chmod 0755 "$artifact"
rm "$checker"
ln "$artifact" "$checker"
[ "$(stat -c '%h:%a' "$checker")" = "2:755" ] ||
  fail "second-Formula fixture did not recreate Cargo's release output"
[ "$(sha256sum "$checker" | awk '{print $1}')" = "$source_sha256" ] ||
  fail "second-Formula fixture changed the authenticated checker bytes"
reported="$(
  bash "$REPO_ROOT/scripts/seal-homebrew-formula-checker.sh" \
    --root "$root" \
    --checker "$checker"
)"
[ "$reported" = "$checker" ] ||
  fail "second-Formula sealer did not report the exact checker"
[ "$(stat -c '%h:%a' "$checker")" = "1:555" ] ||
  fail "second-Formula checker is not one read-only inode"
[ "$(sha256sum "$checker" | awk '{print $1}')" = "$source_sha256" ] ||
  fail "second-Formula checker changed after resealing"

unsafe="$root/target/unsafe/release/xtask"
mkdir -p "${unsafe%/*}"
cp "$checker" "$unsafe"
chmod 0777 "$unsafe"
if bash "$REPO_ROOT/scripts/seal-homebrew-formula-checker.sh" \
    --root "$root" --checker "$unsafe" >/dev/null 2>&1; then
  fail "sealer accepted a writable source checker"
fi

misplaced="$root/target/x86_64-unknown-linux-gnu/xtask"
cp "$checker" "$misplaced"
if bash "$REPO_ROOT/scripts/seal-homebrew-formula-checker.sh" \
    --root "$root" --checker "$misplaced" >/dev/null 2>&1; then
  fail "sealer accepted a checker outside the exact release path"
fi

occupied="$root/target/occupied/release/xtask"
mkdir -p "${occupied%/*}"
cp "$checker" "$occupied"
printf 'occupied\n' >"$occupied.formula-seal"
if bash "$REPO_ROOT/scripts/seal-homebrew-formula-checker.sh" \
    --root "$root" --checker "$occupied" >/dev/null 2>&1; then
  fail "sealer overwrote an occupied seal destination"
fi

echo "test-seal-homebrew-formula-checker.sh: ok"
