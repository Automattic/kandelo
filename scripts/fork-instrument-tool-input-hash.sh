#!/usr/bin/env bash

# Content identity for the repository-built wasm-fork-instrument executable.
# Keep this independent of mtimes: a checkout, rebase, or restored tools/bin
# cache can otherwise make an old binary look newer than its current sources.

fork_instrument_tool_input_hash() {
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
                scripts/build-fork-instrument-tool.sh \
                scripts/run-wasm-fork-instrument.sh \
                scripts/fork-instrument-tool-input-hash.sh; do
                if [ -f "$relative_path" ]; then
                    printf '%s\n' "$relative_path"
                fi
            done
            find crates/fork-instrument crates/program-abi crates/wasm-artifact -type f -print
        } | LC_ALL=C sort -u > "$paths_file"
        # One git process hashes every file (--stdin-paths answers one object
        # id per line, in order). A process per file took about 3 s for the
        # ~400 inputs, on every wrapper call. The digest is unchanged: the
        # same "<path>\0<object id>\n" stream, hashed once.
        git hash-object --stdin-paths < "$paths_file" |
            paste -d '\n' "$paths_file" - |
            while IFS= read -r relative_path && IFS= read -r object_id; do
                printf '%s\0%s\n' "$relative_path" "$object_id"
            done | git hash-object --stdin
    )
}
