#!/usr/bin/env python3
"""Capture and validate exact-bottle Homebrew runtime evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
from typing import Any


MAX_JSON_BYTES = 1_048_576
MAX_LOG_BYTES = 16_777_216
MAX_EVIDENCE_LINES = 16
MAX_EVIDENCE_LINE_BYTES = 1_024
FORMULA_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
PKG_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TAP_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SOURCE_BUILD = re.compile(r"\b(?:building|built)\b.*\bfrom source\b", re.IGNORECASE)
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class EvidenceError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise EvidenceError(message)


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def require_string(value: Any, label: str, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a non-empty string")
    if "\0" in value or pattern is not None and pattern.fullmatch(value) is None:
        fail(f"{label} has an invalid value: {value!r}")
    return value


def require_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        fail(f"{label} must be boolean")
    return value


def regular_file(path: pathlib.Path, label: str, maximum: int) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a regular non-symlink file: {path}")
    if metadata.st_size > maximum:
        fail(f"{label} exceeds {maximum} bytes")
    return path


def load_json(path: pathlib.Path, label: str) -> Any:
    regular_file(path, label, MAX_JSON_BYTES)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid UTF-8 JSON: {error}")


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_identity(value: str, label: str) -> str:
    require_string(value, label, TAP_REPOSITORY)
    owner, name = value.lower().split("/", 1)
    return f"{owner}/{name}"


def normalized_tap_repository(args: argparse.Namespace) -> str:
    return normalized_identity(args.tap_repository, "tap repository")


def normalized_tap_name(args: argparse.Namespace) -> str:
    repository = normalized_tap_repository(args)
    owner, repository_name = repository.split("/", 1)
    if repository == "automattic/kandelo-homebrew":
        expected = repository
    else:
        if not repository_name.startswith("homebrew-") or repository_name == "homebrew-":
            fail("third-party tap repositories must use owner/homebrew-name")
        expected = f"{owner}/{repository_name.removeprefix('homebrew-')}"
        if expected == "automattic/kandelo-homebrew":
            fail("the protected first-party tap name cannot be derived from another repository")
    requested = args.tap_name
    if requested is None:
        if repository != "automattic/kandelo-homebrew":
            fail("tap name is required when repository and Homebrew identities may differ")
        requested = args.tap_repository
    selected = normalized_identity(requested, "tap name")
    if selected != expected:
        fail("tap name does not match the tap repository")
    return selected


def validate_arguments(args: argparse.Namespace) -> None:
    require_string(args.formula, "formula", FORMULA_NAME)
    if args.arch not in ("wasm32", "wasm64"):
        fail(f"unsupported architecture: {args.arch}")
    if isinstance(args.abi, bool) or not isinstance(args.abi, int) or args.abi <= 0:
        fail("ABI must be a positive integer")
    require_string(args.tap_commit, "tap commit", COMMIT)
    repository = normalized_tap_repository(args)
    normalized_tap_name(args)
    expected_root = f"https://ghcr.io/v2/{repository}"
    if args.bottle_root_url != expected_root:
        fail(f"bottle root URL does not match {expected_root}")
    require_string(args.bottle_sha256, "bottle sha256", SHA256)
    if isinstance(args.bottle_bytes, bool) or args.bottle_bytes <= 0:
        fail("bottle byte count must be positive")
    expected_url = (
        f"{args.bottle_root_url}/{args.formula}/blobs/sha256:{args.bottle_sha256}"
    )
    if args.bottle_url != expected_url:
        fail(f"bottle URL does not match {expected_url}")


def validate_dependency_provenance(args: argparse.Namespace) -> dict[str, Any]:
    provenance_path = pathlib.Path(args.dependency_provenance)
    provenance = load_json(provenance_path, "dependency provenance")
    validator = pathlib.Path(__file__).with_name("homebrew-dependency-provenance.py")
    command = [
        sys.executable,
        str(validator),
        "validate",
        "--input",
        str(provenance_path),
        "--tap-repository",
        args.tap_repository,
        "--tap-name",
        normalized_tap_name(args),
        "--tap-commit",
        args.tap_commit,
        "--formula",
        args.formula,
        "--arch",
        args.arch,
        "--bottle-root-url",
        args.bottle_root_url,
        "--tap-root",
        args.tap_root,
    ]
    result = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[:4_096]
        fail(f"dependency provenance validation failed: {detail}")
    dependencies = provenance.get("dependencies")
    if not isinstance(dependencies, list):
        fail("dependency provenance lacks a dependency array")
    summary: list[dict[str, Any]] = []
    for index, dependency in enumerate(dependencies):
        if not isinstance(dependency, dict):
            fail(f"dependency provenance entry {index} must be an object")
        bottle = dependency.get("bottle")
        receipt = dependency.get("receipt")
        if not isinstance(bottle, dict) or not isinstance(receipt, dict):
            fail(f"dependency provenance entry {index} lacks bottle receipt evidence")
        summary.append(
            {
                "full_name": dependency.get("full_name"),
                "version": dependency.get("version"),
                "sha256": bottle.get("sha256"),
                "tag": bottle.get("tag"),
                "receipt_sha256": receipt.get("sha256"),
            }
        )
    return {
        "bottles": summary,
        "provenance_sha256": sha256_file(provenance_path),
    }


def canonical_bottle(args: argparse.Namespace) -> tuple[str, str]:
    document = load_json(pathlib.Path(args.bottle_json), "canonical bottle JSON")
    if not isinstance(document, dict) or len(document) != 1:
        fail("canonical bottle JSON must contain one Formula")
    formula_key, entry = next(iter(document.items()))
    if formula_key != args.formula:
        fail("canonical bottle JSON Formula key does not match")
    entry = exact_keys(entry, {"formula", "bottle"}, "canonical bottle entry")
    formula = exact_keys(
        entry["formula"], {"name", "path", "pkg_version"}, "canonical Formula identity"
    )
    bottle = exact_keys(
        entry["bottle"], {"root_url", "cellar", "rebuild", "tags"}, "canonical bottle"
    )
    version = require_string(formula["pkg_version"], "canonical Formula version", PKG_VERSION)
    if formula["name"] != args.formula:
        fail("canonical Formula name does not match")
    tag_name = f"{args.arch}_kandelo"
    tags = bottle["tags"]
    if not isinstance(tags, dict) or set(tags) != {tag_name}:
        fail(f"canonical bottle JSON must contain only {tag_name}")
    tag = exact_keys(tags[tag_name], {"sha256"}, f"canonical {tag_name} bottle")
    if tag["sha256"] != args.bottle_sha256:
        fail("canonical bottle digest does not match the selected bytes")
    if bottle["root_url"] != args.bottle_root_url:
        fail("canonical bottle root URL does not match")
    return version, tag_name


def validate_formula_info(
    args: argparse.Namespace, version: str, tag_name: str
) -> None:
    document = exact_keys(
        load_json(pathlib.Path(args.formula_info), "Homebrew Formula info"),
        {"formulae", "casks"},
        "Homebrew Formula info",
    )
    formulae = document["formulae"]
    if document["casks"] != [] or not isinstance(formulae, list) or len(formulae) != 1:
        fail("Homebrew Formula info must contain one Formula and no casks")
    formula = formulae[0]
    if not isinstance(formula, dict):
        fail("Homebrew Formula info record must be an object")
    expected_full_name = f"{normalized_tap_name(args)}/{args.formula}"
    if formula.get("name") != args.formula or str(formula.get("full_name", "")).lower() != expected_full_name:
        fail("Homebrew Formula info identity does not match the exact tap Formula")
    versions = formula.get("versions")
    stable_version = versions.get("stable") if isinstance(versions, dict) else None
    revision = formula.get("revision")
    if not isinstance(stable_version, str) or not stable_version:
        fail("Homebrew Formula info lacks versions.stable")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        fail("Homebrew Formula info has an invalid revision")
    info_pkg_version = stable_version if revision == 0 else f"{stable_version}_{revision}"
    if info_pkg_version != version:
        fail("Homebrew Formula info version does not match the bottle")
    formula_path = pathlib.Path(args.tap_root) / "Formula" / f"{args.formula}.rb"
    formula_sha = sha256_file(regular_file(formula_path, "reconstructed Formula", MAX_JSON_BYTES))
    source_checksum = formula.get("ruby_source_checksum")
    if not isinstance(source_checksum, dict) or source_checksum.get("sha256") != formula_sha:
        fail("Homebrew Formula info digest does not match the reconstructed Formula")
    bottle = formula.get("bottle")
    stable = bottle.get("stable") if isinstance(bottle, dict) else None
    files = stable.get("files") if isinstance(stable, dict) else None
    tag = files.get(tag_name) if isinstance(files, dict) else None
    if not isinstance(tag, dict):
        fail(f"Homebrew Formula info lacks the {tag_name} bottle")
    if tag.get("sha256") != args.bottle_sha256 or tag.get("url") != args.bottle_url:
        fail("Homebrew Formula info does not select the exact bottle digest URL")


def read_log(path: pathlib.Path) -> list[str]:
    regular_file(path, "target bottle install log", MAX_LOG_BYTES)
    text = ANSI_ESCAPE.sub("", path.read_bytes().decode("utf-8", errors="replace")).replace(
        "\r", "\n"
    )
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if any(ord(character) < 0x20 and character != "\t" for character in line):
            continue
        encoded = line.encode("utf-8")
        if len(encoded) > MAX_EVIDENCE_LINE_BYTES:
            line = encoded[:MAX_EVIDENCE_LINE_BYTES].decode("utf-8", errors="ignore")
        lines.append(line)
    return lines


def target_install_evidence(
    args: argparse.Namespace, tag_name: str, selection: dict[str, Any]
) -> dict[str, Any]:
    lines = read_log(pathlib.Path(args.install_log))
    source_lines = [line for line in lines if SOURCE_BUILD.search(line)]
    if source_lines:
        fail(f"target install reported a source build: {source_lines[0]}")
    marker = f".{tag_name}.bottle.tar."
    pour = [
        line
        for line in lines
        if "pouring" in line.lower()
        and args.formula in line.lower()
        and marker in line.lower()
    ]
    if not pour:
        fail(f"target install lacks pour evidence for {tag_name}")
    mode = selection["bottle"]["mode"]
    if mode == "anonymous-public-readback":
        fetch = [
            line
            for line in lines
            if args.bottle_url.lower() in line.lower()
            and re.search(r"\b(?:downloading|downloaded|fetching)\b", line, re.IGNORECASE)
        ]
        if not fetch:
            fail("target Homebrew install lacks fetch evidence for the exact public bottle URL")
    else:
        fetch = list(selection["fetch"])
    installed_bottle = regular_file(
        pathlib.Path(args.installed_bottle), "Homebrew-selected target bottle", 2_147_483_648
    )
    if sha256_file(installed_bottle) != args.bottle_sha256:
        fail("Homebrew-selected target bottle digest does not match")
    if installed_bottle.stat().st_size != args.bottle_bytes:
        fail("Homebrew-selected target bottle byte count does not match")
    return {
        "fetch": fetch[:MAX_EVIDENCE_LINES],
        "pour": pour[:MAX_EVIDENCE_LINES],
        "source_build_absent": True,
    }


def target_receipt(args: argparse.Namespace, version: str) -> dict[str, Any]:
    prefix = pathlib.Path(args.target_prefix)
    if not prefix.is_absolute() or prefix.is_symlink():
        fail("target prefix must be an absolute real path")
    expected_suffix = pathlib.PurePath("Cellar") / args.formula / version
    if pathlib.PurePath(prefix).parts[-3:] != expected_suffix.parts:
        fail("target prefix does not identify the exact Formula version")
    receipt_path = pathlib.Path(args.target_receipt)
    if receipt_path != prefix / "INSTALL_RECEIPT.json":
        fail("target receipt path does not belong to the exact target prefix")
    receipt = load_json(receipt_path, "target INSTALL_RECEIPT.json")
    if not isinstance(receipt, dict):
        fail("target INSTALL_RECEIPT.json must be an object")
    if receipt.get("built_as_bottle") is not True:
        fail("target receipt does not prove built_as_bottle=true")
    if receipt.get("poured_from_bottle") is not True:
        fail("target receipt does not prove poured_from_bottle=true")
    if receipt.get("installed_on_request") is not True:
        fail("target receipt does not prove an explicit target install")
    source = receipt.get("source")
    if not isinstance(source, dict):
        fail("target receipt source must be an object")
    tap = normalized_tap_name(args)
    if str(source.get("tap", "")).lower() != tap or source.get("tap_git_head") != args.tap_commit:
        fail("target receipt is not bound to the exact tap commit")
    if source.get("spec") not in (None, "stable"):
        fail("target receipt did not install the stable Formula spec")
    homebrew_version = require_string(receipt.get("homebrew_version"), "target Homebrew version")
    if len(homebrew_version.encode("utf-8")) > 256:
        fail("target Homebrew version is too long")
    return {
        "built_as_bottle": True,
        "homebrew_version": homebrew_version,
        "installed_on_request": True,
        "path": f"Cellar/{args.formula}/{version}/INSTALL_RECEIPT.json",
        "poured_from_bottle": True,
        "sha256": sha256_file(receipt_path),
        "source_tap": tap,
        "source_tap_git_head": args.tap_commit,
    }


def node_evidence(args: argparse.Namespace) -> dict[str, Any]:
    path = pathlib.Path(args.node_receipt)
    receipt = exact_keys(
        load_json(path, "Kandelo Node execution receipt"),
        {"schema", "formula", "arch", "kandelo_abi", "runtime", "launcher", "argv", "status"},
        "Kandelo Node execution receipt",
    )
    if receipt["schema"] != 1 or receipt["formula"] != args.formula or receipt["arch"] != args.arch:
        fail("Kandelo Node execution receipt identity does not match")
    if receipt["kandelo_abi"] != args.abi or receipt["runtime"] != "node" or receipt["status"] != "success":
        fail("Kandelo Node execution receipt does not prove ABI-current Node success")
    launcher = require_string(receipt["launcher"], "Node execution launcher")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", launcher):
        fail("Node execution launcher is invalid")
    argv = receipt["argv"]
    if not isinstance(argv, list) or not argv or len(argv) > 256:
        fail("Node execution argv must contain 1-256 entries")
    for index, value in enumerate(argv):
        value = require_string(value, f"Node execution argv[{index}]")
        if len(value.encode("utf-8")) > 4_096 or "\0" in value:
            fail(f"Node execution argv[{index}] is invalid")
    return {
        "argv": argv,
        "launcher": launcher,
        "receipt_sha256": sha256_file(path),
        "runtime": "node",
        "status": "success",
    }


def selection_evidence(args: argparse.Namespace) -> dict[str, Any]:
    receipt = exact_keys(
        load_json(pathlib.Path(args.selection_receipt), "selected bottle receipt"),
        {"bottle", "fetch", "schema", "status"},
        "selected bottle receipt",
    )
    if receipt["schema"] != 1 or receipt["status"] != "success":
        fail("selected bottle receipt does not prove successful selection")
    bottle = exact_keys(
        receipt["bottle"], {"bytes", "mode", "sha256", "url"}, "selected bottle identity"
    )
    if bottle["mode"] not in ("anonymous-public-readback", "local-dry-run"):
        fail("selected bottle receipt has an invalid selection mode")
    if bottle["url"] != args.bottle_url or bottle["sha256"] != args.bottle_sha256 or bottle["bytes"] != args.bottle_bytes:
        fail("selected bottle receipt does not identify the exact bottle bytes")
    fetch = receipt["fetch"]
    if not isinstance(fetch, list) or len(fetch) != 1:
        fail("selected bottle receipt must contain exactly one bounded fetch record")
    line = require_string(fetch[0], "selected bottle fetch record")
    if len(line.encode("utf-8")) > MAX_EVIDENCE_LINE_BYTES:
        fail("selected bottle fetch record exceeds its byte limit")
    if bottle["mode"] == "anonymous-public-readback":
        if args.bottle_url not in line or args.bottle_sha256 not in line:
            fail("anonymous bottle fetch record lacks the exact URL and digest")
    elif args.bottle_sha256 not in line:
        fail("dry-run bottle selection record lacks the exact digest")
    return receipt


def build_document(args: argparse.Namespace) -> dict[str, Any]:
    validate_arguments(args)
    version, tag_name = canonical_bottle(args)
    validate_formula_info(args, version, tag_name)
    dependencies = validate_dependency_provenance(args)
    selection = selection_evidence(args)
    return {
        "abi": args.abi,
        "arch": args.arch,
        "bottle": {
            "bytes": args.bottle_bytes,
            "sha256": args.bottle_sha256,
            "tag": tag_name,
            "url": args.bottle_url,
            "version": version,
        },
        "dependencies": dependencies,
        "formula": args.formula,
        "node": node_evidence(args),
        "schema": 2,
        "selection": selection,
        "tap": {
            "commit": args.tap_commit,
            "name": normalized_tap_name(args),
            "repository": args.tap_repository,
        },
        "target": {
            "install_log": target_install_evidence(args, tag_name, selection),
            "receipt": target_receipt(args, version),
        },
    }


def validate_document(document: Any, args: argparse.Namespace) -> None:
    validate_arguments(args)
    root = exact_keys(
        document,
        {"abi", "arch", "bottle", "dependencies", "formula", "node", "schema", "selection", "tap", "target"},
        "runtime evidence",
    )
    if root["schema"] != 2 or root["formula"] != args.formula or root["arch"] != args.arch:
        fail("runtime evidence Formula identity does not match")
    if root["abi"] != args.abi:
        fail("runtime evidence ABI does not match")
    tap = exact_keys(root["tap"], {"commit", "name", "repository"}, "runtime evidence tap")
    if tap != {
        "commit": args.tap_commit,
        "name": normalized_tap_name(args),
        "repository": args.tap_repository,
    }:
        fail("runtime evidence tap identity does not match")
    version, tag_name = canonical_bottle(args)
    bottle = exact_keys(
        root["bottle"], {"bytes", "sha256", "tag", "url", "version"}, "runtime evidence bottle"
    )
    if bottle != {
        "bytes": args.bottle_bytes,
        "sha256": args.bottle_sha256,
        "tag": tag_name,
        "url": args.bottle_url,
        "version": version,
    }:
        fail("runtime evidence bottle identity does not match")
    expected_dependencies = validate_dependency_provenance(args)
    if root["dependencies"] != expected_dependencies:
        fail("runtime evidence dependency closure does not match")
    selection = exact_keys(
        root["selection"], {"bottle", "fetch", "schema", "status"}, "runtime selection evidence"
    )
    if selection["schema"] != 1 or selection["status"] != "success":
        fail("runtime selection evidence is not successful")
    selected_bottle = exact_keys(
        selection["bottle"], {"bytes", "mode", "sha256", "url"}, "runtime selected bottle"
    )
    if selected_bottle not in (
        {
            "bytes": args.bottle_bytes,
            "mode": "anonymous-public-readback",
            "sha256": args.bottle_sha256,
            "url": args.bottle_url,
        },
        {
            "bytes": args.bottle_bytes,
            "mode": "local-dry-run",
            "sha256": args.bottle_sha256,
            "url": args.bottle_url,
        },
    ):
        fail("runtime selected bottle identity does not match")
    fetch = selection["fetch"]
    if not isinstance(fetch, list) or len(fetch) != 1:
        fail("runtime selection evidence lacks a bounded fetch record")
    fetch_line = require_string(fetch[0], "runtime selection fetch record")
    if len(fetch_line.encode("utf-8")) > MAX_EVIDENCE_LINE_BYTES:
        fail("runtime selection fetch record exceeds its byte limit")
    if selected_bottle["mode"] == "anonymous-public-readback":
        if args.bottle_url not in fetch_line or args.bottle_sha256 not in fetch_line:
            fail("runtime anonymous fetch record lacks the exact URL and digest")
    elif args.bottle_sha256 not in fetch_line:
        fail("runtime dry-run selection record lacks the exact digest")
    node = exact_keys(
        root["node"], {"argv", "launcher", "receipt_sha256", "runtime", "status"}, "runtime Node evidence"
    )
    if node["runtime"] != "node" or node["status"] != "success":
        fail("runtime evidence does not prove Node success")
    require_string(node["receipt_sha256"], "runtime Node receipt sha256", SHA256)
    launcher = require_string(node["launcher"], "runtime Node launcher")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", launcher):
        fail("runtime Node launcher is invalid")
    if not isinstance(node["argv"], list) or not 1 <= len(node["argv"]) <= 256:
        fail("runtime Node evidence must contain 1-256 argv entries")
    for index, value in enumerate(node["argv"]):
        value = require_string(value, f"runtime Node argv[{index}]")
        if len(value.encode("utf-8")) > 4_096:
            fail(f"runtime Node argv[{index}] exceeds its byte limit")
    target = exact_keys(root["target"], {"install_log", "receipt"}, "runtime target evidence")
    install_log = exact_keys(
        target["install_log"], {"fetch", "pour", "source_build_absent"}, "runtime target install log"
    )
    if install_log["source_build_absent"] is not True:
        fail("runtime target evidence permits a source fallback")
    pour = install_log["pour"]
    if not isinstance(pour, list) or not pour or len(pour) > MAX_EVIDENCE_LINES:
        fail("runtime target evidence lacks bounded pour evidence")
    marker = f".{tag_name}.bottle.tar."
    for index, line in enumerate(pour):
        line = require_string(line, f"runtime target pour[{index}]")
        if len(line.encode("utf-8")) > MAX_EVIDENCE_LINE_BYTES:
            fail(f"runtime target pour[{index}] exceeds its byte limit")
        if args.formula not in line.lower() or marker not in line.lower():
            fail("runtime target pour evidence does not identify the exact bottle tag")
    target_fetch = install_log["fetch"]
    if not isinstance(target_fetch, list) or not target_fetch or len(target_fetch) > MAX_EVIDENCE_LINES:
        fail("runtime target evidence lacks bounded fetch evidence")
    for index, line in enumerate(target_fetch):
        line = require_string(line, f"runtime target fetch[{index}]")
        if len(line.encode("utf-8")) > MAX_EVIDENCE_LINE_BYTES:
            fail(f"runtime target fetch[{index}] exceeds its byte limit")
        if selected_bottle["mode"] == "anonymous-public-readback":
            if args.bottle_url.lower() not in line.lower():
                fail("runtime target fetch evidence lacks the exact public bottle URL")
        elif args.bottle_sha256 not in line:
            fail("runtime dry-run target selection lacks the exact digest")
    receipt = exact_keys(
        target["receipt"],
        {
            "built_as_bottle",
            "homebrew_version",
            "installed_on_request",
            "path",
            "poured_from_bottle",
            "sha256",
            "source_tap",
            "source_tap_git_head",
        },
        "runtime target receipt",
    )
    if receipt["built_as_bottle"] is not True or receipt["poured_from_bottle"] is not True:
        fail("runtime target receipt does not prove a bottle pour")
    if receipt["installed_on_request"] is not True:
        fail("runtime target receipt is not an explicit target install")
    if receipt["path"] != f"Cellar/{args.formula}/{version}/INSTALL_RECEIPT.json":
        fail("runtime target receipt path does not match")
    if receipt["source_tap"] != normalized_tap_name(args) or receipt["source_tap_git_head"] != args.tap_commit:
        fail("runtime target receipt source does not match")
    require_string(receipt["sha256"], "runtime target receipt sha256", SHA256)
    homebrew_version = require_string(
        receipt["homebrew_version"], "runtime target Homebrew version"
    )
    if len(homebrew_version.encode("utf-8")) > 256:
        fail("runtime target Homebrew version exceeds its byte limit")


def write_json(path: pathlib.Path, document: Any) -> None:
    payload = json.dumps(document, indent=2, sort_keys=True) + "\n"
    if len(payload.encode("utf-8")) > MAX_JSON_BYTES:
        fail(f"runtime evidence exceeds {MAX_JSON_BYTES} bytes")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        fail(f"refusing to replace symlink output: {path}")
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(payload, encoding="utf-8")
    os.replace(temporary, path)


def capture(args: argparse.Namespace) -> None:
    document = build_document(args)
    validate_document(document, args)
    write_json(pathlib.Path(args.out), document)


def validate(args: argparse.Namespace) -> None:
    document = load_json(pathlib.Path(args.input), "runtime evidence")
    validate_document(document, args)


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--formula", required=True)
    parser.add_argument("--arch", required=True)
    parser.add_argument("--abi", type=int, required=True)
    parser.add_argument("--tap-repository", required=True)
    parser.add_argument("--tap-name")
    parser.add_argument("--tap-commit", required=True)
    parser.add_argument("--tap-root", required=True)
    parser.add_argument("--bottle-root-url", required=True)
    parser.add_argument("--bottle-json", required=True)
    parser.add_argument("--bottle-url", required=True)
    parser.add_argument("--bottle-sha256", required=True)
    parser.add_argument("--bottle-bytes", type=int, required=True)
    parser.add_argument("--dependency-provenance", required=True)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)
    capture_parser = subparsers.add_parser("capture")
    add_common(capture_parser)
    capture_parser.add_argument("--target-prefix", required=True)
    capture_parser.add_argument("--target-receipt", required=True)
    capture_parser.add_argument("--formula-info", required=True)
    capture_parser.add_argument("--install-log", required=True)
    capture_parser.add_argument("--node-receipt", required=True)
    capture_parser.add_argument("--installed-bottle", required=True)
    capture_parser.add_argument("--selection-receipt", required=True)
    capture_parser.add_argument("--out", required=True)
    capture_parser.set_defaults(handler=capture)
    validate_parser = subparsers.add_parser("validate")
    add_common(validate_parser)
    validate_parser.add_argument("--input", required=True)
    validate_parser.set_defaults(handler=validate)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except EvidenceError as error:
        print(f"homebrew-bottle-runtime-evidence.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
