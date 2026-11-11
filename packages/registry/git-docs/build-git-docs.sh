#!/usr/bin/env bash
# Ship the `git` package's manual pages as git-docs.zip, a lazy archive
# mounted at /usr/.
#
# Upstream writes them in AsciiDoc. This runs git's own
# Documentation/Makefile, which renders each page with asciidoc
# (Documentation/*.txt -> DocBook) and `xmlto man` (DocBook -> troff),
# with AsciiDoc and DocBook XSL from their pinned sources and
# scripts/xmlto-man.sh standing in for xmlto. The Makefile reads the page date from the git
# history this source archive does not have, so the release date is
# passed in.
#
# Pages shipped: git(1); the page of every command built into git, as
# git.c's command table lists them (the git package installs git and
# git-remote-http only, so commands git runs as separate programs have no
# page here); and upstream's file-format and guide pages (sections 5 and
# 7), which `git help` opens, less gitweb.conf(5) for the absent gitweb.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
WORK="$KANDELO_PACKAGE_WORK_DIR"
VERSION="$WASM_POSIX_DEP_VERSION"
DATE="$(kandelo_man_pages_release_date "$VERSION" 2.47.1=2024-11-25)"

ASCIIDOC_SRC="$WORK/asciidoc"
export DOCBOOK_XSL="$WORK/docbook-xsl"
kandelo_package_stage_source_dependency asciidoc-source "$ASCIIDOC_SRC" "$WORK"
kandelo_package_stage_source_dependency docbook-xsl-source "$DOCBOOK_XSL" "$WORK"
ASCIIDOC="$WORK/asciidoc.sh"
cat > "$ASCIIDOC" <<SH
#!/usr/bin/env bash
exec python3 -I -c 'import sys; sys.path.insert(0, sys.argv.pop(1)); sys.argv[0] = "asciidoc"; from asciidoc.asciidoc import cli; cli()' "$ASCIIDOC_SRC" "\$@"
SH
chmod +x "$ASCIIDOC"

# Commands built into git: the { "name", cmd_name, ... } rows of git.c's
# commands[] table. These have no page of their own upstream: internal
# helpers, and merge strategies that git-merge(1) documents.
UNDOCUMENTED_BUILTINS=" checkout--worker merge-ours merge-recursive \
merge-recursive-ours merge-recursive-theirs merge-subtree pickaxe \
submodule--helper upload-archive--writer "
builtins="$(sed -nE 's/^[[:space:]]*\{ "([a-z0-9-]+)", cmd_.*/\1/p' "$SRC/git.c")"
[ "$(printf '%s\n' "$builtins" | wc -l)" -gt 100 ] || {
    echo "build-git-docs: git.c's command table did not parse" >&2
    exit 1
}
pages=(git.1)
for cmd in $builtins; do
    case "$UNDOCUMENTED_BUILTINS" in
        *" $cmd "*) continue ;;
    esac
    pages+=("git-$cmd.1")
done
MAN5=(gitattributes gitformat-bundle gitformat-chunk gitformat-commit-graph
    gitformat-index gitformat-pack gitformat-signature githooks gitignore
    gitmailmap gitmodules gitprotocol-capabilities gitprotocol-common
    gitprotocol-http gitprotocol-pack gitprotocol-v2 gitrepository-layout)
MAN7=(gitcli gitcore-tutorial gitcredentials gitcvs-migration gitdiffcore
    giteveryday gitfaq gitglossary gitpacking gitnamespaces gitremote-helpers
    gitrevisions gitsubmodules gittutorial-2 gittutorial gitworkflows)
for page in "${MAN5[@]}"; do pages+=("$page.5"); done
for page in "${MAN7[@]}"; do pages+=("$page.7"); done

# GIT_VERSION and GIT_DATE are what the Makefile would read from a git
# checkout; prefix=/usr keeps the build's home directory out of the
# pages' documentation links (MAN_BASE_URL). No XML catalog: the pages
# need nothing from the DocBook DTD they declare, and the build machine's
# catalogs are not inputs.
XML_CATALOG_FILES= make -C "$SRC/Documentation" -j"${NCPU:-4}" \
    prefix=/usr \
    GIT_VERSION="$VERSION" GIT_DATE="$DATE" \
    ASCIIDOC="$ASCIIDOC" XMLTO="$REPO_ROOT/scripts/xmlto-man.sh" \
    "${pages[@]}" > "$WORK/git-docs-make.log" 2>&1 || {
    tail -60 "$WORK/git-docs-make.log" >&2
    exit 1
}

specs=()
for page in "${pages[@]}"; do specs+=("Documentation/$page"); done
install_package_man_pages git-docs "$SRC" "${specs[@]}"
