#!/usr/bin/env bash
# Write relocatable pkg-config metadata for Kandelo's sysroot graphics shims.
set -euo pipefail

group="${1:-}"
pc_dir="${2:-}"
if [ -z "$group" ] || [ -z "$pc_dir" ]; then
    echo "usage: write-graphics-pkgconfig.sh <dri|gles> <pkgconfig-dir>" >&2
    exit 2
fi

mkdir -p "$pc_dir"

case "$group" in
    dri)
        cat >"$pc_dir/libdrm.pc" <<'EOF'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: libdrm
Description: Kandelo wasm DRI userspace shim
Version: 1.0.0
Libs: -L${libdir} -ldrm
Cflags: -I${includedir}
EOF

        cat >"$pc_dir/gbm.pc" <<'EOF'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: gbm
Description: Kandelo wasm GBM userspace shim
Version: 1.0.0
Libs: -L${libdir} -lgbm -ldrm
Cflags: -I${includedir}
EOF
        ;;
    gles)
        cat >"$pc_dir/egl.pc" <<'EOF'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: egl
Description: Kandelo wasm EGL userspace shim
Version: 1.0.0
Libs: -L${libdir} -lEGL
Cflags: -I${includedir}
EOF

        cat >"$pc_dir/glesv2.pc" <<'EOF'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: glesv2
Description: Kandelo wasm GLESv2 userspace shim
Version: 1.0.0
Libs: -L${libdir} -lGLESv2
Cflags: -I${includedir}
EOF
        ;;
    *)
        echo "write-graphics-pkgconfig.sh: unsupported group '$group' (expected dri or gles)" >&2
        exit 2
        ;;
esac
