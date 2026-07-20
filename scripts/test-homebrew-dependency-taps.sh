#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PRIMARY="$TMP_ROOT/primary"
CORE="$TMP_ROOT/core"
mkdir -p "$PRIMARY/Formula" "$PRIMARY/Kandelo" "$CORE/Formula"
cat >"$PRIMARY/Formula/m4.rb" <<'RUBY'
class M4 < Formula
end
RUBY
cat >"$CORE/Formula/dash.rb" <<'RUBY'
class Dash < Formula
end
RUBY

for repository in "$PRIMARY" "$CORE"; do
  git -C "$repository" init -q
  git -C "$repository" config user.email test@example.invalid
  git -C "$repository" config user.name Test
  git -C "$repository" add .
  git -C "$repository" commit -qm fixture
done
PRIMARY_SHA="$(git -C "$PRIMARY" rev-parse HEAD)"
CORE_SHA="$(git -C "$CORE" rev-parse HEAD)"

cat >"$PRIMARY/Kandelo/dependency-taps.json" <<JSON
{
  "schema": 1,
  "taps": [
    {
      "tap_name": "kandelo-dev/tap-core",
      "tap_repository": "kandelo-dev/homebrew-tap-core",
      "tap_commit": "$CORE_SHA"
    }
  ]
}
JSON
git -C "$PRIMARY" add Kandelo/dependency-taps.json
git -C "$PRIMARY" commit -qm lock
PRIMARY_SHA="$(git -C "$PRIMARY" rev-parse HEAD)"

validator="$REPO_ROOT/scripts/homebrew-dependency-taps.py"
validated="$TMP_ROOT/validated.json"
python3 "$validator" validate \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  --out "$validated"
jq -e --arg commit "$CORE_SHA" '
  . == {
    schema: 1,
    taps: [{
      tap_commit: $commit,
      tap_name: "kandelo-dev/tap-core",
      tap_repository: "kandelo-dev/homebrew-tap-core"
    }]
  }
' "$validated" >/dev/null

resolved="$TMP_ROOT/resolved.json"
python3 "$validator" resolve \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  --tap-commit "$PRIMARY_SHA" \
  --dependency-root "kandelo-dev/tap-core=$CORE" \
  --out "$resolved"
[ "$(stat -f '%Lp' "$resolved" 2>/dev/null || stat -c '%a' "$resolved")" = "444" ]
jq -e --arg primary "$PRIMARY_SHA" --arg core "$CORE_SHA" \
  --arg primary_root "$(cd "$PRIMARY" && pwd -P)" --arg core_root "$(cd "$CORE" && pwd -P)" '
    .schema == 1 and
    .primary == {
      root: $primary_root,
      tap_commit: $primary,
      tap_name: "acme/tools",
      tap_repository: "acme/homebrew-tools"
    } and
    .dependencies == [{
      root: $core_root,
      tap_commit: $core,
      tap_name: "kandelo-dev/tap-core",
      tap_repository: "kandelo-dev/homebrew-tap-core"
    }]
  ' "$resolved" >/dev/null

if python3 "$validator" resolve \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  --tap-commit "$PRIMARY_SHA" \
  --out "$TMP_ROOT/missing.json" 2>"$TMP_ROOT/missing.err"; then
  echo "test-homebrew-dependency-taps.sh: accepted a missing locked checkout" >&2
  exit 1
fi
grep -F 'checkout set differs from the committed lock' "$TMP_ROOT/missing.err" >/dev/null

cat >"$CORE/dirty" <<'EOF'
dirty
EOF
git -C "$CORE" add dirty
if python3 "$validator" resolve \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  --tap-commit "$PRIMARY_SHA" \
  --dependency-root "kandelo-dev/tap-core=$CORE" \
  --out "$TMP_ROOT/dirty.json" 2>"$TMP_ROOT/dirty.err"; then
  echo "test-homebrew-dependency-taps.sh: accepted a modified dependency checkout" >&2
  exit 1
fi
grep -F 'has local modifications' "$TMP_ROOT/dirty.err" >/dev/null
git -C "$CORE" reset -q HEAD dirty
rm "$CORE/dirty"

printf 'untracked\n' >"$CORE/untracked"
if python3 "$validator" resolve \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  --tap-commit "$PRIMARY_SHA" \
  --dependency-root "kandelo-dev/tap-core=$CORE" \
  --out "$TMP_ROOT/untracked.json" 2>"$TMP_ROOT/untracked.err"; then
  echo "test-homebrew-dependency-taps.sh: accepted an untracked dependency checkout" >&2
  exit 1
fi
grep -F 'has local modifications' "$TMP_ROOT/untracked.err" >/dev/null
rm "$CORE/untracked"

python3 - "$PRIMARY/Kandelo/dependency-taps.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["taps"][0]["tap_commit"] = "main"
path.write_text(json.dumps(value) + "\n")
PY
if python3 "$validator" validate \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  >"$TMP_ROOT/mutable.out" 2>"$TMP_ROOT/mutable.err"; then
  echo "test-homebrew-dependency-taps.sh: accepted a mutable dependency tap revision" >&2
  exit 1
fi
grep -F 'tap_commit must be an exact lowercase SHA' "$TMP_ROOT/mutable.err" >/dev/null

python3 - "$PRIMARY/Kandelo/dependency-taps.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["taps"][0]["tap_commit"] = "0000000000000000000000000000000000000000"
value["taps"][0]["tap_name"] = "other/tools"
value["taps"][0]["tap_repository"] = "other/homebrew-tools"
path.write_text(json.dumps(value) + "\n")
PY
if python3 "$validator" validate \
  --tap-root "$PRIMARY" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  >"$TMP_ROOT/unreviewed.out" 2>"$TMP_ROOT/unreviewed.err"; then
  echo "test-homebrew-dependency-taps.sh: accepted an unreviewed dependency tap" >&2
  exit 1
fi
grep -F 'is not in the reviewed public-tap policy' "$TMP_ROOT/unreviewed.err" >/dev/null

SYMLINK_TAP="$TMP_ROOT/symlink-tap"
mkdir -p "$SYMLINK_TAP/Formula"
ln -s "$PRIMARY/Kandelo" "$SYMLINK_TAP/Kandelo"
if python3 "$validator" validate \
  --tap-root "$SYMLINK_TAP" \
  --tap-name acme/tools \
  --tap-repository acme/homebrew-tools \
  >"$TMP_ROOT/symlink.out" 2>"$TMP_ROOT/symlink.err"; then
  echo "test-homebrew-dependency-taps.sh: accepted a symlinked policy directory" >&2
  exit 1
fi
grep -F 'policy directory must not be a symlink' "$TMP_ROOT/symlink.err" >/dev/null

echo "test-homebrew-dependency-taps.sh: passed"
