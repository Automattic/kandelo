#!/usr/bin/env python3
"""Tests for the hosted-runner runtime ownership preparation boundary."""

from __future__ import annotations

import importlib.util
import stat
import subprocess
import unittest
from pathlib import Path
from unittest import mock


PREPARER_PATH = Path(__file__).with_name(
    "prepare-homebrew-recipe-host-runtime.py"
)
SPEC = importlib.util.spec_from_file_location(
    "prepare_homebrew_recipe_host_runtime", PREPARER_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load host-runtime preparer")
preparer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preparer)


def identity(
    *,
    uid: int = 0,
    gid: int = 0,
    mode: int = 0o755,
    file_type: int = stat.S_IFDIR,
    device: int = 7,
    inode: int = 11,
    path: Path = preparer.RUNTIME_ROOT,
    resolved: Path = preparer.RUNTIME_ROOT,
):
    return preparer.PathIdentity(
        path=path,
        resolved=resolved,
        device=device,
        inode=inode,
        uid=uid,
        gid=gid,
        mode=mode,
        file_type=file_type,
    )


class HostRuntimePreparationTests(unittest.TestCase):
    def test_exact_sealed_and_runner_owned_states_are_accepted(self) -> None:
        self.assertEqual(
            preparer.classify_runtime_root(identity(), 1001, 1001),
            "sealed",
        )
        self.assertEqual(
            preparer.classify_runtime_root(
                identity(uid=1001, gid=1001), 1001, 1001
            ),
            "runner-owned",
        )

    def test_unrecognized_runtime_states_fail_closed(self) -> None:
        cases = (
            identity(uid=1002, gid=1002),
            identity(uid=1001, gid=0),
            identity(uid=1001, gid=1001, mode=0o775),
            identity(file_type=stat.S_IFLNK),
            identity(resolved=Path("/tmp/usr")),
        )
        for candidate in cases:
            with self.subTest(candidate=candidate):
                with self.assertRaises(preparer.PreparationError):
                    preparer.classify_runtime_root(candidate, 1001, 1001)

    def test_root_execution_does_not_reclassify_an_unsealed_owner(self) -> None:
        with self.assertRaisesRegex(
            preparer.PreparationError, "unexpected ownership"
        ):
            preparer.classify_runtime_root(identity(uid=1001, gid=1001), 0, 0)

    @mock.patch.object(preparer, "path_identity")
    def test_root_owned_fixed_executable_is_accepted(self, inspect) -> None:
        inspect.return_value = identity(
            path=preparer.SUDO_BIN,
            resolved=preparer.SUDO_BIN,
            mode=0o4755,
            file_type=stat.S_IFREG,
        )
        preparer.validate_root_tool(preparer.SUDO_BIN)

    @mock.patch.object(preparer, "path_identity")
    def test_replaceable_or_rebound_preparation_tool_is_rejected(
        self, inspect
    ) -> None:
        cases = (
            identity(
                path=preparer.SUDO_BIN,
                resolved=preparer.SUDO_BIN,
                uid=1001,
                gid=1001,
                mode=0o755,
                file_type=stat.S_IFREG,
            ),
            identity(
                path=preparer.SUDO_BIN,
                resolved=preparer.SUDO_BIN,
                mode=0o4775,
                file_type=stat.S_IFREG,
            ),
            identity(
                path=preparer.SUDO_BIN,
                resolved=preparer.CHOWN_BIN,
                mode=0o4755,
                file_type=stat.S_IFREG,
            ),
        )
        for candidate in cases:
            with self.subTest(candidate=candidate):
                inspect.return_value = candidate
                with self.assertRaisesRegex(
                    preparer.PreparationError, "preparation tool is unsafe"
                ):
                    preparer.validate_root_tool(preparer.SUDO_BIN)

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_runtime_root")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_runner_owned_inode_is_reclaimed_and_verified(
        self,
        _getuid,
        _getgid,
        reclaim,
        inspect,
    ) -> None:
        inspect.side_effect = (
            identity(uid=1001, gid=1001),
            identity(),
        )
        preparer.prepare_host_runtime()
        reclaim.assert_called_once_with()
        self.assertEqual(inspect.call_count, 2)

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_runtime_root")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_already_sealed_runtime_is_idempotent(
        self,
        _getuid,
        _getgid,
        reclaim,
        inspect,
    ) -> None:
        inspect.return_value = identity()
        preparer.prepare_host_runtime()
        reclaim.assert_not_called()
        inspect.assert_called_once_with(preparer.RUNTIME_ROOT)

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_runtime_root")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_inode_replacement_during_reclaim_is_rejected(
        self,
        _getuid,
        _getgid,
        _reclaim,
        inspect,
    ) -> None:
        inspect.side_effect = (
            identity(uid=1001, gid=1001),
            identity(inode=12),
        )
        with self.assertRaisesRegex(
            preparer.PreparationError, "changed identity"
        ):
            preparer.prepare_host_runtime()

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_runtime_root")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_reclaim_that_leaves_runner_ownership_is_rejected(
        self,
        _getuid,
        _getgid,
        _reclaim,
        inspect,
    ) -> None:
        inspect.side_effect = (
            identity(uid=1001, gid=1001),
            identity(uid=1001, gid=1001),
        )
        with self.assertRaisesRegex(
            preparer.PreparationError, "was not sealed"
        ):
            preparer.prepare_host_runtime()

    @mock.patch.object(preparer.subprocess, "run")
    @mock.patch.object(preparer, "validate_root_tool")
    def test_reclaim_command_is_fixed_and_nonrecursive(
        self, validate_tool, run
    ) -> None:
        preparer.reclaim_runtime_root()
        self.assertEqual(
            validate_tool.call_args_list,
            [mock.call(preparer.SUDO_BIN), mock.call(preparer.CHOWN_BIN)],
        )
        run.assert_called_once_with(
            [
                "/usr/bin/sudo",
                "-n",
                "--",
                "/usr/bin/chown",
                "--no-dereference",
                "0:0",
                "--",
                "/usr",
            ],
            check=True,
            env={
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/bin:/bin",
            },
        )

    @mock.patch.object(preparer.subprocess, "run")
    @mock.patch.object(preparer, "validate_root_tool")
    def test_reclaim_failure_is_explained(self, _validate_tool, run) -> None:
        run.side_effect = subprocess.CalledProcessError(1, "sudo")
        with self.assertRaisesRegex(
            preparer.PreparationError, "could not reclaim /usr"
        ):
            preparer.reclaim_runtime_root()

    def test_command_line_accepts_no_override(self) -> None:
        with self.assertRaisesRegex(
            preparer.PreparationError, "accepts no arguments"
        ):
            preparer.main(["--root", "/tmp/usr"])


if __name__ == "__main__":
    unittest.main()
