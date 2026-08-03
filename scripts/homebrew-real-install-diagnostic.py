#!/usr/bin/env python3
"""Validate the bounded, non-product in-guest Homebrew diagnostic."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import subprocess
import sys
import tempfile
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_CONTRACT = ROOT / "homebrew/real-install-diagnostic.json"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9+._-]*$")
MAX_JSON_BYTES = 64 * 1024 * 1024
EXECUTOR_PATH = ROOT / "scripts/homebrew-prefix-campaign-executor.py"
CAMPAIGN_PATH = ROOT / "scripts/homebrew-prefix-campaign.py"


class DiagnosticError(RuntimeError):
    """The diagnostic contract or one of its exact inputs is invalid."""


def fail(message: str) -> NoReturn:
    raise DiagnosticError(message)


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON repeats key {key!r}")
        result[key] = value
    return result


def load_json(path: pathlib.Path, label: str) -> tuple[dict[str, Any], bytes]:
    try:
        stat = path.lstat()
        if (
            not path.is_file()
            or path.is_symlink()
            or stat.st_size < 1
            or stat.st_size > MAX_JSON_BYTES
        ):
            fail(f"{label} must be one bounded regular non-symlink file")
        payload = path.read_bytes()
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=reject_duplicates,
            parse_constant=lambda item: fail(
                f"{label} contains invalid constant {item}"
            ),
        )
    except DiagnosticError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value, payload


def exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} must contain exactly {sorted(keys)}")
    return value


def string(value: Any, label: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        fail(f"{label} is invalid")
    return value


def formula_list(value: Any, label: str, *, sorted_list: bool = False) -> list[str]:
    if not isinstance(value, list) or not value:
        fail(f"{label} must be a nonempty array")
    result = [string(item, label, FORMULA) for item in value]
    if len(set(result)) != len(result):
        fail(f"{label} repeats a Formula")
    if sorted_list and result != sorted(result):
        fail(f"{label} must be sorted")
    return result


def formula_list_allow_empty(value: Any, label: str) -> list[str]:
    if not isinstance(value, list):
        fail(f"{label} must be an array")
    result = [string(item, label, FORMULA) for item in value]
    if len(set(result)) != len(result):
        fail(f"{label} repeats a Formula")
    return result


def validate_lifecycle_and_compatibility(
    contract: dict[str, Any],
    vfs_order: list[str],
) -> None:
    expected_lifecycle = {
        "core_formula": "kandelo-dev/tap-core/bzip2",
        "independent_tap": "brandonpayton/kandelo-canary",
        "independent_repository": "brandonpayton/homebrew-kandelo-canary",
        "independent_formula": "brandonpayton/kandelo-canary/m4-canary",
        "independent_dependency": "kandelo-dev/tap-core/dash",
    }
    lifecycle = exact(
        contract["lifecycle"],
        set(expected_lifecycle) | {"independent_revision"},
        "diagnostic lifecycle",
    )
    fixed_lifecycle = dict(lifecycle)
    independent_revision = fixed_lifecycle.pop("independent_revision")
    # WHY: the independent tap revision is release evidence, not a Kandelo
    # source constant. Accept any exact commit here while keeping every tap,
    # Formula, and cross-tap dependency identity fixed by this proof.
    if (
        fixed_lifecycle != expected_lifecycle
        or not isinstance(independent_revision, str)
        or GIT_SHA.fullmatch(independent_revision) is None
    ):
        fail("diagnostic lifecycle differs from the shared guest proof")

    compatibility = exact(
        contract["compatibility"],
        {
            "mirror_link_manifest_bin",
            "link_conflict_owners",
            "aliases",
            "runtime_state",
        },
        "diagnostic compatibility policy",
    )
    mirror = exact(
        compatibility["mirror_link_manifest_bin"],
        {"targets"},
        "diagnostic compatibility mirror",
    )
    if mirror["targets"] != ["/usr/bin", "/bin"]:
        fail("diagnostic compatibility mirror targets changed")

    allowed_packages = {
        f"kandelo-dev/tap-core/{name}" for name in vfs_order
    }
    referenced_packages: list[str] = []
    conflicts = compatibility["link_conflict_owners"]
    if not isinstance(conflicts, list):
        fail("diagnostic link conflict owners must be an array")
    for position, value in enumerate(conflicts):
        entry = exact(
            value,
            {"target", "package", "reason"},
            f"diagnostic link conflict owner #{position}",
        )
        if not all(
            isinstance(entry[key], str) and entry[key]
            for key in ("target", "package", "reason")
        ):
            fail("diagnostic link conflict owner is invalid")
        referenced_packages.append(entry["package"])

    aliases = compatibility["aliases"]
    if not isinstance(aliases, list):
        fail("diagnostic compatibility aliases must be an array")
    for position, value in enumerate(aliases):
        entry = exact(
            value,
            {"package", "source_kind", "source", "targets"},
            f"diagnostic compatibility alias #{position}",
        )
        if (
            entry["source_kind"] not in ("link", "keg")
            or not isinstance(entry["source"], str)
            or not entry["source"]
            or not isinstance(entry["targets"], list)
            or not entry["targets"]
            or not all(
                isinstance(target, str) and target.startswith("/")
                for target in entry["targets"]
            )
        ):
            fail("diagnostic compatibility alias is invalid")
        referenced_packages.append(entry["package"])

    runtime_state = compatibility["runtime_state"]
    if not isinstance(runtime_state, list):
        fail("diagnostic runtime state must be an array")
    for position, value in enumerate(runtime_state):
        if not isinstance(value, dict):
            fail(f"diagnostic runtime state #{position} must be an object")
        kind = value.get("kind")
        expected_keys = {
            "requires_package",
            "path",
            "kind",
            "mode",
            "uid",
            "gid",
            "reason",
        }
        if kind == "text_file":
            expected_keys.add("contents")
        entry = exact(
            value,
            expected_keys,
            f"diagnostic runtime state #{position}",
        )
        if (
            kind not in ("directory", "empty_file", "text_file")
            or not isinstance(entry["path"], str)
            or not entry["path"].startswith("/")
            or not isinstance(entry["mode"], int)
            or not isinstance(entry["uid"], int)
            or not isinstance(entry["gid"], int)
            or not isinstance(entry["reason"], str)
            or not entry["reason"]
            or (kind == "text_file" and not isinstance(entry["contents"], str))
        ):
            fail("diagnostic runtime state is invalid")
        referenced_packages.append(entry["requires_package"])

    if any(package not in allowed_packages for package in referenced_packages):
        fail("diagnostic compatibility policy references a Formula outside its VFS")


def read_contract(path: pathlib.Path) -> tuple[dict[str, Any], bytes]:
    contract, payload = load_json(path, "real-install diagnostic contract")
    exact(
        contract,
        {
            "schema",
            "kind",
            "diagnostic_only",
            "authority",
            "selection",
            "vfs",
            "lifecycle",
            "compatibility",
        },
        "real-install diagnostic contract",
    )
    if (
        contract["schema"] != 1
        or contract["kind"] != "kandelo-homebrew-real-install-diagnostic"
        or contract["diagnostic_only"] is not True
    ):
        fail("real-install contract must remain explicitly diagnostic-only")
    authority = exact(
        contract["authority"],
        {
            "tap_repository",
            "tap_name",
            "source_tap_commit",
            "campaign_sha256",
            "kandelo_commit",
            "kandelo_abi",
            "arch",
        },
        "diagnostic authority",
    )
    if (
        authority["tap_repository"] != "kandelo-dev/homebrew-tap-core"
        or authority["tap_name"] != "kandelo-dev/tap-core"
        or string(authority["source_tap_commit"], "source tap commit", GIT_SHA)
        == ""
        or string(authority["campaign_sha256"], "campaign SHA-256", SHA256)
        == ""
        or string(authority["kandelo_commit"], "Kandelo commit", GIT_SHA)
        == ""
        or authority["kandelo_abi"] != 42
        or authority["arch"] != "wasm32"
    ):
        fail("diagnostic authority is unsupported")
    selection = exact(
        contract["selection"],
        {"roots", "dependencies", "formula_order"},
        "diagnostic selection",
    )
    roots = formula_list(selection["roots"], "selection roots", sorted_list=True)
    formula_order = formula_list(
        selection["formula_order"], "selection Formula order"
    )
    if len(formula_order) != 25 or "homebrew-bootstrap" not in formula_order:
        fail("real-install selection must contain its exact 25-Formula closure")
    if not set(roots).issubset(formula_order):
        fail("real-install selection roots escape its closure")
    dependencies = selection["dependencies"]
    if not isinstance(dependencies, dict) or set(dependencies) != set(formula_order):
        fail("real-install dependencies must cover the exact Formula closure")
    positions = {name: index for index, name in enumerate(formula_order)}
    for name, dependency_value in dependencies.items():
        dependency_names = formula_list_allow_empty(
            dependency_value, f"dependencies for {name}"
        )
        if dependency_names != sorted(dependency_names):
            fail(f"dependencies for {name} must be sorted")
        if any(
            dependency not in positions or positions[dependency] >= positions[name]
            for dependency in dependency_names
        ):
            fail(f"real-install Formula order is not dependency-first at {name}")
    reachable: set[str] = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in reachable:
            continue
        reachable.add(name)
        pending.extend(dependencies[name])
    if reachable != set(formula_order):
        fail("real-install roots do not derive the exact Formula closure")
    vfs = exact(
        contract["vfs"],
        {
            "brewfile",
            "bootstrap_tree",
            "formula_roots",
            "formula_order",
            "materialization_policy",
            "max_vfs_byte_length",
        },
        "diagnostic VFS contract",
    )
    vfs_roots = formula_list(vfs["formula_roots"], "VFS Formula roots")
    vfs_order = formula_list(vfs["formula_order"], "VFS Formula order")
    if (
        vfs["brewfile"] != "homebrew/real-install-diagnostic.Brewfile"
        or vfs["bootstrap_tree"]
        != "homebrew/real-install-diagnostic-brew-package-tree.json"
    ):
        fail("diagnostic VFS source paths changed")
    if vfs_order != [name for name in formula_order if name != "homebrew-bootstrap"]:
        fail("VFS closure must equal the 25-Formula selection minus bootstrap")
    if not set(vfs_roots).issubset(vfs_order):
        fail("VFS roots escape the VFS closure")
    if vfs["max_vfs_byte_length"] != 512 * 1024 * 1024:
        fail("diagnostic VFS capacity changed")
    policy = exact(
        vfs["materialization_policy"],
        {"schema", "kind", "embedded_roots", "embedded_package_order"},
        "diagnostic materialization policy",
    )
    if (
        policy["schema"] != 1
        or policy["kind"] != "kandelo-homebrew-vfs-materialization-policy"
        or policy["embedded_roots"] != ["kandelo-dev/tap-core/bash"]
        or policy["embedded_package_order"]
        != [
            "kandelo-dev/tap-core/libcxx",
            "kandelo-dev/tap-core/ncurses",
            "kandelo-dev/tap-core/bash",
        ]
    ):
        fail("diagnostic must embed exactly Bash and its dependency closure")
    validate_lifecycle_and_compatibility(contract, vfs_order)
    return contract, payload


def brewfile_roots(path: pathlib.Path) -> list[str]:
    try:
        result = subprocess.run(
            ["ruby", str(ROOT / "scripts/homebrew-brewfile-selection.rb"), str(path)],
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot parse diagnostic Brewfile: {error}")
    if result.returncode != 0:
        fail(
            "cannot parse diagnostic Brewfile: "
            + result.stderr.decode("utf-8", errors="replace")[-4096:]
        )
    try:
        value = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"diagnostic Brewfile parser returned invalid JSON: {error}")
    if (
        not isinstance(value, dict)
        or value.get("tap_name") != "kandelo-dev/tap-core"
        or not isinstance(value.get("packages"), list)
    ):
        fail("diagnostic Brewfile parser returned an unsupported contract")
    packages: list[str] = []
    for package in value["packages"]:
        if not isinstance(package, str) or FORMULA.fullmatch(package) is None:
            fail("diagnostic Brewfile selects a Formula outside the core tap")
        packages.append(package)
    return packages


def check_static(contract_path: pathlib.Path) -> dict[str, Any]:
    contract, payload = read_contract(contract_path)
    vfs = contract["vfs"]
    brewfile = ROOT / vfs["brewfile"]
    if brewfile_roots(brewfile) != vfs["formula_roots"]:
        fail("diagnostic Brewfile roots differ from the reviewed contract")
    bootstrap, _ = load_json(ROOT / vfs["bootstrap_tree"], "bootstrap tree spec")
    activation = bootstrap.get("activation")
    if (
        bootstrap.get("kind") != "kandelo-package-deferred-zip-tree"
        or bootstrap.get("package")
        != {"name": "homebrew-bootstrap", "output": "homebrew-bootstrap.zip"}
        or not isinstance(activation, dict)
        or "atomic_group" in activation
        or activation.get("roots") != ["/opt/kandelo/homebrew/bin/brew"]
    ):
        fail("diagnostic bootstrap must be one independent lazy source tree")
    return {
        "schema": 1,
        "kind": "kandelo-homebrew-real-install-diagnostic-static-check",
        "contract_sha256": hashlib.sha256(payload).hexdigest(),
        "selection_formula_count": 25,
        "vfs_formula_count": 24,
        "product_lock_used": False,
    }


def campaign_executor() -> Any:
    spec = importlib.util.spec_from_file_location(
        "homebrew_prefix_executor_for_real_install_diagnostic",
        EXECUTOR_PATH,
    )
    if spec is None or spec.loader is None:
        fail("cannot load the closed-selection validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def campaign_validator() -> Any:
    spec = importlib.util.spec_from_file_location(
        "homebrew_prefix_campaign_for_real_install_diagnostic",
        CAMPAIGN_PATH,
    )
    if spec is None or spec.loader is None:
        fail("cannot load the Formula bottle validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def git_output(root: pathlib.Path, arguments: list[str], label: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot inspect {label}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[-4096:]
        fail(f"cannot inspect {label}: {detail}")
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        fail(f"{label} returned invalid UTF-8: {error}")


def verify_independent_tap(
    contract_path: pathlib.Path,
    tap_root: pathlib.Path,
) -> dict[str, Any]:
    contract, _payload = read_contract(contract_path)
    lifecycle = contract["lifecycle"]
    root = real_directory(tap_root, "independent tap checkout")
    revision = lifecycle["independent_revision"]
    if git_output(root, ["rev-parse", "HEAD"], "independent tap HEAD") != revision:
        fail("independent tap checkout differs from the pinned revision")
    if git_output(
        root,
        ["status", "--short", "--untracked-files=all"],
        "independent tap status",
    ):
        fail("independent tap checkout has local modifications")

    formula_name = lifecycle["independent_formula"].rsplit("/", 1)[-1]
    formula_path = root / "Formula" / f"{formula_name}.rb"
    sidecar_path = root / "Kandelo" / "formula" / f"{formula_name}.json"
    sidecar, sidecar_payload = load_json(
        sidecar_path,
        "independent Formula metadata",
    )
    exact(
        sidecar,
        {
            "bottle_rebuild",
            "bottles",
            "dependencies",
            "formula_path",
            "formula_revision",
            "full_name",
            "kandelo_abi",
            "name",
            "schema",
            "source_metadata",
            "tap_commit",
            "tap_name",
            "tap_repository",
            "version",
        },
        "independent Formula metadata",
    )
    if (
        sidecar["schema"] != 1
        or sidecar["name"] != formula_name
        or sidecar["full_name"] != lifecycle["independent_formula"]
        or sidecar["formula_path"] != f"Formula/{formula_name}.rb"
        or sidecar["kandelo_abi"] != contract["authority"]["kandelo_abi"]
        or sidecar["tap_name"] != lifecycle["independent_tap"]
        or sidecar["tap_repository"] != lifecycle["independent_repository"]
        or sidecar["source_metadata"] != "Kandelo/metadata.json"
        or not isinstance(sidecar["formula_revision"], int)
        or isinstance(sidecar["formula_revision"], bool)
        or sidecar["formula_revision"] < 0
        or not isinstance(sidecar["bottle_rebuild"], int)
        or isinstance(sidecar["bottle_rebuild"], bool)
        or sidecar["bottle_rebuild"] < 0
        or not isinstance(sidecar["version"], str)
        or not sidecar["version"]
    ):
        fail("independent Formula metadata has the wrong identity")

    source_commit = string(
        sidecar["tap_commit"],
        "independent Formula source commit",
        GIT_SHA,
    )
    try:
        ancestry = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "merge-base",
                "--is-ancestor",
                source_commit,
                revision,
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot inspect independent Formula ancestry: {error}")
    if ancestry.returncode != 0:
        fail("independent Formula metadata is not from pinned tap history")

    dependency_name = lifecycle["independent_dependency"].rsplit("/", 1)[-1]
    dependencies = sidecar["dependencies"]
    if not isinstance(dependencies, list) or len(dependencies) != 1:
        fail("independent Formula metadata has the wrong dependency closure")
    dependency = exact(
        dependencies[0],
        {"full_name", "name", "version"},
        "independent Formula dependency",
    )
    if (
        dependency["full_name"] != lifecycle["independent_dependency"]
        or dependency["name"] != dependency_name
        or not isinstance(dependency["version"], str)
        or not dependency["version"]
    ):
        fail("independent Formula metadata has the wrong dependency closure")

    bottles = sidecar["bottles"]
    if not isinstance(bottles, list):
        fail("independent Formula metadata bottle inventory is invalid")
    matching = [
        bottle
        for bottle in bottles
        if isinstance(bottle, dict)
        and bottle.get("arch") == contract["authority"]["arch"]
    ]
    if len(matching) != 1:
        fail("independent Formula metadata lacks one wasm32 bottle")
    bottle = exact(
        matching[0],
        {
            "arch",
            "bottle_tag",
            "browser_compatible",
            "built_at",
            "built_by",
            "built_from",
            "bytes",
            "cache_key_sha",
            "cellar",
            "fork_instrumentation",
            "kandelo_abi",
            "link_manifest",
            "prefix",
            "runtime_support",
            "sha256",
            "status",
            "url",
        },
        "independent Formula bottle metadata",
    )
    bottle_sha = string(
        bottle["sha256"],
        "independent Formula bottle SHA-256",
        SHA256,
    )
    built_from = exact(
        bottle["built_from"],
        {
            "formula_sha256",
            "kandelo_commit",
            "kandelo_repository",
            "tap_commit",
            "tap_repository",
        },
        "independent Formula bottle build source",
    )
    string(
        built_from["formula_sha256"],
        "independent Formula build-source digest",
        SHA256,
    )
    expected_root = (
        "https://ghcr.io/v2/"
        + lifecycle["independent_repository"]
    )
    if (
        bottle["arch"] != "wasm32"
        or bottle["bottle_tag"] != "wasm32_kandelo"
        or bottle["kandelo_abi"] != contract["authority"]["kandelo_abi"]
        or bottle["status"] != "success"
        or bottle["cache_key_sha"] != bottle_sha
        or bottle["url"]
        != f"{expected_root}/{formula_name}/blobs/sha256:{bottle_sha}"
        or built_from["kandelo_commit"] != contract["authority"]["kandelo_commit"]
        or built_from["kandelo_repository"] != "Automattic/kandelo"
        or built_from["tap_commit"] != source_commit
        or built_from["tap_repository"] != lifecycle["independent_repository"]
        or bottle["prefix"] != "/opt/kandelo/homebrew"
        or bottle["cellar"] != "/opt/kandelo/homebrew/Cellar"
        or not isinstance(bottle["bytes"], int)
        or isinstance(bottle["bytes"], bool)
        or bottle["bytes"] <= 0
    ):
        fail("independent Formula bottle metadata is not publishable")

    campaign = campaign_validator()
    try:
        formula_sha, formula_identity, bottle_block = campaign.formula_identity(
            ROOT,
            formula_path,
        )
    except (OSError, UnicodeError, campaign.CampaignError) as error:
        fail(f"cannot validate independent Formula source: {error}")
    if (
        bottle_block is None
        or bottle_block["root_url"] != expected_root
        or bottle_block["rebuild"] != sidecar["bottle_rebuild"]
        or bottle_block["tags"] != {"wasm32_kandelo": bottle_sha}
    ):
        fail("independent Formula source lacks its exact generated bottle block")
    try:
        formula_text = formula_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        fail(f"cannot read independent Formula source: {error}")
    if (
        f"class {formula_name.title().replace('-', '')} < Formula" not in formula_text
        or "keg_only " not in formula_text
        or f'depends_on "{lifecycle["independent_dependency"]}"' not in formula_text
    ):
        fail("independent Formula source is not the unique keg-only canary")

    return {
        "schema": 1,
        "kind": "kandelo-homebrew-real-install-independent-tap-check",
        "repository": lifecycle["independent_repository"],
        "revision": revision,
        "formula": lifecycle["independent_formula"],
        "formula_sha256": formula_sha,
        "formula_identity_sha256": formula_identity,
        "metadata_sha256": hashlib.sha256(sidecar_payload).hexdigest(),
        "bottle_sha256": bottle_sha,
        "bottle_bytes": bottle["bytes"],
        "bottle_url": bottle["url"],
        "dependency": lifecycle["independent_dependency"],
    }


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        if not path.is_dir() or path.is_symlink():
            fail(f"{label} must be a regular non-symlink directory")
        return path.resolve(strict=True)
    except OSError as error:
        fail(f"cannot read {label}: {error}")


def verify_selection(
    contract_path: pathlib.Path,
    selection_root: pathlib.Path,
    receipt_path: pathlib.Path,
    authorization_path: pathlib.Path,
) -> dict[str, Any]:
    static = check_static(contract_path)
    contract, contract_payload = read_contract(contract_path)
    root = real_directory(selection_root, "closed diagnostic selection")
    executor = campaign_executor()
    try:
        selection, selection_payload, tap_root = (
            executor.load_selection_candidate(root)
        )
        receipt, receipt_payload = executor.load_json_bytes(
            executor.regular_file(
                receipt_path,
                "real-install selection readback receipt",
            ),
            "real-install selection readback receipt",
        )
        receipt = executor.validate_selection_readback_receipt(
            receipt,
            receipt_payload,
            selection,
            selection_payload,
        )
        with tempfile.TemporaryDirectory(
            prefix="homebrew-real-install-selection-"
        ) as temporary:
            expected_authorization = pathlib.Path(temporary) / "report.json"
            executor.verify_selection_readback(
                selection_root=root,
                receipt_path=receipt_path,
                output=expected_authorization,
            )
            expected_authorization_payload = expected_authorization.read_bytes()
    except (OSError, RuntimeError, ValueError) as error:
        fail(f"generic closed-selection verification failed: {error}")
    authorization, authorization_payload = load_json(
        authorization_path, "selection readback authorization"
    )
    if authorization_payload != expected_authorization_payload:
        fail("selection authorization was not produced by generic readback verification")
    authority = contract["authority"]
    expected_order = contract["selection"]["formula_order"]
    expected_roots = contract["selection"]["roots"]
    formulae = selection.get("formulae")
    actual_order = (
        [entry.get("formula") for entry in formulae]
        if isinstance(formulae, list)
        and all(isinstance(entry, dict) for entry in formulae)
        else None
    )
    tap = selection.get("tap")
    campaign = selection.get("campaign")
    if (
        selection.get("schema") != 1
        or selection.get("kind")
        != "kandelo-homebrew-closed-selection-candidate"
        or selection.get("arch") != authority["arch"]
        or selection.get("kandelo_abi") != authority["kandelo_abi"]
        or selection.get("roots") != expected_roots
        or actual_order != expected_order
        or not isinstance(tap, dict)
        or tap.get("repository") != authority["tap_repository"]
        or tap.get("name") != authority["tap_name"]
        or tap.get("source_commit") != authority["source_tap_commit"]
        or not isinstance(campaign, dict)
        or campaign.get("sha256") != authority["campaign_sha256"]
        or campaign.get("kandelo_commit") != authority["kandelo_commit"]
    ):
        fail("closed selection differs from the exact diagnostic contract")
    if authorization != json.loads(expected_authorization_payload):
        fail("selection authorization differs from the diagnostic contract")
    actual_tree_oid = executor.filesystem_git_tree_oid(
        tap_root, "real-install diagnostic selected tap"
    )
    if actual_tree_oid != tap["prepared_tree_git_oid"]:
        fail("selected tap bytes changed after anonymous readback")
    metadata, _ = load_json(
        tap_root / "Kandelo/metadata.json", "selected tap metadata"
    )
    packages = metadata.get("packages")
    if not isinstance(packages, list) or not all(
        isinstance(package, dict) for package in packages
    ):
        fail("selected tap metadata has no package inventory")
    if (
        metadata.get("tap_repository") != authority["tap_repository"]
        or metadata.get("tap_name") != authority["tap_name"]
        or metadata.get("tap_commit") != authority["source_tap_commit"]
        or metadata.get("kandelo_commit") != authority["kandelo_commit"]
        or metadata.get("kandelo_abi") != authority["kandelo_abi"]
    ):
        fail("selected tap metadata has the wrong diagnostic authority")
    by_name = {package.get("name"): package for package in packages}
    if (
        len(packages) != 25
        or set(by_name) != set(expected_order)
        or len(by_name) != 25
    ):
        fail("selected tap metadata differs from the 25-Formula closure")
    positions = {name: index for index, name in enumerate(expected_order)}
    expected_dependencies = contract["selection"]["dependencies"]
    selection_by_name = {
        formula["formula"]: formula for formula in selection["formulae"]
    }
    for name, package in by_name.items():
        dependencies = package.get("dependencies")
        if not isinstance(dependencies, list):
            fail(f"selected metadata dependencies are invalid for {name}")
        actual_dependencies: list[str] = []
        for dependency in dependencies:
            full_name = dependency.get("full_name") if isinstance(dependency, dict) else None
            prefix = f"{authority['tap_name']}/"
            if not isinstance(full_name, str) or not full_name.startswith(prefix):
                fail(f"selected metadata dependency is invalid for {name}")
            dependency_name = full_name.removeprefix(prefix)
            if dependency_name not in positions or positions[dependency_name] >= positions[name]:
                fail(f"diagnostic Formula order is not dependency-first at {name}")
            actual_dependencies.append(dependency_name)
        if sorted(actual_dependencies) != expected_dependencies[name]:
            fail(f"selected metadata dependencies changed for {name}")
        bottles = package.get("bottles")
        selected_bottles = (
            [bottle for bottle in bottles if bottle.get("arch") == authority["arch"]]
            if isinstance(bottles, list)
            and all(isinstance(bottle, dict) for bottle in bottles)
            else []
        )
        formula_evidence = selection_by_name[name]
        if (
            len(selected_bottles) != 1
            or package.get("version") != formula_evidence["version"]
            or selected_bottles[0].get("sha256")
            != formula_evidence["archive"]["sha256"]
            or selected_bottles[0].get("bytes")
            != formula_evidence["archive"]["bytes"]
        ):
            fail(f"selected metadata bottle differs from handoff archive for {name}")
    return {
        **static,
        "kind": "kandelo-homebrew-real-install-diagnostic-selection-check",
        "contract_sha256": hashlib.sha256(contract_payload).hexdigest(),
        "selection_manifest_sha256": hashlib.sha256(selection_payload).hexdigest(),
        "selection_authorization_sha256": hashlib.sha256(
            authorization_payload
        ).hexdigest(),
        "selection_receipt_sha256": hashlib.sha256(receipt_payload).hexdigest(),
        "selection_release": {
            "repository": receipt["repository"],
            "tag": receipt["tag"],
            "release_id": receipt["release_id"],
            "target_commitish": receipt["target_commitish"],
            "assets": receipt["assets"],
            "visibility": receipt["visibility"],
        },
        "formulae": selection["formulae"],
        "prepared_tree_git_oid": tap["prepared_tree_git_oid"],
        "source_tap_commit": authority["source_tap_commit"],
    }


def write_new_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    try:
        if not path.parent.is_dir() or path.parent.is_symlink():
            fail("report parent must be a regular directory")
        with path.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except DiagnosticError:
        raise
    except OSError as error:
        fail(f"cannot write report: {error}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--contract", type=pathlib.Path, default=DEFAULT_CONTRACT)
    commands = result.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check")
    check.add_argument("--report-out", type=pathlib.Path)
    verify = commands.add_parser("verify-selection")
    verify.add_argument("--selection", type=pathlib.Path, required=True)
    verify.add_argument("--receipt", type=pathlib.Path, required=True)
    verify.add_argument("--authorization", type=pathlib.Path, required=True)
    verify.add_argument("--report-out", type=pathlib.Path, required=True)
    independent = commands.add_parser("verify-independent-tap")
    independent.add_argument("--tap-root", type=pathlib.Path, required=True)
    independent.add_argument("--report-out", type=pathlib.Path, required=True)
    return result


def main() -> None:
    arguments = parser().parse_args()
    try:
        if arguments.command == "check":
            report = check_static(arguments.contract)
            if arguments.report_out is None:
                print(json.dumps(report, indent=2, sort_keys=True))
            else:
                write_new_json(arguments.report_out, report)
        elif arguments.command == "verify-selection":
            write_new_json(
                arguments.report_out,
                verify_selection(
                    arguments.contract,
                    arguments.selection,
                    arguments.receipt,
                    arguments.authorization,
                ),
            )
        else:
            write_new_json(
                arguments.report_out,
                verify_independent_tap(
                    arguments.contract,
                    arguments.tap_root,
                ),
            )
    except DiagnosticError as error:
        print(f"homebrew-real-install-diagnostic: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
