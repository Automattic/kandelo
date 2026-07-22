#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PORTABLE_CACHE_REL=".ci-test-binary-cache"

out="${1:-}"
if [ -z "$out" ]; then
    echo "usage: $0 <out.tar.zst>" >&2
    exit 2
fi

host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
if [ -z "$host_target" ]; then
    echo "pack-ci-test-workspace: rustc did not report a host target" >&2
    exit 1
fi
xtask_path="target/$host_target/release/xtask"
if [ ! -x "$xtask_path" ]; then
    echo "pack-ci-test-workspace: missing required package resolver: $xtask_path" >&2
    exit 1
fi

for required in \
    local-binaries/kernel.wasm \
    host/wasm/rootfs.vfs \
    examples/gencat.wasm \
    examples/pthread_channel_reuse_test.wasm \
    examples/wait_lifecycle_test.wasm \
    examples/wait_lifecycle_test.wasm64.wasm \
    examples/terminal_attributes_api_test.wasm64.wasm \
    benchmarks/wasm/pipe-throughput.wasm \
    benchmarks/wasm/file-throughput.wasm \
    benchmarks/wasm/syscall-latency.wasm \
    benchmarks/wasm/fork-bench.wasm \
    benchmarks/wasm/clone-bench.wasm \
    benchmarks/wasm/spawn-bench.wasm \
    benchmarks/wasm/hello.wasm; do
    if [ ! -f "$required" ]; then
        echo "pack-ci-test-workspace: missing required artifact: $required" >&2
        exit 1
    fi
done

items=("$xtask_path")
for item in host/wasm; do
    [ -e "$item" ] && items+=("$item")
done
if [ -f target/homebrew-bootstrap/homebrew-bootstrap.vfs ]; then
    # Package/ABI staging builds the exact guest bootstrap before packing. The
    # browser consumer reuses these same bytes instead of rebuilding against a
    # different candidate index.
    items+=(target/homebrew-bootstrap/homebrew-bootstrap.vfs)
fi
# `prepare-browser` uses xtask to map package outputs to their resolver paths.
# The producer already built this exact binary while fetching packages, so keep
# it with the prepared workspace instead of rebuilding it in the consumer.
# The browser consumer reruns `prepare-browser` against this archive. Its
# `has_programs` guard checks both example and benchmark outputs, so retain the
# complete build-programs fixture set to prevent an unintended source rebuild.
for wasm in examples/*.wasm benchmarks/wasm/*.wasm; do
    [ -f "$wasm" ] && items+=("$wasm")
done

stage="$(realpath "$(mktemp -d)")"
cleanup() {
    local status="$?"
    trap - EXIT
    rm -rf "$stage"
    exit "$status"
}
trap cleanup EXIT

relative_root_link() {
    local mirror_relative="$1"
    local target_relative="$2"
    local parent=""
    case "$mirror_relative" in
        */*) parent="${mirror_relative%/*}" ;;
    esac
    local prefix=""
    while [ -n "$parent" ]; do
        prefix="../$prefix"
        case "$parent" in
            */*) parent="${parent%/*}" ;;
            *) parent="" ;;
        esac
    done
    printf '%s%s\n' "$prefix" "$target_relative"
}

if [ -e binaries ] || [ -L binaries ]; then
    source_cache_root="$("$xtask_path" build-deps cache-root)"
    case "$source_cache_root" in
        /*) ;;
        *)
            echo "pack-ci-test-workspace: package resolver returned a non-absolute cache root: $source_cache_root" >&2
            exit 1
            ;;
    esac
    # WHY: prepared conformance workspaces and isolated Homebrew Formula tests
    # must transport package generations identically. A shared staging helper
    # prevents either path from flattening package mirrors into ordinary files
    # and silently discarding the resolver's single-generation identity.
    bash scripts/stage-portable-resolver-binaries.sh \
        "$REPO_ROOT/binaries" "$source_cache_root" "$stage"
fi

if [ -e local-binaries ] || [ -L local-binaries ]; then
    if [ ! -d local-binaries ] || [ -L local-binaries ]; then
        echo "pack-ci-test-workspace: local-binaries must be a real directory" >&2
        exit 1
    fi
    cp -a local-binaries "$stage/local-binaries"
    local_root="$(realpath local-binaries)"
    local_generation_root="$local_root/.kandelo-local-generations"
    while IFS= read -r -d '' mirror; do
        mirror_relative="${mirror#local-binaries/}"
        if [ "$mirror_relative" = "$mirror" ]; then
            echo "pack-ci-test-workspace: local resolver link escaped local-binaries/: $mirror" >&2
            exit 1
        fi
        target="$(realpath "$mirror" 2>/dev/null || true)"
        if [ ! -f "$target" ] || [ -L "$target" ]; then
            echo "pack-ci-test-workspace: local resolver link is not a readable regular file: $mirror" >&2
            exit 1
        fi
        staged_mirror="$stage/local-binaries/$mirror_relative"
        rm "$staged_mirror"
        case "$mirror_relative" in
            programs/*)
                case "$target" in
                    "$local_generation_root"/*)
                        target_relative="${target#"$local_root"/}"
                        ;;
                    *)
                        echo "pack-ci-test-workspace: local program resolver link targets a noncanonical generation: $mirror -> $target" >&2
                        exit 1
                        ;;
                esac
                ln -s \
                    "$(relative_root_link "$mirror_relative" "$target_relative")" \
                    "$staged_mirror"
                ;;
            *)
                case "$target" in
                    "$local_root"/*) ;;
                    *)
                        echo "pack-ci-test-workspace: local scalar resolver link escapes local-binaries/: $mirror -> $target" >&2
                        exit 1
                        ;;
                esac
                # Scalar entries such as kernel.wasm have no package closure.
                # Carry their verified bytes, not a generation- or host-path
                # alias that the test consumer does not need.
                cp -p "$target" "$staged_mirror"
                ;;
        esac
    done < <(find local-binaries -type l -print0)

    unsafe_local_link="$(
        find "$stage/local-binaries" -type l -print0 |
        while IFS= read -r -d '' link; do
            case "$(readlink "$link")" in
                /*)
                    printf '%s\n' "$link"
                    break
                    ;;
            esac
            resolved="$(realpath "$link" 2>/dev/null || true)"
            case "$resolved" in
                "$stage/local-binaries"/*) ;;
                *)
                    printf '%s\n' "$link"
                    break
                    ;;
            esac
        done
    )"
    if [ -n "$unsafe_local_link" ]; then
        echo "pack-ci-test-workspace: portable local resolver closure contains an absolute, dangling, or escaping link: $unsafe_local_link" >&2
        exit 1
    fi
fi

mkdir -p "$(dirname "$out")"
tar_args=(--zstd -cf "$out")
if [ -d "$stage/binaries" ]; then
    tar_args+=(-C "$stage" binaries)
fi
if [ -d "$stage/$PORTABLE_CACHE_REL" ]; then
    tar_args+=(-C "$stage" "$PORTABLE_CACHE_REL")
fi
if [ -d "$stage/local-binaries" ]; then
    tar_args+=(-C "$stage" local-binaries)
fi
tar_args+=(-C "$REPO_ROOT" "${items[@]}")
tar "${tar_args[@]}"

trap - EXIT
rm -rf "$stage"
