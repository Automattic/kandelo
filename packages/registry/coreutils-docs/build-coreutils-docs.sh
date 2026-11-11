#!/usr/bin/env bash
# Generate coreutils man(1) pages from the REAL coreutils.wasm binary
# running inside a Kandelo kernel instance, then format with host help2man.
#
# Faithfulness (see CLAUDE.md "Platform Values Contract"): the man page
# content must come from the actual wasm binary, not a hardcoded/fabricated
# text. We can't run the wasm target on the host, so
# kandelo_man_pages_capture_help (images/vfs/scripts/capture-help-output.ts)
# boots Kandelo instances and runs each tool's --help/--version for real
# inside them, capturing the exact bytes printed. help2man then execs a
# per-tool replay wrapper that prints the captured file; it only reformats
# that already-faithful text into troff.
#
# coreutils ships as a single binary dispatched by argv[0] (GNU
# --enable-single-binary=symlinks), so capturing `ls --help` runs
# coreutils.wasm with argv = ["ls", "--help"]. A tool that prints empty
# --help inside Kandelo is logged and skipped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"

COREUTILS_DIR="${WASM_POSIX_DEP_COREUTILS_DIR:?coreutils dependency dir required}"
COREUTILS_WASM="$COREUTILS_DIR/coreutils.wasm"
[ -f "$COREUTILS_WASM" ] || { echo "coreutils.wasm not found under $COREUTILS_DIR" >&2; exit 2; }

# The GNU coreutils 9.6 tool set, minus the tools this build disables via
# --enable-no-install-program=stdbuf,pinky,who,users,uptime (see
# packages/registry/coreutils/build-coreutils.sh).
TOOLS=(
    b2sum base32 base64 basename basenc cat chcon chgrp chmod chown chroot
    cksum comm cp csplit cut date dd df dir dircolors dirname du echo env
    expand expr factor false fmt fold groups head hostid id install join
    kill link ln logname ls md5sum mkdir mkfifo mknod mktemp mv nice nl
    nohup nproc numfmt od paste pathchk pr printenv printf ptx pwd readlink
    realpath rm rmdir runcon seq sha1sum sha224sum sha256sum sha384sum
    sha512sum shred shuf sleep sort split stat stty sum sync tac tail tee
    test timeout touch tr true truncate tsort tty uname unexpand uniq
    unlink vdir wc whoami yes
)

# The declared coreutils binary, at a path of its own in the capture image;
# each tool runs it under its own argv[0].
BIN=/usr/libexec/kandelo-help-capture/coreutils
SPEC="$WORK/help-capture.json"
{
    printf '{"files": [{"from": "%s", "to": "%s"}],\n' "$COREUTILS_WASM" "$BIN"
    printf ' "env": ["PATH=/usr/bin:/bin", "POSIXLY_CORRECT=1"],\n'
    printf ' "commands": [\n'
    sep=""
    for tool in "${TOOLS[@]}"; do
        printf '%s  {"name": "%s", "path": "%s"}' "$sep" "$tool" "$BIN"
        sep=$',\n'
    done
    printf '\n]}\n'
} > "$SPEC"
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

STAGE="$WORK/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE/share/man/man1"
for helpfile in "$CAP"/*.help; do
    tool="$(basename "$helpfile" .help)"
    kandelo_man_pages_help2man "$CAP" "$tool" "$STAGE/share/man/man1/$tool.1" \
        --source="GNU coreutils 9.6 (Kandelo)" --name="$tool" \
        || echo "help2man failed for $tool" >&2
done
[ -f "$STAGE/share/man/man1/ls.1" ] || { echo "ls.1 not generated" >&2; exit 2; }

ARCHIVE="$WORK/coreutils-docs.zip"; rm -f "$ARCHIVE"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGE" "$ARCHIVE"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary coreutils-docs "$ARCHIVE" coreutils-docs.zip
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary coreutils-docs "$ARCHIVE" coreutils-docs.zip
fi
