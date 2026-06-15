#!/usr/bin/env bash
set -euo pipefail

# Ensure Mozilla's SpiderMonkey source tree is available locally and print the
# source root on stdout. Progress and diagnostics go to stderr so callers can
# safely capture stdout in a variable.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/packages/registry/spidermonkey"
SOURCE_PARENT="${SPIDERMONKEY_SOURCE_PARENT:-$PACKAGE_DIR/source}"

log() {
  echo "$*" >&2
}

is_spidermonkey_source() {
  local dir="$1"
  [ -f "$dir/mach" ] &&
    [ -d "$dir/js/src/tests" ] &&
    [ -d "$dir/js/src/jit-test" ]
}

find_source_root() {
  local root="$1"
  if [ -n "$root" ] && [ -d "$root" ]; then
    while IFS= read -r mach; do
      local dir
      dir="$(dirname "$mach")"
      if is_spidermonkey_source "$dir"; then
        printf '%s\n' "$dir"
        return 0
      fi
    done < <(find "$root" -mindepth 1 -maxdepth 4 -type f -name mach -print 2>/dev/null)
  fi
  return 1
}

if [ -n "${SPIDERMONKEY_SOURCE_DIR:-}" ]; then
  if is_spidermonkey_source "$SPIDERMONKEY_SOURCE_DIR"; then
    printf '%s\n' "$SPIDERMONKEY_SOURCE_DIR"
    exit 0
  fi
  log "ERROR: SPIDERMONKEY_SOURCE_DIR is not a SpiderMonkey source root: $SPIDERMONKEY_SOURCE_DIR"
  exit 1
fi

if source_root="$(find_source_root "$SOURCE_PARENT")"; then
  printf '%s\n' "$source_root"
  exit 0
fi

source_info=()
while IFS= read -r line; do
  source_info+=("$line")
done < <(python3 - "$PACKAGE_DIR/package.toml" "$PACKAGE_DIR/VERSION" <<'PY'
from pathlib import Path
import sys

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11 fallback
    import tomli as tomllib  # type: ignore

manifest = Path(sys.argv[1])
version_file = Path(sys.argv[2])
data = tomllib.loads(manifest.read_text(encoding="utf-8"))
source = data.get("source", {})
version = version_file.read_text(encoding="utf-8").strip()
url = source.get(
    "url",
    f"https://ftp.mozilla.org/pub/firefox/releases/{version}/source/firefox-{version}.source.tar.xz",
)
sha256 = source.get("sha256", "")
print(version)
print(url)
print(sha256)
PY
)

VERSION="${source_info[0]}"
SOURCE_URL="${source_info[1]}"
SOURCE_SHA256="${source_info[2]}"
DOWNLOAD_DIR="$PACKAGE_DIR/downloads"
ARCHIVE="$DOWNLOAD_DIR/firefox-$VERSION.source.tar.xz"

mkdir -p "$DOWNLOAD_DIR" "$SOURCE_PARENT"

if [ ! -f "$ARCHIVE" ]; then
  log "==> Downloading Firefox/SpiderMonkey $VERSION source..."
  curl -fL "$SOURCE_URL" -o "$ARCHIVE"
fi

if [ -n "$SOURCE_SHA256" ]; then
  log "==> Verifying SpiderMonkey source archive..."
  actual_sha="$(
    python3 - "$ARCHIVE" <<'PY'
import hashlib
import sys

h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
  )"
  if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
    log "ERROR: source SHA256 mismatch for $ARCHIVE"
    log "  expected: $SOURCE_SHA256"
    log "  actual:   $actual_sha"
    exit 1
  fi
fi

log "==> Extracting Firefox/SpiderMonkey $VERSION source..."
python3 - "$ARCHIVE" "$SOURCE_PARENT" <<'PY'
from pathlib import Path
import os
import sys
import tarfile

archive = sys.argv[1]
dest = Path(sys.argv[2]).resolve()
with tarfile.open(archive, "r:xz") as tf:
    for member in tf.getmembers():
        target = (dest / member.name).resolve()
        if os.path.commonpath([str(dest), str(target)]) != str(dest):
            raise SystemExit(f"archive member escapes destination: {member.name}")
    tf.extractall(dest)
PY

if source_root="$(find_source_root "$SOURCE_PARENT")"; then
  printf '%s\n' "$source_root"
  exit 0
fi

log "ERROR: could not locate SpiderMonkey source root under $SOURCE_PARENT after extraction"
exit 1
