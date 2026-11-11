#!/usr/bin/env bash
# Ship the `foot` package's manual pages as foot-docs.zip, a lazy archive
# mounted at /usr/.
#
# Upstream writes them in scdoc. doc/meson.build first fills in the
# build's defaults (configure_file), then runs scdoc over each page; this
# does the same with the values build-foot.sh builds foot with: default
# TERM "foot" and no utmp backend. footclient.1 is not shipped: the image
# installs foot only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
kandelo_man_pages_build_scdoc
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 1.17.2=2024-04-17)"

# The pages state these defaults; fail if foot stops being built with them.
FOOT_BUILD="$REPO_ROOT/packages/registry/foot/build-foot.sh"
grep -qF "'-DFOOT_DEFAULT_TERM=\"foot\"'" "$FOOT_BUILD" || {
    echo "build-foot-docs: build-foot.sh no longer sets FOOT_DEFAULT_TERM=\"foot\"" >&2
    exit 1
}
if grep -q 'UTMP_' "$FOOT_BUILD"; then
    echo "build-foot-docs: build-foot.sh now enables a utmp backend" >&2
    exit 1
fi

# doc/meson.build's values when utmp_backend is 'none'.
NO_UTMP='<no utmp support in foot>'
OUT="$SRC/kandelo-man"
mkdir -p "$OUT"
kandelo_man_pages_substitute "$SRC/doc/foot.1.scd" "$OUT/foot.1.scd" \
    @default_terminfo@=foot
kandelo_man_pages_substitute "$SRC/doc/foot.ini.5.scd" "$OUT/foot.ini.5.scd" \
    @default_terminfo@=foot \
    "@utmp_add_args@=$NO_UTMP" \
    "@utmp_del_args@=$NO_UTMP" \
    @utmp_helper_path@=none
cp "$SRC/doc/foot-ctlseqs.7.scd" "$OUT/foot-ctlseqs.7.scd"
for page in foot.1 foot.ini.5 foot-ctlseqs.7; do
    kandelo_man_pages_scdoc "$DATE" "$OUT/$page.scd" "$OUT/$page"
done

install_package_man_pages foot-docs "$SRC" \
    kandelo-man/foot.1 \
    kandelo-man/foot.ini.5 \
    kandelo-man/foot-ctlseqs.7
