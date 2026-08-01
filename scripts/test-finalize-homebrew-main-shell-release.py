#!/usr/bin/env python3
"""Executable contract tests for the main-shell release finalizer."""

from __future__ import annotations

from collections.abc import Callable
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile


REPO = pathlib.Path(__file__).resolve().parent.parent
FINALIZER = REPO / "scripts/finalize-homebrew-main-shell-release.py"
CHECKER = REPO / "scripts/check-homebrew-main-shell-brewfile.mjs"
COPIED = [
    "homebrew/main-shell-migration-lock.json",
    "homebrew/main-shell-homebrew-runtime-support.json",
    "homebrew/main-shell-lazy-artifact-lock.json",
    "homebrew/main-shell-materialization-policy.json",
    "homebrew/homebrew-bootstrap-source-lock.json",
    "homebrew/main-shell-brew-package-tree.json",
    "homebrew/main-shell.Brewfile",
    "homebrew/main-shell-default.json",
    "homebrew/main-shell-demo.json",
    "packages/registry/shell/build.toml",
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


def copy_source(root: pathlib.Path) -> pathlib.Path:
    source = root / "source"
    for relative in COPIED:
        destination = source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / relative, destination)
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


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def set_shell_revision(source: pathlib.Path, literal: str) -> None:
    path = source / "packages/registry/shell/build.toml"
    updated, count = re.subn(
        r"^revision\s*=.*$",
        f"revision = {literal}",
        path.read_text(),
        count=1,
        flags=re.MULTILINE,
    )
    assert count == 1
    path.write_text(updated)


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
    assert migration["catalog"]["tap_commit"] == head
    assert support["catalog"]["tap_commit"] == head
    assert support["availability"]["audited_catalog"]["checkout_commit"] == head
    assert artifact_lock["state"] == "pending"
    assert artifact_lock["image"] is None
    assert artifact_lock["schema"] == 3
    assert artifact_lock["inputs"]["shell_config_sha256"] == digest(
        source / "homebrew/main-shell-default.json"
    )
    assert 'publication_state = "pending"' in (
        source / "packages/registry/shell/build.toml"
    ).read_text()
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
    checker = run_checker(source, tap)
    assert (
        "38 base Formulae, 21 runtime Formulae, and 25 audited Formulae; "
        "the runtime adds 1 beyond the base, yielding 39 total Formulae"
        in checker.stdout
    )

    artifact = root / "shell.vfs.zst"
    artifact.write_bytes(b"reviewed deterministic shell bytes\n")
    sealed = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        "--artifact",
        str(artifact),
        "--apply",
    )
    sealed_json = json.loads(sealed.stdout)
    assert sealed_json["artifact_state"] == "sealed"
    artifact_lock = json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )
    assert artifact_lock["image"] == {
        "sha256": digest(artifact),
        "bytes": artifact.stat().st_size,
    }
    assert 'publication_state = "ready"' in (
        source / "packages/registry/shell/build.toml"
    ).read_text()

    canonical_build = (
        source / "packages/registry/shell/build.toml"
    ).read_text()
    for invalid_revision in ["0", "true", '"22"', "22.5"]:
        set_shell_revision(source, invalid_revision)
        assert_failure(
            run(
                "--source-root",
                str(source),
                "--tap-root",
                str(tap),
                success=False,
            ),
            "revision must be a positive integer",
        )
        (source / "packages/registry/shell/build.toml").write_text(
            canonical_build
        )

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
    set_shell_revision(source, "23")
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
    assert re.search(
        r"^revision\s*=\s*23$",
        (source / "packages/registry/shell/build.toml").read_text(),
        re.MULTILINE,
    )
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
