#!/usr/bin/env python3
"""Executable coverage for the sealed main-shell release-lock validator."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile


sys.dont_write_bytecode = True
SCRIPT = pathlib.Path(__file__).with_name(
    "check-homebrew-main-shell-release-locks.py"
)
SPEC = importlib.util.spec_from_file_location("shell_release_locks", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

TF = "b" * 40
C = "c" * 40


def write(root: pathlib.Path, relative: str, value: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)


def fixture(root: pathlib.Path) -> None:
    write(
        root,
        "packages/registry/shell/build.toml",
        f"""\
script_path = "packages/registry/shell/build-shell.sh"
inputs = []
repo_url = "https://github.com/Automattic/kandelo.git"
commit = "UNPUBLISHED"
revision = 22
publication_state = "ready"

[[git_inputs]]
name = "homebrew_tap_core"
repository = "https://github.com/Kandelo-dev/homebrew-tap-core.git"
commit = "{TF}"

[binary]
index_url = "https://example.invalid/index.toml"
""",
    )
    write(
        root,
        "homebrew/main-shell-migration-lock.json",
        json.dumps({"catalog": {"tap_commit": TF}}),
    )
    write(
        root,
        "homebrew/main-shell-homebrew-runtime-support.json",
        json.dumps(
            {
                "catalog": {"tap_commit": TF},
                "lifecycle_installs": [
                    {
                        "tap": "brandonpayton/kandelo-canary",
                        "repository": "brandonpayton/homebrew-kandelo-canary",
                        "revision": C,
                        "formula": "m4",
                        "phase": "guest-lifecycle",
                        "image_closure": False,
                        "reason": (
                            "The independent tap is proof of live third-party "
                            "installation, not a trusted base-image input."
                        ),
                    }
                ],
            }
        ),
    )
    write(
        root,
        "homebrew/main-shell-lazy-artifact-lock.json",
        json.dumps(
            {
                "state": "sealed",
                "image": {"sha256": "d" * 64, "bytes": 1234},
            }
        ),
    )


def rejected(root: pathlib.Path) -> None:
    try:
        MODULE.check(root, TF, C)
    except MODULE.ContractError:
        return
    raise AssertionError("invalid release-lock fixture was accepted")


with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    fixture(root)
    MODULE.check(root, TF, C)

    build_path = root / "packages/registry/shell/build.toml"
    build = build_path.read_text()
    build_path.write_text(
        build.replace(f'commit = "{TF}"', f'commit = "{"e" * 40}"', 1)
    )
    rejected(root)
    build_path.write_text(build)

    # Keep the nested catalog commit correct while making the top-level recipe
    # commit look publishable. This is the exact ambiguity an unstructured
    # `grep commit = ...` check cannot distinguish.
    build_path.write_text(
        build.replace('commit = "UNPUBLISHED"', f'commit = "{TF}"')
    )
    rejected(root)
    build_path.write_text(build)

    build_path.write_text(
        build.replace(
            'publication_state = "ready"', 'publication_state = "pending"'
        )
    )
    rejected(root)
    build_path.write_text(build)

    # A reviewed next-generation source commit may advance the package
    # revision without changing this reusable workflow implementation.
    build_path.write_text(build.replace("revision = 22", "revision = 23"))
    MODULE.check(root, TF, C)
    build_path.write_text(build)

    for invalid_revision in ["0", "true", '"22"', "22.5"]:
        build_path.write_text(
            build.replace("revision = 22", f"revision = {invalid_revision}")
        )
        rejected(root)
    build_path.write_text(build)

    build_path.write_text(
        build
        + f"""\

[[git_inputs]]
name = "unexpected"
repository = "https://github.com/example/unexpected.git"
commit = "{TF}"
"""
    )
    rejected(root)
    build_path.write_text(build)

    artifact_path = root / "homebrew/main-shell-lazy-artifact-lock.json"
    artifact = artifact_path.read_text()
    artifact_path.write_text(artifact.replace('"sealed"', '"pending"'))
    rejected(root)
    artifact_path.write_text(artifact)

    support_path = root / "homebrew/main-shell-homebrew-runtime-support.json"
    support = support_path.read_text()
    support_path.write_text(support.replace(C, "f" * 40))
    rejected(root)
    support_path.write_text(support)

    migration_path = root / "homebrew/main-shell-migration-lock.json"
    migration = migration_path.read_text()
    migration_path.write_text("[]")
    rejected(root)
    migration_path.write_text(
        f'{{"catalog":{{"tap_commit":"{TF}"}},'
        f'"catalog":{{"tap_commit":"{TF}"}}}}'
    )
    rejected(root)
    migration_path.write_text(migration)

    with tempfile.TemporaryDirectory() as link_temporary:
        link = pathlib.Path(link_temporary) / "source-link"
        link.symlink_to(root, target_is_directory=True)
        rejected(link)

print("test-check-homebrew-main-shell-release-locks: ok")
