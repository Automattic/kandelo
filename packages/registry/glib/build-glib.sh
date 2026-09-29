#!/usr/bin/env bash
#
# Build glib 2.84.4 (libglib-2.0.a, libgmodule-2.0.a, libgobject-2.0.a,
# libgio-2.0.a) for wasm32-posix-kernel.
#
# We bypass upstream's meson build: it runs host-side feature probes
# that misreport against the wasm sysroot. We compile the upstream TU
# lists directly with a hand-curated config.h + glibconfig.h
# (src/config.h, src/glibconfig.h), the same pattern as libxkbcommon /
# alsa-lib / libwayland. gregex.c compiles against the pcre2 package
# (glibmm's Glib::Error::register_init() calls g_regex_error_quark at
# startup, and Waybar's window-rewrite rules use Glib::Regex). gdbus
# and its dependents are excluded from gio (PR22 ports a dbus daemon
# first). See
# docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4.
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# when invoked via `cargo xtask build-deps resolve glib` the resolver
# sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL / _SOURCE_SHA256
# and WASM_POSIX_DEP_LIBFFI_DIR / WASM_POSIX_DEP_ZLIB_DIR /
# WASM_POSIX_DEP_PCRE2_DIR for deps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/glib-src"

GLIB_VERSION="${WASM_POSIX_DEP_VERSION:-2.84.4}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/glib-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/glib/2.84/glib-${GLIB_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set (must be invoked via cargo xtask build-deps resolve glib)}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:?WASM_POSIX_DEP_PCRE2_DIR not set}"

# --- Toolchain ----------------------------------------------------------
for tool in wasm32posix-cc wasm32posix-ar python3; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh (provides the" >&2
        echo "       wasm toolchain + python3 from flake.nix)." >&2
        exit 1
    fi
done

# --- Fetch + verify source ---------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading glib $GLIB_VERSION..."
    TARBALL="/tmp/glib-${GLIB_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    # Keep the dbus-backed built-in module registrations (notification
    # backends, portal monitors) out of gio init — their TUs are not
    # compiled. GIO_DBUS_BUILTIN_MODULES gates them back in if a port
    # ever needs one.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/giomodule-no-dbus-builtins.patch"
    # Route arity-changing callback casts (GDestroyNotify-as-GFunc,
    # GCompareFunc-as-GCompareDataFunc, GClosureNotify casts) through
    # typed thunks. Native ABIs tolerate the extra arguments; wasm's
    # typed call_indirect traps on them.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-callback-signatures.patch"
    # GCredentials backend selection keys off platform macros;
    # wasm32-posix-kernel follows the Linux ucred contract.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-credentials.patch"
fi

# Fresh build + install each run — stale objects would shadow config
# changes and the cache key varies per build.
BUILD_DIR="$SCRIPT_DIR/glib-build"
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: glib resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib"

# --- Curated config + generated headers ---------------------------------
cp "$SCRIPT_DIR/src/config.h" "$SRC_DIR/config.h"
cp "$SCRIPT_DIR/src/glibconfig.h" "$SRC_DIR/glib/glibconfig.h"

GEN_VIS="$SRC_DIR/tools/gen-visibility-macros.py"
echo "==> Generating version + visibility macro headers..."
python3 "$GEN_VIS" "$GLIB_VERSION" versions-macros \
    "$SRC_DIR/glib/gversionmacros.h.in" "$SRC_DIR/glib/gversionmacros.h"
python3 "$GEN_VIS" "$GLIB_VERSION" visibility-macros GLIB \
    "$SRC_DIR/glib/glib-visibility.h"
python3 "$GEN_VIS" "$GLIB_VERSION" visibility-macros GMODULE \
    "$SRC_DIR/gmodule/gmodule-visibility.h"
python3 "$GEN_VIS" "$GLIB_VERSION" visibility-macros GOBJECT \
    "$SRC_DIR/gobject/gobject-visibility.h"
python3 "$GEN_VIS" "$GLIB_VERSION" visibility-macros GIO \
    "$SRC_DIR/gio/gio-visibility.h"

# gnetworking.h: musl needs no nameser_compat include (gnetworking.h.in
# already carries the T_SRV fallback).
sed 's/@NAMESER_COMPAT_INCLUDE@//' \
    "$SRC_DIR/gio/gnetworking.h.in" > "$SRC_DIR/gio/gnetworking.h"

# gmoduleconf.h: dlopen backend (kandelo supports dlopen), dlerror
# present, no leading underscore, RTLD_GLOBAL works.
sed -e 's/@G_MODULE_IMPL@/G_MODULE_IMPL_DL/' \
    -e 's/@G_MODULE_HAVE_DLERROR@/1/' \
    -e 's/@G_MODULE_NEED_USCORE@/0/' \
    -e 's/@G_MODULE_BROKEN_RTLD_GLOBAL@/0/' \
    "$SRC_DIR/gmodule/gmoduleconf.h.in" > "$SRC_DIR/gmodule/gmoduleconf.h"

echo "==> Generating glib-enumtypes with glib-mkenums..."
MKENUMS="$BUILD_DIR/glib-mkenums"
sed "s|@PYTHON@|python3|" "$SRC_DIR/gobject/glib-mkenums.in" > "$MKENUMS"
python3 "$MKENUMS" --template "$SRC_DIR/gobject/glib-enumtypes.h.template" \
    "$SRC_DIR/glib/gunicode.h" > "$SRC_DIR/gobject/glib-enumtypes.h"
python3 "$MKENUMS" --template "$SRC_DIR/gobject/glib-enumtypes.c.template" \
    "$SRC_DIR/glib/gunicode.h" > "$SRC_DIR/gobject/glib-enumtypes.c"

# gioenumtypes runs over the full installed gio header set (upstream's
# gio_headers: base + application + settings + gdbus + gnetworking.h) —
# enum extraction has no link-time cost, and matching upstream keeps
# the generated GType list identical for future consumers.
GIO_ENUM_HEADERS=(
    gappinfo.h gasyncinitable.h gasyncresult.h gbufferedinputstream.h
    gbufferedoutputstream.h gbytesicon.h gcancellable.h gcontenttype.h
    gcharsetconverter.h gconverter.h gconverterinputstream.h
    gconverteroutputstream.h gdatagrambased.h gdatainputstream.h
    gdataoutputstream.h gdebugcontroller.h gdebugcontrollerdbus.h
    gdrive.h gemblem.h gemblemedicon.h gfile.h gfileattribute.h
    gfileenumerator.h gfileicon.h gfileinfo.h gfileinputstream.h
    gfilemonitor.h gfilenamecompleter.h gfileoutputstream.h
    gfileiostream.h gfilterinputstream.h gfilteroutputstream.h gicon.h
    ginetaddress.h ginetaddressmask.h ginetsocketaddress.h ginitable.h
    ginputstream.h gio.h gio-autocleanups.h gioenums.h gioerror.h
    giomodule.h gioscheduler.h giostream.h giotypes.h gloadableicon.h
    gmount.h gmemoryinputstream.h gmemorymonitor.h gmemoryoutputstream.h
    gmountoperation.h gnativesocketaddress.h gnativevolumemonitor.h
    gnetworkaddress.h gnetworkmonitor.h gnetworkservice.h
    goutputstream.h gpermission.h gpollableinputstream.h
    gpollableoutputstream.h gpollableutils.h gpowerprofilemonitor.h
    gproxy.h gproxyaddress.h gproxyaddressenumerator.h gproxyresolver.h
    gresolver.h gresource.h gseekable.h gsimpleasyncresult.h
    gsimpleiostream.h gsimplepermission.h gsimpleproxyresolver.h
    gsocket.h gsocketaddress.h gsocketaddressenumerator.h
    gsocketclient.h gsocketconnectable.h gsocketconnection.h
    gsocketcontrolmessage.h gsocketlistener.h gsocketservice.h
    gsrvtarget.h gsubprocess.h gsubprocesslauncher.h gtask.h
    gtcpconnection.h gtcpwrapperconnection.h gthemedicon.h
    gthreadedsocketservice.h gtlsbackend.h gtlscertificate.h
    gtlsclientconnection.h gtlsconnection.h gtlsdatabase.h
    gtlsfiledatabase.h gtlsinteraction.h gtlspassword.h
    gtlsserverconnection.h gdtlsconnection.h gdtlsclientconnection.h
    gdtlsserverconnection.h gunixconnection.h gunixcredentialsmessage.h
    gunixfdlist.h gunixsocketaddress.h gvfs.h gvolume.h gvolumemonitor.h
    gzlibcompressor.h gzlibdecompressor.h glistmodel.h gliststore.h
    gio-visibility.h
    gapplication.h gapplicationcommandline.h gactiongroup.h gactionmap.h
    gsimpleactiongroup.h gremoteactiongroup.h gactiongroupexporter.h
    gdbusactiongroup.h gaction.h gpropertyaction.h gsimpleaction.h
    gmenumodel.h gmenu.h gmenuexporter.h gdbusmenumodel.h gnotification.h
    gsettingsbackend.h gsettingsschema.h gsettings.h
    gdbusauthobserver.h gcredentials.h gdbusutils.h gdbuserror.h
    gdbusaddress.h gdbusconnection.h gdbusmessage.h gdbusnameowning.h
    gdbusnamewatching.h gdbusproxy.h gdbusintrospection.h
    gdbusmethodinvocation.h gdbusserver.h gdbusinterface.h
    gdbusinterfaceskeleton.h gdbusobject.h gdbusobjectskeleton.h
    gdbusobjectproxy.h gdbusobjectmanager.h gdbusobjectmanagerclient.h
    gdbusobjectmanagerserver.h gtestdbus.h
    gnetworking.h
)
GIO_ENUM_INPUTS=()
for h in "${GIO_ENUM_HEADERS[@]}"; do
    GIO_ENUM_INPUTS+=("$SRC_DIR/gio/$h")
done
python3 "$MKENUMS" --template "$SRC_DIR/gio/gioenumtypes.h.template" \
    "${GIO_ENUM_INPUTS[@]}" > "$SRC_DIR/gio/gioenumtypes.h"
python3 "$MKENUMS" --template "$SRC_DIR/gio/gioenumtypes.c.template" \
    "${GIO_ENUM_INPUTS[@]}" > "$SRC_DIR/gio/gioenumtypes.c"

# --- Compile ------------------------------------------------------------
CFLAGS=(
    -O2 -fPIC -fvisibility=hidden -std=gnu11
    "-I$SRC_DIR"          # config.h at source root, "glib/..." includes
    "-I$SRC_DIR/glib"     # glibconfig.h + internal headers
    "-I$PCRE2_PREFIX/include"  # pcre2.h, included by gregex.c
    -Wno-unused-parameter
    -Wno-unused-function
    -Wno-unused-variable
    -Wno-deprecated-declarations
)

# TU paths are relative to $SRC_DIR; subdirs encode into the object name
# to avoid collisions in the flat build dir.
compile() {
    local tu="$1"; shift
    local obj="$BUILD_DIR/$(echo "$tu" | sed 's#/#_#g; s#\.c$#.o#')"
    echo "    $tu" >&2
    wasm32posix-cc -c "${CFLAGS[@]}" "$@" "$SRC_DIR/$tu" -o "$obj"
    echo "$obj"
}

GLIB_TUS=(
    glib/garcbox.c glib/garray.c glib/gasyncqueue.c glib/gatomic.c
    glib/gbacktrace.c glib/gbase64.c glib/gbitlock.c glib/gbookmarkfile.c
    glib/gbytes.c glib/gcharset.c glib/gchecksum.c glib/gconvert.c
    glib/gdataset.c glib/gdate.c glib/gdatetime.c glib/gdatetime-private.c
    glib/gdir.c glib/genviron.c glib/gerror.c glib/gfileutils.c
    glib/ggettext.c glib/ghash.c glib/ghmac.c glib/ghook.c
    glib/ghostutils.c glib/giochannel.c glib/gkeyfile.c glib/glib-init.c
    glib/glib-private.c glib/glist.c glib/gmain.c glib/gmappedfile.c
    glib/gmarkup.c glib/gmem.c glib/gmessages.c glib/gnode.c
    glib/goption.c glib/gpathbuf.c glib/gpattern.c glib/gpoll.c
    glib/gprimes.c glib/gqsort.c glib/gquark.c glib/gqueue.c
    glib/grand.c glib/grcbox.c glib/gregex.c glib/grefcount.c glib/grefstring.c
    glib/gscanner.c glib/gsequence.c glib/gshell.c glib/gslice.c
    glib/gslist.c glib/gspawn.c glib/gstdio.c glib/gstrfuncs.c
    glib/gstring.c glib/gstringchunk.c glib/gstrvbuilder.c
    glib/gtestutils.c glib/gthread.c glib/gthreadpool.c glib/gtimer.c
    glib/gtimezone.c glib/gtrace.c glib/gtranslit.c glib/gtrashstack.c
    glib/gtree.c glib/guniprop.c glib/gutf8.c glib/gunibreak.c
    glib/gunicollate.c glib/gunidecomp.c glib/guri.c glib/gutils.c
    glib/guuid.c glib/gvariant.c glib/gvariant-core.c
    glib/gvariant-parser.c glib/gvariant-serialiser.c
    glib/gvarianttypeinfo.c glib/gvarianttype.c glib/gversion.c
    glib/gwakeup.c glib/gprintf.c
    glib/glib-unix.c glib/gspawn-posix.c glib/giounix.c
    glib/deprecated/gallocator.c glib/deprecated/gcache.c
    glib/deprecated/gcompletion.c glib/deprecated/grel.c
    glib/deprecated/gthread-deprecated.c
)

echo "==> Compiling ${#GLIB_TUS[@]} glib TUs for wasm32..."
GLIB_OBJS=()
for tu in "${GLIB_TUS[@]}"; do
    GLIB_OBJS+=("$(compile "$tu" -DGLIB_COMPILATION '-DG_LOG_DOMAIN="GLib"')")
done
GLIB_OBJS+=("$(compile glib/libcharset/localcharset.c \
    -DGLIB_COMPILATION '-DG_LOG_DOMAIN="GLib"' '-DLIBDIR="/usr/lib"')")

echo "==> Compiling gmodule..."
GMODULE_OBJS=(
    "$(compile gmodule/gmodule.c \
        -DGMODULE_COMPILATION '-DG_LOG_DOMAIN="GModule"' "-I$SRC_DIR/gmodule")"
    "$(compile gmodule/gmodule-deprecated.c \
        -DGMODULE_COMPILATION '-DG_LOG_DOMAIN="GModule"' "-I$SRC_DIR/gmodule")"
)

echo "==> Compiling gobject..."
GOBJECT_TUS=(
    gobject/gatomicarray.c gobject/gbinding.c gobject/gbindinggroup.c
    gobject/gboxed.c gobject/gclosure.c gobject/genums.c
    gobject/gmarshal.c gobject/gobject.c gobject/gparam.c
    gobject/gparamspecs.c gobject/gsignal.c gobject/gsignalgroup.c
    gobject/gsourceclosure.c gobject/gtype.c gobject/gtypemodule.c
    gobject/gtypeplugin.c gobject/gvalue.c gobject/gvaluearray.c
    gobject/gvaluetransform.c gobject/gvaluetypes.c
    gobject/glib-enumtypes.c
)
GOBJECT_OBJS=()
for tu in "${GOBJECT_TUS[@]}"; do
    GOBJECT_OBJS+=("$(compile "$tu" \
        -DGOBJECT_COMPILATION '-DG_LOG_DOMAIN="GLib-GObject"' \
        "-I$SRC_DIR/gobject" "-I$LIBFFI_PREFIX/include")")
done

echo "==> Compiling gio..."
# Upstream gio_sources + gdbus_sources (the PR22 client core) minus:
# gdbus_daemon_sources, application_sources, portal_sources, the
# three dbus-backed monitors from the base list, the two dbus-backed
# notification backends from the unix list, and the netlink monitors
# (no HAVE_NETLINK). GIO_DBUS_BUILTIN_MODULES stays undefined: the
# guarded g_type_ensure registrations point at exactly those excluded
# TUs; define it only when a port needs a dbus-backed built-in module
# and its sources join this list. gportalstubs.c replaces the four
# portal entry points referenced behind glib_should_use_portal().
GIO_TUS=(
    gio/gappinfo.c gio/gasynchelper.c gio/gasyncinitable.c
    gio/gasyncresult.c gio/gbufferedinputstream.c
    gio/gbufferedoutputstream.c gio/gbytesicon.c gio/gcancellable.c
    gio/gcharsetconverter.c gio/gcontenttype.c
    gio/gcontextspecificgroup.c gio/gconverter.c
    gio/gconverterinputstream.c gio/gconverteroutputstream.c
    gio/gcredentials.c gio/gdatagrambased.c gio/gdatainputstream.c
    gio/gdataoutputstream.c gio/gdebugcontroller.c gio/gdrive.c
    gio/gdummyfile.c gio/gdummyproxyresolver.c gio/gdummytlsbackend.c
    gio/gemblem.c gio/gemblemedicon.c gio/gfile.c gio/gfileattribute.c
    gio/gfileenumerator.c gio/gfileicon.c gio/gfileinfo.c
    gio/gfileinputstream.c gio/gfilemonitor.c gio/gfilenamecompleter.c
    gio/gfileoutputstream.c gio/gfileiostream.c gio/gfilterinputstream.c
    gio/gfilteroutputstream.c gio/gicon.c gio/ginetaddress.c
    gio/ginetaddressmask.c gio/ginetsocketaddress.c gio/ginitable.c
    gio/ginputstream.c gio/gioerror.c gio/giomodule.c
    gio/giomodule-priv.c gio/gioscheduler.c gio/giostream.c
    gio/gloadableicon.c gio/gmarshal-internal.c gio/gmount.c
    gio/gmemorymonitor.c gio/gmemoryinputstream.c
    gio/gmemoryoutputstream.c gio/gmountoperation.c
    gio/gnativesocketaddress.c gio/gnativevolumemonitor.c
    gio/gnetworkaddress.c gio/gnetworking.c gio/gnetworkmonitor.c
    gio/gnetworkmonitorbase.c gio/gnetworkservice.c gio/goutputstream.c
    gio/gpermission.c gio/gpollableinputstream.c
    gio/gpollableoutputstream.c gio/gpollableutils.c
    gio/gpollfilemonitor.c gio/gpowerprofilemonitor.c gio/gproxy.c
    gio/gproxyaddress.c gio/gproxyaddressenumerator.c
    gio/gproxyresolver.c gio/gresolver.c gio/gresource.c
    gio/gresourcefile.c gio/gseekable.c gio/gsimpleasyncresult.c
    gio/gsimpleiostream.c gio/gsimplepermission.c
    gio/gsimpleproxyresolver.c gio/gsocket.c gio/gsocketaddress.c
    gio/gsocketaddressenumerator.c gio/gsocketclient.c
    gio/gsocketconnectable.c gio/gsocketconnection.c
    gio/gsocketcontrolmessage.c gio/gsocketinputstream.c
    gio/gsocketlistener.c gio/gsocketoutputstream.c
    gio/gsocketservice.c gio/gsrvtarget.c gio/gsubprocesslauncher.c
    gio/gsubprocess.c gio/gtask.c gio/gtcpconnection.c
    gio/gtcpwrapperconnection.c gio/gthemedicon.c
    gio/gthreadedsocketservice.c gio/gthreadedresolver.c
    gio/gtlsbackend.c gio/gtlscertificate.c gio/gtlsclientconnection.c
    gio/gtlsconnection.c gio/gtlsdatabase.c gio/gtlsfiledatabase.c
    gio/gtlsinteraction.c gio/gtlspassword.c gio/gtlsserverconnection.c
    gio/gdtlsconnection.c gio/gdtlsclientconnection.c
    gio/gdtlsserverconnection.c gio/gunionvolumemonitor.c
    gio/gunixconnection.c gio/gunixfdlist.c
    gio/gunixcredentialsmessage.c gio/gunixsocketaddress.c gio/gvfs.c
    gio/gvolume.c gio/gvolumemonitor.c gio/gzlibcompressor.c
    gio/gzlibdecompressor.c gio/glistmodel.c gio/gliststore.c
    gio/gdelayedsettingsbackend.c gio/gkeyfilesettingsbackend.c
    gio/gmemorysettingsbackend.c gio/gnullsettingsbackend.c
    gio/gsettingsbackend.c gio/gsettingsschema.c gio/gsettings-mapping.c
    gio/gsettings.c
    gio/ghttpproxy.c gio/glocalfile.c gio/glocalfileenumerator.c
    gio/glocalfileinfo.c gio/glocalfileinputstream.c
    gio/glocalfilemonitor.c gio/glocalfileoutputstream.c
    gio/glocalfileiostream.c gio/glocalvfs.c gio/gsocks4proxy.c
    gio/gsocks4aproxy.c gio/gsocks5proxy.c gio/thumbnail-verify.c
    gio/gfiledescriptorbased.c gio/giounix-private.c
    gio/gunixfdmessage.c gio/gunixmount.c gio/gunixmounts.c
    gio/gunixvolume.c gio/gunixvolumemonitor.c gio/gunixinputstream.c
    gio/gunixoutputstream.c
    gio/gcontenttype-fdo.c gio/gdesktopappinfo.c
    gio/gportalsupport.c gio/gsandbox.c
    gio/gdbusutils.c gio/gdbusaddress.c gio/gdbusauthobserver.c
    gio/gdbusauth.c gio/gdbusauthmechanism.c
    gio/gdbusauthmechanismanon.c gio/gdbusauthmechanismexternal.c
    gio/gdbusauthmechanismsha1.c gio/gdbuserror.c gio/gdbusconnection.c
    gio/gdbusmessage.c gio/gdbusnameowning.c gio/gdbusnamewatching.c
    gio/gdbusproxy.c gio/gdbusprivate.c gio/gdbusintrospection.c
    gio/gdbusmethodinvocation.c gio/gdbusserver.c gio/gdbusinterface.c
    gio/gdbusinterfaceskeleton.c gio/gdbusobject.c
    gio/gdbusobjectskeleton.c gio/gdbusobjectproxy.c
    gio/gdbusobjectmanager.c gio/gdbusobjectmanagerclient.c
    gio/gdbusobjectmanagerserver.c gio/gtestdbus.c
    gio/gapplication.c gio/gapplicationcommandline.c
    gio/gapplicationimpl-dbus.c gio/gactiongroup.c gio/gactionmap.c
    gio/gsimpleactiongroup.c gio/gremoteactiongroup.c
    gio/gactiongroupexporter.c gio/gdbusactiongroup.c gio/gaction.c
    gio/gpropertyaction.c gio/gsimpleaction.c gio/gmenumodel.c
    gio/gmenu.c gio/gmenuexporter.c gio/gdbusmenumodel.c
    gio/gnotification.c gio/gnotificationbackend.c
    gio/gioenumtypes.c
)
GIO_CFLAGS=(
    -DGIO_COMPILATION '-DG_LOG_DOMAIN="GLib-GIO"'
    '-DGIO_MODULE_DIR="/usr/lib/gio/modules"'
    '-DGIO_LAUNCH_DESKTOP="/usr/libexec/gio-launch-desktop"'
    '-DLOCALSTATEDIR="/var"'
    "-I$SRC_DIR/gio" "-I$SRC_DIR/gmodule" "-I$SRC_DIR/subprojects/gvdb"
    "-I$ZLIB_PREFIX/include"
)
GIO_OBJS=()
for tu in "${GIO_TUS[@]}"; do
    GIO_OBJS+=("$(compile "$tu" "${GIO_CFLAGS[@]}")")
done
cp "$SCRIPT_DIR/src/gportalstubs.c" "$SRC_DIR/gio/gportalstubs.c"
GIO_OBJS+=("$(compile gio/gportalstubs.c "${GIO_CFLAGS[@]}")")
GIO_OBJS+=("$(compile subprojects/gvdb/gvdb/gvdb-reader.c "${GIO_CFLAGS[@]}")")
for tu in xdgmime/xdgmime.c xdgmime/xdgmimealias.c xdgmime/xdgmimecache.c \
          xdgmime/xdgmimeglob.c xdgmime/xdgmimeicon.c xdgmime/xdgmimeint.c \
          xdgmime/xdgmimemagic.c xdgmime/xdgmimeparent.c; do
    GIO_OBJS+=("$(compile "gio/$tu" -DXDG_PREFIX=_gio_xdg)")
done

echo "==> Archiving..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libglib-2.0.a" "${GLIB_OBJS[@]}"
wasm32posix-ar rcs "$INSTALL_DIR/lib/libgmodule-2.0.a" "${GMODULE_OBJS[@]}"
wasm32posix-ar rcs "$INSTALL_DIR/lib/libgobject-2.0.a" "${GOBJECT_OBJS[@]}"
wasm32posix-ar rcs "$INSTALL_DIR/lib/libgio-2.0.a" "${GIO_OBJS[@]}"

# --- Install headers -----------------------------------------------------
echo "==> Installing headers..."
INC="$INSTALL_DIR/include/glib-2.0"
mkdir -p "$INC/glib/deprecated" "$INC/gobject" "$INC/gmodule" "$INC/gio"
cp "$SRC_DIR/glib/glibconfig.h" "$INC/glibconfig.h"
cp "$SRC_DIR/glib/glib.h" "$SRC_DIR/glib/glib-object.h" \
   "$SRC_DIR/glib/glib-unix.h" "$SRC_DIR/gmodule/gmodule.h" "$INC/"
cp "$SRC_DIR/glib/"*.h "$INC/glib/"
cp "$SRC_DIR/glib/deprecated/"*.h "$INC/glib/deprecated/"
cp "$SRC_DIR/gobject/"*.h "$INC/gobject/"
cp "$SRC_DIR/gobject/gobjectnotifyqueue.c" "$INC/gobject/"
cp "$SRC_DIR/gmodule/gmodule-visibility.h" "$SRC_DIR/gmodule/gmoduleconf.h" \
   "$INC/gmodule/"
cp "$SRC_DIR/gio/"*.h "$INC/gio/"

# --- host tools ----------------------------------------------------------
# glib-mkenums and glib-genmarshal are host-side python scripts;
# dependent autotools ports (pango, gdk-pixbuf, GTK3) locate them
# through the glib-2.0.pc glib_mkenums / glib_genmarshal variables.
# glib-compile-resources and glib-compile-schemas are compiled C host
# tools and come from the nix host glib in flake.nix instead.
echo "==> Installing glib-mkenums + glib-genmarshal..."
mkdir -p "$INSTALL_DIR/bin"
sed 's|@PYTHON@|/usr/bin/env python3|' \
    "$SRC_DIR/gobject/glib-mkenums.in" > "$INSTALL_DIR/bin/glib-mkenums"
chmod +x "$INSTALL_DIR/bin/glib-mkenums"
sed 's|@PYTHON@|/usr/bin/env python3|' \
    "$SRC_DIR/gobject/glib-genmarshal.in" > "$INSTALL_DIR/bin/glib-genmarshal"
chmod +x "$INSTALL_DIR/bin/glib-genmarshal"

# --- pkg-config ----------------------------------------------------------
echo "==> Writing pkg-config files..."
PC_DIR="$INSTALL_DIR/lib/pkgconfig"
mkdir -p "$PC_DIR"
for lib in glib gmodule gmodule-no-export gobject gio gio-unix gthread; do
    case "$lib" in
        glib)    libs="-lglib-2.0" ;;
        # Static build — gmodule and gmodule-no-export are the same
        # archive; gdk-pixbuf and GTK3 probe the no-export variant.
        gmodule | gmodule-no-export) libs="-lgmodule-2.0 -lglib-2.0" ;;
        gobject) libs="-lgobject-2.0 -lglib-2.0 -lffi" ;;
        # The unix symbols (gunixfdlist, gunixsocketaddress, …) are
        # compiled into libgio; gio-unix-2.0 is a probe-name shim for
        # consumers that require it (GTK3, dbus tools).
        gio | gio-unix) libs="-lgio-2.0 -lgobject-2.0 -lgmodule-2.0 -lglib-2.0 -lffi -lz" ;;
        # Threading lives in libglib since 2.32; upstream still ships
        # a gthread-2.0.pc for consumers that probe it (pango 1.42).
        gthread) libs="-lglib-2.0" ;;
    esac
    # gregex.c lives in libglib-2.0, which every variant above links,
    # so each one needs pcre2. The search path is absolute: consumer
    # build scripts compose PKG_CONFIG_PATH from their own declared
    # prefixes and would not find a bare -lpcre2-8.
    libs="$libs -L$PCRE2_PREFIX/lib -lpcre2-8"
    cat > "$PC_DIR/$lib-2.0.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include
glib_mkenums=\${prefix}/bin/glib-mkenums
glib_genmarshal=\${prefix}/bin/glib-genmarshal

Name: $lib
Description: $lib for wasm32-posix-kernel (static)
Version: $GLIB_VERSION
Libs: -L\${libdir} $libs
Cflags: -I\${includedir}/glib-2.0
EOF
done

echo "==> glib $GLIB_VERSION installed at $INSTALL_DIR"
for a in libglib-2.0.a libgmodule-2.0.a libgobject-2.0.a libgio-2.0.a; do
    echo "    lib/$a ($(wc -c < "$INSTALL_DIR/lib/$a") bytes)"
done
