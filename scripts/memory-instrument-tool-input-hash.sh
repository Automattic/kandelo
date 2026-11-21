#!/usr/bin/env bash

# Content identity for the repository-built wasm-memory-instrument executable.
# Mirrors `scripts/fork-instrument-tool-input-hash.sh`: independent of mtimes,
# so a checkout, rebase, or restored tools/bin cache cannot make an old binary
# look current.

memory_instrument_tool_input_hash() {
    local repo_root="$1"
    local relative_path

    (
        cd "$repo_root"
        local paths_file
        paths_file="$(mktemp)"
        trap 'rm -f "$paths_file"' EXIT
        {
            for relative_path in Cargo.toml Cargo.lock rust-toolchain.toml \
                .cargo/config.toml \
                scripts/build-memory-instrument-tool.sh \
                scripts/run-wasm-memory-instrument.sh \
                scripts/memory-instrument-tool-input-hash.sh; do
                if [ -f "$relative_path" ]; then
                    printf '%s\n' "$relative_path"
                fi
            done
            find crates/memory-instrument -type f -print
        } | LC_ALL=C sort -u > "$paths_file"
        git hash-object --stdin-paths < "$paths_file" |
            paste -d '\n' "$paths_file" - |
            while IFS= read -r relative_path && IFS= read -r object_id; do
                printf '%s\0%s\n' "$relative_path" "$object_id"
            done | git hash-object --stdin
    )
}
