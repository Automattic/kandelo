#!/usr/bin/env bash
# Shared helpers for `-docs` packages that generate man pages from the
# captured --help/--version of real wasm binaries running inside Kandelo.
#
# Faithfulness (see CLAUDE.md "Platform Values Contract"): the page BODY is
# always the exact text a tool printed inside a Kandelo kernel instance;
# help2man only reformats it into troff via a replay wrapper that `cat`s the
# captured bytes. The one-line NAME description passed to `--name` is the
# tool's canonical upstream man-page NAME (metadata, not body), documented per
# package.
#
# A package build script sources this, resolves its dependency binaries,
# captures with `manpage_docs_capture`, emits one page per tool with
# `manpage_docs_emit_page`, then packs with `manpage_docs_finalize`.
#
# Requires: REPO_ROOT set; help2man on PATH; node + tsx available.

# manpage_docs_find_wasm <dep-dir> <wasm-name>
# Echoes the path to <wasm-name> under a dependency output dir, tolerating both
# the flat resolver layout (<dep>/find.wasm) and the mirrored subdir layout
# (<dep>/findutils/find.wasm). Exits non-zero if not found.
manpage_docs_find_wasm() {
    local dep_dir="$1" name="$2" candidate
    for candidate in \
        "$dep_dir/$name" \
        "$dep_dir"/*/"$name"; do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    echo "manpage-docs: $name not found under $dep_dir" >&2
    return 2
}

# manpage_docs_capture <capture-dir> <bin> <tool> [<bin> <tool> ...]
# Runs the shared Kandelo capture harness. Uses a short /tmp TMPDIR so tsx's
# IPC socket path stays under the macOS unix-socket sun_path limit (the
# resolver work dir is a long content-hashed path).
manpage_docs_capture() {
    local capture_dir="$1"; shift
    rm -rf "$capture_dir"
    local tsx_tmp
    tsx_tmp="$(mktemp -d /tmp/kandelo-docs-capture.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf -- '$tsx_tmp'" RETURN
    TMPDIR="$tsx_tmp" node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
        "$REPO_ROOT/images/vfs/scripts/generate-help-capture.ts" \
        "$capture_dir" "$@"
}

# manpage_docs_emit_page <tool> <section> <name-desc> <source-label>
#                        <capture-dir> <stage-dir> <wrap-dir>
# Emits $stage/share/man/man<section>/<tool>.<section> from the captured
# help/version via a replay wrapper. No-op (with a warning) if the tool was
# skipped during capture — an honest gap, never a fabricated page.
manpage_docs_emit_page() {
    local tool="$1" section="$2" name_desc="$3" source_label="$4"
    local capture_dir="$5" stage_dir="$6" wrap_dir="$7"
    local helpfile="$capture_dir/$tool.help"
    local verfile="$capture_dir/$tool.version"
    if [ ! -f "$helpfile" ]; then
        echo "manpage-docs: no capture for $tool (skipped in Kandelo)" >&2
        return 0
    fi
    mkdir -p "$wrap_dir" "$stage_dir/share/man/man$section"
    # Replay wrapper: help2man execs "<wrap>/<tool> --help|--version"; we serve
    # the exact bytes captured from Kandelo, so the man BODY is 100% derived
    # from the real binary and help2man only formats it.
    cat > "$wrap_dir/$tool" <<EOF
#!/usr/bin/env bash
case "\$1" in
  --version) cat "$verfile" ;;
  *)         cat "$helpfile" ;;
esac
EOF
    chmod +x "$wrap_dir/$tool"
    # Pin the NAME section with a help2man [NAME] include instead of --name, so
    # both the page name key (<tool>) and its one-line description are exact.
    # This mirrors coreutils-docs' man/*.x approach and, unlike --name, is
    # immune to help2man inferring a different program name from --version
    # (e.g. gawk's "GNU Awk" would otherwise index the page as "Awk", breaking
    # `whatis gawk`).
    local include="$wrap_dir/$tool.x"
    printf '[NAME]\n%s \\- %s\n' "$tool" "$name_desc" > "$include"
    help2man --no-info --section="$section" --source="$source_label" \
        --include="$include" "$wrap_dir/$tool" \
        > "$stage_dir/share/man/man$section/$tool.$section" || {
        echo "manpage-docs: help2man failed for $tool" >&2
        rm -f "$stage_dir/share/man/man$section/$tool.$section"
        return 1
    }
}

# manpage_docs_finalize <stage-dir> <work-dir> <package-name> <archive-name>
# Deterministically zips the staged man tree and installs it as the package's
# declared output (never mirrored, never fork-instrumented — it is data).
manpage_docs_finalize() {
    local stage_dir="$1" work_dir="$2" package="$3" archive_name="$4"
    local archive="$work_dir/$archive_name"
    rm -f "$archive"
    bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" \
        "$stage_dir" "$archive"
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
            WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
            install_local_binary "$package" "$archive" "$archive_name"
    else
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
            install_local_binary "$package" "$archive" "$archive_name"
    fi
}
