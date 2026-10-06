#!/usr/bin/env bash
#
# Build ruby.zip for the browser shell demo: a root-relative archive of
# bin/ruby (the instrumented interpreter) + the ruby command suite +
# lib/ruby/4.0.0. The shell overlay mounts it at /usr/, so entries
# become /usr/bin/ruby and /usr/lib/ruby/4.0.0/... On first exec the
# whole archive is fetched and unpacked in one go.
#
#   build-ruby-zip.sh <ruby-dependency-dir> <output.zip>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

[ "$#" -eq 2 ] || { echo "usage: $0 <ruby-dependency-dir> <output.zip>" >&2; exit 2; }
RUBY_DIR="$1"
OUTPUT_FILE="$2"

# Locate the ruby package's declared outputs. Ruby is a multi-output
# package, so the outputs may sit directly in RUBY_DIR or under a ruby/
# subdir — accept either.
find_output() {
    local name="$1" p
    for p in "$RUBY_DIR/$name" "$RUBY_DIR/ruby/$name"; do
        [ -f "$p" ] && { echo "$p"; return 0; }
    done
    return 1
}
RUBY_WASM="$(find_output ruby.wasm)" || { echo "ruby.wasm not found under $RUBY_DIR" >&2; exit 1; }
RUNTIME_ZIP="$(find_output ruby-runtime.zip)" || { echo "ruby-runtime.zip not found under $RUBY_DIR" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/ruby-zip.XXXXXX")"
    EXTRACT="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/ruby-extract.XXXXXX")"
else
    STAGING="$(mktemp -d)"; EXTRACT="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING" "$EXTRACT"' EXIT

echo "==> Extracting ruby-runtime.zip..."
unzip -q "$RUNTIME_ZIP" -d "$EXTRACT"
# runtime zip is rooted at usr/ — strip that prefix.
[ -d "$EXTRACT/usr/lib/ruby" ] || { echo "runtime zip missing usr/lib/ruby" >&2; exit 1; }
[ -d "$EXTRACT/usr/bin" ] || { echo "runtime zip missing usr/bin" >&2; exit 1; }

echo "==> Staging ruby.zip tree..."
mkdir -p "$STAGING/bin" "$STAGING/lib"
# stdlib tree (lib/ruby/4.0.0/...)
cp -R "$EXTRACT/usr/lib/ruby" "$STAGING/lib/ruby"
# command suite from the runtime bin/, EXCEPT the interpreter itself
# (we use the instrumented ruby.wasm output for bin/ruby).
for f in "$EXTRACT/usr/bin/"*; do
    base="$(basename "$f")"
    [ "$base" = ruby ] && continue
    cp "$f" "$STAGING/bin/$base"
done
# The instrumented interpreter as bin/ruby (no .wasm extension).
cp "$RUBY_WASM" "$STAGING/bin/ruby"
chmod 755 "$STAGING/bin/"*

# Normalize wrapper shebangs to absolute /usr/bin/ruby so they resolve
# without a working /usr/bin/env (the kernel does no PATH search for the
# shebang interpreter). gem/bundle/bundler ship as #!/usr/bin/env ruby;
# make-install stubs already use #!/usr/bin/ruby (harmless to re-apply).
for w in gem bundle bundler irb erb racc rdoc ri; do
    f="$STAGING/bin/$w"
    [ -f "$f" ] || continue
    # only rewrite text scripts (skip if somehow binary)
    if head -c2 "$f" | grep -q '#!'; then
        sed -i.bak '1s|^#!.*ruby.*$|#!/usr/bin/ruby|' "$f" && rm -f "$f.bak"
    fi
done

# Exactly one regular executable named bin/ruby is required by the loader.
[ -f "$STAGING/bin/ruby" ] || { echo "bin/ruby missing" >&2; exit 1; }

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"; mkdir -p "$OUTPUT_DIR"; rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
