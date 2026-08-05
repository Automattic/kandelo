#!/usr/bin/env python3
"""Executable coverage for the sealed main-shell release-lock validator."""

from __future__ import annotations

import hashlib
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


def write(root: pathlib.Path, relative: str, value: str) -> pathlib.Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    return path


def write_json(root: pathlib.Path, relative: str, value: object) -> pathlib.Path:
    return write(root, relative, json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rebind_locked_inputs(root: pathlib.Path) -> None:
    selection_path = root / "homebrew/main-shell-selection-lock.json"
    selection = json.loads(selection_path.read_text())
    for key, relative in MODULE.SELECTION_INPUTS.items():
        selection["inputs"][key]["sha256"] = digest(root / relative)
    write_json(root, "homebrew/main-shell-selection-lock.json", selection)

    artifact_path = root / "homebrew/main-shell-lazy-artifact-lock.json"
    artifact = json.loads(artifact_path.read_text())
    for key, relative in MODULE.ARTIFACT_INPUTS.items():
        artifact["inputs"][key] = digest(root / relative)
    write_json(root, "homebrew/main-shell-lazy-artifact-lock.json", artifact)


def fixture(root: pathlib.Path) -> None:
    write(
        root,
        "packages/registry/shell/build.toml",
        """\
script_path = "packages/registry/shell/build-shell.sh"
inputs = []
repo_url = "https://github.com/Automattic/kandelo.git"
commit = "UNPUBLISHED"
revision = 23
publication_state = "ready"

[binary]
index_url = "https://example.invalid/index.toml"
""",
    )
    write(root, "homebrew/main-shell.Brewfile", 'brew "example"\n')
    write_json(
        root,
        "homebrew/kandelo-guest-layout.json",
        {"kind": "test-layout", "schema": 1},
    )
    write_json(
        root,
        "homebrew/main-shell-brew-package-tree.json",
        {"kind": "test-bootstrap-tree", "schema": 1},
    )
    write_json(
        root,
        "homebrew/main-shell-demo.json",
        {"kind": "test-demo", "schema": 1},
    )
    write_json(
        root,
        "homebrew/main-shell-materialization-policy.json",
        {"kind": "test-materialization", "schema": 1},
    )
    write_json(
        root,
        "homebrew/main-shell-default.json",
        {"kind": "test-shell", "schema": 1},
    )
    write_json(
        root,
        "homebrew/main-shell-migration-lock.json",
        {"catalog": {"tap_commit": TF}},
    )
    write_json(
        root,
        "homebrew/main-shell-homebrew-runtime-support.json",
        {
            "catalog": {"tap_commit": TF},
            "lifecycle_installs": [
                {
                    "tap": "brandonpayton/kandelo-canary",
                    "repository": "brandonpayton/homebrew-kandelo-canary",
                    "revision": C,
                    "formula": "m4-canary",
                    "phase": "guest-lifecycle",
                    "image_closure": False,
                    "reason": (
                        "The independent tap is proof of live third-party "
                        "installation, not a trusted base-image input."
                    ),
                }
            ],
        },
    )

    selection_inputs = {
        key: {"path": relative, "sha256": digest(root / relative)}
        for key, relative in MODULE.SELECTION_INPUTS.items()
    }
    descriptor_sha = "d" * 64
    write_json(
        root,
        "homebrew/main-shell-selection-lock.json",
        {
            "arch": "wasm32",
            "inputs": selection_inputs,
            "kind": "kandelo-homebrew-main-shell-closed-selection-lock",
            "release": {
                "assets": {
                    "closed-selection.json": {
                        "bytes": 1234,
                        "sha256": descriptor_sha,
                    },
                    "closed-selection.zip": {
                        "bytes": 5678,
                        "sha256": "e" * 64,
                    },
                },
                "formula_count": 3,
                "prepared_tree_git_oid": "f" * 40,
                "repository": "kandelo-dev/homebrew-tap-core",
                "roots": ["alpha", "beta"],
                "selection_manifest_sha256": "a" * 64,
                "tag": f"homebrew-prefix-selection-sha256-{descriptor_sha}",
                "target_commitish": TF,
            },
            "schema": 1,
            "state": "sealed",
        },
    )
    artifact_inputs = {
        key: digest(root / relative)
        for key, relative in MODULE.ARTIFACT_INPUTS.items()
    }
    write_json(
        root,
        "homebrew/main-shell-lazy-artifact-lock.json",
        {
            "image": {"bytes": 1234, "sha256": "1" * 64},
            "inputs": artifact_inputs,
            "kind": "kandelo-homebrew-lazy-shell-artifact-lock",
            "schema": 3,
            "source_date_epoch": 0,
            "state": "sealed",
        },
    )


def rejected(root: pathlib.Path, expected: str | None = None) -> None:
    try:
        MODULE.check(root, TF, C)
    except MODULE.ContractError as error:
        if expected is not None and expected not in str(error):
            raise AssertionError(
                f"rejection did not contain {expected!r}: {error}"
            ) from error
        return
    raise AssertionError("invalid release-lock fixture was accepted")


with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    fixture(root)
    MODULE.check(root, TF, C)

    build_path = root / "packages/registry/shell/build.toml"
    build = build_path.read_text()
    build_path.write_text(
        build.replace('commit = "UNPUBLISHED"', f'commit = "{TF}"')
    )
    rejected(root)
    build_path.write_text(build)

    build_path.write_text(
        build.replace('publication_state = "ready"', 'publication_state = "pending"')
    )
    rejected(root)
    build_path.write_text(build)

    # A reviewed next-generation source commit may advance the package
    # revision without changing this reusable workflow implementation.
    build_path.write_text(build.replace("revision = 23", "revision = 24"))
    MODULE.check(root, TF, C)
    build_path.write_text(build)

    for invalid_revision in ["0", "true", '"23"', "23.5"]:
        build_path.write_text(
            build.replace("revision = 23", f"revision = {invalid_revision}")
        )
        rejected(root)
    build_path.write_text(build)

    build_path.write_text(
        build
        + f"""\

[[git_inputs]]
name = "homebrew_tap_core"
repository = "https://github.com/Kandelo-dev/homebrew-tap-core.git"
commit = "{TF}"
"""
    )
    rejected(root)
    build_path.write_text(build)

    brewfile_path = root / "homebrew/main-shell.Brewfile"
    brewfile = brewfile_path.read_text()
    brewfile_path.write_text(brewfile + 'brew "drift"\n')
    rejected(root)
    brewfile_path.write_text(brewfile)

    selection_path = root / "homebrew/main-shell-selection-lock.json"
    selection = selection_path.read_text()
    selection_path.write_text(selection.replace('"sealed"', '"pending"', 1))
    rejected(root)
    selection_path.write_text(selection)

    selection_value = json.loads(selection)
    selection_value["release"]["target_commitish"] = "2" * 40
    write_json(root, "homebrew/main-shell-selection-lock.json", selection_value)
    rejected(root)
    selection_path.write_text(selection)

    selection_value = json.loads(selection)
    selection_value["release"]["formula_count"] = 0
    write_json(root, "homebrew/main-shell-selection-lock.json", selection_value)
    rejected(root)
    selection_path.write_text(selection)

    selection_value = json.loads(selection)
    selection_value["release"]["tag"] = (
        "homebrew-prefix-selection-sha256-" + "5" * 64
    )
    write_json(root, "homebrew/main-shell-selection-lock.json", selection_value)
    rejected(root, "selection release identity is not exact")
    selection_path.write_text(selection)

    artifact_path = root / "homebrew/main-shell-lazy-artifact-lock.json"
    artifact = artifact_path.read_text()
    artifact_value = json.loads(artifact)
    artifact_value["inputs"]["selection_lock_sha256"] = "3" * 64
    write_json(root, "homebrew/main-shell-lazy-artifact-lock.json", artifact_value)
    rejected(root)
    artifact_path.write_text(artifact)

    artifact_value = json.loads(artifact)
    artifact_value["state"] = "pending"
    artifact_value["image"] = None
    write_json(root, "homebrew/main-shell-lazy-artifact-lock.json", artifact_value)
    rejected(root)
    artifact_path.write_text(artifact)

    demo_path = root / "homebrew/main-shell-demo.json"
    demo = demo_path.read_text()
    demo_path.write_text('{"drift":true}\n')
    rejected(root)
    demo_path.write_text(demo)

    support_path = root / "homebrew/main-shell-homebrew-runtime-support.json"
    support = support_path.read_text()
    support_path.write_text(support.replace(C, "4" * 40))
    rebind_locked_inputs(root)
    rejected(root, "runtime support does not bind the exact canary lifecycle")
    support_path.write_text(support)
    selection_path.write_text(selection)
    artifact_path.write_text(artifact)

    support_path.write_text(support.replace('"m4-canary"', '"m4"'))
    rebind_locked_inputs(root)
    rejected(root, "runtime support does not bind the exact canary lifecycle")
    support_path.write_text(support)
    selection_path.write_text(selection)
    artifact_path.write_text(artifact)

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
