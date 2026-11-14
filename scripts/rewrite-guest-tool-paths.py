#!/usr/bin/env python3
"""Point an installed script tree at the guest's tools.

    rewrite-guest-tool-paths.py <staged-tree> [--map OLD=NEW]... [<forbidden-prefix>...]

Script-based packages (autoconf, automake, libtool, help2man, texinfo's
texi2any, ...) are configured and installed on the build machine with the
dev shell's perl, m4, bash and coreutils, and record those tools' absolute
paths in their scripts (`#! /nix/store/...-perl-5.40.0/bin/perl`,
`M4='/nix/store/...-gnum4-1.4.20/bin/m4'`). Inside Kandelo the same tools
live at fixed image paths, so each recorded path is rewritten to the guest
path of the same command.

A script configured for the guest toolchain (libtool's) also records the
compiler's library directories: clang's resource directory in the store is
rewritten to the guest SDK's (/usr/lib/llvm/lib/clang/<major>), and each
--map rewrites a further prefix, such as the build's sysroot to the guest
SDK's.

A command with no known guest path is an error rather than a guess, and so
is any build-machine path left afterwards: the dev shell's store, and each
<forbidden-prefix> (pass the work and repository roots). A script that still
names a build-machine path would fail inside Kandelo, or worse, run a
different tool than it was built against.
"""

import os
import re
import sys

# Guest locations of the commands these scripts invoke. /bin holds the
# essential commands (images/rootfs/PACKAGES.toml and coreutilsCommandPath in
# images/vfs/lib/init/shell-binaries.ts); everything else is in /usr/bin.
ESSENTIAL = {
    "bash", "sh", "sed", "grep", "egrep", "fgrep", "tar", "gzip", "gunzip",
    "cat", "chgrp", "chmod", "chown", "cp", "date", "dd", "df", "echo",
    "false", "ln", "ls", "mkdir", "mknod", "mv", "pwd", "rm", "rmdir",
    "sleep", "stty", "sync", "true", "uname",
}
USR_BIN = {
    "perl", "m4", "make", "gawk", "awk", "find", "xargs", "cmp", "diff",
    "file", "xz", "bzip2", "install", "env", "sort", "tr", "head", "tail",
    "wc", "basename", "dirname", "expr", "test", "touch", "uniq", "cut",
    "mktemp", "readlink", "realpath", "tee", "od", "printf", "sha256sum",
    "bison", "flex", "patch",
}


def guest_path(command: str) -> str:
    if command in ESSENTIAL:
        return f"/bin/{command}"
    if command in USR_BIN:
        return f"/usr/bin/{command}"
    raise SystemExit(
        f"rewrite-guest-tool-paths: no known guest path for command {command!r}; "
        "add it to scripts/rewrite-guest-tool-paths.py if Kandelo installs it"
    )


STORE_TOOL = re.compile(rb"/nix/store/[0-9a-z]{32}-[^/\s'\"]+/bin/([A-Za-z0-9_.+-]+)")
STORE_CLANG_RESOURCE = re.compile(rb"/nix/store/[0-9a-z]{32}-clang-[0-9.]+-lib/lib/clang/([0-9]+)")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    root = sys.argv[1]
    maps = []
    prefixes = []
    args = sys.argv[2:]
    while args:
        arg = args.pop(0)
        if arg == "--map":
            old, _, new = args.pop(0).partition("=")
            if not old or not new:
                raise SystemExit("rewrite-guest-tool-paths: --map needs OLD=NEW")
            maps.append((os.fsencode(old), os.fsencode(new)))
        elif arg:
            prefixes.append(arg)
    forbidden = [b"/nix/store/"] + [os.fsencode(p) for p in prefixes]
    leftovers = []
    for directory, _, files in os.walk(root):
        for name in files:
            path = os.path.join(directory, name)
            if os.path.islink(path):
                continue
            with open(path, "rb") as handle:
                data = handle.read()
            if b"\0" in data:
                # Binary files (compiled programs, archives) are checked for
                # leftovers but never edited.
                rewritten = data
            else:
                rewritten = STORE_CLANG_RESOURCE.sub(
                    lambda m: b"/usr/lib/llvm/lib/clang/" + m.group(1), data
                )
                rewritten = STORE_TOOL.sub(
                    lambda m: os.fsencode(guest_path(m.group(1).decode())), rewritten
                )
                for old, new in maps:
                    rewritten = rewritten.replace(old, new)
                if rewritten != data:
                    mode = os.stat(path).st_mode
                    with open(path, "wb") as handle:
                        handle.write(rewritten)
                    os.chmod(path, mode)
            for prefix in forbidden:
                if prefix in rewritten:
                    leftovers.append(f"{os.path.relpath(path, root)}: {prefix.decode()}")
    if leftovers:
        raise SystemExit(
            "rewrite-guest-tool-paths: build-machine paths remain:\n  "
            + "\n  ".join(sorted(set(leftovers)))
        )


if __name__ == "__main__":
    main()
