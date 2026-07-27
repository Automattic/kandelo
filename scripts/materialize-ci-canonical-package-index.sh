#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: $0 <release-tag> <expected-abi> <out.toml>" >&2
    exit 2
fi

tag="$1"
abi="$2"
out="$3"
if ! [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] ||
   ! [[ "$abi" =~ ^[0-9]+$ ]] ||
   [ -z "$out" ] ||
   [ -L "$out" ]; then
    echo "materialize-ci-canonical-package-index: invalid tag, ABI, or output" >&2
    exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
state_script="${CANONICAL_INDEX_STATE_SCRIPT:-$repo_root/scripts/release-index-state.sh}"
repository="${GITHUB_REPOSITORY:-Automattic/kandelo}"
if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "materialize-ci-canonical-package-index: invalid repository identity" >&2
    exit 2
fi
host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
xtask="${WASM_POSIX_XTASK_BIN:-$repo_root/target/$host_target/release/xtask}"
if [ -z "$host_target" ] || [ ! -f "$xtask" ] || [ ! -x "$xtask" ]; then
    echo "materialize-ci-canonical-package-index: missing executable package index parser: $xtask" >&2
    exit 1
fi
tmp_root="$(mktemp -d)"
cleanup() {
    rm -rf "$tmp_root"
}
trap cleanup EXIT
snapshot="$tmp_root/index.toml"
head_file="$tmp_root/head"
validated="$tmp_root/validated-index.toml"

set +e
bash "$state_script" snapshot \
    --target-tag "$tag" \
    --expected-abi "$abi" \
    --output "$snapshot" \
    --head-file "$head_file"
status=$?
set -e
case "$status" in
    0)
        if [ ! -f "$snapshot" ] || [ -L "$snapshot" ] ||
           [ ! -f "$head_file" ] || [ -L "$head_file" ]; then
            echo "materialize-ci-canonical-package-index: snapshot output is incomplete" >&2
            exit 1
        fi
        ;;
    44)
        # WHY: absence is a valid first-publication state for a new ABI, but
        # only the release state machine may distinguish a confirmed 404 from
        # an uncertain GitHub failure. Represent that trusted absence as an
        # empty canonical index so every candidate identity requires the
        # closed pre-publication mirror.
        cat > "$snapshot" <<EOF
abi_version = $abi
generated_at = "1970-01-01T00:00:00Z"
generator = "confirmed-absent canonical CI snapshot"
EOF
        ;;
    *)
        echo "materialize-ci-canonical-package-index: canonical release state is uncertain" >&2
        exit "$status"
        ;;
esac

# WHY: release-index-state authenticates which immutable bytes are canonical;
# IndexToml owns their schema. Normalize through that parser before a shell
# identity query can treat matching text fragments as a valid package entry.
"$xtask" index-candidate seed \
    --canonical-index "$snapshot" \
    --candidate-index "$validated" \
    --canonical-index-url \
      "https://github.com/$repository/releases/download/$tag/index.toml" \
    --expected-abi "$abi" \
    --generated-at "1970-01-01T00:00:00Z" \
    --generator "authenticated canonical CI snapshot" || {
    echo "materialize-ci-canonical-package-index: canonical index schema is invalid" >&2
    exit 1
}
if [ ! -f "$validated" ] || [ -L "$validated" ]; then
    echo "materialize-ci-canonical-package-index: package index parser produced no regular output" >&2
    exit 1
fi

mkdir -p "$(dirname "$out")"
staged_out="$(mktemp "$(dirname "$out")/.canonical-package-index.XXXXXX")"
cp -p "$validated" "$staged_out"
mv "$staged_out" "$out"
