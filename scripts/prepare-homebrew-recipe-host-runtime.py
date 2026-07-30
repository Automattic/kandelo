#!/usr/bin/env python3
"""Seal the conventional host runtime before privileged Formula execution."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple


RUNTIME_ROOT = Path("/usr")
SUDO_BIN = Path("/usr/bin/sudo")
CHOWN_BIN = Path("/usr/bin/chown")


class PreparationError(RuntimeError):
    """The host runtime cannot be made safe for isolated recipe execution."""


class PathIdentity(NamedTuple):
    path: Path
    resolved: Path
    device: int
    inode: int
    uid: int
    gid: int
    mode: int
    file_type: int


def path_identity(path: Path) -> PathIdentity:
    """Read one path without silently accepting a link or missing component."""
    try:
        metadata = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise PreparationError(f"{path} is unavailable: {error}") from error
    return PathIdentity(
        path=path,
        resolved=resolved,
        device=metadata.st_dev,
        inode=metadata.st_ino,
        uid=metadata.st_uid,
        gid=metadata.st_gid,
        mode=stat.S_IMODE(metadata.st_mode),
        file_type=stat.S_IFMT(metadata.st_mode),
    )


def rendered(identity: PathIdentity) -> str:
    """Render the bounded metadata needed to diagnose a rejected runner image."""
    type_name = {
        stat.S_IFDIR: "directory",
        stat.S_IFLNK: "symlink",
        stat.S_IFREG: "regular-file",
    }.get(identity.file_type, "other")
    return (
        f"path={identity.path} resolved={identity.resolved} "
        f"device={identity.device} inode={identity.inode} "
        f"uid={identity.uid} gid={identity.gid} "
        f"mode={identity.mode:04o} type={type_name}"
    )


def classify_runtime_root(
    identity: PathIdentity, runner_uid: int, runner_gid: int
) -> str:
    """Accept only the sealed state or the exact hosted-runner regression."""
    if (
        identity.path != RUNTIME_ROOT
        or identity.resolved != RUNTIME_ROOT
        or identity.file_type != stat.S_IFDIR
        or identity.mode != 0o755
    ):
        raise PreparationError(
            "host runtime root has an unexpected path, type, or mode "
            f"({rendered(identity)}; expected=/usr-real-directory-mode-0755)"
        )
    if identity.uid == 0 and identity.gid == 0:
        return "sealed"
    if (
        runner_uid != 0
        and runner_gid != 0
        and identity.uid == runner_uid
        and identity.gid == runner_gid
    ):
        return "runner-owned"
    raise PreparationError(
        "host runtime root has unexpected ownership "
        f"({rendered(identity)}; expected=root:root-or-current-runner:"
        "current-runner)"
    )


def validate_root_tool(path: Path) -> None:
    """Require an immutable root-owned executable before privileged use."""
    identity = path_identity(path)
    if (
        identity.path != identity.resolved
        or identity.file_type != stat.S_IFREG
        or identity.uid != 0
        or identity.gid != 0
        or identity.mode & 0o022
        or not identity.mode & 0o111
    ):
        raise PreparationError(
            "host-runtime preparation tool is unsafe "
            f"({rendered(identity)}; expected=root:root-executable-"
            "regular-file-not-group/other-writable)"
        )


def reclaim_runtime_root() -> None:
    """Change only the evidenced directory inode, never its descendants."""
    for tool in (SUDO_BIN, CHOWN_BIN):
        validate_root_tool(tool)
    try:
        subprocess.run(
            [
                str(SUDO_BIN),
                "-n",
                "--",
                str(CHOWN_BIN),
                "--no-dereference",
                "0:0",
                "--",
                str(RUNTIME_ROOT),
            ],
            check=True,
            env={
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/bin:/bin",
            },
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise PreparationError(
            f"could not reclaim {RUNTIME_ROOT} for privileged Formula execution"
        ) from error


def prepare_host_runtime() -> None:
    """Seal `/usr` while rejecting every unrecognized runner-image state."""
    runner_uid = os.getuid()
    runner_gid = os.getgid()
    before = path_identity(RUNTIME_ROOT)
    state = classify_runtime_root(before, runner_uid, runner_gid)
    if state == "sealed":
        print(f"Homebrew host runtime already sealed: {rendered(before)}")
        return

    # WHY: Recent GitHub-hosted images changed only the /usr directory inode
    # from root:root to the workflow identity. That owner could replace
    # root-owned children while a privileged recipe service is running. Reclaim
    # this one evidenced inode before Formula code executes; recursive chown
    # would instead corrupt intentional ownership inside the system runtime.
    reclaim_runtime_root()
    after = path_identity(RUNTIME_ROOT)
    after_state = classify_runtime_root(after, runner_uid, runner_gid)
    if after_state != "sealed":
        raise PreparationError(
            f"host runtime root was not sealed ({rendered(after)})"
        )
    if (after.device, after.inode) != (before.device, before.inode):
        raise PreparationError(
            "host runtime root changed identity while ownership was reclaimed "
            f"(before={rendered(before)}; after={rendered(after)})"
        )
    print(
        "Homebrew host runtime sealed from the current runner identity: "
        f"{rendered(after)}"
    )


def main(arguments: list[str]) -> int:
    if arguments:
        raise PreparationError("host-runtime preparation accepts no arguments")
    prepare_host_runtime()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except PreparationError as error:
        print(f"prepare-homebrew-recipe-host-runtime.py: {error}", file=sys.stderr)
        raise SystemExit(1) from error
