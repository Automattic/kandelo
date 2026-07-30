#!/usr/bin/env python3
"""Tests for the hosted-runner projection-ownership boundary."""

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

USR_ROOT, ETC_ROOT = preparer.HOST_PROJECTION_ANCESTORS


def identity(
    *,
    uid: int = 0,
    gid: int = 0,
    mode: int = 0o755,
    file_type: int = stat.S_IFDIR,
    device: int = 7,
    inode: int = 11,
    path: Path = USR_ROOT,
    resolved: Path | None = None,
):
    return preparer.PathIdentity(
        path=path,
        resolved=path if resolved is None else resolved,
        device=device,
        inode=inode,
        uid=uid,
        gid=gid,
        mode=mode,
        file_type=file_type,
    )


def sealed_roots() -> tuple[object, object]:
    return (
        identity(path=USR_ROOT, inode=11),
        identity(path=ETC_ROOT, inode=12),
    )


class HostRuntimePreparationTests(unittest.TestCase):
    def test_exact_sealed_and_runner_owned_states_are_accepted(self) -> None:
        for root in preparer.HOST_PROJECTION_ANCESTORS:
            with self.subTest(root=root, state="sealed"):
                self.assertEqual(
                    preparer.classify_projection_ancestor(
                        identity(path=root), root, 1001, 1001
                    ),
                    "sealed",
                )
            with self.subTest(root=root, state="runner-owned"):
                self.assertEqual(
                    preparer.classify_projection_ancestor(
                        identity(path=root, uid=1001, gid=1001),
                        root,
                        1001,
                        1001,
                    ),
                    "runner-owned",
                )

    def test_unrecognized_projection_states_fail_closed(self) -> None:
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
                    preparer.classify_projection_ancestor(
                        candidate, USR_ROOT, 1001, 1001
                    )

    def test_expected_path_must_be_a_fixed_projection_ancestor(self) -> None:
        with self.assertRaisesRegex(
            preparer.PreparationError, "unexpected path"
        ):
            preparer.classify_projection_ancestor(
                identity(path=Path("/tmp")), Path("/tmp"), 1001, 1001
            )

    def test_root_execution_does_not_reclassify_an_unsealed_owner(self) -> None:
        with self.assertRaisesRegex(
            preparer.PreparationError, "unexpected ownership"
        ):
            preparer.classify_projection_ancestor(
                identity(uid=1001, gid=1001), USR_ROOT, 0, 0
            )

    @mock.patch.object(preparer, "path_identity")
    def test_root_owned_fixed_executable_is_accepted(self, inspect) -> None:
        inspect.return_value = identity(
            path=preparer.SUDO_BIN,
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
                uid=1001,
                gid=1001,
                mode=0o755,
                file_type=stat.S_IFREG,
            ),
            identity(
                path=preparer.SUDO_BIN,
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
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_only_runner_owned_ancestor_is_reclaimed_and_both_are_verified(
        self,
        _getuid,
        _getgid,
        reclaim,
        inspect,
    ) -> None:
        sealed_usr, sealed_etc = sealed_roots()
        inspect.side_effect = (
            sealed_usr,
            identity(path=ETC_ROOT, inode=12, uid=1001, gid=1001),
            sealed_usr,
            sealed_etc,
        )
        preparer.prepare_host_runtime()
        reclaim.assert_called_once_with((ETC_ROOT,), 1001, 1001)
        self.assertEqual(inspect.call_count, 4)

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_all_runner_owned_ancestors_are_reclaimed_in_fixed_order(
        self,
        _getuid,
        _getgid,
        reclaim,
        inspect,
    ) -> None:
        sealed_usr, sealed_etc = sealed_roots()
        inspect.side_effect = (
            identity(path=USR_ROOT, inode=11, uid=1001, gid=1001),
            identity(path=ETC_ROOT, inode=12, uid=1001, gid=1001),
            sealed_usr,
            sealed_etc,
        )
        preparer.prepare_host_runtime()
        reclaim.assert_called_once_with(
            preparer.HOST_PROJECTION_ANCESTORS, 1001, 1001
        )

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_all_sealed_ancestors_are_idempotent(
        self,
        _getuid,
        _getgid,
        reclaim,
        inspect,
    ) -> None:
        inspect.side_effect = sealed_roots()
        preparer.prepare_host_runtime()
        reclaim.assert_not_called()
        self.assertEqual(
            inspect.call_args_list,
            [mock.call(USR_ROOT), mock.call(ETC_ROOT)],
        )

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_unrecognized_second_ancestor_prevents_any_reclaim(
        self,
        _getuid,
        _getgid,
        reclaim,
        inspect,
    ) -> None:
        inspect.side_effect = (
            identity(path=USR_ROOT, uid=1001, gid=1001),
            identity(path=ETC_ROOT, inode=12, uid=1002, gid=1002),
        )
        with self.assertRaisesRegex(
            preparer.PreparationError, "unexpected ownership"
        ):
            preparer.prepare_host_runtime()
        reclaim.assert_not_called()

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_replacement_of_either_ancestor_is_rejected(
        self,
        _getuid,
        _getgid,
        _reclaim,
        inspect,
    ) -> None:
        for replaced_root in preparer.HOST_PROJECTION_ANCESTORS:
            with self.subTest(root=replaced_root):
                before_usr = identity(
                    path=USR_ROOT, inode=11, uid=1001, gid=1001
                )
                before_etc = identity(path=ETC_ROOT, inode=12)
                after_usr, after_etc = sealed_roots()
                if replaced_root == USR_ROOT:
                    after_usr = after_usr._replace(inode=99)
                else:
                    after_etc = after_etc._replace(inode=99)
                inspect.side_effect = (
                    before_usr,
                    before_etc,
                    after_usr,
                    after_etc,
                )
                with self.assertRaisesRegex(
                    preparer.PreparationError, "changed identity"
                ):
                    preparer.prepare_host_runtime()
                inspect.reset_mock()

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_reclaim_that_leaves_runner_ownership_is_rejected(
        self,
        _getuid,
        _getgid,
        _reclaim,
        inspect,
    ) -> None:
        sealed_usr, _sealed_etc = sealed_roots()
        inspect.side_effect = (
            identity(path=USR_ROOT, uid=1001, gid=1001),
            identity(path=ETC_ROOT, inode=12),
            sealed_usr,
            identity(path=ETC_ROOT, inode=12, uid=1001, gid=1001),
        )
        with self.assertRaisesRegex(
            preparer.PreparationError, "was not sealed"
        ):
            preparer.prepare_host_runtime()

    @mock.patch.object(preparer, "path_identity")
    @mock.patch.object(preparer, "reclaim_projection_ancestors")
    @mock.patch.object(preparer.os, "getgid", return_value=1001)
    @mock.patch.object(preparer.os, "getuid", return_value=1001)
    def test_ownership_change_during_reclaim_is_rejected(
        self,
        _getuid,
        _getgid,
        _reclaim,
        inspect,
    ) -> None:
        inspect.side_effect = (
            identity(path=USR_ROOT, uid=1001, gid=1001),
            identity(path=ETC_ROOT, inode=12),
            identity(path=USR_ROOT),
            identity(path=ETC_ROOT, inode=12, uid=1002, gid=1002),
        )
        with self.assertRaisesRegex(
            preparer.PreparationError, "unexpected ownership"
        ):
            preparer.prepare_host_runtime()

    @mock.patch.object(preparer.subprocess, "run")
    @mock.patch.object(preparer, "validate_root_tool")
    def test_reclaim_command_is_fixed_and_nonrecursive(
        self, validate_tool, run
    ) -> None:
        preparer.reclaim_projection_ancestors(
            preparer.HOST_PROJECTION_ANCESTORS, 1001, 1001
        )
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
                "--from=1001:1001",
                "0:0",
                "--",
                "/usr",
                "/etc",
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
    def test_single_reclaim_candidate_remains_fixed(self, _validate, run) -> None:
        preparer.reclaim_projection_ancestors((ETC_ROOT,), 1001, 1001)
        self.assertEqual(run.call_args.args[0][7:], ["--", "/etc"])

    @mock.patch.object(preparer.subprocess, "run")
    @mock.patch.object(preparer, "validate_root_tool")
    def test_unknown_repeated_out_of_order_or_empty_candidates_fail_closed(
        self, validate_tool, run
    ) -> None:
        cases = (
            (),
            (Path("/tmp"),),
            (USR_ROOT, USR_ROOT),
            (ETC_ROOT, USR_ROOT),
        )
        for candidates in cases:
            with self.subTest(candidates=candidates):
                with self.assertRaisesRegex(
                    preparer.PreparationError,
                    "unknown, repeated, or out-of-order",
                ):
                    preparer.reclaim_projection_ancestors(
                        candidates, 1001, 1001
                    )
        validate_tool.assert_not_called()
        run.assert_not_called()

    @mock.patch.object(preparer.subprocess, "run")
    @mock.patch.object(preparer, "validate_root_tool")
    def test_reclaim_failure_is_explained(self, _validate_tool, run) -> None:
        run.side_effect = subprocess.CalledProcessError(1, "sudo")
        with self.assertRaisesRegex(
            preparer.PreparationError,
            "could not reclaim the host projection ancestors",
        ):
            preparer.reclaim_projection_ancestors((ETC_ROOT,), 1001, 1001)

    @mock.patch.object(preparer.subprocess, "run")
    @mock.patch.object(preparer, "validate_root_tool")
    def test_reclaim_rejects_a_root_caller_identity(
        self, validate_tool, run
    ) -> None:
        for uid, gid in ((0, 0), (1001, 0), (0, 1001)):
            with self.subTest(uid=uid, gid=gid):
                with self.assertRaisesRegex(
                    preparer.PreparationError, "requires a non-root runner"
                ):
                    preparer.reclaim_projection_ancestors(
                        (USR_ROOT,), uid, gid
                    )
        validate_tool.assert_not_called()
        run.assert_not_called()

    def test_command_line_accepts_no_override(self) -> None:
        with self.assertRaisesRegex(
            preparer.PreparationError, "accepts no arguments"
        ):
            preparer.main(["--root", "/tmp/usr"])


if __name__ == "__main__":
    unittest.main()
