#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
TMPDIR="$(cd "$TMPDIR" && pwd -P)"
. "$REPO_ROOT/scripts/homebrew-patched-launcher.sh"

cleanup() {
  homebrew_patched_launcher_cleanup
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

fail() {
  echo "test-homebrew-patched-launcher.sh: $*" >&2
  exit 1
}

prefix="$TMPDIR/prefix"
patch_file="$TMPDIR/marker.patch"
work_dir="$TMPDIR/work"
mkdir -p "$prefix/bin" "$work_dir"

cat >"$prefix/bin/brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

brew_file="$(cd "${0%/*}" && pwd -P)/${0##*/}"
prefix="${brew_file%/*/*}"
repository="$prefix"
if [ -L "$brew_file" ]; then
  target="$(readlink "$brew_file")"
  target_dirname="$(dirname "$target")"
  if [[ "$target_dirname" = /* ]]; then
    target_dir="$(cd "$target_dirname" && pwd -P)"
  else
    target_dir="$(cd "$(dirname "$brew_file")/$target_dirname" && pwd -P)"
  fi
  repository="${target_dir%/*}"
fi

case "${1:-}" in
  --prefix)
    if [ "$#" -eq 2 ]; then
      printf '%s/opt/%s\n' "$prefix" "$2"
    elif [ -L "$brew_file" ] && [ "${FAKE_BREW_BAD_PREFIX:-}" = "1" ]; then
      printf '%s/bad\n' "$prefix"
    else
      printf '%s\n' "$prefix"
    fi
    ;;
  --cellar) printf '%s/Cellar\n' "$prefix" ;;
  --repository) printf '%s\n' "$repository" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$prefix/bin/brew"
printf 'unpatched\n' >"$prefix/marker.txt"

git -C "$prefix" init -q
git -C "$prefix" config user.name "Kandelo Test"
git -C "$prefix" config user.email "kandelo-test@example.invalid"
git -C "$prefix" add .
git -C "$prefix" commit -q -m "fixture"

cat >"$patch_file" <<'EOF'
diff --git a/marker.txt b/marker.txt
index 5742de9..a95d2c7 100644
--- a/marker.txt
+++ b/marker.txt
@@ -1 +1 @@
-unpatched
+patched
EOF

homebrew_patched_launcher_prepare "$prefix/bin/brew" "$patch_file" "$work_dir"

[ "$HOMEBREW_PATCHED_PREFIX" = "$prefix" ] || fail "selected prefix changed"
[ "$($HOMEBREW_PATCHED_BREW_BIN --prefix)" = "$prefix" ] || fail "launcher reports the wrong prefix"
[ "$($HOMEBREW_PATCHED_BREW_BIN --cellar)" = "$prefix/Cellar" ] || fail "launcher reports the wrong Cellar"
[ "$($HOMEBREW_PATCHED_BREW_BIN --prefix cmake)" = "$prefix/opt/cmake" ] ||
  fail "launcher moved a core dependency prefix"
[ "$($HOMEBREW_PATCHED_BREW_BIN --repository)" = "$HOMEBREW_PATCHED_OVERLAY" ] ||
  fail "launcher reports the wrong repository"
[ "$(cat "$prefix/marker.txt")" = "unpatched" ] || fail "original repository was modified"
[ "$(cat "$HOMEBREW_PATCHED_OVERLAY/marker.txt")" = "patched" ] || fail "overlay patch was not applied"
[ -L "$HOMEBREW_PATCHED_LAUNCHER" ] || fail "launcher symlink was not created"

launcher="$HOMEBREW_PATCHED_LAUNCHER"
overlay="$HOMEBREW_PATCHED_OVERLAY"
homebrew_patched_launcher_cleanup
[ ! -e "$launcher" ] || fail "launcher symlink was not removed"
[ ! -e "$overlay" ] || fail "overlay worktree was not removed"

failure_work_dir="$TMPDIR/failure-work"
mkdir -p "$failure_work_dir"
set +e
(
  set -e
  trap homebrew_patched_launcher_cleanup EXIT
  export FAKE_BREW_BAD_PREFIX=1
  homebrew_patched_launcher_prepare "$prefix/bin/brew" "$patch_file" "$failure_work_dir"
)
failure_status=$?
set -e
[ "$failure_status" -ne 0 ] || fail "invalid patched prefix unexpectedly succeeded"
[ ! -e "$failure_work_dir/homebrew-overlay" ] || fail "failed prepare left its overlay worktree"
if find "$prefix/bin" -maxdepth 1 -type l -name '.kandelo-brew-*' -print -quit | grep -q .; then
  fail "failed prepare left its launcher symlink"
fi
[ "$(cat "$prefix/marker.txt")" = "unpatched" ] || fail "failed prepare modified the original repository"
[ -z "$(git -C "$prefix" status --short)" ] || fail "failed prepare left the original repository dirty"

echo "test-homebrew-patched-launcher.sh: ok"
