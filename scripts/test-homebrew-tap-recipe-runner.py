#!/usr/bin/env python3
"""Focused tests for the privileged tap-recipe filesystem/protocol boundary."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import socket
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


RUNNER_PATH = Path(__file__).with_name("homebrew-tap-recipe-runner.py")
SPEC = importlib.util.spec_from_file_location("homebrew_tap_recipe_runner", RUNNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load tap recipe runner")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def manifest_bytes(files: list[dict[str, object]], entrypoint: str = "build.sh") -> bytes:
    return (
        json.dumps(
            {
                "schema": 1,
                "dependencies": [],
                "entrypoint": entrypoint,
                "files": files,
            },
            indent=2,
        )
        + "\n"
    ).encode()


class ProtocolTests(unittest.TestCase):
    def test_json_rejects_duplicate_keys_and_non_finite_numbers(self) -> None:
        with self.assertRaisesRegex(runner.RunnerError, "repeats key"):
            runner.parse_json_bytes(b'{"schema":1,"schema":1}', "fixture")
        with self.assertRaisesRegex(runner.RunnerError, "non-finite"):
            runner.parse_json_bytes(b'{"value":NaN}', "fixture")

    def test_homebrew_names_include_version_and_feature_markers(self) -> None:
        for name in ("python@3.14", "gcc@14", "libc++", "foo.bar-baz_1"):
            self.assertIsNotNone(runner.FORMULA_RE.fullmatch(name))
        for name in ("@broken", "+broken", "broken/name", "Uppercase"):
            self.assertIsNone(runner.FORMULA_RE.fullmatch(name))

    def test_systemd_slice_and_unit_have_distinct_grammars(self) -> None:
        self.assertIsNotNone(runner.UNIT_RE.fullmatch("kandelo-homebrew-build-123"))
        self.assertIsNone(runner.UNIT_RE.fullmatch("kandelo-homebrew-build-123.slice"))
        self.assertIsNotNone(
            runner.SLICE_RE.fullmatch("kandelo-homebrew-build-123.slice")
        )

    def test_posix_tree_colons_do_not_enter_systemd_bind_grammar(self) -> None:
        runner.safe_relative_path("share/man/man3/App::Cpan.3", 4_096)
        runner.contained_symlink(
            "share/man/man3/App::Alias.3", "App::Cpan.3", 4_096
        )
        self.assertTrue(runner.safe_tree_text("App::Cpan.3"))
        self.assertFalse(runner.safe_systemd_path_text("/tmp/App::Cpan.3"))
        with self.assertRaisesRegex(runner.RunnerError, "bounded absolute path"):
            runner.canonical_requested_path(
                "/tmp/App::Cpan.3", label="systemd bind path"
            )
        with self.assertRaisesRegex(runner.RunnerError, "unsafe"):
            runner.safe_relative_path("share/man/bad\nname", 4_096)

    def test_protected_runner_socket_fits_the_linux_pathname_limit(self) -> None:
        protected = Path("/run/kandelo-homebrew-publisher") / (
            "build-" + ("a" * 64)
        )
        socket_path = protected / runner.RUNNER_SOCKET_BASENAME
        self.assertEqual(len(os.fsencode(socket_path)), 104)
        self.assertLessEqual(
            len(os.fsencode(socket_path)), runner.UNIX_SOCKET_PATHNAME_BYTES
        )

    @unittest.skipUnless(
        sys.platform.startswith("linux"), "Linux sockaddr_un limit regression"
    )
    def test_linux_enforces_the_filesystem_socket_pathname_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            previous_directory = os.open(".", os.O_RDONLY)
            try:
                os.chdir(temporary)

                def relative_socket_path(length: int, marker: str) -> Path:
                    # WHY: A relative bind makes the sockaddr bytes independent
                    # of checkout, Nix-store, and runner temp-directory lengths.
                    directory_bytes = length - len(os.fsencode("/s"))
                    self.assertGreater(directory_bytes, 0)
                    path = Path(marker * directory_bytes) / "s"
                    path.parent.mkdir()
                    self.assertEqual(len(os.fsencode(path)), length)
                    return path

                maximum = relative_socket_path(
                    runner.UNIX_SOCKET_PATHNAME_BYTES, "a"
                )
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                try:
                    listener.bind(str(maximum))
                finally:
                    listener.close()
                    maximum.unlink(missing_ok=True)

                too_long = relative_socket_path(
                    runner.UNIX_SOCKET_PATHNAME_BYTES + 1, "b"
                )
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                try:
                    with self.assertRaises(OSError):
                        listener.bind(str(too_long))
                finally:
                    listener.close()
                    too_long.unlink(missing_ok=True)
            finally:
                os.fchdir(previous_directory)
                os.close(previous_directory)

    def test_relative_paths_reject_controls_unicode_and_traversal(self) -> None:
        self.assertEqual(
            runner.recipe_relative_path("nested/build.sh", label="fixture"),
            "nested/build.sh",
        )
        for value in ("../build.sh", "nested//build.sh", "é/build.sh", "a\nb"):
            with self.subTest(value=value):
                with self.assertRaises(runner.RunnerError):
                    runner.recipe_relative_path(value, label="fixture")

    def test_config_keeps_child_mount_aliases_virtual(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            host_keys = (
                "allowed_request_root",
                "native_cellar",
                "platform_host_root",
                "protected_root",
                "recipe_host_root",
                "sealed_root",
                "sysroot_host_root",
                "target_cellar",
            )
            config: dict[str, object] = {}
            for key in host_keys:
                path = root / key
                path.mkdir()
                config[key] = str(path)
            native_closure_manifest = (
                Path(config["protected_root"]) / "native-closure.json"
            )
            config["native_closure_manifest"] = str(native_closure_manifest)
            aliases = {
                "platform_alias_root": "/home/runner/kandelo-platform",
                "recipe_alias_root": "/home/runner/work/tap/Kandelo/recipes/fixture",
                "sysroot_alias_root": "/home/runner/kandelo-sysroot",
            }
            config.update(aliases)

            runner.normalize_config_paths(config)

            for key in host_keys:
                self.assertEqual(config[key], root / key)
            for key, value in aliases.items():
                self.assertEqual(config[key], Path(value))
                self.assertFalse(Path(value).exists())
            self.assertEqual(
                config["native_closure_manifest"], native_closure_manifest
            )

            native_closure_manifest.write_text('{"schema":1}')
            preseeded = {
                key: str(root / key)
                for key in host_keys
            }
            preseeded["native_closure_manifest"] = str(native_closure_manifest)
            preseeded.update(aliases)
            with self.assertRaisesRegex(
                runner.RunnerError, "appeared before native Homebrew was sealed"
            ):
                runner.normalize_config_paths(preseeded)

    def test_sysroot_staging_cli_accepts_only_its_two_paths(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            [
                str(RUNNER_PATH),
                "--stage-sysroot",
                "--source",
                "/source",
                "--destination",
                "/protected/sysroot",
            ],
        ):
            arguments = runner.parse_arguments()
        self.assertTrue(arguments.stage_sysroot)
        self.assertEqual(arguments.source, "/source")
        self.assertEqual(arguments.destination, "/protected/sysroot")

        with (
            mock.patch.object(
                sys,
                "argv",
                [
                    str(RUNNER_PATH),
                    "--stage-sysroot",
                    "--source",
                    "/source",
                    "--destination",
                    "/protected/sysroot",
                    "--formula",
                    "unexpected",
                ],
            ),
            self.assertRaisesRegex(runner.RunnerError, "only --source"),
        ):
            runner.parse_arguments()

    def test_native_closure_staging_cli_accepts_only_its_two_paths(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            [
                str(RUNNER_PATH),
                "--stage-native-closure",
                "--source",
                "/native/Cellar",
                "--destination",
                "/protected/native-closure.json",
            ],
        ):
            arguments = runner.parse_arguments()
        self.assertTrue(arguments.stage_native_closure)
        self.assertEqual(arguments.source, "/native/Cellar")
        self.assertEqual(
            arguments.destination, "/protected/native-closure.json"
        )

        with (
            mock.patch.object(
                sys,
                "argv",
                [
                    str(RUNNER_PATH),
                    "--stage-native-closure",
                    "--source",
                    "/native/Cellar",
                    "--destination",
                    "/protected/native-closure.json",
                    "--formula",
                    "unexpected",
                ],
            ),
            self.assertRaisesRegex(runner.RunnerError, "only --source"),
        ):
            runner.parse_arguments()

    def test_command_deadline_survives_a_descendant_inheriting_stdout(self) -> None:
        started = time.monotonic()
        with self.assertRaisesRegex(runner.RunnerError, "execution deadline"):
            runner.run_bounded_command(
                [
                    sys.executable,
                    "-c",
                    (
                        "import subprocess, sys; "
                        "subprocess.Popen("
                        "[sys.executable, '-c', 'import time; time.sleep(3)'], "
                        "stdout=sys.stdout, stderr=sys.stderr)"
                    ),
                ],
                timeout_seconds=1,
            )
        self.assertLess(time.monotonic() - started, 2.0)

    def test_command_output_limit_is_caller_bounded(self) -> None:
        with self.assertRaisesRegex(runner.RunnerError, "fixture output limit"):
            runner.run_bounded_command(
                [sys.executable, "-c", "print('x' * 4096)"],
                timeout_seconds=5,
                max_output_bytes=128,
                output_limit_error="fixture output limit",
            )

    def test_failed_unit_diagnostics_are_bounded_and_nonfatal(self) -> None:
        with mock.patch.object(
            runner,
            "run_bounded_command",
            side_effect=[1, runner.RunnerError("bounded fixture failure")],
        ) as bounded:
            runner.report_recipe_unit_failure("kandelo-homebrew-build-123")

        self.assertEqual(bounded.call_count, 2)
        limits = [
            call.kwargs["max_output_bytes"] for call in bounded.call_args_list
        ]
        self.assertEqual(
            sum(limits), runner.MAX_RECIPE_FAILURE_DIAGNOSTIC_BYTES
        )
        self.assertTrue(
            any(
                argument == "--property=ExecMainStatus"
                for argument in bounded.call_args_list[0].args[0]
            )
        )
        self.assertIn(
            "kandelo-homebrew-build-123.service",
            bounded.call_args_list[1].args[0],
        )


@unittest.skipUnless(
    Path("/nix/var/nix/profiles/default/bin/nix-store").exists(),
    "Nix closure query is unavailable",
)
class NixRuntimeProjectionTests(unittest.TestCase):
    def test_projects_exact_runtime_closure_instead_of_the_whole_store(self) -> None:
        node = shutil.which("node")
        clang = shutil.which("clang")
        if node is None or clang is None:
            self.skipTest("declared Node and LLVM tools are unavailable")
        node_path = Path(node).resolve(strict=True)
        llvm_bin = Path(clang).resolve(strict=True).parent
        store = Path("/nix/store")
        if not runner.is_within(node_path, store) or not runner.is_within(
            llvm_bin, store
        ):
            self.skipTest("declared Node and LLVM tools are not Nix store objects")

        roots = runner.nix_store_requisites(
            {"node_bin": node_path, "llvm_bin": llvm_bin}
        )
        self.assertNotIn(store, roots)
        self.assertTrue(any(runner.is_within(node_path, root) for root in roots))
        self.assertTrue(any(runner.is_within(llvm_bin, root) for root in roots))
        self.assertTrue(
            all(runner.NIX_STORE_ROOT_RE.fullmatch(str(root)) for root in roots)
        )


class RecipeProjectionTests(unittest.TestCase):
    def make_recipe(self, root: Path) -> tuple[Path, str]:
        source = root / "recipe-fixture"
        nested = source / "nested"
        nested.mkdir(parents=True)
        source.chmod(0o755)
        nested.chmod(0o755)
        build = source / "build.sh"
        helper = nested / "helper.txt"
        build.write_bytes(b"#!/usr/bin/env bash\nexit 0\n")
        helper.write_bytes(b"fixture\n")
        build.chmod(0o755)
        helper.chmod(0o644)
        records = []
        for path, mode in ((build, "0755"), (helper, "0644")):
            data = path.read_bytes()
            records.append(
                {
                    "bytes": len(data),
                    "mode": mode,
                    "path": path.relative_to(source).as_posix(),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        data = manifest_bytes(records)
        manifest = source / "recipe.json"
        manifest.write_bytes(data)
        manifest.chmod(0o644)
        return source, hashlib.sha256(data).hexdigest()

    def stage(self, root: Path, source: Path, digest: str) -> Path:
        fake_runner = root / "homebrew-tap-recipe-runner"
        fake_runner.write_bytes(b"runner")
        destination = root / "selected-recipe"
        with (
            mock.patch.object(runner, "__file__", str(fake_runner)),
            mock.patch.object(runner.os, "geteuid", return_value=0),
            mock.patch.object(runner.os, "chown"),
            mock.patch.object(runner.os, "fchown"),
        ):
            runner.stage_recipe(
                str(source), str(destination), "recipe-fixture", digest
            )
        return destination

    def test_stages_only_the_manifest_closed_recipe_with_semantic_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, digest = self.make_recipe(root)
            destination = self.stage(root, source, digest)
            self.assertEqual(
                (destination / "build.sh").read_bytes(),
                (source / "build.sh").read_bytes(),
            )
            self.assertEqual(
                stat.S_IMODE((destination / "recipe.json").stat().st_mode), 0o644
            )
            self.assertEqual(
                stat.S_IMODE((destination / "build.sh").stat().st_mode), 0o755
            )
            self.assertEqual(
                stat.S_IMODE((destination / "nested").stat().st_mode), 0o755
            )
            self.assertNotEqual(destination.stat().st_ino, source.stat().st_ino)

    def test_rejects_extra_nodes_and_removes_partial_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, digest = self.make_recipe(root)
            (source / "undeclared").write_bytes(b"authority")
            (source / "undeclared").chmod(0o644)
            with self.assertRaisesRegex(runner.RunnerError, "unexpected file"):
                self.stage(root, source, digest)
            self.assertFalse((root / "selected-recipe").exists())

    def test_rejects_symlinks_and_wrong_manifest_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, digest = self.make_recipe(root)
            with self.assertRaisesRegex(runner.RunnerError, "attestation"):
                self.stage(root, source, "0" * 64)
            os.symlink("build.sh", source / "alias")
            with self.assertRaises(runner.RunnerError):
                self.stage(root, source, digest)


class SysrootProjectionTests(unittest.TestCase):
    def make_sysroot(self, root: Path) -> tuple[Path, int]:
        source = root / "source-sysroot"
        (source / "bin").mkdir(parents=True)
        (source / "include/real").mkdir(parents=True)
        (source / "lib").mkdir()
        (source / "share/man/man3").mkdir(parents=True)
        files = {
            "metadata.txt": b"sysroot metadata\n",
            "bin/tool": b"#!/bin/sh\nexit 0\n",
            "include/real/fixture.h": b"#define FIXTURE 1\n",
            "lib/libc.a": b"archive\n",
            "share/man/man3/App::Cpan.3": b"documented module\n",
        }
        for relative, data in files.items():
            path = source / relative
            path.write_bytes(data)
            path.chmod(0o755 if relative == "bin/tool" else 0o644)
        (source / "lib/libc-link.a").symlink_to("libc.a")
        (source / "include/alias").symlink_to("real", target_is_directory=True)
        (source / "share/man/man3/App::Alias.3").symlink_to("App::Cpan.3")
        return source, sum(len(data) for data in files.values())

    def stage(
        self,
        root: Path,
        source: Path,
        *,
        limits: dict[str, int] = runner.SYSROOT_LIMITS,
    ) -> tuple[Path, str, int, int]:
        protected = root / "protected"
        protected.mkdir()
        destination = protected / "sysroot"
        digest, entries, total = runner.stage_sysroot_tree(
            source,
            destination,
            owner_uid=os.getuid(),
            owner_gid=os.getgid(),
            limits=limits,
        )
        return destination, digest, entries, total

    def test_preserves_contained_symlinks_and_seals_exact_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, expected_bytes = self.make_sysroot(root)

            destination, digest, entries, total = self.stage(root, source)

            self.assertEqual(entries, 15)
            self.assertEqual(total, expected_bytes)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
            self.assertTrue((destination / "lib/libc-link.a").is_symlink())
            self.assertEqual(
                os.readlink(destination / "lib/libc-link.a"), "libc.a"
            )
            self.assertTrue((destination / "include/alias").is_symlink())
            self.assertEqual(os.readlink(destination / "include/alias"), "real")
            self.assertEqual(
                os.readlink(destination / "share/man/man3/App::Alias.3"),
                "App::Cpan.3",
            )
            self.assertEqual(
                (
                    destination / "share/man/man3/App::Alias.3"
                ).read_bytes(),
                b"documented module\n",
            )
            self.assertEqual(
                (destination / "include/alias/fixture.h").read_bytes(),
                (source / "include/real/fixture.h").read_bytes(),
            )
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o555)
            self.assertEqual(
                stat.S_IMODE((destination / "bin/tool").stat().st_mode), 0o555
            )
            self.assertEqual(
                stat.S_IMODE((destination / "metadata.txt").stat().st_mode),
                0o444,
            )
            snapshot, validated_entries, validated_bytes = (
                runner.inspect_tree_snapshot(
                    destination,
                    runner.SYSROOT_LIMITS,
                    "test sysroot",
                    hash_files=True,
                    sealed_owner=(os.getuid(), os.getgid()),
                    require_single_link_files=True,
                )
            )
            self.assertEqual(validated_entries, entries)
            self.assertEqual(validated_bytes, total)
            self.assertEqual(
                runner.sealed_tree_manifest(snapshot, "test sysroot"), digest
            )

    def test_rejects_dangling_escaping_absolute_and_looping_symlinks(self) -> None:
        cases = {
            "dangling": ("missing", "dangling"),
            "escaping": ("../outside", "escapes"),
            "absolute": ("/etc/passwd", "unsafe symlink"),
            "loop": ("second", "loop"),
        }
        for label, (target, expected) in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                source = root / "source"
                source.mkdir()
                (source / "first").symlink_to(target)
                if label == "loop":
                    (source / "second").symlink_to("first")
                protected = root / "protected"
                protected.mkdir()
                destination = protected / "sysroot"

                with self.assertRaisesRegex(runner.RunnerError, expected):
                    runner.stage_sysroot_tree(
                        source,
                        destination,
                        owner_uid=os.getuid(),
                        owner_gid=os.getgid(),
                    )

                self.assertFalse(destination.exists())
                self.assertEqual(list(protected.glob(".sysroot-stage-*")), [])

    def test_rejects_cross_device_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source"
            source.mkdir()
            (source / "foreign").write_bytes(b"fixture\n")
            original_stat = runner.os.stat

            def cross_device_stat(
                path: object, *args: object, **kwargs: object
            ) -> os.stat_result:
                result = original_stat(path, *args, **kwargs)
                if path == "foreign" and kwargs.get("follow_symlinks") is False:
                    values = list(result)
                    values[2] = result.st_dev + 1
                    return os.stat_result(values)
                return result

            with (
                mock.patch.object(runner.os, "stat", cross_device_stat),
                self.assertRaisesRegex(runner.RunnerError, "crosses a filesystem"),
            ):
                runner.inspect_tree_snapshot(
                    source,
                    runner.SYSROOT_LIMITS,
                    "test sysroot",
                    hash_files=False,
                )

    def test_rejects_limits_before_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source"
            source.mkdir()
            (source / "first").write_bytes(b"first")
            (source / "second").write_bytes(b"second")
            protected = root / "protected"
            protected.mkdir()
            limits = {
                "max_entries": 1,
                "max_file_bytes": 16,
                "max_bytes": 16,
                "max_path_bytes": 128,
            }
            with self.assertRaisesRegex(runner.RunnerError, "entry limit"):
                runner.stage_sysroot_tree(
                    source,
                    protected / "sysroot",
                    owner_uid=os.getuid(),
                    owner_gid=os.getgid(),
                    limits=limits,
                )
            self.assertEqual(list(protected.iterdir()), [])

    def test_source_mutation_removes_the_complete_partial_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, _ = self.make_sysroot(root)
            protected = root / "protected"
            protected.mkdir()
            destination = protected / "sysroot"
            original_copy = runner.copy_input_tree

            def copy_then_mutate(*args: object, **kwargs: object) -> tuple[int, int]:
                result = original_copy(*args, **kwargs)
                (source / "metadata.txt").write_bytes(b"changed after copy\n")
                return result

            with (
                mock.patch.object(
                    runner, "copy_input_tree", copy_then_mutate
                ),
                self.assertRaisesRegex(runner.RunnerError, "changed while"),
            ):
                runner.stage_sysroot_tree(
                    source,
                    destination,
                    owner_uid=os.getuid(),
                    owner_gid=os.getgid(),
                )

            self.assertFalse(destination.exists())
            self.assertEqual(list(protected.glob(".sysroot-stage-*")), [])

    def test_failed_post_rename_validation_removes_published_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, _ = self.make_sysroot(root)
            protected = root / "protected"
            protected.mkdir()
            destination = protected / "sysroot"
            original_inspect = runner.inspect_tree_snapshot

            def reject_published_tree(
                path: Path,
                limits: dict[str, int],
                label: str,
                **kwargs: object,
            ) -> tuple[runner.TreeSnapshot, int, int]:
                if label == "published sysroot":
                    raise runner.RunnerError("simulated final validation failure")
                return original_inspect(path, limits, label, **kwargs)

            with (
                mock.patch.object(
                    runner, "inspect_tree_snapshot", reject_published_tree
                ),
                self.assertRaisesRegex(
                    runner.RunnerError, "simulated final validation failure"
                ),
            ):
                runner.stage_sysroot_tree(
                    source,
                    destination,
                    owner_uid=os.getuid(),
                    owner_gid=os.getgid(),
                )

            self.assertFalse(destination.exists())
            self.assertEqual(list(protected.glob(".sysroot-stage-*")), [])

    def test_final_validation_rejects_mode_and_symlink_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, _ = self.make_sysroot(root)
            destination, original_digest, _, _ = self.stage(root, source)
            (destination / "metadata.txt").chmod(0o644)
            with self.assertRaisesRegex(runner.RunnerError, "not sealed"):
                runner.inspect_tree_snapshot(
                    destination,
                    runner.SYSROOT_LIMITS,
                    "test sysroot",
                    hash_files=True,
                    sealed_owner=(os.getuid(), os.getgid()),
                    require_single_link_files=True,
                )
            (destination / "metadata.txt").chmod(0o444)
            link = destination / "lib/libc-link.a"
            link.parent.chmod(0o755)
            link.unlink()
            link.symlink_to("../metadata.txt")
            link.parent.chmod(0o555)
            snapshot, _, _ = runner.inspect_tree_snapshot(
                destination,
                runner.SYSROOT_LIMITS,
                "test sysroot",
                hash_files=True,
                sealed_owner=(os.getuid(), os.getgid()),
                require_single_link_files=True,
            )
            self.assertNotEqual(
                runner.sealed_tree_manifest(snapshot, "test sysroot"),
                original_digest,
            )


class ServiceRootProjectionTests(unittest.TestCase):
    def test_creates_only_declared_mount_destinations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary).resolve()
            declared = host / "declared"
            secret = host / "host-secret"
            declared.mkdir()
            secret.write_text("must stay outside the service root\n")
            readonly_destination = Path("/projection/declared")
            writable_source = host / "writable"
            writable_source.mkdir()
            writable_destination = Path("/projection/writable")
            service_root = host / "service-root"
            with (
                mock.patch.object(runner.os, "geteuid", return_value=0),
                mock.patch.object(runner.os, "chown"),
            ):
                runner.prepare_service_root(
                    service_root,
                    [(declared, readonly_destination)],
                    [(writable_source, writable_destination)],
                )
            self.assertTrue((service_root / "projection/declared").is_dir())
            self.assertTrue((service_root / "projection/writable").is_dir())
            self.assertFalse((service_root / secret.relative_to("/")).exists())
            self.assertFalse((service_root / "run/systemd/private").exists())

    def test_rejects_two_sources_for_one_service_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary).resolve()
            first = host / "first"
            second = host / "second"
            first.mkdir()
            second.mkdir()
            with (
                mock.patch.object(runner.os, "geteuid", return_value=0),
                mock.patch.object(runner.os, "chown"),
                self.assertRaisesRegex(runner.RunnerError, "ambiguous"),
            ):
                runner.prepare_service_root(
                    host / "service-root",
                    [(first, Path("/input")), (second, Path("/input"))],
                    [],
                )

    def test_rejects_one_destination_with_conflicting_access_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary).resolve()
            source = host / "source"
            source.mkdir()
            with (
                mock.patch.object(runner.os, "geteuid", return_value=0),
                mock.patch.object(runner.os, "chown"),
                self.assertRaisesRegex(runner.RunnerError, "ambiguous"),
            ):
                runner.prepare_service_root(
                    host / "service-root",
                    [(source, Path("/input"))],
                    [(source, Path("/input"))],
                )

    def test_rejects_destination_traversal_before_creating_outside_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary).resolve()
            source = host / "source"
            source.mkdir()
            service_root = host / "service-root"
            escaped = host / "escaped"
            with (
                mock.patch.object(runner.os, "geteuid", return_value=0),
                mock.patch.object(runner.os, "chown"),
                self.assertRaisesRegex(runner.RunnerError, "destination is unsafe"),
            ):
                runner.prepare_service_root(
                    service_root,
                    [(source, Path("/projection/../../escaped"))],
                    [],
                )
            self.assertFalse(escaped.exists())


class ResourceProjectionTests(unittest.TestCase):
    RESOURCE = {
        "name": "chocolate-doom",
        "source_sha256": "a" * 64,
        "source_url": "https://example.test/chocolate-doom.tar.gz",
    }

    def make_fixture(
        self, root: Path
    ) -> tuple[dict[str, object], dict[str, object], Path]:
        resource = root / "kandelo-package-resources/chocolate-doom"
        resource.mkdir(parents=True)
        (resource / "input.txt").write_text("verified resource\n")
        request: dict[str, object] = {
            "resources": {"chocolate-doom": str(resource)}
        }
        config: dict[str, object] = {
            "build_uid": os.getuid(),
            "resources": [dict(self.RESOURCE)],
        }
        return request, config, resource

    def test_accepts_only_the_attested_fixed_resource_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            request, config, resource = self.make_fixture(root)

            selected = runner.validate_requested_resources(
                request, config, root
            )

            self.assertEqual(selected, {"chocolate-doom": resource})
            self.assertEqual(
                runner.resource_env_key("chocolate-doom"),
                "WASM_POSIX_DEP_RESOURCE_CHOCOLATE_DOOM_DIR",
            )
            self.assertEqual(
                runner.resource_guest_root("chocolate-doom"),
                Path("/kandelo/resources/chocolate-doom"),
            )

    def test_rejects_dependency_and_resource_environment_collision(self) -> None:
        with self.assertRaisesRegex(
            runner.RunnerError,
            "dependency and resource paths collide",
        ):
            runner.reject_dependency_resource_env_collisions(
                ["kandelo-dev/tap-core/resource-chocolate-doom"],
                ["chocolate-doom"],
            )

    def test_rejects_missing_extra_and_caller_selected_resource_paths(self) -> None:
        mutations = {
            "missing": lambda request, _config, _resource: request[
                "resources"
            ].clear(),
            "unexpected mapping": lambda request, _config, resource: request[
                "resources"
            ].update({"extra": str(resource)}),
            "caller path": lambda request, _config, resource: request[
                "resources"
            ].update({"chocolate-doom": str(resource.parent)}),
            "extra staged root": lambda _request, _config, resource: (
                resource.parent / "extra"
            ).mkdir(),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                request, config, resource = self.make_fixture(root)
                mutate(request, config, resource)

                with self.assertRaises(runner.RunnerError):
                    runner.validate_requested_resources(request, config, root)

    def test_rejects_resource_root_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            request, config, resource = self.make_fixture(root)
            outside = root / "outside"
            outside.mkdir()
            shutil.rmtree(resource)
            resource.symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(runner.RunnerError, "canonical"):
                runner.validate_requested_resources(request, config, root)

    def test_rejects_resource_directory_replacement_after_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            request, config, resource = self.make_fixture(root)
            selected = runner.validate_requested_resources(
                request, config, root
            )
            identity = runner.capture_resource_staging_identity(root, selected)
            shutil.rmtree(resource)
            resource.mkdir()
            (resource / "input.txt").write_text("replacement\n")

            with self.assertRaisesRegex(
                runner.RunnerError,
                "staging identity changed",
            ):
                runner.require_resource_staging_identity(
                    root, selected, identity
                )

    def test_copy_rejects_symlink_escape_and_late_directory_mutation(self) -> None:
        limits = {
            "max_entries": 16,
            "max_file_bytes": 1_024,
            "max_bytes": 4_096,
            "max_path_bytes": 128,
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source"
            source.mkdir()
            (source / "input.txt").write_text("resource\n")
            (source / "escape").symlink_to("../outside")
            with (
                mock.patch.object(runner.os, "fchown"),
                mock.patch.object(runner.os, "chown"),
                self.assertRaisesRegex(runner.RunnerError, "escapes"),
            ):
                runner.copy_input_tree(source, root / "escaped-copy", limits)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source"
            source.mkdir()
            (source / "input.txt").write_text("resource\n")
            original_listdir = runner.os.listdir
            mutated = False

            def listdir_and_mutate(directory: int) -> list[str]:
                nonlocal mutated
                names = original_listdir(directory)
                if not mutated:
                    (source / "late.txt").write_text("late mutation\n")
                    mutated = True
                return names

            with (
                mock.patch.object(runner.os, "listdir", listdir_and_mutate),
                mock.patch.object(runner.os, "fchown"),
                mock.patch.object(runner.os, "chown"),
                self.assertRaisesRegex(runner.RunnerError, "changed while copied"),
            ):
                runner.copy_input_tree(source, root / "mutated-copy", limits)


class TargetDependencySelectionTests(unittest.TestCase):
    @staticmethod
    def make_rack(cellar: Path, name: str, *, mode: int = 0o555) -> Path:
        keg = cellar / name / "1.0"
        keg.mkdir(parents=True)
        keg.chmod(mode)
        keg.parent.chmod(mode)
        return keg

    @staticmethod
    def translate_fixture_root_ownership():
        original = runner.canonical_real_directory

        def canonical_with_fixture_root(
            value: object,
            *,
            label: str,
            owner_uid: int | None = None,
            exact_mode: int | None = None,
        ) -> Path:
            # Temporary fixtures belong to the test user. Translate production
            # root ownership to that user, but preserve nonzero owner checks so
            # the active Formula rack boundary remains exercised.
            expected_owner_uid = os.getuid() if owner_uid == 0 else owner_uid
            return original(
                value,
                label=label,
                owner_uid=expected_owner_uid,
                exact_mode=exact_mode,
            )

        return mock.patch.object(
            runner,
            "canonical_real_directory",
            side_effect=canonical_with_fixture_root,
        )

    def test_ignores_only_the_active_formula_rack_and_selects_sealed_dependencies(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "Cellar"
            cellar.mkdir()
            cellar.chmod(0o1775)
            dependency = self.make_rack(cellar, "dependency")
            self.make_rack(cellar, "active", mode=0o755)

            with self.translate_fixture_root_ownership():
                closure, selected = runner.target_dependency_keg_roots(
                    cellar,
                    "kandelo-dev/tap-core/active",
                    ["kandelo-dev/tap-core/dependency"],
                    os.getuid(),
                )

                self.assertEqual(closure, {"dependency": dependency})
                self.assertEqual(selected, {"dependency": dependency})
                with self.assertRaisesRegex(runner.RunnerError, "wrong mode"):
                    runner.installed_keg_roots(cellar, "native dependency")

    def test_rejects_an_unsealed_extra_rack(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "Cellar"
            cellar.mkdir()
            cellar.chmod(0o1775)
            self.make_rack(cellar, "dependency")
            self.make_rack(cellar, "active")
            self.make_rack(cellar, "unexpected", mode=0o755)

            with (
                self.translate_fixture_root_ownership(),
                self.assertRaisesRegex(runner.RunnerError, "wrong mode"),
            ):
                runner.target_dependency_keg_roots(
                    cellar,
                    "kandelo-dev/tap-core/active",
                    ["kandelo-dev/tap-core/dependency"],
                    os.getuid(),
                )

    def test_rejects_a_same_name_rack_not_owned_by_the_formula_identity(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "Cellar"
            cellar.mkdir()
            cellar.chmod(0o1775)
            self.make_rack(cellar, "dependency")
            self.make_rack(cellar, "active")

            with (
                self.translate_fixture_root_ownership(),
                self.assertRaisesRegex(runner.RunnerError, "wrong owner"),
            ):
                runner.target_dependency_keg_roots(
                    cellar,
                    "kandelo-dev/tap-core/active",
                    ["kandelo-dev/tap-core/dependency"],
                    os.getuid() + 1,
                )

    def test_rejects_self_dependencies_and_colliding_short_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "Cellar"
            cellar.mkdir()
            cellar.chmod(0o1775)

            with self.assertRaisesRegex(
                runner.RunnerError, "cannot depend on its own"
            ):
                runner.target_dependency_keg_roots(
                    cellar,
                    "kandelo-dev/tap-core/active",
                    ["kandelo-dev/tap-core/active"],
                    os.getuid(),
                )
            with self.assertRaisesRegex(
                runner.RunnerError, "collide in the target Cellar"
            ):
                runner.target_dependency_keg_roots(
                    cellar,
                    "kandelo-dev/tap-core/active",
                    [
                        "first-owner/first-tap/shared",
                        "second-owner/second-tap/shared",
                    ],
                    os.getuid(),
                )


class NativeClosureAuthenticationTests(unittest.TestCase):
    make_rack = staticmethod(TargetDependencySelectionTests.make_rack)
    translate_fixture_root_ownership = staticmethod(
        TargetDependencySelectionTests.translate_fixture_root_ownership
    )

    @staticmethod
    def manifest(cellar: Path, kegs: dict[str, Path]) -> bytes:
        return runner.compact_json(runner.native_closure_document(cellar, kegs))

    def authenticate(
        self,
        cellar: Path,
        manifest: bytes,
        direct_formulae: list[str],
    ) -> dict[str, Path]:
        with (
            self.translate_fixture_root_ownership(),
            mock.patch.object(
                runner, "open_regular_file", return_value=(manifest, mock.sentinel.stat)
            ),
            mock.patch.object(
                runner, "validate_sealed_dependency_tree"
            ) as validate_tree,
        ):
            result = runner.authenticated_native_keg_roots(
                cellar,
                cellar.parent / "native-closure.json",
                direct_formulae,
            )
        self.validation_calls = validate_tree.call_args_list
        return result

    def test_accepts_transitive_kegs_but_exposes_direct_roots_separately(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "native/Cellar"
            cellar.mkdir(parents=True)
            direct = self.make_rack(cellar, "wabt")
            transitive = self.make_rack(cellar, "openssl@3")
            cellar.chmod(0o555)
            closure = {"openssl@3": transitive, "wabt": direct}

            authenticated = self.authenticate(
                cellar, self.manifest(cellar, closure), ["wabt"]
            )

            self.assertEqual(authenticated, closure)
            self.assertEqual(
                {name: authenticated[name] for name in ["wabt"]},
                {"wabt": direct},
            )
            self.assertEqual(
                self.validation_calls,
                [
                    mock.call(transitive, "native dependency openssl@3"),
                    mock.call(direct, "native dependency wabt"),
                ],
            )

    def test_rejects_sealed_extra_rack_outside_the_authenticated_inventory(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "native/Cellar"
            cellar.mkdir(parents=True)
            direct = self.make_rack(cellar, "wabt")
            transitive = self.make_rack(cellar, "openssl@3")
            self.make_rack(cellar, "injected")
            cellar.chmod(0o555)
            expected = {"openssl@3": transitive, "wabt": direct}

            with self.assertRaisesRegex(
                runner.RunnerError, "authenticated sealed closure"
            ):
                self.authenticate(
                    cellar, self.manifest(cellar, expected), ["wabt"]
                )

    def test_rejects_mutable_racks_even_when_the_manifest_names_them(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "native/Cellar"
            cellar.mkdir(parents=True)
            direct = self.make_rack(cellar, "wabt")
            mutable = self.make_rack(cellar, "mutable", mode=0o755)
            cellar.chmod(0o555)
            expected = {"mutable": mutable, "wabt": direct}

            with self.assertRaisesRegex(runner.RunnerError, "wrong mode"):
                self.authenticate(
                    cellar, self.manifest(cellar, expected), ["wabt"]
                )

    def test_rejects_a_missing_declared_direct_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cellar = Path(temporary).resolve() / "native/Cellar"
            cellar.mkdir(parents=True)
            transitive = self.make_rack(cellar, "openssl@3")
            cellar.chmod(0o555)
            expected = {"openssl@3": transitive}

            with self.assertRaisesRegex(
                runner.RunnerError, "omits declared direct tools"
            ):
                self.authenticate(
                    cellar, self.manifest(cellar, expected), ["wabt"]
                )

    def test_rejects_manifest_name_order_and_keg_collisions(self) -> None:
        cellar = Path("/native/Cellar")
        fixtures = {
            "unsorted": {
                "cellar": str(cellar),
                "kegs": [
                    {"formula": "zlib", "root": f"{cellar}/zlib/1.0"},
                    {"formula": "openssl@3", "root": f"{cellar}/openssl@3/1.0"},
                ],
                "schema": 1,
            },
            "duplicate root": {
                "cellar": str(cellar),
                "kegs": [
                    {"formula": "first", "root": f"{cellar}/first/1.0"},
                    {"formula": "second", "root": f"{cellar}/first/1.0"},
                ],
                "schema": 1,
            },
        }
        for label, document in fixtures.items():
            with self.subTest(label=label), self.assertRaises(runner.RunnerError):
                runner.parse_native_closure_manifest(
                    runner.compact_json(document),
                    cellar,
                    label="native closure manifest",
                )

    def test_projects_complete_target_and_native_closures_in_distinct_realms(
        self,
    ) -> None:
        target_cellar = Path("/target/Cellar")
        native_cellar = Path("/native/Cellar")
        target_shared = target_cellar / "shared/target-1.0"
        target_transitive = target_cellar / "target-transitive/1.0"
        native_shared = native_cellar / "shared/native-1.0"
        native_transitive = native_cellar / "native-transitive/1.0"

        binds = runner.dependency_keg_binds(
            target_cellar,
            {"shared": target_shared, "target-transitive": target_transitive},
            native_cellar,
            {"native-transitive": native_transitive, "shared": native_shared},
        )

        self.assertEqual(len(binds), 8)
        self.assertIn((target_shared, Path("/target/opt/shared")), binds)
        self.assertIn((native_shared, Path("/native/opt/shared")), binds)
        self.assertIn(
            (target_transitive, Path("/target/opt/target-transitive")), binds
        )
        self.assertIn(
            (native_transitive, Path("/native/opt/native-transitive")), binds
        )

        with self.assertRaisesRegex(runner.RunnerError, "bind collides"):
            runner.dependency_keg_binds(
                target_cellar,
                {"shared": target_shared},
                target_cellar,
                {"shared": target_cellar / "shared/native-1.0"},
            )

    def test_selects_proxy_formulae_and_native_requirements_by_plan_identity(
        self,
    ) -> None:
        target_cellar = Path("/target/Cellar")
        native_cellar = Path("/native/Cellar")
        target_kegs = {
            "gpatch": target_cellar / "gpatch/2.8",
            "ncurses": target_cellar / "ncurses/6.5",
        }
        native_kegs = {
            "binaryen": native_cellar / "binaryen/131",
            "gpatch": native_cellar / "gpatch/2.8",
            "openssl@3": native_cellar / "openssl@3/3.6.3",
            "wabt": native_cellar / "wabt/1.0.41",
        }

        proxies, requirements = runner.native_execution_roots(
            target_kegs,
            native_kegs,
            ["gpatch"],
            ["binaryen", "wabt"],
            ["ncurses"],
        )

        self.assertEqual(proxies, {"gpatch": target_kegs["gpatch"]})
        self.assertEqual(
            requirements,
            {
                "binaryen": native_kegs["binaryen"],
                "wabt": native_kegs["wabt"],
            },
        )
        self.assertNotIn("openssl@3", requirements)
        self.assertEqual(
            runner.requested_native_proxy_roots(
                [str(target_kegs["gpatch"])], proxies
            ),
            [target_kegs["gpatch"]],
        )

    def test_rejects_missing_substituted_versioned_or_colliding_native_proxies(
        self,
    ) -> None:
        target_cellar = Path("/target/Cellar")
        native_cellar = Path("/native/Cellar")
        native = {"gpatch": native_cellar / "gpatch/2.8"}

        fixtures = (
            (
                "missing proxy",
                {},
                [],
                "omits direct native tool proxy",
            ),
            (
                "version mismatch",
                {"gpatch": target_cellar / "gpatch/2.7"},
                [],
                "changed its selected version",
            ),
            (
                "target collision",
                {"gpatch": target_cellar / "gpatch/2.8"},
                ["gpatch"],
                "collide with direct native tools",
            ),
        )
        for label, target, dependencies, error in fixtures:
            with (
                self.subTest(label=label),
                self.assertRaisesRegex(runner.RunnerError, error),
            ):
                runner.native_execution_roots(
                    target,
                    native,
                    ["gpatch"],
                    [],
                    dependencies,
                )

        proxies = {"gpatch": target_cellar / "gpatch/2.8"}
        for supplied in (
            ["/substituted/Cellar/gpatch/2.8"],
            [str(proxies["gpatch"]), str(proxies["gpatch"])],
            [],
        ):
            with (
                self.subTest(supplied=supplied),
                self.assertRaisesRegex(
                    runner.RunnerError, "changed its declared native tool roots"
                ),
            ):
                runner.requested_native_proxy_roots(supplied, proxies)
        two_proxies = {
            "automake": target_cellar / "automake/1.18.1",
            "gpatch": target_cellar / "gpatch/2.8",
        }
        with self.assertRaisesRegex(
            runner.RunnerError, "changed its declared native tool roots"
        ):
            runner.requested_native_proxy_roots(
                [
                    str(two_proxies["gpatch"]),
                    str(two_proxies["automake"]),
                ],
                two_proxies,
            )


class SealedDependencyPathTests(unittest.TestCase):
    @staticmethod
    def root_owned(value: os.stat_result) -> os.stat_result:
        return os.stat_result(
            (
                value.st_mode,
                value.st_ino,
                value.st_dev,
                value.st_nlink,
                0,
                0,
                value.st_size,
                value.st_atime,
                value.st_mtime,
                value.st_ctime,
            )
        )

    def test_accepts_colons_in_sealed_keg_members_and_symlink_targets(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            keg = Path(temporary).resolve() / "Cellar/perl/5.42"
            man = keg / "share/man/man3"
            man.mkdir(parents=True)
            page = man / "App::Cpan.3"
            page.write_text("documented module\n")
            page.chmod(0o444)
            alias = man / "App::Alias.3"
            alias.symlink_to("App::Cpan.3")
            for directory in (man, man.parent, man.parent.parent, keg):
                directory.chmod(0o555)

            real_stat = os.stat
            real_fstat = os.fstat

            def root_stat(*args, **kwargs):
                return self.root_owned(real_stat(*args, **kwargs))

            def root_fstat(*args, **kwargs):
                return self.root_owned(real_fstat(*args, **kwargs))

            with (
                mock.patch.object(runner.os, "stat", side_effect=root_stat),
                mock.patch.object(runner.os, "fstat", side_effect=root_fstat),
            ):
                runner.validate_sealed_dependency_tree(
                    keg, "native dependency perl"
                )


@unittest.skipUnless(
    sys.platform.startswith("linux")
    and os.geteuid() == 0
    and os.environ.get("KANDELO_RUN_SYSTEMD_RECIPE_ROOT_TEST") == "1",
    "live root-owned systemd recipe boundary is opt-in",
)
class LiveSystemdServiceRootTests(unittest.TestCase):
    def test_malicious_recipe_cannot_reach_host_or_system_manager(self) -> None:
        recipe_uid = 65_534
        recipe_gid = 65_534
        with (
            tempfile.TemporaryDirectory(
                prefix="kandelo-recipe-service-", dir="/run"
            ) as protected_temporary,
            tempfile.TemporaryDirectory(
                prefix="kandelo-recipe-request-", dir="/tmp"
            ) as request_temporary,
        ):
            protected = Path(protected_temporary)
            request_root = Path(request_temporary)
            recipe_host = protected / "selected-recipe"
            platform_host = protected / "platform"
            sysroot_host = protected / "sysroot"
            sealed_root = protected / "sealed-outputs"
            for directory in (
                recipe_host,
                platform_host / "libc/glue",
                sysroot_host / "lib",
                sealed_root,
            ):
                directory.mkdir(parents=True, exist_ok=True)
            source = request_root / "kandelo-package-source"
            resource_root = request_root / "kandelo-package-resources"
            resource_source = resource_root / "fixture-data"
            work = request_root / "kandelo-package-work"
            output = request_root / "kandelo-package-out"
            for directory in (source, work, output):
                directory.mkdir()
            resource_source.mkdir(parents=True)
            (source / "input.txt").write_text("reviewed source\n")
            (resource_source / "input.txt").write_text("reviewed resource\n")
            host_secret = request_root.parent / (
                f"{request_root.name}-host-secret"
            )
            host_secret.write_text("must remain outside\n")
            dependency_prefix = Path(
                f"/home/kandelo-recipe-dependency-{os.getpid()}"
            )
            dependency_keg = dependency_prefix / "Cellar/dependency/1.0"
            dependency_opt = dependency_prefix / "opt/dependency"
            (dependency_keg / "lib").mkdir(parents=True)
            (dependency_prefix / "opt").mkdir()
            (dependency_keg / "lib/value.txt").write_text("sealed dependency\n")
            dependency_opt.symlink_to(host_secret)
            for directory in (
                dependency_keg / "lib",
                dependency_keg,
                dependency_keg.parent,
            ):
                directory.chmod(0o555)

            # Production tap and checkout aliases live below /home on GitHub
            # runners. Keep this shape so the test proves explicit binds remain
            # usable inside the private ProtectHome=tmpfs projection.
            recipe_alias = Path("/home/runner/kandelo-recipe")
            platform_alias = Path("/home/runner/kandelo-platform")
            sysroot_alias = Path("/home/runner/kandelo-sysroot")
            script = recipe_host / "build.sh"
            script.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f"host_secret={str(host_secret)!r}\n"
                '[ ! -e "$host_secret" ] && [ ! -r "$host_secret" ]\n'
                '[ ! -e "/proc/1/root$host_secret" ] && '
                '[ ! -r "/proc/1/root$host_secret" ]\n'
                "[ ! -e /run/systemd/private ]\n"
                "if /usr/bin/systemd-run --quiet --wait --pipe -- "
                "/usr/bin/true >/dev/null 2>&1; then exit 93; fi\n"
                '[ "$(/usr/bin/cat "$WASM_POSIX_DEP_SOURCE_DIR/input.txt")" = '
                '"reviewed source" ]\n'
                '[ "$(/usr/bin/cat "$WASM_POSIX_DEP_RESOURCE_FIXTURE_DATA_DIR/input.txt")" = '
                '"reviewed resource" ]\n'
                'if (: >"$WASM_POSIX_DEP_RESOURCE_FIXTURE_DATA_DIR/write-probe") '
                "2>/dev/null; then exit 94; fi\n"
                '[ -r "$WASM_POSIX_DEP_RECIPE_DIR/build.sh" ]\n'
                '[ -r "$WASM_POSIX_GLUE_DIR/abi_constants.h" ]\n'
                '[ -r "$WASM_POSIX_SYSROOT/lib/libc.a" ]\n'
                f'[ "$(/usr/bin/cat {str(dependency_opt)!r}/lib/value.txt)" = '
                '"sealed dependency" ]\n'
                "printf 'closed root projection\\n' "
                '>"$WASM_POSIX_DEP_OUT_DIR/canary.txt"\n'
            )
            script.chmod(0o555)
            (platform_host / "libc/glue/abi_constants.h").write_text("fixture\n")
            (sysroot_host / "lib/libc.a").write_text("fixture\n")
            passwd = protected / "recipe-passwd"
            group = protected / "recipe-group"
            passwd.write_text(
                f"root:x:0:0:root:/root:/usr/sbin/nologin\n"
                f"kandelo-homebrew-recipe:x:{recipe_uid}:{recipe_gid}:"
                "recipe:/nonexistent:/usr/sbin/nologin\n"
            )
            group.write_text(
                f"root:x:0:\nkandelo-homebrew-recipe:x:{recipe_gid}:\n"
            )
            for file in (
                platform_host / "libc/glue/abi_constants.h",
                sysroot_host / "lib/libc.a",
                passwd,
                group,
            ):
                file.chmod(0o444)
            for directory in (
                recipe_host,
                platform_host / "libc/glue",
                platform_host / "libc",
                platform_host,
                sysroot_host / "lib",
                sysroot_host,
                sealed_root,
            ):
                directory.chmod(0o555)
            protected.chmod(0o555)

            request = {
                "entrypoint": recipe_alias / "build.sh",
                "environment": {
                    "PATH": "/usr/bin:/bin",
                    "WASM_POSIX_DEP_OUT_DIR": str(output),
                    "WASM_POSIX_DEP_RECIPE_DIR": str(recipe_alias),
                    "WASM_POSIX_DEP_SOURCE_DIR": str(source),
                    "WASM_POSIX_DEP_RESOURCE_FIXTURE_DATA_DIR": (
                        "/kandelo/resources/fixture-data"
                    ),
                    "WASM_POSIX_GLUE_DIR": str(platform_alias / "libc/glue"),
                    "WASM_POSIX_SYSROOT": str(sysroot_alias),
                },
                "limits": runner.EXPECTED_LIMITS,
                "output_root": output,
                "platform_root": platform_alias,
                "recipe_root": recipe_alias,
                "resources": {"fixture-data": str(resource_source)},
                "source_root": source,
                "sysroot": sysroot_alias,
                "work_root": work,
            }
            config = {
                "build_uid": os.getuid(),
                "group_file": group,
                "llvm_bin": Path("/usr/bin"),
                "node_bin": Path("/usr/bin/node"),
                "platform_host_root": platform_host,
                "protected_root": protected,
                "recipe_gid": recipe_gid,
                "recipe_host_root": recipe_host,
                "recipe_uid": recipe_uid,
                "recipe_user": "kandelo-homebrew-recipe",
                "resources": [
                    {
                        "name": "fixture-data",
                        "source_sha256": "a" * 64,
                        "source_url": "https://example.test/fixture-data.tar.gz",
                    }
                ],
                "sealed_root": sealed_root,
                "slice": "system.slice",
                "sysroot_host_root": sysroot_host,
                "unit_prefix": f"kandelo-recipe-live-{os.getpid()}",
                "passwd_file": passwd,
            }
            try:
                sealed, _, entries, total = runner.run_recipe(
                    request,
                    config,
                    {},
                    {"fixture-data": resource_source},
                    runner.capture_resource_staging_identity(
                        request_root,
                        {"fixture-data": resource_source},
                    ),
                    [],
                    [],
                    [
                        (dependency_keg, dependency_keg),
                        (dependency_keg, dependency_opt),
                    ],
                    "a" * 64,
                )
                self.assertEqual(entries, 1)
                self.assertEqual(total, 23)
                self.assertEqual(
                    (sealed / "canary.txt").read_text(),
                    "closed root projection\n",
                )
                self.assertEqual(host_secret.read_text(), "must remain outside\n")
            finally:
                host_secret.unlink(missing_ok=True)
                shutil.rmtree(dependency_prefix, ignore_errors=True)


class OutputSealingTests(unittest.TestCase):
    def seal(self, root: Path) -> Path:
        raw = root / "raw"
        sealed = root / "sealed"
        raw_stat = raw.stat()
        with (
            mock.patch.object(runner.os, "chown"),
            mock.patch.object(runner.os, "fchown"),
        ):
            runner.seal_output_tree(
                raw,
                sealed,
                runner.EXPECTED_LIMITS,
                recipe_uid=raw_stat.st_uid,
                recipe_gid=raw_stat.st_gid,
            )
        return sealed

    def test_seals_valid_output_and_preserves_executable_meaning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir(mode=0o755)
            raw.chmod(0o755)
            executable = raw / "program"
            data = raw / "App::Cpan.3"
            alias = raw / "App::Alias.3"
            executable.write_bytes(b"wasm")
            data.write_bytes(b"data")
            executable.chmod(0o755)
            data.chmod(0o644)
            alias.symlink_to("App::Cpan.3")
            sealed = self.seal(root)
            self.assertEqual(stat.S_IMODE(sealed.stat().st_mode), 0o555)
            self.assertEqual(stat.S_IMODE((sealed / "program").stat().st_mode), 0o555)
            self.assertEqual(
                stat.S_IMODE((sealed / "App::Cpan.3").stat().st_mode), 0o444
            )
            self.assertEqual(
                os.readlink(sealed / "App::Alias.3"), "App::Cpan.3"
            )

    def test_rejects_modes_outside_the_published_output_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir(mode=0o755)
            raw.chmod(0o755)
            unsafe = raw / "unsafe"
            unsafe.write_bytes(b"data")
            unsafe.chmod(0o600)
            with self.assertRaisesRegex(runner.RunnerError, "unsafe links, mode"):
                self.seal(root)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO creation is unavailable")
    def test_rejects_fifo_without_opening_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir(mode=0o755)
            raw.chmod(0o755)
            os.mkfifo(raw / "fifo", 0o644)
            with self.assertRaisesRegex(runner.RunnerError, "unsupported node"):
                self.seal(root)


if __name__ == "__main__":
    unittest.main()
