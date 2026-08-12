#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRITER="$REPO_ROOT/scripts/write-dev-shell-host-target.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-host-target.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

if [ ! -f "$WRITER" ]; then
  echo "test-write-dev-shell-host-target: protected writer is absent" >&2
  exit 1
fi

mkdir -p "$TEST_ROOT/bin"
cat >"$TEST_ROOT/bin/rustc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = -vV ]
printf 'rustc 1.0.0\nhost: test-host_1.0\n'
EOF
chmod +x "$TEST_ROOT/bin/rustc"

target_file="$(mktemp "$TEST_ROOT/target.XXXXXX")"
writer_output="$(
  PATH="$TEST_ROOT/bin:$PATH" \
    bash "$WRITER" --out "$target_file"
)"
[ "$(cat "$target_file")" = test-host_1.0 ]
if [[ "$writer_output" == *test-host_1.0* ]]; then
  echo "test-write-dev-shell-host-target: machine data leaked to stdout" >&2
  exit 1
fi

ln -s "$target_file" "$TEST_ROOT/symlink-target"
if PATH="$TEST_ROOT/bin:$PATH" \
    bash "$WRITER" --out "$TEST_ROOT/symlink-target" >/dev/null 2>&1
then
  echo "test-write-dev-shell-host-target: symlink output was accepted" >&2
  exit 1
fi

cat >"$TEST_ROOT/bin/rustc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = -vV ]
printf 'rustc 1.0.0\nhost: invalid target\n'
EOF
chmod +x "$TEST_ROOT/bin/rustc"
if PATH="$TEST_ROOT/bin:$PATH" \
    bash "$WRITER" --out "$target_file" >/dev/null 2>&1
then
  echo "test-write-dev-shell-host-target: invalid target was accepted" >&2
  exit 1
fi

echo "test-write-dev-shell-host-target: ok"
