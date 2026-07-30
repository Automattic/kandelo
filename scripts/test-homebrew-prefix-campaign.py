#!/usr/bin/env python3
"""Adversarial tests for the atomic Homebrew guest-prefix campaign."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from dataclasses import dataclass
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOL_PATH = ROOT / "scripts/homebrew-prefix-campaign.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("homebrew_prefix_campaign", TOOL_PATH)
assert SPEC is not None and SPEC.loader is not None
CAMPAIGN = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CAMPAIGN
SPEC.loader.exec_module(CAMPAIGN)

RETIRED_PREFIX = "/home/linuxbrew/.linuxbrew"
TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_NAME = "kandelo-dev/tap-core"
HISTORICAL_TAP_COMMIT = "1" * 40
HISTORICAL_KANDELO_COMMIT = "2" * 40
BOOTSTRAP_REVISION = "3" * 40
BOOTSTRAP_ARCHIVE_SHA = "4" * 64


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def run(command: list[str], cwd: pathlib.Path) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def commit(root: pathlib.Path, message: str) -> str:
    run(["git", "add", "-A"], root)
    run(
        [
            "git",
            "-c",
            "user.name=Campaign Test",
            "-c",
            "user.email=campaign-test@example.invalid",
            "commit",
            "-m",
            message,
        ],
        root,
    )
    return run(["git", "rev-parse", "HEAD"], root)


def stripped_formula(name: str) -> bytes:
    class_name = "".join(part.capitalize() for part in name.replace("-", "_").split("_"))
    return (
        f'class {class_name} < Formula\n'
        '  desc "fixture"\n'
        "\n"
        "  def install\n"
        "  end\n"
        "\n"
        "end\n"
    ).encode()


def selected_formula(
    name: str, version: str, rebuild: int, arch_to_sha: dict[str, str]
) -> bytes:
    class_name = "".join(part.capitalize() for part in name.replace("-", "_").split("_"))
    lines = [
        f"class {class_name} < Formula\n",
        '  desc "fixture"\n',
        "\n",
        "  bottle do\n",
        f'    root_url "https://ghcr.io/v2/{TAP_REPOSITORY}"\n',
    ]
    if rebuild:
        lines.append(f"    rebuild {rebuild}\n")
    for arch, digest in sorted(arch_to_sha.items()):
        lines.append(
            f'    sha256 cellar: "{RETIRED_PREFIX}/Cellar", '
            f'{arch}_kandelo: "{digest}"\n'
        )
    lines.extend(
        [
            "  end\n",
            "\n",
            "  def install\n",
            "  end\n",
            "\n",
            "end\n",
        ]
    )
    return "".join(lines).encode()


def source_only_formula(name: str) -> bytes:
    class_name = "".join(part.capitalize() for part in name.replace("-", "_").split("_"))
    return (
        f"class {class_name} < Formula\n"
        '  desc "source-only fixture"\n'
        "\n"
        "end\n"
    ).encode()


def bootstrap_formula(version: str, manifest_sha256: str) -> bytes:
    return (
        "class HomebrewBootstrap < Formula\n"
        '  desc "source-only fixture"\n'
        f'  url "https://github.com/Homebrew/brew/archive/'
        f'{BOOTSTRAP_REVISION}.tar.gz"\n'
        f'  version "{version}"\n'
        f'  sha256 "{BOOTSTRAP_ARCHIVE_SHA}"\n'
        "\n"
        "  def install\n"
        f'    kandelo_build_tap_recipe(manifest_sha256: "{manifest_sha256}")\n'
        "  end\n"
        "end\n"
    ).encode()


def write_bootstrap_recipe(
    tap: pathlib.Path, *, retired_prefix: bool = False
) -> str:
    version = f"6.0.3-4-g{BOOTSTRAP_REVISION[:7]}"
    recipe_root = tap / "Kandelo/recipes/homebrew-bootstrap"
    (recipe_root / "patches").mkdir(parents=True, exist_ok=True)
    patch = b"fixture patch\n"
    if retired_prefix:
        patch += RETIRED_PREFIX.encode() + b"\n"
    (recipe_root / "patches/0001-add-kandelo-wasm-bottle-tags.patch").write_bytes(
        patch
    )
    (recipe_root / "build.sh").write_text("#!/bin/sh\nexit 0\n")
    (recipe_root / "build.sh").chmod(0o755)
    (recipe_root / "PATCH-LICENSE.md").write_text("fixture license evidence\n")
    (recipe_root / "recipe.json").unlink(missing_ok=True)
    lock = {
        "kind": "kandelo-homebrew-bootstrap-tap-recipe-lock",
        "license": {"expression": "BSD-2-Clause AND GPL-2.0-or-later"},
        "outputs": {
            "archive": {
                "bytes": 10,
                "path": "homebrew-bootstrap.zip",
                "sha256": "7" * 64,
            },
            "environment": {
                "bytes": 10,
                "path": "homebrew-brew.env",
                "sha256": "8" * 64,
            },
        },
        "package": {
            "arch": "wasm32",
            "name": "homebrew-bootstrap",
            "version": version,
        },
        "patch": {
            "path": "patches/0001-add-kandelo-wasm-bottle-tags.patch",
            "sha256": sha256(patch),
        },
        "prepared": {
            "archive_format": "kandelo-deterministic-zip-v1",
            "patched_tree_git_oid": "9" * 40,
            "patched_tree_sha256": "a" * 64,
            "portable_ruby_version": "4.0.5_1",
        },
        "schema": 1,
        "source": {
            "archive_sha256": BOOTSTRAP_ARCHIVE_SHA,
            "archive_url": (
                "https://github.com/Homebrew/brew/archive/"
                f"{BOOTSTRAP_REVISION}.tar.gz"
            ),
            "commit_timestamp": 1,
            "repository": "https://github.com/Homebrew/brew.git",
            "revision": BOOTSTRAP_REVISION,
            "tree_git_oid": "b" * 40,
        },
    }
    write_json(recipe_root / "source-lock.json", lock)
    records = []
    for path in sorted(
        value for value in recipe_root.rglob("*") if value.is_file()
    ):
        relative = path.relative_to(recipe_root).as_posix()
        payload = path.read_bytes()
        records.append(
            {
                "bytes": len(payload),
                "mode": f"{path.stat().st_mode & 0o7777:04o}",
                "path": relative,
                "sha256": sha256(payload),
            }
        )
    write_json(
        recipe_root / "recipe.json",
        {
            "dependencies": [],
            "entrypoint": "build.sh",
            "files": records,
            "schema": 1,
        },
    )
    manifest_sha = sha256((recipe_root / "recipe.json").read_bytes())
    (tap / "Formula/homebrew-bootstrap.rb").write_bytes(
        bootstrap_formula(version, manifest_sha)
    )
    return version


def add_bytes(
    archive: tarfile.TarFile, name: str, payload: bytes, mode: int = 0o644
) -> None:
    member = tarfile.TarInfo(name)
    member.size = len(payload)
    member.mode = mode
    member.mtime = 0
    archive.addfile(member, io.BytesIO(payload))


def make_archive(
    name: str,
    version: str,
    *,
    retired_cross_chunk: bool = False,
    unsafe_member: bool = False,
) -> bytes:
    receipt_formula = stripped_formula(name)
    receipt = json.dumps(
        {
            "arch": "x86_64",
            "built_as_bottle": True,
            "built_on": {"os": "Linux", "os_version": "fixture"},
            "changed_files": [],
            "compiler": "clang",
            "homebrew_version": "Homebrew fixture",
            "installed_on_request": True,
            "poured_from_bottle": False,
            "runtime_dependencies": [],
            "source": {"scm_revision": "fixture"},
            "source_modified_time": 0,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for directory in (
            name,
            f"{name}/{version}",
            f"{name}/{version}/.brew",
            f"{name}/{version}/share",
        ):
            member = tarfile.TarInfo(directory)
            member.type = tarfile.DIRTYPE
            member.mode = 0o755
            member.mtime = 0
            archive.addfile(member)
        add_bytes(archive, f"{name}/{version}/.brew/{name}.rb", receipt_formula)
        add_bytes(archive, f"{name}/{version}/INSTALL_RECEIPT.json", receipt)
        payload = b"fixture"
        if retired_cross_chunk:
            # WHY: the retired path begins in one inspector read and ends in
            # the next, proving the campaign uses the canonical overlap-aware
            # full-member scan rather than a per-chunk substring shortcut.
            split = len(RETIRED_PREFIX) // 2
            payload = (
                b"x" * (1024 * 1024 - split)
                + RETIRED_PREFIX.encode()
                + b"/Cellar"
            )
        add_bytes(archive, f"{name}/{version}/share/data", payload)
        if unsafe_member:
            add_bytes(archive, "../escape", b"unsafe")
    return buffer.getvalue()


def bottle_record(
    name: str,
    arch: str,
    abi: int,
    digest: str,
    byte_count: int,
    version: str,
    rebuild: int,
) -> dict[str, Any]:
    return {
        "arch": arch,
        "bottle_tag": f"{arch}_kandelo",
        "browser_compatible": False,
        "built_at": "2026-07-29T00:00:00Z",
        "built_by": "https://github.com/kandelo-dev/homebrew-tap-core/actions/runs/1",
        "built_from": {
            "formula_sha256": sha256(stripped_formula(name)),
            "kandelo_commit": HISTORICAL_KANDELO_COMMIT,
            "kandelo_repository": "Automattic/kandelo",
            "tap_commit": HISTORICAL_TAP_COMMIT,
            "tap_repository": TAP_REPOSITORY,
        },
        "bytes": byte_count,
        "cache_key_sha": digest,
        "cellar": f"{RETIRED_PREFIX}/Cellar",
        "fork_instrumentation": "not-required",
        "kandelo_abi": abi,
        "link_manifest": (
            f"Kandelo/link/{name}-{version}-rebuild{rebuild}-{arch}.json"
        ),
        "prefix": RETIRED_PREFIX,
        "runtime_support": ["node"],
        "sha256": digest,
        "status": "success",
        "url": (
            f"https://ghcr.io/v2/{TAP_REPOSITORY}/{name}/"
            f"blobs/sha256:{digest}"
        ),
    }


def sidecar(
    name: str,
    version: str,
    rebuild: int,
    abi: int,
    bottles: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "bottle_rebuild": rebuild,
        "bottles": bottles,
        "dependencies": [],
        "formula_path": f"Formula/{name}.rb",
        "formula_revision": 0,
        "full_name": f"{TAP_NAME}/{name}",
        "kandelo_abi": abi,
        "name": name,
        "schema": 1,
        "source_metadata": "Kandelo/metadata.json",
        "tap_commit": HISTORICAL_TAP_COMMIT,
        "tap_name": TAP_NAME,
        "tap_repository": TAP_REPOSITORY,
        "version": version,
    }


def package_from_sidecar(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value[key]
        for key in (
            "bottle_rebuild",
            "bottles",
            "dependencies",
            "formula_path",
            "formula_revision",
            "full_name",
            "name",
            "version",
        )
    } | {"formula_metadata": f"Kandelo/formula/{value['name']}.json"}


def write_live_link(
    tap: pathlib.Path,
    name: str,
    version: str,
    rebuild: int,
    bottle: dict[str, Any],
) -> str:
    arch = bottle["arch"]
    link_rel = bottle["link_manifest"]
    link = {
        "arch": arch,
        "bottle": {
            "bytes": bottle["bytes"],
            "cache_key_sha": bottle["cache_key_sha"],
            "payload_root": f"{name}/{version}",
            "sha256": bottle["sha256"],
            "url": bottle["url"],
        },
        "cellar": bottle["cellar"],
        "env": {"PATH_prepend": ["bin"]},
        "kandelo_abi": bottle["kandelo_abi"],
        "keg": f"{bottle['cellar']}/{name}/{version}",
        "links": [],
        "package": name,
        "prefix": bottle["prefix"],
        "receipts": [f".brew/{name}.rb", "INSTALL_RECEIPT.json"],
        "schema": 1,
        "version": version,
    }
    write_json(tap / link_rel, link)
    return (
        link_rel.replace("Kandelo/link/", "Kandelo/reports/")
        .removesuffix(".json")
        + ".provenance.json"
    )


def write_live_provenance(
    tap: pathlib.Path,
    name: str,
    version: str,
    rebuild: int,
    bottle: dict[str, Any],
    metadata_sha256: str,
) -> None:
    arch = bottle["arch"]
    link_rel = bottle["link_manifest"]
    provenance_rel = (
        link_rel.replace("Kandelo/link/", "Kandelo/reports/")
        .removesuffix(".json")
        + ".provenance.json"
    )
    provenance = {
        "bottle": {
            "bottle_tag": bottle["bottle_tag"],
            "bytes": bottle["bytes"],
            "cache_key_sha": bottle["cache_key_sha"],
            "cellar": bottle["cellar"],
            "prefix": bottle["prefix"],
            "sha256": bottle["sha256"],
            "url": bottle["url"],
        },
        "build": {
            "brew_version": "Homebrew fixture",
            "dev_shell": "scripts/dev-shell.sh",
            "github_run": "https://example.invalid/actions/runs/1",
            "job": "verify-bottle",
            "runner_os": "fixture",
            "sdk_fingerprint": "5" * 64,
            "sysroot_fingerprint": "6" * 64,
        },
        "formula": {
            "path": f"Formula/{name}.rb",
            "sha256": bottle["built_from"]["formula_sha256"],
        },
        "metadata": {
            "metadata_json": {
                "path": "Kandelo/metadata.json",
                "sha256": metadata_sha256,
            },
            "formula_json": {
                "path": f"Kandelo/formula/{name}.json",
                "sha256": sha256(
                    (tap / f"Kandelo/formula/{name}.json").read_bytes()
                ),
            },
            "link_manifest_json": {
                "path": link_rel,
                "sha256": sha256((tap / link_rel).read_bytes()),
            },
            "provenance_json": {
                "path": provenance_rel,
                "sha256": "0" * 64,
            },
        },
        "repositories": dict(bottle["built_from"]) | {
            # built_from's Formula hash belongs in the Formula section, not in
            # the repository identity object.
        },
        "schema": 1,
        "subject": {
            "arch": arch,
            "bottle_rebuild": rebuild,
            "kandelo_abi": bottle["kandelo_abi"],
            "package": name,
            "version": version,
        },
        "validation": {
            "outcome_lists": [
                {
                    "failed": [],
                    "name": "schema",
                    "passed": ["fixture sidecars"],
                    "skipped": [],
                    "status": "success",
                },
                {
                    "failed": [],
                    "name": "homebrew_audit",
                    "passed": [],
                    "skip_reason": "fixture does not run brew audit",
                    "skipped": ["brew audit"],
                    "status": "skipped",
                },
                {
                    "failed": [],
                    "name": "bottle_build",
                    "passed": ["fixture bottle built"],
                    "skipped": [],
                    "status": "success",
                },
                {
                    "failed": [],
                    "name": "node_smoke",
                    "passed": ["fixture Node smoke"],
                    "skipped": [],
                    "status": "success",
                },
                {
                    "failed": [],
                    "name": "browser_smoke",
                    "passed": [],
                    "skip_reason": "fixture is Node-only",
                    "skipped": ["browser smoke"],
                    "status": "skipped",
                },
            ]
        },
    }
    provenance["repositories"].pop("formula_sha256")
    provenance["metadata"]["provenance_json"]["sha256"] = (
        CAMPAIGN.normalized_provenance_sha256(provenance)
    )
    write_json(tap / provenance_rel, provenance)


def refresh_provenance_hashes(
    tap: pathlib.Path,
    name: str,
    version: str,
    rebuild: int,
    arch: str,
    *,
    metadata_sha256: str | None = None,
) -> pathlib.Path:
    link_rel = f"Kandelo/link/{name}-{version}-rebuild{rebuild}-{arch}.json"
    provenance_rel = (
        link_rel.replace("Kandelo/link/", "Kandelo/reports/")
        .removesuffix(".json")
        + ".provenance.json"
    )
    path = tap / provenance_rel
    provenance = json.loads(path.read_text())
    provenance["metadata"]["formula_json"]["sha256"] = sha256(
        (tap / f"Kandelo/formula/{name}.json").read_bytes()
    )
    provenance["metadata"]["link_manifest_json"]["sha256"] = sha256(
        (tap / link_rel).read_bytes()
    )
    if metadata_sha256 is not None:
        provenance["metadata"]["metadata_json"]["sha256"] = metadata_sha256
    provenance["metadata"]["provenance_json"]["sha256"] = "0" * 64
    provenance["metadata"]["provenance_json"]["sha256"] = (
        CAMPAIGN.normalized_provenance_sha256(provenance)
    )
    write_json(path, provenance)
    return path


@dataclass
class Fixture:
    temporary: tempfile.TemporaryDirectory[str]
    kandelo: pathlib.Path
    old_tap: pathlib.Path
    source_tap: pathlib.Path
    native_brew: pathlib.Path
    archives: dict[str, bytes]
    versions: dict[str, str]
    kandelo_commit: str
    old_tap_commit: str
    source_tap_commit: str
    native_brew_commit: str
    metadata_sha256: str
    layout_sha256: str

    def options(
        self,
        *,
        kandelo_commit: str | None = None,
        old_tap_commit: str | None = None,
        source_tap_commit: str | None = None,
        native_brew_commit: str | None = None,
        metadata_sha256: str | None = None,
        layout_sha256: str | None = None,
    ) -> Any:
        return CAMPAIGN.CampaignOptions(
            kandelo_root=self.kandelo,
            kandelo_commit=kandelo_commit or self.kandelo_commit,
            old_tap_root=self.old_tap,
            old_tap_commit=old_tap_commit or self.old_tap_commit,
            source_tap_root=self.source_tap,
            source_tap_commit=source_tap_commit or self.source_tap_commit,
            native_brew_root=self.native_brew,
            native_brew_commit=(
                native_brew_commit or self.native_brew_commit
            ),
            metadata_sha256=metadata_sha256 or self.metadata_sha256,
            guest_layout_sha256=layout_sha256 or self.layout_sha256,
            jobs=4,
        )

    def dependencies(self, overrides: dict[str, bytes] | None = None) -> Any:
        archives = dict(self.archives)
        if overrides:
            archives.update(overrides)

        def fetch(
            _url: str,
            digest: str,
            _byte_count: int,
            output: pathlib.Path,
            _kandelo_root: pathlib.Path,
        ) -> None:
            output.write_bytes(archives[digest])

        def probe(
            _remote: str, _reference: str, _kandelo_root: pathlib.Path
        ) -> dict[str, Any]:
            return {
                "digest": None,
                "kind": "manifest",
                "schema": 1,
                "status": "missing",
            }

        def resolve_metadata(
            _native_brew_root: pathlib.Path,
            _source_tap_root: pathlib.Path,
            _tap_name: str,
            formulae: list[str],
        ) -> dict[str, dict[str, Any]]:
            dependencies = {
                "alpha": ["beta"],
                "homebrew-bootstrap": ["alpha", "beta"],
            }
            return {
                name: {
                    "dependencies": dependencies.get(name, []),
                    "version": self.versions[name],
                }
                for name in formulae
            }

        def load_historical_formula(
            old_tap_root: pathlib.Path,
            _name: str,
            _commit: str,
            formula_path: str,
        ) -> bytes:
            return (old_tap_root / formula_path).read_bytes()

        return CAMPAIGN.CampaignDependencies(
            fetch_bottle=fetch,
            probe_destination=probe,
            resolve_formula_metadata=resolve_metadata,
            load_historical_formula=load_historical_formula,
        )

    def close(self) -> None:
        self.temporary.cleanup()


def make_fixture(
    *,
    alpha_cross_chunk: bool = False,
    alpha_unsafe: bool = False,
    alpha_source_changed: bool = True,
) -> Fixture:
    temporary = tempfile.TemporaryDirectory(prefix="homebrew-prefix-campaign-test-")
    root = pathlib.Path(temporary.name)
    kandelo = root / "kandelo"
    tap = root / "old-tap"
    source_tap = root / "source-tap"
    native_brew = root / "native-brew"
    kandelo.mkdir()
    tap.mkdir()
    native_brew.mkdir()
    run(["git", "init", "-q"], kandelo)
    run(["git", "init", "-q"], tap)
    run(["git", "init", "-q"], native_brew)

    for relative in (
        "scripts/homebrew-prefix-campaign.py",
        "scripts/homebrew-inspect-bottle.py",
        "scripts/homebrew-publication-limits.sh",
        "scripts/homebrew-formula-source-digest.rb",
        "scripts/homebrew-validate-wasm-artifact.sh",
        "scripts/homebrew-oci-layout.py",
    ):
        destination = kandelo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    readback = kandelo / "scripts/homebrew-verify-public-bottle.ts"
    readback.write_text("// fixture: production uses the exact committed verifier\n")
    (kandelo / "crates/shared/src").mkdir(parents=True)
    (kandelo / "crates/shared/src/lib.rs").write_text(
        "pub const ABI_VERSION: u32 = 42;\n"
    )
    write_json(kandelo / "abi/snapshot.json", {"abi_version": 42})
    layout = {
        "cellar": "/opt/kandelo/homebrew/Cellar",
        "kind": "kandelo-homebrew-guest-layout",
        "prefix": "/opt/kandelo/homebrew",
        "repository": "/opt/kandelo/homebrew",
        "retired_prefixes": [RETIRED_PREFIX],
        "schema": 1,
        "stable_entrypoint": "/usr/bin/brew",
    }
    write_json(kandelo / "homebrew/kandelo-guest-layout.json", layout)
    campaign_inputs = {
        "kind": "kandelo-homebrew-guest-prefix-campaign-inputs",
        "schema": 1,
        # Deliberately unsorted: output order must derive canonically.
        "source_only_formulae": [
            {
                "disposition": "deferred",
                "formula_path": "Formula/later.rb",
                "name": "later",
                "reason": "service-formula-migration",
            },
            {
                "arches": ["wasm32"],
                "disposition": "required-build",
                "formula_path": "Formula/homebrew-bootstrap.rb",
                "name": "homebrew-bootstrap",
                "recipe_lock": "Kandelo/recipes/homebrew-bootstrap/source-lock.json",
            },
        ],
    }
    write_json(
        kandelo / "homebrew/guest-prefix-campaign-inputs.json", campaign_inputs
    )
    kandelo_commit = commit(kandelo, "fixture Kandelo")
    layout_sha = sha256((kandelo / "homebrew/kandelo-guest-layout.json").read_bytes())

    for directory in (
        "Formula",
        "Kandelo/formula",
        "Kandelo/link",
        "Kandelo/reports",
        "Kandelo/reports/failures",
        "Kandelo/reports/rollbacks",
    ):
        (tap / directory).mkdir(parents=True, exist_ok=True)
    archives: dict[str, bytes] = {}
    formula_sidecars: dict[str, dict[str, Any]] = {}
    for name, version, rebuild, abi, cross_chunk, unsafe in (
        ("alpha", "1.0", 1, 42, alpha_cross_chunk, alpha_unsafe),
        ("beta", "2.0", 0, 41, False, False),
    ):
        archive = make_archive(
            name,
            version,
            retired_cross_chunk=cross_chunk,
            unsafe_member=unsafe,
        )
        digest = sha256(archive)
        archives[digest] = archive
        bottle = bottle_record(
            name, "wasm32", abi, digest, len(archive), version, rebuild
        )
        value = sidecar(name, version, rebuild, abi, [bottle])
        formula_sidecars[name] = value
        write_json(tap / f"Kandelo/formula/{name}.json", value)
        (tap / f"Formula/{name}.rb").write_bytes(
            selected_formula(name, version, rebuild, {"wasm32": digest})
        )
        write_live_link(tap, name, version, rebuild, bottle)

    bootstrap_version = write_bootstrap_recipe(tap)
    (tap / "Formula/later.rb").write_bytes(source_only_formula("later"))
    metadata = {
        "generated_at": "2026-07-29T00:00:00Z",
        "generator": "campaign fixture",
        "kandelo_abi": 42,
        "kandelo_commit": HISTORICAL_KANDELO_COMMIT,
        "kandelo_repository": "Automattic/kandelo",
        "packages": [package_from_sidecar(formula_sidecars["alpha"])],
        "release_tag": "bottles-abi-v42",
        "schema": 1,
        "tap_commit": HISTORICAL_TAP_COMMIT,
        "tap_name": TAP_NAME,
        "tap_repository": TAP_REPOSITORY,
    }
    write_json(tap / "Kandelo/metadata.json", metadata)
    metadata_sha = sha256((tap / "Kandelo/metadata.json").read_bytes())
    for name, value in formula_sidecars.items():
        write_live_provenance(
            tap,
            name,
            value["version"],
            value["bottle_rebuild"],
            value["bottles"][0],
            metadata_sha,
        )
    write_json(tap / "Kandelo/link/stale-1.0-rebuild0-wasm32.json", {"stale": True})
    write_json(
        tap / "Kandelo/reports/stale-1.0-rebuild0-wasm32.provenance.json",
        {"stale": True},
    )
    tap_commit = commit(tap, "fixture tap")
    shutil.copytree(tap, source_tap, ignore=shutil.ignore_patterns(".git"))
    run(["git", "init", "-q"], source_tap)
    # The candidate source is intentionally not the Formula identity that
    # produced the old bytes. The campaign must bind both authorities without
    # rewriting the old record's provenance.
    if alpha_source_changed:
        alpha_source = (source_tap / "Formula/alpha.rb").read_text()
        (source_tap / "Formula/alpha.rb").write_text(
            alpha_source.replace('desc "fixture"', 'desc "candidate fixture"')
        )
    source_tap_commit = commit(source_tap, "fixture candidate source tap")
    (native_brew / "bin").mkdir()
    (native_brew / "Library/Homebrew").mkdir(parents=True)
    (native_brew / "bin/brew").write_text("#!/bin/sh\nexit 1\n")
    (native_brew / "bin/brew").chmod(0o755)
    (native_brew / "Library/Homebrew/version.rb").write_text(
        "# fixture exact native Homebrew source\n"
    )
    native_brew_commit = commit(native_brew, "fixture native Homebrew")
    return Fixture(
        temporary=temporary,
        kandelo=kandelo,
        old_tap=tap,
        source_tap=source_tap,
        native_brew=native_brew,
        archives=archives,
        versions={
            "alpha": "1.0",
            "beta": "2.0",
            "homebrew-bootstrap": bootstrap_version,
            "later": "1.0",
        },
        kandelo_commit=kandelo_commit,
        old_tap_commit=tap_commit,
        source_tap_commit=source_tap_commit,
        native_brew_commit=native_brew_commit,
        metadata_sha256=metadata_sha,
        layout_sha256=layout_sha,
    )


class PrefixCampaignTests(unittest.TestCase):
    def test_derives_every_class_and_deterministic_order(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        first = CAMPAIGN.derive_campaign(
            fixture.options(), fixture.dependencies()
        )
        second = CAMPAIGN.derive_campaign(
            fixture.options(), fixture.dependencies()
        )
        self.assertEqual(first, second)
        self.assertEqual(
            [value["name"] for value in first["formulae"]],
            ["alpha", "beta", "homebrew-bootstrap"],
        )
        by_name = {value["name"]: value for value in first["formulae"]}
        self.assertNotEqual(
            by_name["alpha"]["old_formula_sources"][0][
                "identity_excluding_bottle_sha256"
            ],
            by_name["alpha"]["formula_source"][
                "identity_excluding_bottle_sha256"
            ],
        )
        self.assertEqual(
            by_name["alpha"]["variants"][0]["old_record"]["built_from"][
                "formula_sha256"
            ],
            by_name["alpha"]["old_formula_sources"][0][
                "identity_excluding_bottle_sha256"
            ],
        )
        self.assertEqual(
            by_name["alpha"]["variants"][0]["disposition"],
            {
                "kind": "required-rebuild",
                "reasons": ["formula-source-changed"],
            },
        )
        self.assertEqual(
            by_name["beta"]["variants"][0]["disposition"],
            {"kind": "required-rebuild", "reasons": ["abi-mismatch"]},
        )
        self.assertEqual(
            by_name["homebrew-bootstrap"]["variants"][0]["disposition"],
            {"kind": "required-build", "reasons": ["new-campaign-entrant"]},
        )
        self.assertEqual(
            by_name["alpha"]["dependencies"],
            [{"full_name": f"{TAP_NAME}/beta", "version": "2.0"}],
        )
        self.assertEqual(
            by_name["homebrew-bootstrap"]["dependencies"],
            [
                {"full_name": f"{TAP_NAME}/alpha", "version": "1.0"},
                {"full_name": f"{TAP_NAME}/beta", "version": "2.0"},
            ],
        )
        self.assertEqual(
            first["authority"]["source_materialization"]["kind"],
            "exact-git-tree-v1",
        )
        self.assertEqual(
            first["deferred_source_formulae"][0]["name"], "later"
        )
        self.assertEqual(first["summary"]["formulae"], 3)
        self.assertEqual(first["summary"]["variants"], 3)
        self.assertEqual(first["summary"]["byte_clean_reuse_candidates"], 0)
        self.assertEqual(first["summary"]["required_builds"], 3)
        self.assertEqual(
            [value["path"] for value in first["retirements"]],
            [
                "Kandelo/link/stale-1.0-rebuild0-wasm32.json",
                "Kandelo/reports/stale-1.0-rebuild0-wasm32.provenance.json",
            ],
        )

    def test_unchanged_formula_is_required_for_reuse(self) -> None:
        fixture = make_fixture(alpha_source_changed=False)
        self.addCleanup(fixture.close)
        result = CAMPAIGN.derive_campaign(
            fixture.options(), fixture.dependencies()
        )
        alpha = result["formulae"][0]["variants"][0]
        self.assertEqual(
            alpha["disposition"],
            {"kind": "byte-clean-reuse-candidate", "reasons": []},
        )

    def test_metadata_and_selected_sidecar_must_match_current_authority(
        self,
    ) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        metadata_path = fixture.old_tap / "Kandelo/metadata.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["kandelo_abi"] = 41
        metadata["release_tag"] = "bottles-abi-v41"
        write_json(metadata_path, metadata)
        metadata_head = commit(fixture.old_tap, "mismatch selected metadata ABI")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "differs from the exact current Kandelo ABI"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(
                    old_tap_commit=metadata_head,
                    metadata_sha256=sha256(metadata_path.read_bytes()),
                ),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        sidecar_path = fixture.old_tap / "Kandelo/formula/alpha.json"
        sidecar_value = json.loads(sidecar_path.read_text())
        sidecar_value["tap_commit"] = "f" * 40
        write_json(sidecar_path, sidecar_value)
        sidecar_head = commit(fixture.old_tap, "mismatch selected sidecar")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "sidecar ABI/tap_commit"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=sidecar_head),
                fixture.dependencies(),
            )

    def test_abi_snapshot_and_metadata_generator_are_bound(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        write_json(fixture.kandelo / "abi/snapshot.json", {"abi_version": 41})
        kandelo_head = commit(fixture.kandelo, "mismatch ABI snapshot")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "snapshot version differs"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(kandelo_commit=kandelo_head),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        metadata_path = fixture.old_tap / "Kandelo/metadata.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["generated_at"] = "not-a-timestamp"
        write_json(metadata_path, metadata)
        old_head = commit(fixture.old_tap, "invalid metadata timestamp")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "RFC 3339 UTC timestamp"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(
                    old_tap_commit=old_head,
                    metadata_sha256=sha256(metadata_path.read_bytes()),
                ),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        metadata_path = fixture.old_tap / "Kandelo/metadata.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["generator"] = ""
        write_json(metadata_path, metadata)
        old_head = commit(fixture.old_tap, "empty metadata generator")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "generator must be a non-empty string"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(
                    old_tap_commit=old_head,
                    metadata_sha256=sha256(metadata_path.read_bytes()),
                ),
                fixture.dependencies(),
            )

    def test_candidate_pkg_version_comes_from_exact_native_homebrew(
        self,
    ) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        base = fixture.dependencies()

        def mismatched_metadata(
            _native: pathlib.Path,
            _source: pathlib.Path,
            _tap_name: str,
            formulae: list[str],
        ) -> dict[str, dict[str, Any]]:
            metadata = {
                name: {
                    "dependencies": [],
                    "version": fixture.versions[name],
                }
                for name in formulae
            }
            metadata["alpha"]["version"] = "9.9"
            return metadata

        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "candidate pkg_version 9.9"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(),
                CAMPAIGN.CampaignDependencies(
                    fetch_bottle=base.fetch_bottle,
                    probe_destination=base.probe_destination,
                    resolve_formula_metadata=mismatched_metadata,
                    load_historical_formula=base.load_historical_formula,
                ),
            )

    def test_native_metadata_emits_only_required_campaign_dependencies(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="campaign-native-metadata-test-"
        ) as temporary_name:
            root = pathlib.Path(temporary_name)
            native = root / "native"
            source = root / "source"
            (native / "bin").mkdir(parents=True)
            (native / "Library/Homebrew").mkdir(parents=True)
            (source / "Formula").mkdir(parents=True)
            for name in ("alpha", "beta", "bootstrap"):
                (source / f"Formula/{name}.rb").write_text(
                    f"class {name.title()} < Formula\nend\n"
                )
            document = {
                "casks": [],
                "formulae": [
                    {
                        "build_dependencies": ["beta", "cmake"],
                        "dependencies": [],
                        "full_name": f"{TAP_NAME}/alpha",
                        "name": "alpha",
                        "optional_dependencies": ["bootstrap"],
                        "recommended_dependencies": [],
                        "revision": 0,
                        "test_dependencies": [],
                        "versions": {"stable": "1.0"},
                    },
                    {
                        "build_dependencies": [],
                        "dependencies": [],
                        "full_name": f"{TAP_NAME}/beta",
                        "name": "beta",
                        "optional_dependencies": [],
                        "recommended_dependencies": [],
                        "revision": 1,
                        "test_dependencies": [],
                        "versions": {"stable": "2.0"},
                    },
                    {
                        "build_dependencies": ["alpha"],
                        "dependencies": [f"{TAP_NAME}/beta"],
                        "full_name": f"{TAP_NAME}/bootstrap",
                        "name": "bootstrap",
                        "optional_dependencies": [],
                        "recommended_dependencies": [],
                        "revision": 0,
                        "test_dependencies": ["unzip"],
                        "versions": {"stable": "3.0"},
                    },
                ],
            }
            payload = json.dumps(document, separators=(",", ":"))
            (native / "bin/brew").write_text(
                "#!/bin/sh\n"
                "printf '%s' "
                + json.dumps(payload)
                + "\n"
            )
            (native / "bin/brew").chmod(0o755)
            resolved = CAMPAIGN.default_resolve_formula_metadata(
                native,
                source,
                TAP_NAME,
                ["alpha", "beta", "bootstrap"],
            )
            self.assertEqual(
                resolved,
                {
                    "alpha": {
                        "dependencies": ["beta"],
                        "version": "1.0",
                    },
                    "beta": {
                        "dependencies": [],
                        "version": "2.0_1",
                    },
                    "bootstrap": {
                        "dependencies": ["alpha", "beta"],
                        "version": "3.0",
                    },
                },
            )

    def test_dependency_graph_rejects_cycles_and_deferred_edges(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        base = fixture.dependencies()

        def metadata_with(
            dependencies: dict[str, list[str]],
        ) -> Any:
            def resolve(
                _native: pathlib.Path,
                _source: pathlib.Path,
                _tap_name: str,
                formulae: list[str],
            ) -> dict[str, dict[str, Any]]:
                return {
                    name: {
                        "dependencies": dependencies.get(name, []),
                        "version": fixture.versions[name],
                    }
                    for name in formulae
                }

            return CAMPAIGN.CampaignDependencies(
                fetch_bottle=base.fetch_bottle,
                probe_destination=base.probe_destination,
                resolve_formula_metadata=resolve,
                load_historical_formula=base.load_historical_formula,
            )

        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError,
            "dependency graph cycles",
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(),
                metadata_with({"alpha": ["beta"], "beta": ["alpha"]}),
            )
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError,
            "depends on deferred campaign Formulae",
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(),
                metadata_with({"alpha": ["later"]}),
            )

    def test_protected_overlay_is_materialized_and_tree_bound(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="campaign-overlay-test-"
        ) as temporary_name:
            root = pathlib.Path(temporary_name)
            tap = root / "tap"
            tap.mkdir()
            run(["git", "init", "-q"], tap)
            (tap / "Formula").mkdir()
            formula = tap / "Formula/example.rb"
            formula.write_text('class Example < Formula\n  desc "base"\nend\n')
            base_formula = formula.read_bytes()
            base = commit(tap, "base tap")
            base_tree = run(["git", "rev-parse", f"{base}^{{tree}}"], tap)
            formula.write_text('class Example < Formula\n  desc "target"\nend\n')
            target = commit(tap, "target tap")
            target_tree = run(["git", "rev-parse", f"{target}^{{tree}}"], tap)
            target_formula = formula.read_bytes()
            run(["git", "checkout", "--detach", base], tap)

            source_root = tap / "Kandelo/campaigns/prefix-v1/source"
            (source_root / "Formula").mkdir(parents=True)
            (source_root / "Formula/example.rb").write_bytes(target_formula)
            manifest = {
                "base": {
                    "commit": base,
                    "tree_git_oid": base_tree,
                },
                "campaign": "prefix-v1",
                "files": [
                    {
                        "base": {
                            "blob_git_oid": CAMPAIGN.git_object_id(
                                "blob", base_formula
                            ),
                            "bytes": len(base_formula),
                            "mode": "100644",
                            "sha256": sha256(base_formula),
                        },
                        "path": "Formula/example.rb",
                        "target": {
                            "blob_git_oid": CAMPAIGN.git_object_id(
                                "blob", target_formula
                            ),
                            "bytes": len(target_formula),
                            "mode": "100644",
                            "sha256": sha256(target_formula),
                        },
                    }
                ],
                "kind": (
                    "kandelo-homebrew-prefix-campaign-source-overlay"
                ),
                "schema": 1,
                "source_root": "Kandelo/campaigns/prefix-v1/source",
                "target_tree_git_oid": target_tree,
            }
            manifest_path = tap / CAMPAIGN.SOURCE_MANIFEST_PATH
            write_json(manifest_path, manifest)
            materializer = tap / CAMPAIGN.SOURCE_MATERIALIZER_PATH
            materializer.parent.mkdir(parents=True, exist_ok=True)
            materializer.write_text(
                "#!/usr/bin/env python3\n"
                "raise SystemExit('Kandelo must not execute tap code')\n"
            )
            materializer.chmod(0o755)
            authority = {
                "target_source": {
                    "manifest_path": CAMPAIGN.SOURCE_MANIFEST_PATH,
                    "manifest_sha256": sha256(manifest_path.read_bytes()),
                    "source_root": "Kandelo/campaigns/prefix-v1/source",
                    "source_tree_git_oid": CAMPAIGN.filesystem_git_tree_oid(
                        source_root, "test source overlay"
                    ),
                    "target_tree_git_oid": target_tree,
                }
            }
            write_json(tap / CAMPAIGN.SOURCE_AUTHORITY_PATH, authority)
            source_commit = commit(tap, "sealed overlay")
            output = root / "materialized"
            materialized, identity = CAMPAIGN.candidate_source_snapshot(
                CAMPAIGN.git_authority(tap, source_commit, "test tap"),
                source_commit,
                output,
            )
            self.assertEqual(
                (materialized / "Formula/example.rb").read_bytes(),
                target_formula,
            )
            self.assertEqual(identity["kind"], "sealed-target-overlay-v1")
            self.assertEqual(identity["target_tree_git_oid"], target_tree)

            # Bind the exact Git authority, then replace every mutable
            # overlay identity with a self-consistent transient target. The
            # materializer must still consume source_commit, not the edited
            # checkout, even if the writer restores it before final rebind.
            exact_root = CAMPAIGN.git_authority(
                tap, source_commit, "overlay race input"
            )
            transient_formula = (
                b'class Example < Formula\n'
                b'  desc "transient uncommitted target"\n'
                b"end\n"
            )
            saved = {
                path: path.read_bytes()
                for path in (
                    source_root / "Formula/example.rb",
                    manifest_path,
                    tap / CAMPAIGN.SOURCE_AUTHORITY_PATH,
                )
            }
            transient_tree_root = root / "transient-target"
            shutil.copytree(output, transient_tree_root)
            (
                transient_tree_root / "Formula/example.rb"
            ).write_bytes(transient_formula)
            transient_tree = CAMPAIGN.filesystem_git_tree_oid(
                transient_tree_root, "transient overlay target"
            )
            transient_manifest = json.loads(
                manifest_path.read_text()
            )
            transient_manifest["files"][0]["target"] = {
                "blob_git_oid": CAMPAIGN.git_object_id(
                    "blob", transient_formula
                ),
                "bytes": len(transient_formula),
                "mode": "100644",
                "sha256": sha256(transient_formula),
            }
            transient_manifest["target_tree_git_oid"] = transient_tree
            (
                source_root / "Formula/example.rb"
            ).write_bytes(transient_formula)
            write_json(manifest_path, transient_manifest)
            transient_authority = json.loads(
                (
                    tap / CAMPAIGN.SOURCE_AUTHORITY_PATH
                ).read_text()
            )
            target_authority = transient_authority["target_source"]
            target_authority["manifest_sha256"] = sha256(
                manifest_path.read_bytes()
            )
            target_authority["source_tree_git_oid"] = (
                CAMPAIGN.filesystem_git_tree_oid(
                    source_root, "transient overlay payload"
                )
            )
            target_authority["target_tree_git_oid"] = transient_tree
            write_json(
                tap / CAMPAIGN.SOURCE_AUTHORITY_PATH,
                transient_authority,
            )
            try:
                raced, raced_identity = (
                    CAMPAIGN.candidate_source_snapshot(
                        exact_root,
                        source_commit,
                        root / "race-materialized",
                    )
                )
            finally:
                for path, payload in saved.items():
                    path.write_bytes(payload)
            self.assertEqual(
                (raced / "Formula/example.rb").read_bytes(),
                target_formula,
            )
            self.assertEqual(
                raced_identity["target_tree_git_oid"], target_tree
            )
            self.assertEqual(
                run(
                    [
                        "git",
                        "status",
                        "--porcelain=v1",
                        "--untracked-files=all",
                    ],
                    tap,
                ),
                "",
            )

            bad_authority = json.loads(
                (tap / CAMPAIGN.SOURCE_AUTHORITY_PATH).read_text()
            )
            bad_authority["target_source"]["target_tree_git_oid"] = "f" * 40
            write_json(tap / CAMPAIGN.SOURCE_AUTHORITY_PATH, bad_authority)
            bad_commit = commit(tap, "tamper target tree")
            with self.assertRaisesRegex(
                CAMPAIGN.CampaignError,
                "manifest differs from its authority",
            ):
                CAMPAIGN.candidate_source_snapshot(
                    CAMPAIGN.git_authority(tap, bad_commit, "tampered tap"),
                    bad_commit,
                    root / "bad-output",
                )

    def test_required_entrant_recipe_is_exact_and_has_no_retired_prefix(
        self,
    ) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        write_bootstrap_recipe(fixture.source_tap, retired_prefix=True)
        source_head = commit(
            fixture.source_tap, "put retired prefix in entrant patch"
        )
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "contains retired guest prefix"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(source_tap_commit=source_head),
                fixture.dependencies(),
            )

    def test_final_candidate_guard_covers_examples_and_acceptance_files(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="campaign-final-prefix-test-"
        ) as temporary_name:
            tap = pathlib.Path(temporary_name)
            (tap / "Kandelo/examples").mkdir(parents=True)
            (tap / "Kandelo/examples/metadata.json").write_text(
                json.dumps({"prefix": RETIRED_PREFIX})
            )
            with self.assertRaisesRegex(
                CAMPAIGN.CampaignError, "final candidate tap still contains"
            ):
                CAMPAIGN.validate_final_candidate_prefixes(
                    tap, [RETIRED_PREFIX]
                )
            (tap / "Kandelo/examples/metadata.json").unlink()
            (tap / "Kandelo").mkdir(exist_ok=True)
            (tap / "Kandelo/vfs-acceptance.json").write_text(
                json.dumps({"executable": f"{RETIRED_PREFIX}/bin/python3"})
            )
            with self.assertRaisesRegex(
                CAMPAIGN.CampaignError, "vfs-acceptance.json"
            ):
                CAMPAIGN.validate_final_candidate_prefixes(
                    tap, [RETIRED_PREFIX]
                )
            (tap / "Kandelo/vfs-acceptance.json").unlink()
            negative = (
                tap
                / "Kandelo/formula_support/test/"
                "kandelo_formula_support_test.rb"
            )
            negative.parent.mkdir(parents=True)
            negative.write_text(
                f'refute_includes source, "{RETIRED_PREFIX}"\n'
            )
            permitted = CAMPAIGN.validate_final_candidate_prefixes(
                tap, [RETIRED_PREFIX]
            )
            self.assertEqual(
                permitted[0]["disposition"],
                "permitted-historical-or-negative-evidence",
            )

        with tempfile.TemporaryDirectory(
            prefix="campaign-final-prefix-git-test-"
        ) as temporary_name:
            root = pathlib.Path(temporary_name)
            kandelo = root / "kandelo"
            tap = root / "tap"
            kandelo.mkdir()
            tap.mkdir()
            run(["git", "init", "-q"], kandelo)
            run(["git", "init", "-q"], tap)
            layout = {
                "cellar": "/opt/kandelo/homebrew/Cellar",
                "kind": "kandelo-homebrew-guest-layout",
                "prefix": "/opt/kandelo/homebrew",
                "repository": "/opt/kandelo/homebrew",
                "retired_prefixes": [RETIRED_PREFIX],
                "schema": 1,
                "stable_entrypoint": "/usr/bin/brew",
            }
            write_json(
                kandelo / "homebrew/kandelo-guest-layout.json", layout
            )
            kandelo_commit = commit(kandelo, "final layout")
            (tap / "Formula").mkdir()
            (tap / "Formula/clean.rb").write_text(
                'class Clean < Formula\n  desc "clean"\nend\n'
            )
            tap_commit = commit(tap, "clean final tap")
            self.assertEqual(
                CAMPAIGN.check_final_prefix_candidate(
                    kandelo_root=kandelo,
                    kandelo_commit=kandelo_commit,
                    source_tap_root=tap,
                    source_tap_commit=tap_commit,
                    guest_layout_sha256=sha256(
                        (
                            kandelo
                            / "homebrew/kandelo-guest-layout.json"
                        ).read_bytes()
                    ),
                ),
                [],
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        patch = (
            fixture.source_tap
            / "Kandelo/recipes/homebrew-bootstrap/patches/"
            "0001-add-kandelo-wasm-bottle-tags.patch"
        )
        patch.write_bytes(patch.read_bytes() + b"unlocked change\n")
        source_head = commit(fixture.source_tap, "drift entrant patch")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "differs from recipe.json"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(source_tap_commit=source_head),
                fixture.dependencies(),
            )

    def test_required_entrant_paths_and_arches_fail_closed(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        inputs_path = (
            fixture.kandelo / "homebrew/guest-prefix-campaign-inputs.json"
        )
        inputs = json.loads(inputs_path.read_text())
        bootstrap = next(
            value
            for value in inputs["source_only_formulae"]
            if value["name"] == "homebrew-bootstrap"
        )
        bootstrap["recipe_lock"] = (
            "Kandelo/recipes/homebrew-bootstrap/../"
            "homebrew-bootstrap/source-lock.json"
        )
        write_json(inputs_path, inputs)
        kandelo_head = commit(fixture.kandelo, "add recipe path traversal")
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "dot path segments"):
            CAMPAIGN.derive_campaign(
                fixture.options(kandelo_commit=kandelo_head),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        inputs_path = (
            fixture.kandelo / "homebrew/guest-prefix-campaign-inputs.json"
        )
        inputs = json.loads(inputs_path.read_text())
        bootstrap = next(
            value
            for value in inputs["source_only_formulae"]
            if value["name"] == "homebrew-bootstrap"
        )
        bootstrap["arches"] = ["wasm32", "wasm64"]
        write_json(inputs_path, inputs)
        kandelo_head = commit(fixture.kandelo, "mismatch entrant arches")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError,
            "must exactly equal its recipe-lock arch",
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(kandelo_commit=kandelo_head),
                fixture.dependencies(),
            )

    def test_cross_chunk_retired_prefix_requires_rebuild(self) -> None:
        fixture = make_fixture(alpha_cross_chunk=True)
        self.addCleanup(fixture.close)
        result = CAMPAIGN.derive_campaign(
            fixture.options(), fixture.dependencies()
        )
        alpha = result["formulae"][0]["variants"][0]
        self.assertEqual(
            alpha["disposition"],
            {
                "kind": "required-rebuild",
                "reasons": ["retired-prefix", "formula-source-changed"],
            },
        )
        self.assertEqual(
            alpha["inspection"]["retired_prefixes"], [RETIRED_PREFIX]
        )

    def test_unsafe_tar_is_rejected(self) -> None:
        fixture = make_fixture(alpha_unsafe=True)
        self.addCleanup(fixture.close)
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "unsafe path segment"):
            CAMPAIGN.derive_campaign(
                fixture.options(), fixture.dependencies()
            )

    def test_link_and_provenance_internal_contracts_are_verified(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        link_path = (
            fixture.old_tap
            / "Kandelo/link/alpha-1.0-rebuild1-wasm32.json"
        )
        link = json.loads(link_path.read_text())
        link["keg"] = "/unrelated/Cellar/alpha/1.0"
        write_json(link_path, link)
        old_head = commit(fixture.old_tap, "break link keg")
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "keg is not canonical"):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=old_head),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        provenance_path = (
            fixture.old_tap
            / "Kandelo/reports/alpha-1.0-rebuild1-wasm32.provenance.json"
        )
        provenance = json.loads(provenance_path.read_text())
        provenance["repositories"]["kandelo_repository"] = "Other/project"
        provenance["metadata"]["provenance_json"]["sha256"] = "0" * 64
        provenance["metadata"]["provenance_json"]["sha256"] = (
            CAMPAIGN.normalized_provenance_sha256(provenance)
        )
        write_json(provenance_path, provenance)
        old_head = commit(fixture.old_tap, "break provenance repository")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "differs from built_from"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=old_head),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        provenance_path = (
            fixture.old_tap
            / "Kandelo/reports/alpha-1.0-rebuild1-wasm32.provenance.json"
        )
        provenance = json.loads(provenance_path.read_text())
        provenance["metadata"]["metadata_json"]["sha256"] = "c" * 64
        provenance["metadata"]["provenance_json"]["sha256"] = "0" * 64
        provenance["metadata"]["provenance_json"]["sha256"] = (
            CAMPAIGN.normalized_provenance_sha256(provenance)
        )
        write_json(provenance_path, provenance)
        old_head = commit(fixture.old_tap, "break historical metadata hash")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "not reachable.*old tap history"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=old_head),
                fixture.dependencies(),
            )

    def test_inspected_fork_and_direct_dependencies_match_sidecar(
        self,
    ) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        sidecar_path = fixture.old_tap / "Kandelo/formula/beta.json"
        sidecar_value = json.loads(sidecar_path.read_text())
        sidecar_value["bottles"][0]["fork_instrumentation"] = "required"
        write_json(sidecar_path, sidecar_value)
        refresh_provenance_hashes(
            fixture.old_tap, "beta", "2.0", 0, "wasm32"
        )
        old_head = commit(fixture.old_tap, "mismatch fork evidence")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "fork instrumentation"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=old_head),
                fixture.dependencies(),
            )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        sidecar_path = fixture.old_tap / "Kandelo/formula/beta.json"
        sidecar_value = json.loads(sidecar_path.read_text())
        sidecar_value["dependencies"] = [
            {
                "full_name": f"{TAP_NAME}/alpha",
                "name": "alpha",
                "version": "1.0",
            }
        ]
        write_json(sidecar_path, sidecar_value)
        refresh_provenance_hashes(
            fixture.old_tap, "beta", "2.0", 0, "wasm32"
        )
        old_head = commit(fixture.old_tap, "mismatch dependency evidence")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "direct dependencies"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=old_head),
                fixture.dependencies(),
            )

    def test_unknown_old_prefix_cannot_be_reused(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        sidecar_path = fixture.old_tap / "Kandelo/formula/beta.json"
        sidecar_value = json.loads(sidecar_path.read_text())
        sidecar_value["bottles"][0]["prefix"] = "/foreign/homebrew"
        sidecar_value["bottles"][0]["cellar"] = "/foreign/homebrew/Cellar"
        write_json(sidecar_path, sidecar_value)
        old_head = commit(fixture.old_tap, "use unknown old prefix")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "explicitly retired guest layout"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=old_head),
                fixture.dependencies(),
            )

    def test_removed_old_formula_requires_explicit_classification(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        run(["git", "rm", "Formula/later.rb"], fixture.source_tap)
        source_head = commit(fixture.source_tap, "remove old Formula silently")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "disappeared without an explicit"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(source_tap_commit=source_head),
                fixture.dependencies(),
            )

    def test_exact_snapshots_close_edit_restore_and_final_dirty_races(
        self,
    ) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        base = fixture.dependencies()
        source_path = fixture.source_tap / "Formula/alpha.rb"
        committed_source = source_path.read_bytes()
        expected_sha = sha256(committed_source)
        restore_lock = threading.Lock()
        restored = False

        def mutate_then_resolve(
            _native: pathlib.Path,
            _source: pathlib.Path,
            _tap_name: str,
            formulae: list[str],
        ) -> dict[str, dict[str, Any]]:
            source_path.write_bytes(
                committed_source.replace(
                    b'desc "candidate fixture"',
                    b'desc "transient uncommitted source"',
                )
            )
            return {
                name: {
                    "dependencies": [],
                    "version": fixture.versions[name],
                }
                for name in formulae
            }

        def restore_then_fetch(
            url: str,
            digest: str,
            byte_count: int,
            output: pathlib.Path,
            kandelo_root: pathlib.Path,
        ) -> None:
            nonlocal restored
            with restore_lock:
                if not restored:
                    source_path.write_bytes(committed_source)
                    restored = True
            base.fetch_bottle(
                url, digest, byte_count, output, kandelo_root
            )

        result = CAMPAIGN.derive_campaign(
            fixture.options(),
            CAMPAIGN.CampaignDependencies(
                fetch_bottle=restore_then_fetch,
                probe_destination=base.probe_destination,
                resolve_formula_metadata=mutate_then_resolve,
                load_historical_formula=base.load_historical_formula,
            ),
        )
        self.assertTrue(restored)
        self.assertEqual(
            result["formulae"][0]["formula_source"]["sha256"], expected_sha
        )
        self.assertEqual(
            run(
                ["git", "status", "--porcelain=v1", "--untracked-files=all"],
                fixture.source_tap,
            ),
            "",
        )

        fixture = make_fixture()
        self.addCleanup(fixture.close)
        base = fixture.dependencies()

        def dirty_then_resolve(
            _native: pathlib.Path,
            _source: pathlib.Path,
            _tap_name: str,
            formulae: list[str],
        ) -> dict[str, dict[str, Any]]:
            (fixture.source_tap / "untracked-race").write_text("dirty\n")
            return {
                name: {
                    "dependencies": [],
                    "version": fixture.versions[name],
                }
                for name in formulae
            }

        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "final rebind worktree is dirty"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(),
                CAMPAIGN.CampaignDependencies(
                    fetch_bottle=base.fetch_bottle,
                    probe_destination=base.probe_destination,
                    resolve_formula_metadata=dirty_then_resolve,
                    load_historical_formula=base.load_historical_formula,
                ),
            )

    def test_stale_exact_commit_is_rejected(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "does not match exact commit"):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit="0" * 40), fixture.dependencies()
            )
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "does not match exact commit"):
            CAMPAIGN.derive_campaign(
                fixture.options(source_tap_commit="0" * 40),
                fixture.dependencies(),
            )
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "does not match exact commit"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(native_brew_commit="0" * 40),
                fixture.dependencies(),
            )

    def test_altered_metadata_and_layout_digests_are_rejected(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "old metadata SHA-256"):
            CAMPAIGN.derive_campaign(
                fixture.options(metadata_sha256="0" * 64),
                fixture.dependencies(),
            )
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "guest layout SHA-256"):
            CAMPAIGN.derive_campaign(
                fixture.options(layout_sha256="0" * 64),
                fixture.dependencies(),
            )

    def test_anonymous_byte_and_digest_mismatches_are_rejected(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        alpha_digest = next(
            bottle["sha256"]
            for bottle in json.loads(
                (fixture.old_tap / "Kandelo/formula/alpha.json").read_text()
            )["bottles"]
        )
        original = fixture.archives[alpha_digest]
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "anonymous byte count"):
            CAMPAIGN.derive_campaign(
                fixture.options(),
                fixture.dependencies({alpha_digest: original[:-1]}),
            )
        changed = bytes([original[0] ^ 1]) + original[1:]
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "anonymous SHA-256"):
            CAMPAIGN.derive_campaign(
                fixture.options(),
                fixture.dependencies({alpha_digest: changed}),
            )

    def test_unexpected_sidecar_and_unclassified_formula_are_rejected(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        (fixture.old_tap / "Kandelo/link/README.txt").write_text("unexpected\n")
        new_head = commit(fixture.old_tap, "add unexpected sidecar")
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "unexpected entry"):
            CAMPAIGN.derive_campaign(
                fixture.options(old_tap_commit=new_head), fixture.dependencies()
            )

        run(["git", "rm", "Kandelo/link/README.txt"], fixture.old_tap)
        old_head = commit(fixture.old_tap, "restore old sidecar closure")
        (fixture.source_tap / "Formula/rogue.rb").write_bytes(
            source_only_formula("rogue")
        )
        source_head = commit(fixture.source_tap, "add unclassified Formula")
        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "source-only Formula inventory differs"
        ):
            CAMPAIGN.derive_campaign(
                fixture.options(
                    old_tap_commit=old_head, source_tap_commit=source_head
                ),
                fixture.dependencies(),
            )

    def test_destination_must_be_anonymously_absent(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)

        def fetch(
            _url: str,
            digest: str,
            _byte_count: int,
            output: pathlib.Path,
            _kandelo_root: pathlib.Path,
        ) -> None:
            output.write_bytes(fixture.archives[digest])

        def present(
            _remote: str, _reference: str, _kandelo_root: pathlib.Path
        ) -> dict[str, Any]:
            return {
                "digest": "sha256:" + "1" * 64,
                "kind": "manifest",
                "schema": 1,
                "status": "present",
            }

        with self.assertRaisesRegex(
            CAMPAIGN.CampaignError, "not anonymously proven absent"
        ):
            fixture_dependencies = fixture.dependencies()
            CAMPAIGN.derive_campaign(
                fixture.options(),
                CAMPAIGN.CampaignDependencies(
                    fetch_bottle=fetch,
                    probe_destination=present,
                    resolve_formula_metadata=(
                        fixture_dependencies.resolve_formula_metadata
                    ),
                    load_historical_formula=(
                        fixture_dependencies.load_historical_formula
                    ),
                ),
            )

    def test_duplicate_json_keys_are_rejected(self) -> None:
        fixture = make_fixture()
        self.addCleanup(fixture.close)
        metadata_path = fixture.old_tap / "Kandelo/metadata.json"
        payload = metadata_path.read_text()
        metadata_path.write_text(payload.replace('{\n', '{\n  "schema": 1,\n', 1))
        new_head = commit(fixture.old_tap, "duplicate metadata key")
        new_digest = sha256(metadata_path.read_bytes())
        with self.assertRaisesRegex(CAMPAIGN.CampaignError, "repeats key 'schema'"):
            CAMPAIGN.derive_campaign(
                fixture.options(
                    old_tap_commit=new_head, metadata_sha256=new_digest
                ),
                fixture.dependencies(),
            )

    def test_manifest_output_is_external_and_never_replaced(self) -> None:
        with tempfile.TemporaryDirectory(prefix="campaign-output-test-") as name:
            root = pathlib.Path(name)
            kandelo = root / "kandelo"
            old_tap = root / "old-tap"
            source_tap = root / "source-tap"
            output_root = root / "output"
            for directory in (kandelo, old_tap, source_tap, output_root):
                directory.mkdir()
            with self.assertRaisesRegex(
                CAMPAIGN.CampaignError, "outside all clean input worktrees"
            ):
                CAMPAIGN.validate_external_output(
                    kandelo / "manifest.json", kandelo, old_tap, source_tap
                )
            output = CAMPAIGN.validate_external_output(
                output_root / "manifest.json", kandelo, old_tap, source_tap
            )
            CAMPAIGN.write_new_file(output, b"first\n")
            with self.assertRaises(FileExistsError):
                CAMPAIGN.write_new_file(output, b"second\n")
            self.assertEqual(output.read_bytes(), b"first\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
