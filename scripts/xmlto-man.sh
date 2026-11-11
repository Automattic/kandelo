#!/usr/bin/env bash
# `xmlto man`, for docs packages (git-docs, dbus-docs) whose upstream
# renders DocBook with xmlto, built from pinned DocBook XSL instead:
#
#   xmlto-man.sh [-m <custom.xsl>]... [--stringparam <name>=<value>]... \
#       man <page.xml>
#
# xmlto's man format runs xsltproc over one stylesheet that imports DocBook
# XSL's manpages stylesheet and includes each -m stylesheet, plus a layer
# of its own that sets man.charmap.use.subset to 0 (it writes that layer
# whenever `locale charmap` answers, so in practice always): every
# character DocBook XSL's charmap knows becomes a troff escape rather than
# raw UTF-8. It writes the page into the current directory. This does the
# same, with DocBook XSL at $DOCBOOK_XSL. As with xmlto, the DocBook DTD a
# page declares is read only if XML_CATALOG_FILES resolves it (--nonet);
# a page that uses the DTD's entities needs it. xsltproc is flake.nix's
# pinned libxslt.
set -euo pipefail

: "${DOCBOOK_XSL:?xmlto-man.sh: set DOCBOOK_XSL to the DocBook XSL tree}"
command -v xsltproc >/dev/null || {
    echo "xmlto-man.sh: xsltproc is not on PATH (flake.nix provides it)" >&2
    exit 2
}
layers=() params=() input="" format=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -m) layers+=("$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"); shift 2 ;;
        --stringparam) params+=(--stringparam "${2%%=*}" "${2#*=}"); shift 2 ;;
        man) format=man; shift ;;
        -*) echo "xmlto-man.sh: unsupported option $1" >&2; exit 2 ;;
        *) [ -z "$input" ] || { echo "xmlto-man.sh: more than one input" >&2; exit 2; }
           input="$1"; shift ;;
    esac
done
[ "$format" = man ] && [ -n "$input" ] || {
    echo "xmlto-man.sh: usage: xmlto-man.sh [-m xsl]... [--stringparam k=v]... man <page.xml>" >&2
    exit 2
}

layer_dir="$(mktemp -d)"
trap 'rm -rf "$layer_dir"' EXIT
cat > "$layer_dir/charmap.xsl" <<'XSL'
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">
  <xsl:param name="man.charmap.use.subset" select="'0'"/>
</xsl:stylesheet>
XSL
{
    echo '<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">'
    echo "  <xsl:import href=\"$DOCBOOK_XSL/manpages/docbook.xsl\"/>"
    for layer in "$layer_dir/charmap.xsl" ${layers[@]+"${layers[@]}"}; do
        echo "  <xsl:include href=\"$layer\"/>"
    done
    echo '</xsl:stylesheet>'
} > "$layer_dir/man.xsl"
xsltproc --nonet --xinclude ${params[@]+"${params[@]}"} "$layer_dir/man.xsl" "$input"
