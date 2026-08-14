#!/usr/bin/env python3
"""Create, seal, and verify the main shell's closed Homebrew selection."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
EXECUTOR_PATH = ROOT / "scripts/homebrew-prefix-campaign-executor.py"
INPUT_PATHS = {
    "brewfile": "homebrew/main-shell.Brewfile",
    "guest_layout": "homebrew/kandelo-guest-layout.json",
    "migration_lock": "homebrew/main-shell-migration-lock.json",
    "runtime_support": "homebrew/main-shell-homebrew-runtime-support.json",
}
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TAG = re.compile(r"^homebrew-prefix-selection-sha256-([0-9a-f]{64})$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_FORMULAE = 256


class LockError(RuntimeError):
    """A fail-closed main-shell selection-lock error."""


def fail(message: str) -> NoReturn:
    raise LockError(message)


def duplicate_rejecting_object(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            fail(f"JSON repeats key {key!r}")
        value[key] = item
    return value


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: pathlib.Path, label: str) -> tuple[dict[str, Any], bytes]:
    try:
        metadata = path.lstat()
        if (
            not path.is_file()
            or path.is_symlink()
            or metadata.st_size < 1
            or metadata.st_size > MAX_JSON_BYTES
        ):
            fail(f"{label} must be one bounded regular non-symlink file")
        payload = path.read_bytes()
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
            parse_constant=lambda item: fail(
                f"{label} contains invalid constant {item}"
            ),
        )
    except LockError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value, payload


def exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} must contain exactly {sorted(keys)}")
    return value


def string(value: Any, label: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        fail(f"{label} is invalid")
    return value


def integer(value: Any, label: str, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        fail(f"{label} is invalid")
    return value


def executor() -> Any:
    spec = importlib.util.spec_from_file_location(
        "homebrew_prefix_campaign_executor_for_shell_lock",
        EXECUTOR_PATH,
    )
    if spec is None or spec.loader is None:
        fail("cannot load the closed-selection validator")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def repository_input(root: pathlib.Path, relative: str) -> pathlib.Path:
    candidate = root / relative
    try:
        if candidate.resolve().relative_to(root.resolve()) != pathlib.Path(
            relative
        ):
            fail(f"repository input {relative} resolves indirectly")
    except (OSError, ValueError) as error:
        fail(f"repository input {relative} is unsafe: {error}")
    return candidate


def source_abi(root: pathlib.Path) -> int:
    path = root / "crates/shared/src/lib.rs"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"cannot read Kandelo ABI: {error}")
    match = re.search(
        r"^pub const ABI_VERSION: u32 = ([0-9]+);$", text, re.MULTILINE
    )
    if match is None:
        fail("cannot read Kandelo ABI")
    return int(match.group(1))


def brewfile_roots(root: pathlib.Path, brewfile: pathlib.Path) -> list[str]:
    try:
        result = subprocess.run(
            [
                "ruby",
                str(root / "scripts/homebrew-brewfile-selection.rb"),
                str(brewfile),
            ],
            cwd=root,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot derive Brewfile roots: {error}")
    if result.returncode != 0 or len(result.stdout) > MAX_JSON_BYTES:
        detail = result.stderr.decode("utf-8", errors="replace")[-4096:]
        fail(f"cannot derive Brewfile roots: {detail}")
    try:
        value = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Brewfile root derivation returned invalid JSON: {error}")
    if (
        not isinstance(value, dict)
        or value.get("schema") != 1
        or value.get("kind") != "kandelo-static-brewfile-v1"
        or not isinstance(value.get("packages"), list)
    ):
        fail("Brewfile root derivation returned an unsupported contract")
    return [
        string(name, "Brewfile Formula", FORMULA)
        for name in value["packages"]
    ]


def tap_formula_name(value: Any, tap_name: str, label: str) -> str:
    if not isinstance(value, str) or not value.startswith(f"{tap_name}/"):
        fail(f"{label} is outside {tap_name}")
    return string(value.removeprefix(f"{tap_name}/"), label, FORMULA)


def derive_roots_and_required_formulae(
    root: pathlib.Path,
    inputs: dict[str, tuple[dict[str, Any], bytes]],
    *,
    require_finalized_brewfile: bool = False,
) -> tuple[list[str], set[str], str, int, str]:
    migration = inputs["migration_lock"][0]
    runtime = inputs["runtime_support"][0]
    layout = inputs["guest_layout"][0]
    tap_name = migration.get("tap_name")
    tap_repository = migration.get("tap_repository")
    if tap_name != "kandelo-dev/tap-core" or (
        tap_repository != "kandelo-dev/homebrew-tap-core"
    ):
        fail("main-shell migration lock has the wrong tap identity")
    migration_catalog = migration.get("catalog")
    runtime_catalog = runtime.get("catalog")
    if not isinstance(migration_catalog, dict) or not isinstance(
        runtime_catalog, dict
    ):
        fail("main-shell inputs lack catalog authority")
    source_commit = string(
        migration_catalog.get("tap_commit"),
        "main-shell catalog commit",
        GIT_SHA,
    )
    if (
        runtime_catalog.get("tap_commit") != source_commit
        or runtime_catalog.get("tap_name") != tap_name
        or runtime_catalog.get("tap_repository") != tap_repository
    ):
        fail("runtime-support and migration catalog authorities differ")
    if (
        layout.get("kind") != "kandelo-homebrew-guest-layout"
        or layout.get("prefix") != "/opt/kandelo/homebrew"
    ):
        fail("main-shell guest layout is not the canonical /opt prefix")

    roots = brewfile_roots(root, root / INPUT_PATHS["brewfile"])
    if require_finalized_brewfile:
        migration_roots: list[str] = []
        packages = migration.get("packages")
        if not isinstance(packages, list):
            fail("main-shell migration roots are invalid")
        for position, record in enumerate(packages):
            formula = record.get("formula") if isinstance(record, dict) else None
            migration_roots.append(
                string(
                    formula.get("name") if isinstance(formula, dict) else None,
                    f"main-shell migration root #{position}",
                    FORMULA,
                )
            )
        if roots != migration_roots:
            staged = [name for name in roots if name not in migration_roots]
            if staged:
                fail(
                    "historical closed-selection roots are not finalized: "
                    + ", ".join(staged)
                )
            fail(
                "historical closed-selection Brewfile differs from the "
                "migration roots"
            )
    formula_roots = runtime.get("formula_roots")
    if not isinstance(formula_roots, list) or not formula_roots:
        fail("runtime-support Formula roots are invalid")
    for position, record in enumerate(formula_roots):
        if not isinstance(record, dict):
            fail(f"runtime-support Formula root #{position} is invalid")
        roots.append(
            tap_formula_name(
                record.get("package"),
                tap_name,
                f"runtime-support Formula root #{position}",
            )
        )
    activation = runtime.get("activation")
    bootstrap = (
        activation.get("bootstrap_package")
        if isinstance(activation, dict)
        else None
    )
    if not isinstance(bootstrap, dict):
        fail("runtime-support bootstrap package is invalid")
    roots.append(
        string(
            bootstrap.get("name"),
            "runtime-support bootstrap package",
            FORMULA,
        )
    )
    roots = sorted(set(roots))

    closure = migration.get("formula_closure")
    additional = runtime.get("additional_formula_order")
    if not isinstance(closure, list) or not isinstance(additional, list):
        fail("main-shell Formula inventories are invalid")
    required = {
        tap_formula_name(value, tap_name, "main-shell Formula closure")
        for value in closure
    }
    required.update(
        tap_formula_name(value, tap_name, "runtime-support Formula")
        for value in additional
    )
    required.add(bootstrap["name"])
    return roots, required, tap_name, source_abi(root), source_commit


def validate_selected_formula_closure(
    *,
    tap_root: pathlib.Path,
    tap_name: str,
    source_commit: str,
    kandelo_abi: int,
    kandelo_commit: str,
    arch: str,
    roots: list[str],
    formulae: list[dict[str, Any]],
) -> list[str]:
    metadata, _payload = load_json(
        tap_root / "Kandelo/metadata.json", "closed selection tap metadata"
    )
    packages = metadata.get("packages")
    if (
        metadata.get("schema") != 1
        or metadata.get("tap_name") != tap_name
        or metadata.get("tap_repository")
        != "kandelo-dev/homebrew-tap-core"
        or metadata.get("tap_commit") != source_commit
        or metadata.get("kandelo_abi") != kandelo_abi
        or metadata.get("kandelo_commit") != kandelo_commit
        or not isinstance(packages, list)
        or not packages
        or len(packages) > MAX_FORMULAE
    ):
        fail("closed selection tap metadata has the wrong authority")

    selected = {record["formula"]: record for record in formulae}
    if len(selected) != len(formulae):
        fail("closed selection Formula inventory repeats a Formula")
    package_dependencies: dict[str, list[str]] = {}
    for position, package in enumerate(packages):
        if not isinstance(package, dict):
            fail(f"closed selection metadata package #{position} is invalid")
        name = string(
            package.get("name"),
            f"closed selection metadata package #{position}",
            FORMULA,
        )
        if name in package_dependencies or name not in selected:
            fail("closed selection metadata Formula inventory differs")
        if (
            package.get("full_name") != f"{tap_name}/{name}"
            or package.get("version") != selected[name]["version"]
        ):
            fail(f"closed selection metadata identity differs for {name}")
        dependencies = package.get("dependencies")
        if not isinstance(dependencies, list) or len(dependencies) > MAX_FORMULAE:
            fail(f"closed selection metadata dependencies are invalid for {name}")
        names: list[str] = []
        for dependency in dependencies:
            if not isinstance(dependency, dict):
                fail(f"closed selection metadata dependency is invalid for {name}")
            dependency_name = string(
                dependency.get("name"),
                f"closed selection metadata dependency of {name}",
                FORMULA,
            )
            if dependency.get("full_name") not in (
                None,
                f"{tap_name}/{dependency_name}",
            ):
                fail(
                    "closed selection metadata dependency is outside "
                    f"the tap for {name}"
                )
            names.append(dependency_name)
        if len(set(names)) != len(names):
            fail(f"closed selection metadata repeats a dependency for {name}")
        package_dependencies[name] = names

        bottles = package.get("bottles")
        if not isinstance(bottles, list):
            fail(f"closed selection metadata bottles are invalid for {name}")
        matching = [
            bottle
            for bottle in bottles
            if isinstance(bottle, dict) and bottle.get("arch") == arch
        ]
        archive = selected[name]["archive"]
        if (
            len(matching) != 1
            or not isinstance(matching[0], dict)
            or matching[0].get("status") != "success"
            or matching[0].get("kandelo_abi") != kandelo_abi
            or matching[0].get("bytes") != archive["bytes"]
            or matching[0].get("sha256") != archive["sha256"]
        ):
            fail(f"closed selection bottle provenance differs for {name}")

    if set(package_dependencies) != set(selected):
        fail("closed selection metadata Formula inventory differs")

    ordered: list[str] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            fail(f"closed selection dependency graph cycles at {name}")
        if name in visited:
            return
        if name not in package_dependencies:
            fail(f"closed selection dependency graph omits {name}")
        visiting.add(name)
        for dependency in package_dependencies[name]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
        ordered.append(name)

    for root_name in roots:
        visit(root_name)
    # WHY: a partial catalog is useful precisely because unrelated Formulae
    # may remain unfinished. Requiring the selected inventory to equal the
    # roots' dependency closure prevents it from quietly becoming a second,
    # vaguely scoped tap while still permitting newly discovered dependencies.
    if ordered != [record["formula"] for record in formulae]:
        fail("closed selection is not the exact dependency closure of its roots")
    return ordered


def create_pending(root: pathlib.Path) -> dict[str, Any]:
    records: dict[str, Any] = {}
    for name, relative in INPUT_PATHS.items():
        path = repository_input(root, relative)
        records[name] = {
            "path": relative,
            "sha256": sha256_file(path),
        }
    inputs = {
        name: load_json(root / relative, f"main-shell {name}")
        for name, relative in INPUT_PATHS.items()
        if name != "brewfile"
    }
    # Derivation here makes a pending lock fail immediately if the source
    # contracts disagree; it does not guess the future selection identity.
    inputs["brewfile"] = ({}, (root / INPUT_PATHS["brewfile"]).read_bytes())
    derive_roots_and_required_formulae(root, inputs)
    return {
        "arch": "wasm32",
        "inputs": records,
        "kind": "kandelo-homebrew-main-shell-closed-selection-lock",
        "release": None,
        "schema": 1,
        "state": "pending",
    }


def validate_lock(
    value: Any, root: pathlib.Path
) -> tuple[dict[str, Any], dict[str, tuple[dict[str, Any], bytes]]]:
    value = exact_keys(
        value,
        {"arch", "inputs", "kind", "release", "schema", "state"},
        "main-shell closed-selection lock",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-main-shell-closed-selection-lock"
        or value["arch"] != "wasm32"
        or value["state"] not in ("pending", "sealed")
    ):
        fail("main-shell closed-selection lock has an unsupported contract")
    records = exact_keys(
        value["inputs"], set(INPUT_PATHS), "main-shell lock inputs"
    )
    loaded: dict[str, tuple[dict[str, Any], bytes]] = {}
    for name, relative in INPUT_PATHS.items():
        record = exact_keys(
            records[name], {"path", "sha256"}, f"main-shell {name} input"
        )
        if record["path"] != relative:
            fail(f"main-shell {name} input path differs")
        expected = string(
            record["sha256"], f"main-shell {name} input SHA-256", SHA256
        )
        path = repository_input(root, relative)
        payload = path.read_bytes()
        if sha256_bytes(payload) != expected:
            fail(f"main-shell {name} input differs from its lock")
        if name == "brewfile":
            loaded[name] = ({}, payload)
        else:
            loaded[name] = load_json(path, f"main-shell {name}")
    derive_roots_and_required_formulae(root, loaded)
    if value["state"] == "pending" and value["release"] is not None:
        fail("pending main-shell selection lock names a release")
    if value["state"] == "sealed" and not isinstance(value["release"], dict):
        fail("sealed main-shell selection lock lacks a release")
    return value, loaded


def validate_receipt(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "arch",
            "assets",
            "formula_count",
            "kind",
            "prepared_tree_git_oid",
            "release_id",
            "repository",
            "roots",
            "schema",
            "selection_manifest_sha256",
            "tag",
            "target_commitish",
            "visibility",
        },
        "closed selection readback receipt",
    )
    if (
        value["schema"] != 1
        or value["kind"] != "kandelo-homebrew-closed-selection-readback"
        or value["arch"] != "wasm32"
        or value["visibility"] != "public-anonymous-readback"
    ):
        fail("closed selection readback receipt is unsupported")
    assets = exact_keys(
        value["assets"],
        {"closed-selection.json", "closed-selection.zip"},
        "closed selection readback assets",
    )
    for name, record in assets.items():
        exact_keys(record, {"bytes", "sha256"}, f"closed selection asset {name}")
        integer(record["bytes"], f"closed selection asset {name} bytes", 1)
        string(
            record["sha256"], f"closed selection asset {name} SHA-256", SHA256
        )
    match = TAG.fullmatch(value.get("tag", ""))
    if match is None or match.group(1) != assets["closed-selection.json"]["sha256"]:
        fail("closed selection receipt tag differs from its descriptor")
    string(value["target_commitish"], "selection release target", GIT_SHA)
    string(value["prepared_tree_git_oid"], "selection prepared tree", GIT_SHA)
    string(
        value["selection_manifest_sha256"],
        "selection manifest SHA-256",
        SHA256,
    )
    integer(value["formula_count"], "selection Formula count", 1)
    integer(value["release_id"], "selection release id", 1)
    roots = value["roots"]
    if not isinstance(roots, list) or not roots:
        fail("closed selection receipt roots are invalid")
    checked_roots = [
        string(root, "closed selection receipt root", FORMULA)
        for root in roots
    ]
    if checked_roots != sorted(set(checked_roots)):
        fail("closed selection receipt roots must be unique and sorted")
    if value["repository"] != "kandelo-dev/homebrew-tap-core":
        fail("closed selection receipt has the wrong repository")
    return value


def release_from_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    return {
        "assets": receipt["assets"],
        "formula_count": receipt["formula_count"],
        "prepared_tree_git_oid": receipt["prepared_tree_git_oid"],
        "repository": receipt["repository"],
        "roots": receipt["roots"],
        "selection_manifest_sha256": receipt[
            "selection_manifest_sha256"
        ],
        "tag": receipt["tag"],
        "target_commitish": receipt["target_commitish"],
    }


def verify_selection(
    *,
    root: pathlib.Path,
    lock: dict[str, Any],
    inputs: dict[str, tuple[dict[str, Any], bytes]],
    selection_root: pathlib.Path,
    receipt: dict[str, Any] | None,
    allow_pending: bool,
) -> dict[str, Any]:
    selection_validator = executor()
    try:
        selection, selection_payload, tap_root = (
            selection_validator.load_selection_candidate(selection_root)
        )
    except selection_validator.ExecutorError as error:
        # The imported executor owns the generic selection contract, while
        # this command owns the product lock. Convert its fail-closed error to
        # this CLI's stable error surface without hiding the useful reason.
        fail(f"closed selection is invalid: {error}")
    roots, required, tap_name, abi, source_commit = (
        derive_roots_and_required_formulae(
            root, inputs, require_finalized_brewfile=True
        )
    )
    if selection["arch"] != lock["arch"] or selection["kandelo_abi"] != abi:
        fail("closed selection architecture or ABI differs from Kandelo")
    if selection["roots"] != roots:
        fail("closed selection roots differ from product-owned inputs")
    selected_names = validate_selected_formula_closure(
        tap_root=tap_root,
        tap_name=tap_name,
        source_commit=source_commit,
        kandelo_abi=abi,
        kandelo_commit=selection["campaign"]["kandelo_commit"],
        arch=selection["arch"],
        roots=roots,
        formulae=selection["formulae"],
    )
    if not required.issubset(selected_names):
        fail("closed selection omits required main-shell Formulae")
    if (
        selection["tap"]["name"] != tap_name
        or selection["tap"]["repository"].lower()
        != "kandelo-dev/homebrew-tap-core"
        or selection["tap"]["source_commit"] != source_commit
    ):
        fail("closed selection tap authority differs from product inputs")
    layout_sha = lock["inputs"]["guest_layout"]["sha256"]
    if selection["campaign"]["guest_layout_sha256"] != layout_sha:
        fail("closed selection guest layout differs from its product lock")

    if lock["state"] == "pending":
        if not allow_pending:
            fail("pending closed selection is not a publishable shell input")
        if receipt is not None:
            fail("pending closed selection must not use a release receipt")
    else:
        if receipt is None:
            fail("sealed closed selection requires public readback evidence")
        if lock["release"] != release_from_receipt(receipt):
            fail("closed selection readback differs from its sealed lock")
        if (
            receipt["target_commitish"] != source_commit
            or receipt["roots"] != roots
            or receipt["formula_count"] != len(selected_names)
            or receipt["prepared_tree_git_oid"]
            != selection["tap"]["prepared_tree_git_oid"]
            or receipt["selection_manifest_sha256"]
            != sha256_bytes(selection_payload)
        ):
            fail("closed selection readback differs from selected tap bytes")
    return {
        "arch": selection["arch"],
        "formula_count": len(selected_names),
        "kind": "kandelo-homebrew-main-shell-selection-verification",
        "prepared_tree_git_oid": selection["tap"][
            "prepared_tree_git_oid"
        ],
        "roots": roots,
        "schema": 1,
        "selection_manifest_sha256": sha256_bytes(selection_payload),
        "source_tap_commit": source_commit,
        "state": lock["state"],
    }


def atomic_write(path: pathlib.Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        fail(f"output already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(pretty_json(value))
        os.chmod(temporary, 0o644)
        os.link(temporary, path)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(ROOT))
    commands = parser.add_subparsers(dest="command", required=True)
    pending = commands.add_parser("create-pending")
    pending.add_argument("--out", required=True)
    seal = commands.add_parser("seal")
    seal.add_argument("--lock", required=True)
    seal.add_argument("--selection", required=True)
    seal.add_argument("--receipt", required=True)
    seal.add_argument("--out", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--lock", required=True)
    verify.add_argument("--selection", required=True)
    verify.add_argument("--receipt")
    verify.add_argument("--allow-pending", action="store_true")
    verify.add_argument("--report-out")
    roots = commands.add_parser("roots")
    roots.add_argument("--out")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    root = pathlib.Path(arguments.repo_root).resolve()
    try:
        if arguments.command == "create-pending":
            atomic_write(pathlib.Path(arguments.out), create_pending(root))
            return 0
        if arguments.command == "roots":
            lock = create_pending(root)
            loaded = {
                name: (
                    ({}, (root / relative).read_bytes())
                    if name == "brewfile"
                    else load_json(root / relative, f"main-shell {name}")
                )
                for name, relative in INPUT_PATHS.items()
            }
            roots, _required, _tap, _abi, _commit = (
                derive_roots_and_required_formulae(
                    root, loaded, require_finalized_brewfile=True
                )
            )
            value = {
                "kind": "kandelo-homebrew-main-shell-selection-roots",
                "roots": roots,
                "schema": 1,
            }
            if arguments.out:
                atomic_write(pathlib.Path(arguments.out), value)
            else:
                sys.stdout.buffer.write(pretty_json(value))
            del lock
            return 0

        lock, lock_payload = load_json(
            pathlib.Path(arguments.lock), "main-shell selection lock"
        )
        if lock_payload != pretty_json(lock):
            fail("main-shell selection lock is not canonical pretty JSON")
        lock, inputs = validate_lock(lock, root)
        receipt = None
        if getattr(arguments, "receipt", None):
            receipt, receipt_payload = load_json(
                pathlib.Path(arguments.receipt),
                "closed selection readback receipt",
            )
            if receipt_payload != pretty_json(receipt):
                fail("closed selection readback receipt is not canonical JSON")
            receipt = validate_receipt(receipt)
        if arguments.command == "seal":
            if lock["state"] != "pending":
                fail("only a pending main-shell selection lock can be sealed")
            report = verify_selection(
                root=root,
                lock=lock,
                inputs=inputs,
                selection_root=pathlib.Path(arguments.selection),
                receipt=None,
                allow_pending=True,
            )
            if receipt is None:
                fail("sealing requires a public readback receipt")
            if (
                receipt["roots"] != report["roots"]
                or receipt["formula_count"] != report["formula_count"]
                or receipt["prepared_tree_git_oid"]
                != report["prepared_tree_git_oid"]
                or receipt["selection_manifest_sha256"]
                != report["selection_manifest_sha256"]
                or receipt["target_commitish"]
                != report["source_tap_commit"]
            ):
                fail("public readback differs from the pending selection")
            sealed = dict(lock)
            sealed["state"] = "sealed"
            sealed["release"] = release_from_receipt(receipt)
            atomic_write(pathlib.Path(arguments.out), sealed)
            return 0
        report = verify_selection(
            root=root,
            lock=lock,
            inputs=inputs,
            selection_root=pathlib.Path(arguments.selection),
            receipt=receipt,
            allow_pending=arguments.allow_pending,
        )
        if arguments.report_out:
            atomic_write(pathlib.Path(arguments.report_out), report)
        else:
            sys.stdout.buffer.write(pretty_json(report))
        return 0
    except LockError as error:
        print(f"homebrew-main-shell-selection-lock: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
