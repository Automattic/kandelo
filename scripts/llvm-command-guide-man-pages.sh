#!/usr/bin/env bash
# Build LLVM's manual pages the way LLVM's own build does.
#
# LLVM writes its command guide in reStructuredText (llvm/docs/
# CommandGuide) and builds the pages with Sphinx's man builder
# (llvm/cmake/modules/AddSphinxTarget.cmake). Every package that ships
# LLVM tools ships their pages from its own LLVM source, so the
# command lives here, sourced by those docs recipes.
#
#   kandelo_llvm_command_guide_man_pages <llvm-src> <out-dir> <version> <date>
#       Run the dev shell's sphinx-build over <llvm-src>/llvm/docs into
#       <out-dir>, with the version and release from llvm's own
#       LLVMVersion.cmake, which must equal <version> (the package's).
#       Sphinx dates the pages by SOURCE_DATE_EPOCH, set to <date>
#       (YYYY-MM-DD, the release's date) instead of the build clock.
#
# Requires scripts/install-package-man-pages.sh to be sourced first.

kandelo_llvm_command_guide_man_pages() {
    local src="$1" out="$2" version="$3" date="$4"
    local version_file="$src/cmake/Modules/LLVMVersion.cmake"
    local major minor patch suffix release log
    llvm_version_part() {
        sed -nE "s/^ *set\\(LLVM_VERSION_$1 *([^)]*)\\)/\\1/p" "$version_file" | head -n 1
    }
    major="$(llvm_version_part MAJOR)"
    minor="$(llvm_version_part MINOR)"
    patch="$(llvm_version_part PATCH)"
    suffix="$(llvm_version_part SUFFIX)"
    release="$major.$minor.$patch$suffix"
    if [ "$release" != "$version" ]; then
        echo "kandelo_llvm_command_guide_man_pages: LLVMVersion.cmake says" \
            "$release, the package $version" >&2
        return 1
    fi

    rm -rf "$out" "$out.doctrees"
    log="$out.sphinx.log"
    # Upstream defect in LLVM 23's docs configuration, not a Kandelo gap:
    # conf.py skips the Markdown parser (myst_parser) for man builds,
    # but the root document became index.md, and Sphinx refuses to
    # build without a loadable root ("unable to load the master
    # document"). A plain `sphinx-build -b man -t builder-man` over
    # llvm-project-23.1.3/llvm/docs without myst_parser fails the same
    # way. The man builder writes only conf.py's man_pages list, so
    # rooting the build at one of those reStructuredText pages changes
    # no page. Only a Markdown-rooted tree gets the override.
    local root_override=()
    if [ ! -f "$src/llvm/docs/index.rst" ] && [ -f "$src/llvm/docs/index.md" ]; then
        root_override=(-D master_doc=CommandGuide/llvm-ar)
    fi
    # LLVM 23 moved the configuration conf.py imports into utils/docs;
    # LLVM's own Sphinx targets append it to PYTHONPATH the same way.
    PYTHONPATH="${PYTHONPATH:+$PYTHONPATH:}$src/utils/docs" \
    SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$date")" \
        sphinx-build -b man -d "$out.doctrees" -q -t builder-man \
            -D version="$major" -D release="$release" \
            "${root_override[@]+"${root_override[@]}"}" \
            "$src/llvm/docs" "$out" > "$log" 2>&1 || {
        tail -40 "$log" >&2
        return 1
    }
}
