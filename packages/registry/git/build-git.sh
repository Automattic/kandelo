#!/usr/bin/env bash
set -euo pipefail

# Build Git 2.47.1 for wasm32-posix-kernel.
#
# Git uses a Makefile-based build system (no autoconf). Cross-compilation
# is done via config.mak overrides.
#
# Resolves zlib, openssl, and libcurl via
# `cargo xtask build-deps resolve <name>` — see
# docs/dependency-management.md. openssl is pulled in because static
# libcurl in our build references -lssl -lcrypto.
#
# Fork instrumentation is applied so fork+exec works properly (git gc --auto,
# hooks, pager, credential helpers, etc.). wasm-fork-instrument auto-discovers
# fork paths via call-graph analysis — no onlylist is needed.
#
# HTTP/HTTPS transport is always built (git-remote-http, symlinked to
# git-remote-https in the VFS). git does a real end-to-end TLS handshake
# through its libcurl+OpenSSL. On Node the guest's TLS runs over a real
# outbound socket (TcpNetworkBackend). In the browser the host's
# TlsNetworkBackend terminates that TLS locally with a per-session MITM CA
# (installed at /etc/ssl/certs/ca-certificates.crt), decrypts the HTTP
# request, and re-issues it with fetch() through the configured CORS proxy —
# so no HTTPS->HTTP gitconfig rewrite is used or needed.
#
# Output: bin/git.wasm and bin/git-remote-http.wasm under the resolver work
#         root (beside this script when run standalone).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
GIT_VERSION="$WASM_POSIX_DEP_VERSION"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/git-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
# Explicit env wins; else the in-tree sysroot. Matches build-libcurl.sh:49.
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/libc/glue"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# --- Resolve zlib, openssl, and libcurl via the dep cache ---
# openssl is a transitive dep: our cached libcurl.a references
# -lssl/-lcrypto symbols, and the final link needs their .a files
# findable on -L. Env-var short-circuits (WASM_POSIX_DEP_<NAME>_DIR)
# let an outer resolver run pass prefixes through without re-invoking
# cargo for each dep.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    ZLIB_PREFIX="$(resolve_dep zlib)"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib resolve returned '$ZLIB_PREFIX' but libz.a missing" >&2
    exit 1
fi
echo "==> zlib at $ZLIB_PREFIX"

OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
if [ -z "$OPENSSL_PREFIX" ]; then
    echo "==> Resolving openssl via cargo xtask build-deps..."
    OPENSSL_PREFIX="$(resolve_dep openssl)"
fi
if [ ! -f "$OPENSSL_PREFIX/lib/libssl.a" ] || [ ! -f "$OPENSSL_PREFIX/lib/libcrypto.a" ]; then
    echo "ERROR: openssl resolve returned '$OPENSSL_PREFIX' but libssl.a/libcrypto.a missing" >&2
    exit 1
fi
echo "==> openssl at $OPENSSL_PREFIX"

CURL_PREFIX="${WASM_POSIX_DEP_LIBCURL_DIR:-}"
if [ -z "$CURL_PREFIX" ]; then
    echo "==> Resolving libcurl via cargo xtask build-deps..."
    CURL_PREFIX="$(resolve_dep libcurl)"
fi
if [ ! -f "$CURL_PREFIX/lib/libcurl.a" ] || [ ! -f "$CURL_PREFIX/include/curl/curl.h" ]; then
    echo "ERROR: libcurl resolve returned '$CURL_PREFIX' but libcurl.a/curl.h missing" >&2
    exit 1
fi
echo "==> libcurl at $CURL_PREFIX"

# Check for wasm-opt (required for -O2 optimization after build).
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -z "$WASM_OPT" ]; then
    echo "ERROR: wasm-opt not found. Install binaryen." >&2
    exit 1
fi

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

# --- Download Git source ---
kandelo_package_stage_primary_source git "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

cd "$SRC_DIR"

# --- Create config.mak for cross-compilation ---
echo "==> Creating config.mak for wasm32 cross-compilation..."
cat > config.mak << ENDMAK
# Cross-compilation for wasm32-posix-kernel
CC = wasm32posix-cc
AR = wasm32posix-ar
RANLIB = wasm32posix-ranlib
STRIP = wasm32posix-strip

# Install paths — must match wasm VFS layout so git finds /etc/gitconfig
prefix = /usr
sysconfdir = /etc

# Optimization + debug info for symbolication. -gline-tables-only emits
# DWARF line tables without full debug info and is retained for general
# debuggability.
CFLAGS = -O2 -gline-tables-only

# Disable optional features that need unavailable infrastructure
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_GETTEXT = YesPlease
NO_EXPAT = YesPlease
NO_ICONV = YesPlease
NO_REGEX = NeedsStartEnd
NO_NSEC = YesPlease
NO_INSTALL_HARDLINKS = YesPlease

# Disable features that require runtime infrastructure we don't have
NO_OPENSSL = YesPlease

# Use zlib from the dep-cache prefix
ZLIB_PATH = $ZLIB_PREFIX

# SHA-1 backend: use the bundled block-sha1 (no OpenSSL dependency needed)
BLK_SHA1 = YesPlease

# SHA-256 backend: use the bundled sha256 implementation
OPENSSL_SHA256 =

# wasm32 has no pthreads
NO_PTHREADS = YesPlease

# Disable mmap — Git's mmap usage for packfiles would work but we want
# to keep things simple for the initial build.
NO_MMAP = YesPlease

# No /etc/passwd or getpwnam — use fallback
NO_GECOS_IN_PWENT = YesPlease

# Disable features that try to spawn helper programs we may not have
NO_EXTERNAL_DIFF = YesPlease

# Tell Git about platform capabilities
HAVE_CLOCK_GETTIME = YesPlease
HAVE_CLOCK_MONOTONIC = YesPlease
HAVE_GETDELIM = YesPlease
HAVE_PATHS_H = YesPlease
HAVE_DEV_TTY = YesPlease

# Cross-compilation: can't run test programs
CROSS_COMPILING = YesPlease

# Don't build git-daemon, git-http-backend, etc.
PROGRAMS =

# Link statically
EXTLIBS = -lz
ENDMAK

# HTTP/HTTPS transport via libcurl.
# Note: NO_CURL is NOT set — this enables git-remote-http/https.
# Setting CURLDIR triggers git's Makefile to derive CURL_CFLAGS =
# -I$CURLDIR/include. We can't just set CURL_CFLAGS directly because
# the Makefile resets it when CURLDIR is unset. CURL_LDFLAGS is
# consumed as-is (appended after CURL_LIBCURL).
cat >> config.mak << ENDCURL

CURLDIR = $CURL_PREFIX
CURL_LDFLAGS = -L$CURL_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$ZLIB_PREFIX/lib -lcurl -lssl -lcrypto -ldl -lz
ENDCURL

# --- Build ---
echo "==> Building git..."
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Override uname_S to prevent config.mak.uname from applying Darwin-specific
# settings (HAVE_BSD_SYSCTL, precompose_utf8, etc.). Must be on the command
# line so it takes effect before config.mak.uname conditionals.
make uname_S=Wasm32 -j"$NCPU" git git-remote-http 2>&1 | tail -50

echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"

if [ ! -f "$SRC_DIR/git" ]; then
    echo "ERROR: git binary not found after build" >&2
    exit 1
fi

cp "$SRC_DIR/git" "$BIN_DIR/git.wasm"

if [ ! -f "$SRC_DIR/git-remote-http" ]; then
    echo "ERROR: git-remote-http binary not found after build" >&2
    exit 1
fi
cp "$SRC_DIR/git-remote-http" "$BIN_DIR/git-remote-http.wasm"
echo "==> Collected git-remote-http.wasm"
SIZE_BEFORE=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Pre-instrument size: $(echo "$SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${SIZE_BEFORE} bytes")"

# --- Fork instrumentation, then optimization ---
# git.wasm reaches the instrumenter as wasm-ld wrote it. Its compiler facts
# (the `kandelo.calltypes` section) describe that exact code, and they shrink
# git's fork-path instrumentation to a few dozen functions; a wasm-opt pass
# first would inline call sites across functions, and the instrumenter would
# then ignore the facts (their code hash no longer matches). The instrumenter
# runs wasm-opt -O2 over the whole module afterwards.
echo "==> Applying fork instrumentation to git.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm.instr"
mv "$BIN_DIR/git.wasm.instr" "$BIN_DIR/git.wasm"

SIZE_AFTER=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Post-instrument size: $(echo "$SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${SIZE_AFTER} bytes")"

# git-remote-http keeps wasm-opt first: curl's SIGALRM longjmp keeps most
# of it on the fork path even with facts, so the inlined, smaller call graph
# instruments smaller (docs/plans/2026-10-02-fork-sinks.md, "jmp_buf identity
# and curl").
# Apply the same pipeline to git-remote-http — libcurl may call fork()
# internally (e.g., for DNS resolution when pthreads are unavailable).
# git-remote-http is always built post-Phase-7 (HTTP/HTTPS transport
# is required, not optional).
if [ -f "$BIN_DIR/git-remote-http.wasm" ]; then
    echo "==> Optimizing + instrumenting git-remote-http.wasm..."
    RH_SIZE_BEFORE=$(wc -c < "$BIN_DIR/git-remote-http.wasm" | tr -d ' ')
    "$WASM_OPT" -g -O2 "$BIN_DIR/git-remote-http.wasm" -o "$BIN_DIR/git-remote-http.wasm"
    "$FORK_INSTRUMENT" "$BIN_DIR/git-remote-http.wasm" -o "$BIN_DIR/git-remote-http.wasm.instr"
    mv "$BIN_DIR/git-remote-http.wasm.instr" "$BIN_DIR/git-remote-http.wasm"
    RH_SIZE_AFTER=$(wc -c < "$BIN_DIR/git-remote-http.wasm" | tr -d ' ')
    echo "==> git-remote-http: $(echo "$RH_SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${RH_SIZE_BEFORE}") -> $(echo "$RH_SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${RH_SIZE_AFTER}")"
fi

echo ""
echo "==> git built successfully with fork support!"
echo "Binary: $BIN_DIR/git.wasm"
echo "HTTP transport: $BIN_DIR/git-remote-http.wasm"

# Install into local-binaries/ (multi-binary program).
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary git "$BIN_DIR/git.wasm" git.wasm
install_local_binary git "$BIN_DIR/git-remote-http.wasm" git-remote-http.wasm
