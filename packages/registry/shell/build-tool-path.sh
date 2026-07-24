#!/usr/bin/env bash
# Select the host-tool closure used by the shell package recipe.

kandelo_shell_build_tool_path() {
    local nix_store="${NIX_STORE:-/nix/store}"
    local declared="${KANDELO_DEV_SHELL_TOOL_PATH:-}"
    local combined entry selected=""

    if [ -z "$declared" ]; then
        # The package recipe remains usable by a compatible external resolver.
        # Kandelo's authoritative build path always sets the declared Nix path.
        printf '%s\n' "$PATH"
        return 0
    fi

    combined="$declared:$PATH"
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        case "$entry" in
            "$nix_store"/*/bin) ;;
            *)
                # KANDELO_DEV_SHELL_TOOL_PATH also contains the worktree SDK
                # shims. Retain only paths the Nix shell explicitly selected.
                case ":$declared:" in
                    *":$entry:"*) ;;
                    *) continue ;;
                esac
                ;;
        esac
        case ":$selected:" in
            *":$entry:"*) continue ;;
        esac
        selected="${selected:+$selected:}$entry"
    done < <(printf '%s' "$combined" | tr ':' '\n')

    if [ -z "$selected" ]; then
        echo "ERROR: shell build has no declared Nix tool path" >&2
        return 1
    fi
    printf '%s\n' "$selected"
}

kandelo_shell_activate_build_tool_path() {
    local nix_store="${NIX_STORE:-/nix/store}"
    local tool resolved

    [ -n "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ] || return 0
    PATH="$(kandelo_shell_build_tool_path)" || return 1
    export PATH

    # WHY: package.toml validates versions, while this check validates source.
    # Both are required: a compatible runner binary is still undeclared build
    # state when the canonical recipe is running through Nix.
    for tool in git jq node npm ruby sha256sum tar wc; do
        resolved="$(type -P "$tool" || true)"
        case "$resolved" in
            "$nix_store"/*/bin/"$tool") ;;
            *)
                echo "ERROR: shell host tool $tool is outside the Nix store: ${resolved:-missing}" >&2
                return 1
                ;;
        esac
    done
}
