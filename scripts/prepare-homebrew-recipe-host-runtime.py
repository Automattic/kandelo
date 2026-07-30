#!/usr/bin/env python3
"""Seal the conventional host runtime before privileged Formula execution."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple


# WHY: These are the complete mutable ancestors of the conventional host
# sources projected by homebrew-tap-recipe-runner.py on GitHub's Ubuntu
# runners. Keep this list fixed: accepting a caller-selected path would turn
# the preparer into a privileged ownership-changing interface.
HOST_PROJECTION_ANCESTORS = (Path("/usr"), Path("/etc"))
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


def classify_projection_ancestor(
    identity: PathIdentity,
    expected_path: Path,
    runner_uid: int,
    runner_gid: int,
) -> str:
    """Accept only the sealed state or the exact hosted-runner regression."""
    if (
        expected_path not in HOST_PROJECTION_ANCESTORS
        or identity.path != expected_path
        or identity.resolved != expected_path
        or identity.file_type != stat.S_IFDIR
        or identity.mode != 0o755
    ):
        raise PreparationError(
            "host projection ancestor has an unexpected path, type, or mode "
            f"({rendered(identity)}; expected_path={expected_path} "
            "expected_type=directory expected_mode=0755)"
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
        "host projection ancestor has unexpected ownership "
        f"({rendered(identity)}; expected_owner=root:root-or-"
        f"{runner_uid}:{runner_gid})"
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


def reclaim_projection_ancestors(
    candidates: tuple[Path, ...], runner_uid: int, runner_gid: int
) -> None:
    """Change only the evidenced directory inodes, never their descendants."""
    if runner_uid <= 0 or runner_gid <= 0:
        raise PreparationError(
            "host-projection reclamation requires a non-root runner identity"
        )
    expected_candidates = tuple(
        root for root in HOST_PROJECTION_ANCESTORS if root in candidates
    )
    if not candidates or candidates != expected_candidates:
        raise PreparationError(
            "host-projection reclamation received an unknown, repeated, or "
            "out-of-order path"
        )
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
                f"--from={runner_uid}:{runner_gid}",
                "0:0",
                "--",
                *(str(candidate) for candidate in candidates),
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
            "could not reclaim the host projection ancestors for privileged "
            "Formula execution"
        ) from error


def prepare_host_runtime() -> None:
    """Seal fixed host ancestors and reject unrecognized runner-image state."""
    runner_uid = os.getuid()
    runner_gid = os.getgid()
    before = tuple(
        path_identity(root) for root in HOST_PROJECTION_ANCESTORS
    )
    states = tuple(
        classify_projection_ancestor(
            identity, root, runner_uid, runner_gid
        )
        for root, identity in zip(HOST_PROJECTION_ANCESTORS, before, strict=True)
    )
    candidates = tuple(
        root
        for root, state in zip(HOST_PROJECTION_ANCESTORS, states, strict=True)
        if state == "runner-owned"
    )
    if not candidates:
        print(
            "Homebrew host projection ancestors already sealed: "
            + "; ".join(rendered(identity) for identity in before)
        )
        return

    # WHY: GitHub-hosted images have supplied /usr and /etc directory inodes as
    # the workflow identity while leaving selected children root-owned. That
    # owner could replace a projected child while a privileged recipe service
    # is running. Reclaim only the fixed, evidenced inodes before Formula code
    # executes; recursive chown would corrupt intentional child ownership.
    reclaim_projection_ancestors(candidates, runner_uid, runner_gid)
    after = tuple(
        path_identity(root) for root in HOST_PROJECTION_ANCESTORS
    )
    for root, old, new in zip(
        HOST_PROJECTION_ANCESTORS, before, after, strict=True
    ):
        after_state = classify_projection_ancestor(
            new, root, runner_uid, runner_gid
        )
        if after_state != "sealed":
            raise PreparationError(
                f"host projection ancestor was not sealed ({rendered(new)})"
            )
        if (new.device, new.inode) != (old.device, old.inode):
            raise PreparationError(
                "host projection ancestor changed identity while ownership "
                f"was reclaimed (before={rendered(old)}; after={rendered(new)})"
            )
    print(
        "Homebrew host projection ancestors sealed from the current runner "
        "identity: " + "; ".join(rendered(identity) for identity in after)
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
