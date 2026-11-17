# Sourced, not executed. sudo's configure invocation, shared by
# build-sudo.sh and sudo-docs/build-sudo-docs.sh: configure fills in the
# manual pages (paths, defaults) as well as the programs, so both must see
# the same configuration.
#
#   sudo_configure <source-dir> <work-dir> <sdk-root>
#       Run <source-dir>/configure in the current directory.
#
# --with-mdoc fixes the manual pages' macro set. configure otherwise picks
# it from whichever nroff or mandoc the build machine has; it does not
# affect the programs.
sudo_configure() {
    local source_dir="$1" work_dir="$2" sdk_root="$3"
    export ac_cv_func_devname=no ac_cv_func_freezero=no
    export ac_cv_func_getutsid=no ac_cv_func_getutxid=yes
    export ac_cv_func__innetgr=no ac_cv_func_innetgr=no
    export ac_cv_func_mkdtempat=no ac_cv_func_mkostempsat=no
    export ac_cv_func_pw_dup=no ac_cv_func_setgroupent=no
    export ac_cv_func_setpassent=no ac_cv_func_sysctl=no
    export CONFIG_SITE="$sdk_root/config.site"
    local src="/usr/src/sudo-$WASM_POSIX_DEP_VERSION" prefix_maps
    prefix_maps="-ffile-prefix-map=$work_dir=$src"
    prefix_maps+=" -fdebug-prefix-map=$work_dir=$src"
    prefix_maps+=" -fmacro-prefix-map=$work_dir=$src"
    prefix_maps+=" -fdebug-compilation-dir=$src"
    export CFLAGS="-O2 -D_GNU_SOURCE $prefix_maps"

    "$source_dir/configure" \
        --host=wasm32-unknown-none --prefix=/usr --sysconfdir=/etc \
        --localstatedir=/var --runstatedir=/var/run --disable-nls \
        --without-pam --without-sendmail --without-interfaces \
        --disable-log-server --disable-log-client --disable-shared-libutil \
        --enable-static-sudoers --disable-shared --enable-static \
        --disable-hardening --disable-pie --with-logging=file \
        --with-rundir=/var/run/sudo --with-vardir=/var/run/sudo \
        --with-iologdir=/var/log/sudo-io \
        --with-secure-path-value=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        --with-mdoc \
        CC=wasm32posix-cc CXX=wasm32posix-c++ AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib NM=wasm32posix-nm STRIP=wasm32posix-strip
}
