#!/usr/bin/env python3
"""Executable contract tests for the main-shell release finalizer."""

from __future__ import annotations

from collections.abc import Callable
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from unittest import mock


REPO = pathlib.Path(__file__).resolve().parent.parent
FINALIZER = REPO / "scripts/finalize-homebrew-main-shell-release.py"
CHECKER = REPO / "scripts/check-homebrew-main-shell-brewfile.mjs"
PRODUCT_STATE = REPO / "scripts/homebrew-main-shell-product-state.py"
EXECUTOR_PATH = REPO / "scripts/homebrew-prefix-campaign-executor.py"
EXECUTOR_SPEC = importlib.util.spec_from_file_location(
    "homebrew_prefix_campaign_executor_for_finalizer_test",
    EXECUTOR_PATH,
)
assert EXECUTOR_SPEC is not None and EXECUTOR_SPEC.loader is not None
EXECUTOR = importlib.util.module_from_spec(EXECUTOR_SPEC)
sys.modules[EXECUTOR_SPEC.name] = EXECUTOR
EXECUTOR_SPEC.loader.exec_module(EXECUTOR)
FINALIZER_SPEC = importlib.util.spec_from_file_location(
    "finalize_homebrew_main_shell_release_for_test",
    FINALIZER,
)
assert FINALIZER_SPEC is not None and FINALIZER_SPEC.loader is not None
FINALIZER_MODULE = importlib.util.module_from_spec(FINALIZER_SPEC)
sys.modules[FINALIZER_SPEC.name] = FINALIZER_MODULE
FINALIZER_SPEC.loader.exec_module(FINALIZER_MODULE)
COPIED = [
    "crates/shared/src/lib.rs",
    "homebrew/kandelo-guest-layout.json",
    "homebrew/main-shell-migration-lock.json",
    "homebrew/main-shell-homebrew-runtime-support.json",
    "homebrew/main-shell-selection-lock.json",
    "homebrew/main-shell-lazy-artifact-lock.json",
    "homebrew/main-shell-materialization-policy.json",
    "homebrew/homebrew-bootstrap-source-lock.json",
    "homebrew/main-shell-brew-package-tree.json",
    "homebrew/main-shell.Brewfile",
    "homebrew/main-shell-default.json",
    "homebrew/main-shell-demo.json",
    "images/vfs/products/generated/catalog.json",
    "scripts/homebrew-brewfile-selection.rb",
    "docs/homebrew-publishing.md",
]
TAP_NAME = "kandelo-dev/tap-core"
DEPENDENCIES = {
    "bash": ["ncurses"],
    "ncurses": ["libcxx"],
    "m4": ["dash"],
    "diffutils": ["coreutils", "ed"],
    "tar": ["dash", "gzip"],
    "curl": ["libcurl", "openssl", "zlib"],
    "git": [
        "coreutils",
        "dash",
        "diffutils",
        "grep",
        "less",
        "libcurl",
        "openssl",
        "sed",
        "vim",
        "zlib",
    ],
    "libcurl": ["openssl", "zlib"],
    "less": ["ncurses"],
    "vim": ["ncurses"],
    "ruby": ["zlib"],
    "file-formula": ["libmagic"],
}


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_catalog_json(value: object) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def run(*arguments: str, success: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(FINALIZER), *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if success and result.returncode != 0:
        raise AssertionError(result.stderr)
    if not success and result.returncode == 0:
        raise AssertionError("invalid finalization unexpectedly succeeded")
    return result


def assert_product_state(source: pathlib.Path, expected: str) -> None:
    result = subprocess.run(
        [sys.executable, str(PRODUCT_STATE), "--root", str(source)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    if result.stdout.strip() != expected:
        raise AssertionError(
            f"expected product state {expected!r}, got {result.stdout!r}"
        )


def copy_local_source(root: pathlib.Path) -> pathlib.Path:
    source = root / "source"
    for relative in COPIED:
        destination = source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / relative, destination)
    return source


def copy_source(root: pathlib.Path) -> pathlib.Path:
    source = copy_local_source(root)
    # WHY: this finalizer exercises the reviewed ABI-42 shell-delivery
    # contract, including its ABI-42 bottle cohort. An unrelated Kandelo ABI
    # bump must not silently turn those historical fixtures into an ABI-43
    # publication claim; a later ABI-43 Homebrew campaign must supply and seal
    # its own matching bottles and selection.
    abi_path = source / "crates/shared/src/lib.rs"
    abi_source, replacements = re.subn(
        r"^pub const ABI_VERSION: u32 = [0-9]+;$",
        "pub const ABI_VERSION: u32 = 42;",
        abi_path.read_text(),
        count=1,
        flags=re.MULTILINE,
    )
    assert replacements == 1
    abi_path.write_text(abi_source)

    # Preserve the still-supported public ABI-42 fixture independently of the
    # repository's current review-pending local ABI-43 product. This lets the
    # same finalizer prove that public inputs retain their existing behavior
    # while local-test provenance fails before any candidate tap read.
    old_commit = "6ad0e3dbc60e5572c4288c86919238f71c1bc110"
    migration_path = source / "homebrew/main-shell-migration-lock.json"
    migration = json.loads(migration_path.read_text())
    excluded_roots = {"login", "sudo-lite", "sudo", "ruby"}
    excluded_closure = {
        f"{TAP_NAME}/login",
        f"{TAP_NAME}/sudo-lite",
        f"{TAP_NAME}/sudo",
        f"{TAP_NAME}/libyaml",
        f"{TAP_NAME}/ruby",
    }
    migration["catalog"]["tap_commit"] = old_commit
    migration["packages"] = [
        entry
        for entry in migration["packages"]
        if entry["formula"]["name"] not in excluded_roots
    ]
    migration["formula_closure"] = [
        identity
        for identity in migration["formula_closure"]
        if identity not in excluded_closure
    ]
    migration.pop("product", None)
    write_json(migration_path, migration)

    brewfile_path = source / "homebrew/main-shell.Brewfile"
    brewfile_path.write_text(
        "".join(
            line
            for line in brewfile_path.read_text().splitlines(keepends=True)
            if not any(
                line == f'brew "{TAP_NAME}/{name}"\n'
                for name in excluded_roots
            )
        )
    )

    write_json(
        source / "homebrew/main-shell-materialization-policy.json",
        {
            "schema": 1,
            "kind": "kandelo-homebrew-vfs-materialization-policy",
            "embedded_roots": [f"{TAP_NAME}/bash"],
            "embedded_package_order": [
                f"{TAP_NAME}/libcxx",
                f"{TAP_NAME}/ncurses",
                f"{TAP_NAME}/bash",
            ],
        },
    )

    # The ABI-42 fixture must carry the product catalog that describes its
    # own legacy root set.  The current checked catalog intentionally names
    # the review-pending ABI-43 login product instead.
    catalog_path = source / "images/vfs/products/generated/catalog.json"
    catalog = json.loads(catalog_path.read_text())
    shell = next(
        entry
        for entry in catalog["products"]
        if entry["manifest"]["id"] == "browser-main-shell"
    )
    homebrew = shell["manifest"]["software"]["homebrew"]
    embedded = next(group for group in homebrew if group["materialization"] == "embedded")
    lazy = next(group for group in homebrew if group["materialization"] == "lazy")
    embedded["formulae"] = ["bash"]
    if "ruby" not in lazy["formulae"]:
        lazy["formulae"].append("ruby")
    shell["sha256"] = hashlib.sha256(
        canonical_catalog_json(shell["manifest"])
    ).hexdigest()
    catalog_path.write_bytes(canonical_catalog_json(catalog))

    support_path = source / "homebrew/main-shell-homebrew-runtime-support.json"
    support = json.loads(support_path.read_text())
    support["catalog"]["tap_commit"] = old_commit
    support["base_formula_order"] = [
        identity
        for identity in support["base_formula_order"]
        if identity not in excluded_closure
    ]
    support["activation"]["bootstrap_package"]["required_kernel_abi"] = 42
    support["formula_order"] = [
        identity
        for identity in support["formula_order"]
        if identity != f"{TAP_NAME}/libyaml"
    ]
    support["additional_formula_order"] = [f"{TAP_NAME}/ruby"]
    support["availability"] = {
        "audited_catalog": {
            "checkout_commit": old_commit,
            "metadata_sha256": "1" * 64,
            "metadata_tap_commit": "2" * 40,
            "kandelo_commit": "3" * 40,
            "runtime_bottle_provenance_sha256": "4" * 64,
            "kandelo_abi": 42,
            "release_tag": "bottles-abi-v42",
            "required_arch": "wasm32",
        },
        "reusable_public_abi42": [
            f"{TAP_NAME}/{name}"
            for name in [
                "zlib", "ruby", "coreutils", "dash", "ed", "diffutils",
                "grep", "libcxx", "ncurses", "less", "openssl", "libcurl",
                "sed", "vim", "git", "curl", "bzip2", "xz", "findutils",
                "gawk", "gzip", "tar", "posix-utils-lite", "libmagic",
                "file-formula",
            ]
        ],
        "requires_rebuild": [],
        "missing_metadata": [],
        "can_be_deferred": [],
    }
    write_json(support_path, support)

    # Keep the copied pending locks internally bound to the transformed
    # ABI-42 fixture. The finalizer deliberately verifies these digests before
    # it accepts a closed selection, so carrying the repository's ABI-43
    # input hashes here would test only stale-lock rejection.
    selection_path = source / "homebrew/main-shell-selection-lock.json"
    selection = json.loads(selection_path.read_text())
    for bound_input in selection["inputs"].values():
        bound_input["sha256"] = digest(source / bound_input["path"])
    write_json(selection_path, selection)

    artifact_path = source / "homebrew/main-shell-lazy-artifact-lock.json"
    artifact = json.loads(artifact_path.read_text())
    artifact_inputs = {
        "bootstrap_tree_spec_sha256": "homebrew/main-shell-brew-package-tree.json",
        "brewfile_sha256": "homebrew/main-shell.Brewfile",
        "demo_config_sha256": "homebrew/main-shell-demo.json",
        "materialization_policy_sha256":
            "homebrew/main-shell-materialization-policy.json",
        "migration_lock_sha256": "homebrew/main-shell-migration-lock.json",
        "runtime_support_sha256":
            "homebrew/main-shell-homebrew-runtime-support.json",
        "selection_lock_sha256": "homebrew/main-shell-selection-lock.json",
        "shell_config_sha256": "homebrew/main-shell-default.json",
    }
    for key, relative in artifact_inputs.items():
        artifact["inputs"][key] = digest(source / relative)
    write_json(artifact_path, artifact)
    return source


def package_record(
    name: str,
    formula: dict | None,
    dependencies: dict[str, list[str]],
) -> dict:
    revision = formula["revision"] if formula else 0
    version = formula["version"] if formula else "1.0"
    if revision:
        version = f"{version}_{revision}"
    rebuild = formula["bottle_rebuild"] if formula else 1
    if name in {"file-formula", "make", "nano", "nethack", "unzip", "wget", "zip"}:
        rebuild += 1
    bottle_sha = hashlib.sha256(f"bottle:{name}:{rebuild}".encode()).hexdigest()
    return {
        "name": name,
        "full_name": f"{TAP_NAME}/{name}",
        "version": version,
        "formula_revision": revision,
        "bottle_rebuild": rebuild,
        "dependencies": [
            {"name": dependency, "full_name": f"{TAP_NAME}/{dependency}"}
            for dependency in dependencies.get(name, [])
        ],
        "bottles": [
            {
                "arch": "wasm32",
                "bottle_tag": "wasm32_kandelo",
                "status": "success",
                "kandelo_abi": 42,
                "bytes": 100 + len(name),
                "sha256": bottle_sha,
                "cache_key_sha": bottle_sha,
                "url": (
                    "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/"
                    f"{name}/blobs/sha256:{bottle_sha}"
                ),
                "runtime_support": ["node"],
                "built_from": {
                    "tap_repository": "kandelo-dev/homebrew-tap-core",
                    "tap_commit": "a" * 40,
                    "kandelo_repository": "Automattic/kandelo",
                    "kandelo_commit": (
                        "b" * 40 if name == "gawk" else "c" * 40
                    ),
                    "formula_sha256": hashlib.sha256(
                        f"formula:{name}".encode()
                    ).hexdigest(),
                },
            }
        ],
    }


def create_tap(
    root: pathlib.Path,
    source: pathlib.Path,
    omit: str | None = None,
    dependency_overrides: dict[str, list[str]] | None = None,
) -> pathlib.Path:
    tap = root / "tap"
    (tap / "Kandelo").mkdir(parents=True)
    lock = json.loads((source / "homebrew/main-shell-migration-lock.json").read_text())
    support = json.loads(
        (source / "homebrew/main-shell-homebrew-runtime-support.json").read_text()
    )
    formulae = {
        entry["formula"]["name"]: entry["formula"] for entry in lock["packages"]
    }
    names = {
        identity.split("/")[-1] for identity in lock["formula_closure"]
    } | {
        identity.split("/")[-1]
        for identity in support["availability"]["reusable_public_abi42"]
    }
    if omit:
        names.remove(omit)
    dependencies = {**DEPENDENCIES, **(dependency_overrides or {})}
    metadata = {
        "schema": 1,
        "generated_at": "2026-07-28T00:00:00Z",
        "generator": "test",
        "tap_repository": "kandelo-dev/homebrew-tap-core",
        "tap_name": TAP_NAME,
        "tap_commit": "d" * 40,
        "kandelo_repository": "Automattic/kandelo",
        "kandelo_commit": "c" * 40,
        "kandelo_abi": 42,
        "release_tag": "bottles-abi-v42",
        "packages": [
            package_record(name, formulae.get(name), dependencies)
            for name in sorted(names)
        ],
    }
    (tap / "Kandelo/metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    subprocess.run(["git", "-C", str(tap), "init", "-q"], check=True)
    subprocess.run(
        ["git", "-C", str(tap), "config", "user.email", "test@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(tap), "config", "user.name", "Finalizer test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(tap), "add", "Kandelo/metadata.json"], check=True)
    subprocess.run(
        ["git", "-C", str(tap), "commit", "-qm", "fixture"], check=True
    )
    return tap


def dependency_order(
    roots: list[str], packages: dict[str, dict]
) -> list[str]:
    result: list[str] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        assert name not in visiting
        if name in visited:
            return
        visiting.add(name)
        for dependency in packages[name]["dependencies"]:
            visit(dependency["name"])
        visiting.remove(name)
        visited.add(name)
        result.append(name)

    for name in roots:
        visit(name)
    return result


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def create_closed_selection(
    root: pathlib.Path,
    source: pathlib.Path,
) -> tuple[pathlib.Path, pathlib.Path, str]:
    selection_root = root / "selection"
    tap = selection_root / "tap"
    (tap / "Kandelo").mkdir(parents=True)
    migration = json.loads(
        (source / "homebrew/main-shell-migration-lock.json").read_text()
    )
    support = json.loads(
        (
            source / "homebrew/main-shell-homebrew-runtime-support.json"
        ).read_text()
    )
    formulae = {
        entry["formula"]["name"]: entry["formula"]
        for entry in migration["packages"]
    }
    dependencies = {**DEPENDENCIES, "ruby": ["zlib", "libyaml"]}
    names = {
        identity.split("/")[-1]
        for identity in migration["formula_closure"]
    } | {
        identity.split("/")[-1]
        for identity in support["availability"]["reusable_public_abi42"]
    }
    names.update({"homebrew-bootstrap", "libyaml"})
    packages = {
        name: package_record(name, formulae.get(name), dependencies)
        for name in names
    }
    source_commit = "e" * 40
    metadata = {
        "schema": 1,
        "generated_at": "2026-08-01T00:00:00Z",
        "generator": "selection-finalizer-test",
        "tap_repository": "kandelo-dev/homebrew-tap-core",
        "tap_name": TAP_NAME,
        "tap_commit": source_commit,
        "kandelo_repository": "Automattic/kandelo",
        "kandelo_commit": "c" * 40,
        "kandelo_abi": 42,
        "release_tag": "bottles-abi-v42",
        "packages": [packages[name] for name in sorted(packages)],
    }
    write_json(tap / "Kandelo/metadata.json", metadata)

    roots = sorted(
        {
            entry["formula"]["name"]
            for entry in migration["packages"]
        }
        | {
            entry["package"].split("/")[-1]
            for entry in support["formula_roots"]
        }
        | {"homebrew-bootstrap"}
    )
    ordered = dependency_order(roots, packages)
    selection_formulae = []
    for name in ordered:
        bottle = packages[name]["bottles"][0]
        selection_formulae.append(
            {
                "archive": {
                    "bytes": bottle["bytes"],
                    "sha256": bottle["sha256"],
                },
                "formula": name,
                "handoff": {
                    "manifest_sha256": hashlib.sha256(
                        f"handoff:{name}".encode()
                    ).hexdigest(),
                    "tag": "homebrew-prefix-handoff-sha256-"
                    + hashlib.sha256(f"handoff:{name}".encode()).hexdigest(),
                },
                "version": packages[name]["version"],
            }
        )
    campaign_sha = "f" * 64
    selection = {
        "arch": "wasm32",
        "campaign": {
            "guest_layout_sha256": digest(
                source / "homebrew/kandelo-guest-layout.json"
            ),
            "kandelo_commit": metadata["kandelo_commit"],
            "sha256": campaign_sha,
            "tag": f"homebrew-prefix-campaign-sha256-{campaign_sha}",
        },
        "formulae": selection_formulae,
        "kandelo_abi": 42,
        "kind": "kandelo-homebrew-closed-selection-candidate",
        "roots": roots,
        "schema": 1,
        "tap": {
            "name": TAP_NAME,
            "path": "tap",
            "prepared_tree_git_oid": EXECUTOR.filesystem_git_tree_oid(
                tap, "selection finalizer fixture"
            ),
            "repository": "kandelo-dev/homebrew-tap-core",
            "source_commit": source_commit,
            "source_tree_git_oid": "1" * 40,
        },
    }
    selection_payload = EXECUTOR.pretty_json(selection)
    (selection_root / "selection.json").write_bytes(selection_payload)

    descriptor_sha = "9" * 64
    receipt = {
        "arch": "wasm32",
        "assets": {
            "closed-selection.json": {
                "bytes": len(selection_payload),
                "sha256": descriptor_sha,
            },
            "closed-selection.zip": {
                "bytes": 1,
                "sha256": "8" * 64,
            },
        },
        "formula_count": len(ordered),
        "kind": "kandelo-homebrew-closed-selection-readback",
        "prepared_tree_git_oid": selection["tap"][
            "prepared_tree_git_oid"
        ],
        "release_id": 1,
        "repository": "kandelo-dev/homebrew-tap-core",
        "roots": roots,
        "schema": 1,
        "selection_manifest_sha256": hashlib.sha256(
            selection_payload
        ).hexdigest(),
        "tag": f"homebrew-prefix-selection-sha256-{descriptor_sha}",
        "target_commitish": source_commit,
        "visibility": "public-anonymous-readback",
    }
    receipt_path = root / "selection-readback.json"
    receipt_path.write_bytes(canonical_json(receipt))
    return selection_root, receipt_path, source_commit


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def add_future_libyaml_shape(source: pathlib.Path) -> None:
    support_path = source / "homebrew/main-shell-homebrew-runtime-support.json"
    support = json.loads(support_path.read_text())
    libyaml = f"{TAP_NAME}/libyaml"
    ruby = f"{TAP_NAME}/ruby"
    formula_order = support["formula_order"]
    formula_order.insert(formula_order.index(ruby), libyaml)
    support["additional_formula_order"].insert(0, libyaml)
    reusable = support["availability"]["reusable_public_abi42"]
    reusable.insert(reusable.index(ruby), libyaml)
    write_json(support_path, support)


def run_checker(
    source: pathlib.Path,
    tap: pathlib.Path,
    success: bool = True,
) -> subprocess.CompletedProcess[str]:
    arguments = [
        "node",
        str(CHECKER),
        str(source / "homebrew/main-shell.Brewfile"),
        str(source / "homebrew/main-shell-migration-lock.json"),
    ]
    arguments.extend(
        [
            str(tap / "Kandelo/metadata.json"),
            str(source / "homebrew/main-shell-homebrew-runtime-support.json"),
            str(source / "images/vfs/products/generated/catalog.json"),
            str(source / "homebrew/main-shell-materialization-policy.json"),
        ]
    )
    result = subprocess.run(
        arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if success and result.returncode != 0:
        raise AssertionError(result.stderr)
    if not success and result.returncode == 0:
        raise AssertionError("invalid main-shell contract unexpectedly succeeded")
    return result


def assert_failure(
    result: subprocess.CompletedProcess[str], expected: str
) -> None:
    if expected not in result.stderr:
        raise AssertionError(
            f"failure did not contain {expected!r}:\n{result.stderr}"
        )


def remove_one_embedded_formula(policy: dict) -> None:
    policy["embedded_package_order"].pop()


def duplicate_one_embedded_formula(policy: dict) -> None:
    policy["embedded_package_order"][1] = policy["embedded_package_order"][0]


def substitute_one_embedded_formula(policy: dict) -> None:
    policy["embedded_package_order"][0] = f"{TAP_NAME}/unknown"


def misorder_embedded_formulae(policy: dict) -> None:
    policy["embedded_package_order"][0:2] = reversed(
        policy["embedded_package_order"][0:2]
    )


with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-local-rejection."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_local_source(root)
    tap = root / "must-not-read-or-create"
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}
    rejected = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        "--apply",
        success=False,
    )
    assert_failure(
        rejected,
        "local-test provenance is not promotable or selectable",
    )
    assert before == {path: digest(path) for path in paths}
    assert not tap.exists()


with tempfile.TemporaryDirectory(prefix="kandelo-shell-finalizer-test.") as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    tap = create_tap(root, source)
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}

    preview = run("--source-root", str(source), "--tap-root", str(tap))
    preview_json = json.loads(preview.stdout)
    assert preview_json["applied"] is False
    assert preview_json["artifact_state"] == "pending"
    assert before == {path: digest(path) for path in paths}

    applied = run(
        "--source-root", str(source), "--tap-root", str(tap), "--apply"
    )
    applied_json = json.loads(applied.stdout)
    assert applied_json["applied"] is True
    assert applied_json["roots"] == 32
    assert applied_json["base_formulae"] == 38
    assert applied_json["embedded"] == 3
    assert applied_json["lazy"] == 35
    assert applied_json["runtime_formulae"] == 21
    assert applied_json["audited_formulae"] == 25
    assert applied_json["runtime_extra"] == 1
    assert applied_json["total"] == 39
    head = subprocess.run(
        ["git", "-C", str(tap), "rev-parse", "HEAD"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    migration = json.loads(
        (source / "homebrew/main-shell-migration-lock.json").read_text()
    )
    support = json.loads(
        (source / "homebrew/main-shell-homebrew-runtime-support.json").read_text()
    )
    artifact_lock = json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )
    selection_lock = json.loads(
        (source / "homebrew/main-shell-selection-lock.json").read_text()
    )
    assert migration["catalog"]["tap_commit"] == head
    assert support["catalog"]["tap_commit"] == head
    assert support["availability"]["audited_catalog"]["checkout_commit"] == head
    assert artifact_lock["state"] == "pending"
    assert artifact_lock["image"] is None
    assert artifact_lock["schema"] == 3
    assert selection_lock["state"] == "pending"
    assert selection_lock["release"] is None
    assert selection_lock["inputs"]["migration_lock"]["sha256"] == digest(
        source / "homebrew/main-shell-migration-lock.json"
    )
    assert selection_lock["inputs"]["runtime_support"]["sha256"] == digest(
        source / "homebrew/main-shell-homebrew-runtime-support.json"
    )
    assert artifact_lock["inputs"]["selection_lock_sha256"] == digest(
        source / "homebrew/main-shell-selection-lock.json"
    )
    assert artifact_lock["inputs"]["shell_config_sha256"] == digest(
        source / "homebrew/main-shell-default.json"
    )
    assert_product_state(source, "awaiting-selection")
    rebuilt = {
        entry["formula"]["name"]: entry["formula"]["bottle_rebuild"]
        for entry in migration["packages"]
    }
    assert rebuilt["file-formula"] == 4
    assert rebuilt["zip"] == 2

    shell_config_path = source / "homebrew/main-shell-default.json"
    first_shell_config_sha = artifact_lock["inputs"]["shell_config_sha256"]
    shell_config = json.loads(shell_config_path.read_text())
    shell_config["argv"].append("--norc")
    shell_config_path.write_text(json.dumps(shell_config, indent=2) + "\n")
    refreshed = run(
        "--source-root", str(source), "--tap-root", str(tap), "--apply"
    )
    refreshed_json = json.loads(refreshed.stdout)
    assert refreshed_json["artifact_state"] == "pending"
    artifact_lock = json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )
    assert artifact_lock["inputs"]["shell_config_sha256"] == digest(
        shell_config_path
    )
    assert artifact_lock["inputs"]["shell_config_sha256"] != first_shell_config_sha
    assert artifact_lock["image"] is None
    assert_product_state(source, "awaiting-selection")
    checker = run_checker(source, tap)
    assert (
        "38 base Formulae, 21 runtime Formulae, and 25 audited Formulae; "
        "the runtime adds 1 beyond the base, yielding 39 total Formulae"
        in checker.stdout
    )

    artifact = root / "shell.vfs.zst"
    artifact.write_bytes(b"reviewed deterministic shell bytes\n")
    rejected_artifact = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        "--artifact",
        str(artifact),
        "--apply",
        success=False,
    )
    assert_failure(
        rejected_artifact,
        "--artifact requires --selection and --selection-receipt",
    )
    assert_product_state(source, "awaiting-selection")

    (tap / "untracked").write_text("dirty\n")
    dirty = run(
        "--source-root", str(source), "--tap-root", str(tap), success=False
    )
    assert "tap checkout must be clean" in dirty.stderr

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-future-shape."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    add_future_libyaml_shape(source)
    tap = create_tap(
        root,
        source,
        dependency_overrides={"ruby": ["zlib", "libyaml"]},
    )
    applied = run(
        "--source-root", str(source), "--tap-root", str(tap), "--apply"
    )
    summary = json.loads(applied.stdout)
    assert summary["roots"] == 32
    assert summary["base_formulae"] == 38
    assert summary["embedded"] == 3
    assert summary["lazy"] == 35
    assert summary["runtime_formulae"] == 22
    assert summary["audited_formulae"] == 26
    assert summary["runtime_extra"] == 2
    assert summary["total"] == 40
    checker = run_checker(source, tap)
    assert (
        "38 base Formulae, 22 runtime Formulae, and 26 audited Formulae; "
        "the runtime adds 2 beyond the base, yielding 40 total Formulae"
        in checker.stdout
    )

    support_path = source / "homebrew/main-shell-homebrew-runtime-support.json"
    baseline = json.loads(support_path.read_text())
    libyaml = f"{TAP_NAME}/libyaml"
    ruby = f"{TAP_NAME}/ruby"

    missing_runtime = json.loads(json.dumps(baseline))
    missing_runtime["formula_order"].remove(libyaml)
    missing_runtime["additional_formula_order"].remove(libyaml)
    missing_runtime["availability"]["reusable_public_abi42"].remove(libyaml)
    write_json(support_path, missing_runtime)
    assert_failure(
        run_checker(source, tap, success=False),
        "tap metadata dependency closure does not match the Homebrew "
        "runtime-support layer",
    )

    missing_availability = json.loads(json.dumps(baseline))
    missing_availability["availability"]["reusable_public_abi42"].remove(
        libyaml
    )
    write_json(support_path, missing_availability)
    assert_failure(
        run_checker(source, tap, success=False),
        "Homebrew runtime-support activation includes Formulae without "
        f"admitted public ABI-42 bottles: {libyaml}",
    )

    missing_additional = json.loads(json.dumps(baseline))
    missing_additional["additional_formula_order"].remove(libyaml)
    write_json(support_path, missing_additional)
    assert_failure(
        run_checker(source, tap, success=False),
        "Homebrew runtime-support additional closure is not its exact "
        "base-relative difference",
    )

    duplicate_runtime = json.loads(json.dumps(baseline))
    duplicate_runtime["formula_order"].append(libyaml)
    write_json(support_path, duplicate_runtime)
    assert_failure(
        run_checker(source, tap, success=False),
        f"Homebrew runtime-support formula_order contains duplicate {libyaml}",
    )

    duplicate_additional = json.loads(json.dumps(baseline))
    duplicate_additional["additional_formula_order"].append(libyaml)
    write_json(support_path, duplicate_additional)
    assert_failure(
        run_checker(source, tap, success=False),
        "Homebrew runtime-support additional_formula_order contains "
        f"duplicate {libyaml}",
    )

    duplicate_availability = json.loads(json.dumps(baseline))
    duplicate_availability["availability"]["reusable_public_abi42"].append(
        libyaml
    )
    write_json(support_path, duplicate_availability)
    assert_failure(
        run_checker(source, tap, success=False),
        "Homebrew runtime-support availability.reusable_public_abi42 "
        f"contains duplicate {libyaml}",
    )

    duplicate_across_partitions = json.loads(json.dumps(baseline))
    duplicate_across_partitions["availability"]["requires_rebuild"] = [
        libyaml
    ]
    write_json(support_path, duplicate_across_partitions)
    assert_failure(
        run_checker(source, tap, success=False),
        "Homebrew runtime-support availability partition contains duplicate "
        f"{libyaml}",
    )

    mismatched_availability = json.loads(json.dumps(baseline))
    reusable = mismatched_availability["availability"][
        "reusable_public_abi42"
    ]
    reusable[reusable.index(libyaml)] = f"{TAP_NAME}/unknown"
    write_json(support_path, mismatched_availability)
    assert_failure(
        run_checker(source, tap, success=False),
        "Homebrew runtime-support availability includes Formulae outside "
        f"the declared shell/runtime union: {TAP_NAME}/unknown",
    )

    mismatched_runtime_order = json.loads(json.dumps(baseline))
    formula_order = mismatched_runtime_order["formula_order"]
    libyaml_index = formula_order.index(libyaml)
    ruby_index = formula_order.index(ruby)
    formula_order[libyaml_index], formula_order[ruby_index] = (
        formula_order[ruby_index],
        formula_order[libyaml_index],
    )
    mismatched_runtime_order["additional_formula_order"] = [ruby, libyaml]
    write_json(support_path, mismatched_runtime_order)
    assert_failure(
        run_checker(source, tap, success=False),
        "tap metadata dependency closure does not match the Homebrew "
        "runtime-support layer",
    )

    substituted_runtime = json.loads(json.dumps(baseline))
    bzip2 = f"{TAP_NAME}/bzip2"
    formula_order = substituted_runtime["formula_order"]
    formula_order[formula_order.index(libyaml)] = bzip2
    substituted_runtime["additional_formula_order"].remove(libyaml)
    substituted_runtime["availability"]["reusable_public_abi42"].remove(
        libyaml
    )
    write_json(support_path, substituted_runtime)
    assert_failure(
        run_checker(source, tap, success=False),
        "tap metadata dependency closure does not match the Homebrew "
        "runtime-support layer",
    )

    write_json(support_path, baseline)
    run_checker(source, tap)

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-selection."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    clean_source_tap = create_tap(root, source)
    clean_source_head = subprocess.run(
        ["git", "-C", str(clean_source_tap), "rev-parse", "HEAD"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    selection, receipt, source_commit = create_closed_selection(root, source)
    assert clean_source_head != source_commit
    assert not (selection / "tap/.git").exists()
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}

    ambiguous = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(clean_source_tap),
        "--selection",
        str(selection),
        "--selection-receipt",
        str(receipt),
        success=False,
    )
    assert "not allowed with argument --tap-root" in ambiguous.stderr

    preview = run(
        "--source-root",
        str(source),
        "--selection",
        str(selection),
        "--selection-receipt",
        str(receipt),
    )
    preview_summary = json.loads(preview.stdout)
    assert preview_summary["final_tap_commit"] == source_commit
    assert preview_summary["runtime_formulae"] == 22
    assert preview_summary["audited_formulae"] == 26
    assert preview_summary["runtime_extra"] == 2
    assert preview_summary["total"] == 40
    assert preview_summary["selection"]["formula_count"] == 41
    assert before == {path: digest(path) for path in paths}

    applied = run(
        "--source-root",
        str(source),
        "--selection",
        str(selection),
        "--selection-receipt",
        str(receipt),
        "--apply",
    )
    summary = json.loads(applied.stdout)
    assert summary["applied"] is True
    migration = json.loads(
        (source / "homebrew/main-shell-migration-lock.json").read_text()
    )
    support = json.loads(
        (
            source / "homebrew/main-shell-homebrew-runtime-support.json"
        ).read_text()
    )
    selection_lock = json.loads(
        (source / "homebrew/main-shell-selection-lock.json").read_text()
    )
    artifact_lock = json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )
    libyaml = f"{TAP_NAME}/libyaml"
    ruby = f"{TAP_NAME}/ruby"
    assert migration["catalog"]["tap_commit"] == source_commit
    assert support["catalog"]["tap_commit"] == source_commit
    assert support["availability"]["audited_catalog"][
        "checkout_commit"
    ] == source_commit
    assert support["formula_order"].index(libyaml) < support[
        "formula_order"
    ].index(ruby)
    assert support["additional_formula_order"] == [libyaml, ruby]
    assert libyaml in support["availability"]["reusable_public_abi42"]
    assert selection_lock["state"] == "sealed"
    assert selection_lock["release"]["target_commitish"] == source_commit
    assert artifact_lock["state"] == "pending"
    assert artifact_lock["inputs"]["selection_lock_sha256"] == digest(
        source / "homebrew/main-shell-selection-lock.json"
    )
    assert_product_state(source, "candidate")

    artifact = root / "selected-shell.vfs.zst"
    artifact.write_bytes(b"selected deterministic shell bytes\n")
    sealed = run(
        "--source-root",
        str(source),
        "--selection",
        str(selection),
        "--selection-receipt",
        str(receipt),
        "--artifact",
        str(artifact),
        "--apply",
    )
    assert json.loads(sealed.stdout)["artifact_state"] == "sealed"
    assert json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )["image"] == {
        "bytes": artifact.stat().st_size,
        "sha256": digest(artifact),
    }
    assert_product_state(source, "publishable")

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-cross-abi-selection."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    selection, receipt, _source_commit = create_closed_selection(root, source)
    abi_path = source / "crates/shared/src/lib.rs"
    abi_source, replacements = re.subn(
        r"^pub const ABI_VERSION: u32 = 42;$",
        "pub const ABI_VERSION: u32 = 43;",
        abi_path.read_text(),
        count=1,
        flags=re.MULTILINE,
    )
    assert replacements == 1
    abi_path.write_text(abi_source)
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}

    cross_abi = run(
        "--source-root",
        str(source),
        "--selection",
        str(selection),
        "--selection-receipt",
        str(receipt),
        success=False,
    )
    assert_failure(
        cross_abi,
        "closed selection architecture or ABI differs from Kandelo",
    )
    assert before == {path: digest(path) for path in paths}

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-selection-authority."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    selection, receipt, _source_commit = create_closed_selection(root, source)
    receipt_value = json.loads(receipt.read_text())
    receipt_value["target_commitish"] = "a" * 40
    receipt.write_bytes(canonical_json(receipt_value))
    wrong_authority = run(
        "--source-root",
        str(source),
        "--selection",
        str(selection),
        "--selection-receipt",
        str(receipt),
        success=False,
    )
    assert_failure(
        wrong_authority,
        "closed selection does not retain one exact source-tap authority",
    )

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-selection-race."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    selection, receipt, source_commit = create_closed_selection(root, source)
    caller_metadata = selection / "tap/Kandelo/metadata.json"
    original_metadata = caller_metadata.read_bytes()
    original_receipt = receipt.read_bytes()
    original_runtime_provenance = FINALIZER_MODULE.runtime_provenance
    checked_paths: list[pathlib.Path] = []

    def mutate_caller_inputs(
        metadata_path: pathlib.Path,
        support_bytes: bytes,
    ) -> str:
        checked_paths.append(metadata_path)
        caller_metadata.write_bytes(b"{}\n")
        receipt.write_bytes(b"{}\n")
        return original_runtime_provenance(metadata_path, support_bytes)

    try:
        with mock.patch.object(
            FINALIZER_MODULE,
            "runtime_provenance",
            side_effect=mutate_caller_inputs,
        ):
            _staged, summary = FINALIZER_MODULE.prepare(
                source,
                None,
                selection,
                receipt,
                None,
            )
    finally:
        caller_metadata.write_bytes(original_metadata)
        receipt.write_bytes(original_receipt)
    assert summary["final_tap_commit"] == source_commit
    assert len(checked_paths) == 1
    assert checked_paths[0] != caller_metadata

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-schema-fail."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    tap = create_tap(root, source)
    artifact_path = source / "homebrew/main-shell-lazy-artifact-lock.json"
    artifact_lock = json.loads(artifact_path.read_text())
    artifact_lock["schema"] = 2
    artifact_path.write_text(json.dumps(artifact_lock, indent=2) + "\n")
    invalid_schema = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        success=False,
    )
    assert (
        "artifact lock is not the exact schema-3 contract"
        in invalid_schema.stderr
    )

with tempfile.TemporaryDirectory(prefix="kandelo-shell-finalizer-fail.") as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    tap = create_tap(root, source, omit="zip")
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}
    missing = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        "--apply",
        success=False,
    )
    assert "missing shell root zip" in missing.stderr
    assert before == {path: digest(path) for path in paths}


def expect_materialization_failure(
    label: str,
    mutate: Callable[[dict], None],
    expected: str,
) -> None:
    with tempfile.TemporaryDirectory(
        prefix=f"kandelo-shell-finalizer-{label}."
    ) as temporary:
        root = pathlib.Path(temporary)
        source = copy_source(root)
        policy_path = source / "homebrew/main-shell-materialization-policy.json"
        policy = json.loads(policy_path.read_text())
        mutate(policy)
        write_json(policy_path, policy)
        tap = create_tap(root, source)
        result = run(
            "--source-root",
            str(source),
            "--tap-root",
            str(tap),
            success=False,
        )
        assert_failure(result, expected)


expect_materialization_failure(
    "missing-embedded",
    remove_one_embedded_formula,
    "main-shell materialization policy must embed exactly three Formulae; "
    "found 2",
)
expect_materialization_failure(
    "duplicate-embedded",
    duplicate_one_embedded_formula,
    "main-shell embedded Formula order repeats Formula "
    f"{TAP_NAME}/libcxx",
)
expect_materialization_failure(
    "substituted-embedded",
    substitute_one_embedded_formula,
    "main-shell embedded Formulae are outside the reviewed base closure: "
    f"{TAP_NAME}/unknown",
)
expect_materialization_failure(
    "misordered-embedded",
    misorder_embedded_formulae,
    "main-shell embedded Formula order is not the exact dependency closure "
    "of its reviewed roots",
)

with tempfile.TemporaryDirectory(
    prefix="kandelo-shell-finalizer-duplicate-base."
) as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    migration_path = source / "homebrew/main-shell-migration-lock.json"
    migration = json.loads(migration_path.read_text())
    migration["formula_closure"][-1] = migration["formula_closure"][-2]
    write_json(migration_path, migration)
    tap = create_tap(root, source)
    duplicate_base = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        success=False,
    )
    assert_failure(
        duplicate_base,
        "main-shell reviewed closure repeats Formula "
        f"{TAP_NAME}/nano",
    )

print("test-finalize-homebrew-main-shell-release: ok")
