#!/usr/bin/env bash
# Shared steps for `<pkg>-docs` packages that ship a program's upstream
# manual pages as a lazy `/usr/`-mounted ZIP.
#
# A docs package pins the same source URL, SHA-256 and version as the
# package that builds the program, so the pages come from the very source
# tree the binary was built from (tests/package-system/
# package-docs-source-parity.test.ts keeps the two in step). Nothing here
# authors, paraphrases or copies a page from the host.
#
#   kandelo_man_pages_stage_source <recipe-dir>
#       Prepare the resolver work/output roots and stage the pinned,
#       verified upstream source. Sets KANDELO_MAN_PAGES_SOURCE to the
#       staged tree.
#
#   kandelo_man_pages_substitute <in> <out> <token=value>...
#       Fill in the placeholders upstream's own build substitutes into a
#       page template (`grep.in.1`, `php.1.in`, ...). Each token is replaced
#       literally; a token missing from <in> is a hard failure, so an
#       upstream template change cannot silently ship a stale page.
#
#   kandelo_man_pages_release_date <version> <version=YYYY-MM-DD>...
#       Print the named release's date (its release tag's date). Page
#       generators that stamp a date (scdoc, DocBook XSL) otherwise read
#       the build clock, which the dev shell pins to 1980. A version with
#       no recorded date is a hard failure, so a version bump has to
#       record its release date too.
#
#   kandelo_man_pages_build_scdoc
#       Build scdoc for the build machine from the declared scdoc-source
#       dependency and set KANDELO_SCDOC to it. scdoc is the page
#       generator of the wlroots-family projects (sway, foot, labwc, ...).
#
#   kandelo_man_pages_scdoc <release-date> <in.scd> <out>
#       Render one page with scdoc, dated <release-date>, the way
#       upstream meson builds do (`scdoc < in > out`).
#
#   install_package_man_pages <docs-pkg> <tree-dir> <spec>...
#       Stage the named pages and install them as the package's declared
#       `<docs-pkg>.zip` output. Each spec is one of:
#
#         relpath[:destname]  copy <tree-dir>/relpath as destname
#         destname=target     destname is a symlink to page `target` in the
#                             same section (an installed alias command)
#
#       The man section comes from the destination name's extension:
#
#         doc/bash.1          -> share/man/man1/bash.1
#         less.nro:less.1     -> share/man/man1/less.1  (less keeps troff in .nro)
#         unxz.1=xz.1         -> share/man/man1/unxz.1 -> xz.1
#
#       A missing page is a hard failure: upstream moving or renaming a
#       page must surface as a build error, not as `man foo` finding
#       nothing once the archive has shipped.

kandelo_man_pages_stage_source() {
    local recipe_dir="${1:-}"
    if [ -z "$recipe_dir" ] || [ ! -d "$recipe_dir" ]; then
        echo "kandelo_man_pages_stage_source: usage:" \
            "kandelo_man_pages_stage_source <recipe-dir>" >&2
        return 2
    fi
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    # shellcheck source=/dev/null
    source "$repo_root/scripts/package-build-roots.sh"
    kandelo_package_load_source_metadata "$recipe_dir" || return
    kandelo_package_prepare_build_roots "$recipe_dir" wasm32 || return

    local label src
    label="$(basename "$recipe_dir")"
    src="$KANDELO_PACKAGE_WORK_DIR/upstream-src"
    rm -rf "$src"
    kandelo_package_stage_verified_source "$label" "$src" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
        "$WASM_POSIX_DEP_SOURCE_SHA256" "$KANDELO_PACKAGE_WORK_DIR" || return
    KANDELO_MAN_PAGES_SOURCE="$src"
}

kandelo_man_pages_substitute() {
    local in="${1:-}" out="${2:-}"
    if [ "$#" -lt 3 ] || [ -z "$in" ] || [ -z "$out" ]; then
        echo "kandelo_man_pages_substitute: usage:" \
            "kandelo_man_pages_substitute <in> <out> <token=value>..." >&2
        return 2
    fi
    shift 2
    if [ ! -f "$in" ] || [ -L "$in" ]; then
        echo "kandelo_man_pages_substitute: template missing: $in" >&2
        return 1
    fi
    local content pair token value
    content="$(cat "$in"; printf x)"
    content="${content%x}"
    for pair in "$@"; do
        token="${pair%%=*}"
        value="${pair#*=}"
        if [ -z "$token" ] || [ "$token" = "$pair" ]; then
            echo "kandelo_man_pages_substitute: expected token=value: '$pair'" >&2
            return 2
        fi
        case "$content" in
            *"$token"*) ;;
            *)
                echo "kandelo_man_pages_substitute: $in has no '$token'" >&2
                return 1
                ;;
        esac
        content="${content//"$token"/"$value"}"
    done
    printf '%s' "$content" > "$out"
}

kandelo_man_pages_release_date() {
    local version="${1:-}"
    if [ "$#" -lt 2 ] || [ -z "$version" ]; then
        echo "kandelo_man_pages_release_date: usage:" \
            "kandelo_man_pages_release_date <version> <version=YYYY-MM-DD>..." >&2
        return 2
    fi
    shift
    local pair date=""
    for pair in "$@"; do
        if [ "${pair%%=*}" = "$version" ]; then
            date="${pair#*=}"
        fi
    done
    case "$date" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) printf '%s\n' "$date" ;;
        "")
            echo "kandelo_man_pages_release_date: no release date recorded" \
                "for version $version" >&2
            return 1
            ;;
        *)
            echo "kandelo_man_pages_release_date: '$date' is not YYYY-MM-DD" >&2
            return 2
            ;;
    esac
}

kandelo_man_pages_build_scdoc() {
    local work="${KANDELO_PACKAGE_WORK_DIR:-${WASM_POSIX_DEP_WORK_DIR:-}}"
    if [ -z "$work" ]; then
        echo "kandelo_man_pages_build_scdoc: requires KANDELO_PACKAGE_WORK_DIR" >&2
        return 2
    fi
    local src="$work/scdoc-src"
    kandelo_package_stage_source_dependency scdoc-source "$src" "$work" || return
    # Upstream's Makefile links statically, which macOS cannot do; scdoc
    # only runs here, so link it the build machine's default way.
    make -C "$src" CC=cc LDFLAGS= scdoc > "$work/scdoc-build.log" 2>&1 || {
        tail -40 "$work/scdoc-build.log" >&2
        return 1
    }
    KANDELO_SCDOC="$src/scdoc"
}

kandelo_man_pages_scdoc() {
    local date="${1:-}" in="${2:-}" out="${3:-}" epoch
    if [ "$#" -ne 3 ] || [ -z "$date" ] || [ -z "$in" ] || [ -z "$out" ]; then
        echo "kandelo_man_pages_scdoc: usage:" \
            "kandelo_man_pages_scdoc <release-date> <in.scd> <out>" >&2
        return 2
    fi
    if [ -z "${KANDELO_SCDOC:-}" ]; then
        echo "kandelo_man_pages_scdoc: run kandelo_man_pages_build_scdoc first" >&2
        return 2
    fi
    # scdoc prints SOURCE_DATE_EPOCH as a UTC date.
    epoch="$(perl -MTime::Local=timegm -e '
        my ($y, $m, $d) = split /-/, $ARGV[0];
        print timegm(0, 0, 0, $d, $m - 1, $y);
    ' "$date")" || return
    mkdir -p "$(dirname "$out")"
    SOURCE_DATE_EPOCH="$epoch" "$KANDELO_SCDOC" < "$in" > "$out"
}

install_package_man_pages() {
    local pkg="${1:-}" tree="${2:-}"
    if [ "$#" -lt 3 ] || [ -z "$pkg" ] || [ -z "$tree" ]; then
        echo "install_package_man_pages: usage:" \
            "install_package_man_pages <docs-pkg> <tree-dir> <spec>..." >&2
        return 2
    fi
    shift 2

    # $pkg becomes a path component of $stage/$archive below (rm -rf/-f
    # targets). A bare package name is the only safe input there: a caller
    # typo that passes a path instead -- "../escape", "sub/pkg" -- must not
    # let those removals walk outside $work.
    case "$pkg" in
        ""|.|..|*/*)
            echo "install_package_man_pages: invalid package name: '$pkg'" >&2
            return 2
            ;;
    esac

    if [ ! -d "$tree" ] || [ -L "$tree" ]; then
        echo "install_package_man_pages: tree must be a real directory: $tree" >&2
        return 1
    fi

    local work="${KANDELO_PACKAGE_WORK_DIR:-${WASM_POSIX_DEP_WORK_DIR:-}}"
    if [ -z "$work" ]; then
        echo "install_package_man_pages: requires KANDELO_PACKAGE_WORK_DIR or" \
            "WASM_POSIX_DEP_WORK_DIR" >&2
        return 2
    fi

    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

    local stage="$work/$pkg-stage"
    rm -rf "$stage"

    local spec src dest target section dir
    for spec in "$@"; do
        target=""
        case "$spec" in
            *=*)
                dest="${spec%%=*}"
                target="${spec#*=}"
                ;;
            *:*)
                src="${spec%%:*}"
                dest="${spec#*:}"
                ;;
            *)
                src="$spec"
                dest="$(basename "$src")"
                ;;
        esac
        case "$dest" in
            ""|*/*)
                echo "install_package_man_pages: $pkg: invalid page name '$dest'" >&2
                return 2
                ;;
        esac
        section="${dest##*.}"
        case "$section" in
            [1-9]) ;;
            *)
                echo "install_package_man_pages: $pkg: cannot infer a man section" \
                    "from '$dest'" >&2
                return 2
                ;;
        esac
        dir="$stage/share/man/man$section"
        mkdir -p "$dir"
        if [ -n "$target" ]; then
            case "$target" in
                ""|*/*)
                    echo "install_package_man_pages: $pkg: alias target must be a" \
                        "page in the same section: '$spec'" >&2
                    return 2
                    ;;
            esac
            if [ ! -f "$dir/$target" ] || [ -L "$dir/$target" ]; then
                echo "install_package_man_pages: $pkg: alias '$dest' names" \
                    "'$target', which is not a page staged earlier in man$section" >&2
                return 1
            fi
            ln -s "$target" "$dir/$dest"
            continue
        fi
        if [ ! -f "$tree/$src" ] || [ -L "$tree/$src" ]; then
            echo "install_package_man_pages: $pkg: expected man page missing:" \
                "$tree/$src" >&2
            return 1
        fi
        cp "$tree/$src" "$dir/$dest"
        chmod 644 "$dir/$dest"
    done

    local archive="$work/$pkg.zip"
    rm -f "$archive"
    bash "$repo_root/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$archive"

    # shellcheck source=/dev/null
    source "$repo_root/scripts/install-local-binary.sh"
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
            install_local_binary "$pkg" "$archive" "$pkg.zip"
    else
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
            install_local_binary "$pkg" "$archive" "$pkg.zip"
    fi
}
