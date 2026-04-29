#!/usr/bin/env bash
set -euo pipefail

# Build bash 5.2 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Applies asyncify with an onlylist so fork works (pipes, $(cmd), subshells).
#
# Output: examples/libs/bash/bin/bash.wasm

BASH_VERSION_PKG="${BASH_VERSION_PKG:-5.2.37}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/bash-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
ONLYLIST="$SCRIPT_DIR/asyncify-onlylist.txt"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -z "$WASM_OPT" ]; then
    echo "ERROR: wasm-opt not found. Install binaryen." >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/glue"

# --- Resolve ncurses via the dep cache (provides libtinfo for bash readline) ---
NCURSES_PREFIX="${WASM_POSIX_DEP_NCURSES_DIR:-}"
if [ -z "$NCURSES_PREFIX" ]; then
    echo "==> Resolving ncurses via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    NCURSES_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve ncurses)"
fi
if [ ! -f "$NCURSES_PREFIX/lib/libtinfo.a" ]; then
    echo "ERROR: ncurses resolve returned '$NCURSES_PREFIX' but libtinfo.a missing" >&2
    exit 1
fi
echo "==> ncurses at $NCURSES_PREFIX"
export CPPFLAGS="-I$NCURSES_PREFIX/include"
export LDFLAGS_NCURSES="-L$NCURSES_PREFIX/lib"

# --- Download bash source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading bash $BASH_VERSION_PKG..."
    TARBALL="bash-${BASH_VERSION_PKG}.tar.gz"
    URL="https://ftpmirror.gnu.org/gnu/bash/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring bash for wasm32..."

    # Most cache variables come from sdk/config.site via wasm32posix-configure.
    # Only override bash-specific cache here.

    # Bash-specific cache — configure probes these with runtime tests we can't execute
    export bash_cv_dup2_broken=no
    export bash_cv_pgrp_pipe=no
    export bash_cv_sys_siglist=no
    export bash_cv_under_sys_siglist=no
    export bash_cv_getenv_redef=yes
    export bash_cv_printf_a_format=yes
    export bash_cv_mail_dir=/var/mail
    export bash_cv_func_sigsetjmp=present
    export bash_cv_func_strcoll_broken=no
    export bash_cv_must_reinstall_sighandlers=no
    export bash_cv_job_control_missing=present
    export bash_cv_sys_named_pipes=present
    export bash_cv_unusable_rtsigs=no
    export bash_cv_type_rlimit=quad_t
    export bash_cv_wcontinued_broken=no
    export bash_cv_fpurge_missing=yes
    export bash_cv_fnmatch_equiv_fallback=yes
    export bash_cv_sys_errlist=yes
    export bash_cv_func_strcasestr=yes
    export bash_cv_getcwd_malloc=yes
    export bash_cv_mkfifo_supported=yes
    export bash_cv_termcap_lib=libtinfo
    export bash_cv_struct_timespec_in_time_h=yes
    export bash_cv_struct_stat_st_atim_tv_nsec=yes
    export bash_cv_dev_fd=absent
    export bash_cv_dev_stdin=absent

    # Functions bash probes for that musl provides but the SDK config.site doesn't cover
    export ac_cv_func_getwd=no
    export ac_cv_func_sigrelse=no
    export ac_cv_func_ulimit=no
    export ac_cv_func_fpurge=no
    export ac_cv_func___fpurge=yes

    # glibc extensions not in musl — bash's configure wrongly detects them as
    # present when cross-compiling without link tests. Force bash to use its
    # own fallback implementations (shipped in lib/sh/).
    export ac_cv_func_mbschr=no
    export ac_cv_func_mbsnrtowcs=no
    export ac_cv_func_wcsnrtombs=no
    export ac_cv_func_fgets_unlocked=no
    export ac_cv_func_fputs_unlocked=no
    export ac_cv_func_getc_unlocked=no
    export ac_cv_func_getchar_unlocked=no
    export ac_cv_func_putc_unlocked=no
    export ac_cv_func_putchar_unlocked=no

    # -gline-tables-only keeps DWARF line tables for wasm-opt's asyncify pass
    # to read function names from (the wasm `name` section is stripped by
    # clang's driver's default post-link wasm-opt, but DWARF is preserved).
    export CFLAGS="-O2 -gline-tables-only -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
    export LDFLAGS="-Wl,-z,stack-size=1048576 ${LDFLAGS_NCURSES:-}"

    wasm32posix-configure \
        --prefix=/usr \
        --without-bash-malloc \
        --enable-readline \
        --enable-history \
        --enable-bang-history \
        --with-curses \
        --disable-nls \
        --disable-mem-scramble \
        --disable-net-redirections \
        --disable-progcomp \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Patch host-generated files ---
# signames.c is generated by mksignames (host binary) using the build host's
# signal numbers. On macOS, SIGUSR1=30, but on Linux/wasm32 SIGUSR1=10.
# Regenerating after build is too late — signames.c is compiled in.
if [ -f support/signames.c ] || [ -f signames.c ]; then
    echo "==> Patching signal names for Linux/wasm32..."
    # Will be regenerated during make; we patch post-gen below
fi

# --- wasm32 function pointer signature fix ---
# Bash's unwind_prot system stores cleanup functions as `Function *` (typedef'd
# as `int Function()` — K&R no-args). On wasm32, call_indirect requires exact
# signature match; x86/ARM ABIs tolerate mismatch. Most cleanups are
# `void (*)(void *)`. The no-arg ones trap with "indirect call type mismatch".
#
# Fix 1: patch unwind_frame_run_internal to cast cleanup to (void(*)(void*))
# Fix 2: patch the no-arg cleanup functions (pop_stream, parser_restore_alias)
#        to accept an unused void* arg so their wasm signature matches
if ! grep -q "wasm32 signature fix" unwind_prot.c; then
    echo "==> Patching unwind_prot.c: cast cleanup to void(*)(void*) for wasm32"
    # Cast the cleanup call to the correct signature
    perl -i -pe 's/\Q(*(elt->head.cleanup)) (elt->arg.v);\E/\/\* wasm32 signature fix: cleanups are always void (*)(void *) *\/\n\t    ((void (*)(void *))(elt->head.cleanup)) (elt->arg.v);/' unwind_prot.c
fi

# Create a shared "wasm32 unwind wrappers" compilation unit that bridges the
# varied cleanup signatures bash uses to the single `void (*)(void *)` form
# that our unwind_prot cast expects. Each wrapper calls the real function,
# discarding any return value and synthesizing missing args.
#
# These functions have signatures that don't match void(*)(void*) on wasm32:
#   void f(void)   — set_history_remembering, pop_args, pop_context,
#                    bashline_reset_event_hook, merge_temporary_env,
#                    bashline_reinitialize, reset_locals, pop_stream,
#                    parser_restore_alias
#   int  f(void*)  — close, unlink (libc)
#   int  f(int)    — restore_signal_mask (static to execute_cmd.c, so we
#                    wrap it differently — by patching the file directly)
if ! grep -q "wasm32_uw_wrappers" wasm32_uw.c 2>/dev/null; then
    echo "==> Writing wasm32_uw.c + wasm32_uw.h with unwind cleanup wrappers"
    cat > wasm32_uw.h << 'HEADEOF'
/* wasm32_uw_wrappers: normalized void(*)(void*) cleanup functions.
 * Include this wherever add_unwind_protect is called with a wrapped cleanup.
 * File-local wrappers (reset_locals_w, set_history_remembering_w) are
 * defined in their respective source files, not declared here.
 */
#ifndef _WASM32_UW_H
#define _WASM32_UW_H

extern void pop_stream_w (void *unused);
extern void parser_restore_alias_w (void *unused);
extern void pop_args_w (void *unused);
extern void pop_context_w (void *unused);
extern void bashline_reset_event_hook_w (void *unused);
extern void merge_temporary_env_w (void *unused);
extern void bashline_reinitialize_w (void *unused);
extern void close_w (void *fdp);
extern void unlink_w (void *path);

#endif
HEADEOF

    # wasm32_uw.c covers *non-static* cleanup functions that can be linked to
    # from outside their defining translation unit. Static functions
    # (reset_locals in print_cmd.c, set_history_remembering in
    # builtins/evalstring.c) get file-local wrappers instead — handled below.
    cat > wasm32_uw.c << 'WRAPEOF'
/* wasm32_uw_wrappers: normalize bash cleanup callbacks to void (*)(void *)
 * so they can be called via call_indirect on wasm32 without signature traps.
 * Every wrapper discards the arg if the real function takes none, and discards
 * any return value.
 */

#include "config.h"
#include <unistd.h>

extern void pop_stream (void);
extern void parser_restore_alias (void);
extern void pop_args (void);
extern void pop_context (void);
extern void bashline_reset_event_hook (void);
extern void merge_temporary_env (void);
extern void bashline_reinitialize (void);

void pop_stream_w (void *unused) { pop_stream (); }
void parser_restore_alias_w (void *unused) { parser_restore_alias (); }
void pop_args_w (void *unused) { pop_args (); }
void pop_context_w (void *unused) { pop_context (); }
void bashline_reset_event_hook_w (void *unused) { bashline_reset_event_hook (); }
void merge_temporary_env_w (void *unused) { merge_temporary_env (); }
void bashline_reinitialize_w (void *unused) { bashline_reinitialize (); }

/* libc int-returning cleanups */
void close_w (void *fdp) { (void)close ((int)(long)fdp); }
void unlink_w (void *path) { (void)unlink ((const char *)path); }
WRAPEOF

    # Inject wasm32_uw.o into OBJECTS for the top-level bash link
    if ! grep -q "wasm32_uw.o" Makefile; then
        sed -i.bak 's/\(OBJECTS[[:space:]]*=[[:space:]]*\)shell\.o /\1main_wrapper.o wasm32_uw.o shell.o /' Makefile
        rm -f Makefile.bak
    fi

    # Revert the earlier single-file injection of pop_stream_w / parser_restore_alias_w
    # into evalstring.c — the wrappers now live in wasm32_uw.c.
    if grep -q "wasm32_unwind_wrappers" builtins/evalstring.c; then
        # Remove our injected definitions. The include of common.h above them
        # stays; we just drop the 5 wrapper lines.
        perl -i -e '
          local $/;
          $_ = <>;
          s|/\* wasm32_unwind_wrappers:.*?static void parser_restore_alias_w \(void \*unused\) \{ parser_restore_alias \(\); \}\n||s;
          print;
        ' builtins/evalstring.c
    fi

    # Rewrite add_unwind_protect call sites to use the wrappers.
    # Search every .c and .def under the bash tree. Also inject the header
    # include into files that end up using a wrapper.
    echo "==> Rewriting add_unwind_protect call sites to use *_w wrappers"
    for f in *.c builtins/*.c builtins/*.def; do
        [ -f "$f" ] || continue
        perl -i -pe '
          s/add_unwind_protect \(pop_stream,/add_unwind_protect (pop_stream_w,/g;
          s/add_unwind_protect \(parser_restore_alias,/add_unwind_protect (parser_restore_alias_w,/g;
          s/add_unwind_protect \(pop_args,/add_unwind_protect (pop_args_w,/g;
          s/add_unwind_protect \(pop_context,/add_unwind_protect (pop_context_w,/g;
          s/add_unwind_protect \(bashline_reset_event_hook,/add_unwind_protect (bashline_reset_event_hook_w,/g;
          s/add_unwind_protect \(merge_temporary_env,/add_unwind_protect (merge_temporary_env_w,/g;
          s/add_unwind_protect \(bashline_reinitialize,/add_unwind_protect (bashline_reinitialize_w,/g;
          s/add_unwind_protect \(reset_locals,/add_unwind_protect (reset_locals_w,/g;
          s/add_unwind_protect \(set_history_remembering,/add_unwind_protect (set_history_remembering_w,/g;
          s/add_unwind_protect \(close,/add_unwind_protect (close_w,/g;
          s/add_unwind_protect \(unlink,/add_unwind_protect (unlink_w,/g;
        ' "$f"

        # If this file now uses a _w wrapper, inject the header include just
        # after the config.h include so the extern declarations are visible.
        # Handles both `#include "config.h"` and `#include <config.h>` styles.
        if grep -q "_w," "$f" && ! grep -q "wasm32_uw\.h" "$f"; then
            if [[ "$f" == builtins/* ]]; then
                perl -i -pe 's|^(#include [<"]config\.h[>"])$|$1\n#include "../wasm32_uw.h"|' "$f"
            else
                perl -i -pe 's|^(#include [<"]config\.h[>"])$|$1\n#include "wasm32_uw.h"|' "$f"
            fi
        fi
    done

    # Inject file-local static wrappers for static cleanup functions.
    # Defined at end of file (so the original cleanup is visible); forward-
    # declared near the top of the file so the earlier add_unwind_protect
    # call site compiles.

    if ! grep -q "wasm32-static-wrapper" builtins/evalstring.c; then
        # Forward decl after config.h include
        perl -i -pe 's|^(#include [<"]config\.h[>"])$|$1\n/* wasm32-static-wrapper forward decl */\n#if defined (HISTORY)\nstatic void set_history_remembering_w (void *unused);\n#endif|' builtins/evalstring.c
        # Definition at end of file
        cat >> builtins/evalstring.c << 'EOF'

#if defined (HISTORY)
/* wasm32-static-wrapper */
static void set_history_remembering_w (void *unused) { set_history_remembering (); }
#endif
EOF
    fi

    if ! grep -q "wasm32-static-wrapper" print_cmd.c; then
        perl -i -pe 's|^(#include [<"]config\.h[>"])$|$1\n/* wasm32-static-wrapper forward decl */\nstatic void reset_locals_w (void *unused);|' print_cmd.c
        cat >> print_cmd.c << 'EOF'

/* wasm32-static-wrapper */
static void reset_locals_w (void *unused) { reset_locals (); }
EOF
    fi

    # restore_signal_mask is static in execute_cmd.c and returns int. Add a
    # file-local wrapper next to the existing function and rewrite its caller.
    if ! grep -q "restore_signal_mask_w" execute_cmd.c; then
        perl -i -pe '
          if (/^static int$/ && !$done) {
            $next = <>;
            if ($next =~ /^restore_signal_mask \(set\)$/) {
              print "static int restore_signal_mask (sigset_t *set);\n";
              print "/* wasm32 cleanup wrapper: int-returning 1-arg → void(*)(void*) */\n";
              print "static void restore_signal_mask_w (void *set) { (void)restore_signal_mask((sigset_t *)set); }\n\n";
              $done = 1;
            }
            $_ = $_ . $next;
          }
        ' execute_cmd.c
        perl -i -pe 's/add_unwind_protect \(restore_signal_mask,/add_unwind_protect (restore_signal_mask_w,/g' execute_cmd.c
    fi
fi

# --- Patch readline Makefile: exclude duplicates of bash's own sources ---
# bash's bundled lib/readline/Makefile bundles shell.o, xmalloc.o, and xfree.o
# into libreadline.a and libhistory.a (they're included for standalone readline
# builds). When linked into bash, these collide with general.o/variables.o/
# xmalloc.o at the top level. Strip them from the archive object lists.
if [ -f lib/readline/Makefile ] && ! grep -q "wasm32 skip shell" lib/readline/Makefile; then
    echo "==> Patching lib/readline/Makefile to skip bundled shell.o/xmalloc.o/xfree.o"
    perl -i -pe 's/^HISTOBJ = history\.o histexpand\.o histfile\.o histsearch\.o shell\.o savestring\.o \\/# wasm32 skip shell.o (bash provides it)\nHISTOBJ = history.o histexpand.o histfile.o histsearch.o savestring.o \\/' lib/readline/Makefile
    perl -i -pe 's/^\s+xmalloc\.o xfree\.o compat\.o\s*$/\t  compat.o/' lib/readline/Makefile
    perl -i -pe 's/^libhistory\.a: \$\(HISTOBJ\) xmalloc\.o xfree\.o$/libhistory.a: \$(HISTOBJ)/' lib/readline/Makefile
    perl -i -pe 's/\$\(AR\) \$\(ARFLAGS\) \$\@ \$\(HISTOBJ\) xmalloc\.o xfree\.o/\$(AR) \$(ARFLAGS) \$\@ \$(HISTOBJ)/' lib/readline/Makefile
fi

# --- Provide __main_argc_argv wrapper ---
# Clang for wasm32 auto-renames `int main(int, char**)` -> __main_argc_argv
# so the CRT can call it. Bash uses K&R-style `main(argc, argv, env)` with
# three args, which clang does NOT auto-mangle. Without the wrapper, wasm-ld
# GC-strips all bash code because nothing reaches `main` from `_start`.
cat > main_wrapper.c << 'WRAPEOF'
extern int main(int argc, char **argv, char **envp);
extern char **environ;
int __main_argc_argv(int argc, char **argv) {
    return main(argc, argv, environ);
}
WRAPEOF

# Inject main_wrapper.o into the bash link line
if ! grep -q "main_wrapper.o" Makefile; then
    # OBJECTS line has tabs; match any whitespace before =
    sed -i.bak 's/^\(OBJECTS[[:space:]]*=[[:space:]]*\)shell\.o /\1main_wrapper.o shell.o /' Makefile
    rm -f Makefile.bak
    if grep -q "main_wrapper.o" Makefile; then
        echo "==> Injected main_wrapper.o into OBJECTS"
    else
        echo "ERROR: failed to inject main_wrapper.o into Makefile" >&2
        exit 1
    fi
fi

# --- Build ---
echo "==> Building bash..."
# bash 5.2.37's Makefile has a parallel-build race (`lib/<subdir>/Makefile`
# vs the top-level link) that produces exit 2 under -jN with no visible
# error. Serial builds fine; ~3 min on an 8-core. Stay with -j1 unless
# bash's own Makefile gets fixed upstream.
make -j1 2>&1 | tail -30

BASH_BIN="$SRC_DIR/bash"
if [ ! -f "$BASH_BIN" ]; then
    echo "ERROR: bash binary not found after build" >&2
    exit 1
fi

mkdir -p "$BIN_DIR"
cp "$BASH_BIN" "$BIN_DIR/bash.wasm"
SIZE_BEFORE=$(wc -c < "$BIN_DIR/bash.wasm" | tr -d ' ')
echo "==> Pre-asyncify size: $(echo "$SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${SIZE_BEFORE} bytes")"

# --- Asyncify transform with onlylist ---
if [ -f "$ONLYLIST" ]; then
    echo "==> Applying asyncify with onlylist..."
    ONLY_FUNCS=$(grep -v '^#' "$ONLYLIST" | grep -v '^\s*$' | tr -d ' ' | tr '\n' ',' | sed 's/,$//')

    # Full asyncify (no onlylist) instruments every function for fork support.
    # An onlylist approach was attempted first to keep the binary smaller, but
    # bash has many static fork-path functions (execute_pipeline,
    # execute_coproc, command_substitute_stdout, etc.) that LLVM at -O2
    # inlines into single-caller sites — they disappear as distinct named
    # functions and asyncify's onlylist silently fails to cover them. When
    # the asyncify call chain has gaps, kernel_fork's import wrapper is
    # generated but never reached from the uninstrumented callers, so bash
    # thinks `fork()` succeeded when it actually didn't: pipeline child-side
    # redirection runs in the parent process and writes to a closed pipe
    # fail with EPIPE. Full asyncify instruments everything uniformly and
    # the call chain from main → reader_loop → ... → make_child → fork →
    # kernel_fork works end-to-end. Size cost: 1.5MB → 2.7MB.
    "$WASM_OPT" -g --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        "$BIN_DIR/bash.wasm" -o "$BIN_DIR/bash.wasm"

    "$WASM_OPT" -O2 "$BIN_DIR/bash.wasm" -o "$BIN_DIR/bash.wasm"
fi

SIZE_AFTER=$(wc -c < "$BIN_DIR/bash.wasm" | tr -d ' ')
echo "==> Final size: $(echo "$SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${SIZE_AFTER} bytes")"

echo ""
echo "==> bash built successfully!"
echo "Binary: $BIN_DIR/bash.wasm"

# Install into local-binaries/ (resolver priority 1) and the resolver
# scratch dir when invoked by xtask build-deps / stage-release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary bash "$BIN_DIR/bash.wasm"

echo ""
echo "Run with:"
echo "  npx tsx examples/shell/serve.ts -c 'echo hello from bash'"
