#!/usr/bin/env python3
"""Capture and validate bounded evidence for same-tap Homebrew dependency pours."""

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
MAX_DEPENDENCY_LIST_BYTES = 65_536
MAX_DEPENDENCIES = 128
MAX_EVIDENCE_LINES = 16
MAX_EVIDENCE_LINE_BYTES = 1_024
FORMULA_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
PKG_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
TAP_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SOURCE_BUILD = re.compile(r"\b(?:building|built)\b.*\bfrom source\b", re.IGNORECASE)


class ProvenanceError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ProvenanceError(message)


def require_string(value: Any, label: str, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a non-empty string")
    if pattern is not None and pattern.fullmatch(value) is None:
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


def run_brew(brew_bin: pathlib.Path, *arguments: str) -> str:
    try:
        result = subprocess.run(
            [str(brew_bin), *arguments],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        fail(f"brew {' '.join(arguments)} timed out")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[:2_048]
        fail(f"brew {' '.join(arguments)} failed ({result.returncode}): {stderr}")
    if len(result.stdout) > MAX_JSON_BYTES:
        fail(f"brew {' '.join(arguments)} output exceeds {MAX_JSON_BYTES} bytes")
    try:
        return result.stdout.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"brew {' '.join(arguments)} output is not UTF-8: {error}")


def normalized_tap_name(name: str) -> str:
    require_string(name, "tap name", TAP_REPOSITORY)
    owner, name = name.lower().split("/", 1)
    return f"{owner}/{name}"


def selected_tap_name(args: argparse.Namespace) -> str:
    repository = normalized_tap_name(args.tap_repository)
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
    selected = normalized_tap_name(requested)
    if selected != expected:
        fail("tap name does not match the tap repository")
    return selected


def parse_expected_dependencies(contents: str, label: str, normalized_tap: str) -> set[str]:
    expected: set[str] = set()
    prefix = f"{normalized_tap}/"
    for index, raw in enumerate(contents.splitlines()):
        full_name = raw.strip()
        if not full_name:
            continue
        if full_name != full_name.lower() or not full_name.startswith(prefix):
            fail(f"{label} line {index + 1} is not from the selected tap")
        name = full_name.removeprefix(prefix)
        require_string(name, f"{label} line {index + 1}", FORMULA_NAME)
        if full_name in expected:
            fail(f"duplicate {label} entry: {full_name}")
        expected.add(full_name)
    if len(expected) > MAX_DEPENDENCIES:
        fail(f"{label} exceeds {MAX_DEPENDENCIES} entries")
    return expected


def expected_dependencies(path: pathlib.Path, normalized_tap: str) -> set[str]:
    regular_file(path, "expected dependency list", MAX_DEPENDENCY_LIST_BYTES)
    try:
        contents = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        fail(f"expected dependency list is not UTF-8: {error}")
    return parse_expected_dependencies(contents, "expected dependency", normalized_tap)


def exact_tap_dependencies(
    tap_root: pathlib.Path, tap_name: str, formula: str, arch: str, bottle_root_url: str
) -> dict[str, dict[str, Any]]:
    resolver = pathlib.Path(__file__).with_name("homebrew-formula-runtime-closure.rb")
    regular_file(resolver, "static Formula dependency resolver", MAX_JSON_BYTES)
    try:
        result = subprocess.run(
            ["ruby", str(resolver), str(tap_root), tap_name, formula, arch],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        fail(f"static Formula dependency resolution failed: {error}")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[:4_096]
        fail(f"static Formula dependency resolution failed ({result.returncode}): {stderr}")
    if len(result.stdout) > MAX_JSON_BYTES:
        fail("static Formula dependency metadata exceeds its byte limit")
    try:
        document = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"static Formula dependency metadata is not UTF-8 JSON: {error}")
    if not isinstance(document, dict) or len(document) > MAX_DEPENDENCIES:
        fail(f"static Formula dependency metadata must contain at most {MAX_DEPENDENCIES} entries")

    normalized_tap = normalized_tap_name(tap_name)
    expected_tag = f"{arch}_kandelo"
    dependencies: dict[str, dict[str, Any]] = {}
    prior_full_name = ""
    for full_name, raw_bottle in document.items():
        require_string(full_name, "static dependency full name")
        names = parse_expected_dependencies(full_name, "static dependency", normalized_tap)
        if len(names) != 1 or full_name <= prior_full_name:
            fail("static Formula dependency metadata must be uniquely sorted by full name")
        prior_full_name = full_name
        name = full_name.removeprefix(f"{normalized_tap}/")
        bottle = exact_keys(
            raw_bottle,
            {"cellar", "rebuild", "sha256", "tag", "url"},
            f"static dependency {full_name} bottle",
        )
        bottle_sha = require_string(
            bottle["sha256"], f"static dependency {full_name} bottle sha256", SHA256
        )
        if bottle["tag"] != expected_tag:
            fail(f"static dependency {full_name} bottle tag does not match {expected_tag}")
        if bottle["url"] != f"{bottle_root_url}/{name}/blobs/sha256:{bottle_sha}":
            fail(f"static dependency {full_name} bottle URL does not match the selected root")
        if bottle["cellar"] not in (
            "any",
            "any_skip_relocation",
            "/home/linuxbrew/.linuxbrew/Cellar",
        ):
            fail(f"static dependency {full_name} bottle cellar is invalid")
        if (
            not isinstance(bottle["rebuild"], int)
            or isinstance(bottle["rebuild"], bool)
            or bottle["rebuild"] < 0
        ):
            fail(f"static dependency {full_name} bottle rebuild is invalid")
        dependencies[full_name] = bottle
    return dependencies


def exact_direct_dependencies(
    tap_root: pathlib.Path, tap_name: str, formula: str
) -> set[str]:
    resolver = pathlib.Path(__file__).with_name("homebrew-formula-runtime-closure.rb")
    regular_file(resolver, "static Formula dependency resolver", MAX_JSON_BYTES)
    try:
        result = subprocess.run(
            ["ruby", str(resolver), str(tap_root), tap_name, formula, "--direct"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        fail(f"static direct Formula dependency resolution failed: {error}")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[:4_096]
        fail(
            "static direct Formula dependency resolution failed "
            f"({result.returncode}): {stderr}"
        )
    if len(result.stdout) > MAX_DEPENDENCY_LIST_BYTES:
        fail("static direct Formula dependency list exceeds its byte limit")
    try:
        contents = result.stdout.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"static direct Formula dependency list is not UTF-8: {error}")
    return parse_expected_dependencies(
        contents, "static direct dependency", normalized_tap_name(tap_name)
    )


def read_log_lines(path: pathlib.Path) -> list[str]:
    regular_file(path, "Homebrew install log", MAX_LOG_BYTES)
    data = path.read_bytes().decode("utf-8", errors="replace")
    normalized = ANSI_ESCAPE.sub("", data).replace("\r", "\n")
    lines: list[str] = []
    for raw in normalized.splitlines():
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


def selected_evidence(
    lines: list[str], dependency: str, tag: str, bottle_url: str, bottle_sha: str
) -> tuple[list[str], list[str]]:
    filename_marker = f".{tag}.bottle.tar."
    dependency_url = f"/{dependency}/blobs/sha256:{bottle_sha}"
    fetch: list[str] = []
    pour: list[str] = []
    source_build: list[str] = []
    for line in lines:
        lowered = line.lower()
        mentions_dependency = (
            dependency.lower() in lowered
            or dependency_url in lowered
            or bottle_url.lower() in lowered
        )
        if mentions_dependency and SOURCE_BUILD.search(line):
            source_build.append(line)
        if bottle_url.lower() in lowered and re.search(
            r"\b(?:downloading|downloaded|fetching)\b", line, re.I
        ):
            fetch.append(line)
        if (
            "pouring" in lowered
            and dependency.lower() in lowered
            and filename_marker in lowered
        ):
            pour.append(line)
    if source_build:
        fail(f"dependency {dependency} was reported as built from source: {source_build[0]}")
    if not fetch:
        fail(f"dependency {dependency} lacks bounded fetch evidence for {bottle_sha}")
    if not pour:
        fail(f"dependency {dependency} lacks pour evidence for tag {tag}")
    return fetch[:MAX_EVIDENCE_LINES], pour[:MAX_EVIDENCE_LINES]


def formula_record(info: Any, expected_full_name: str, expected_name: str) -> dict[str, Any]:
    if not isinstance(info, dict) or sorted(info.keys()) != ["casks", "formulae"]:
        fail(f"brew info for {expected_full_name} has an unexpected top-level shape")
    formulae = info.get("formulae")
    if info.get("casks") != [] or not isinstance(formulae, list) or len(formulae) != 1:
        fail(f"brew info for {expected_full_name} must contain exactly one formula")
    record = formulae[0]
    if not isinstance(record, dict):
        fail(f"brew info for {expected_full_name} formula record must be an object")
    if record.get("name") != expected_name:
        fail(f"brew info name does not match {expected_name}")
    if str(record.get("full_name", "")).lower() != expected_full_name:
        fail(f"brew info full_name does not match {expected_full_name}")
    return record


def capture(args: argparse.Namespace) -> None:
    repository = args.tap_repository
    require_string(repository, "tap repository", TAP_REPOSITORY)
    normalized_tap = selected_tap_name(args)
    require_string(args.tap_commit, "tap commit", COMMIT)
    require_string(args.formula, "formula", FORMULA_NAME)
    if args.arch not in ("wasm32", "wasm64"):
        fail(f"unsupported architecture: {args.arch}")
    if not re.fullmatch(r"https://[^\s]+", args.bottle_root_url) or args.bottle_root_url.endswith("/"):
        fail(f"invalid bottle root URL: {args.bottle_root_url}")

    brew_input = pathlib.Path(args.brew_bin)
    brew_bin = pathlib.Path(os.path.abspath(brew_input))
    brew_target = brew_bin.resolve()
    if not brew_target.is_file():
        fail(f"brew executable does not resolve to a regular file: {brew_input}")
    if not os.access(brew_target, os.X_OK):
        fail(f"brew executable is not executable: {brew_target}")
    tap_root = pathlib.Path(args.tap_root).resolve()
    if not tap_root.is_dir() or pathlib.Path(args.tap_root).is_symlink():
        fail(f"tap root must be a real directory: {args.tap_root}")
    target_receipt_path = pathlib.Path(args.target_receipt)
    target_receipt = load_json(target_receipt_path, "target INSTALL_RECEIPT.json")
    if not isinstance(target_receipt, dict):
        fail("target INSTALL_RECEIPT.json must be an object")
    runtime_dependencies = target_receipt.get("runtime_dependencies")
    if not isinstance(runtime_dependencies, list):
        fail("target receipt runtime_dependencies must be an array")
    if len(runtime_dependencies) > MAX_DEPENDENCIES * 4:
        fail("target receipt has an unreasonable dependency count")
    log_lines = read_log_lines(pathlib.Path(args.install_log))
    bottle_tag = f"{args.arch}_kandelo"
    expected = expected_dependencies(pathlib.Path(args.expected_dependencies), normalized_tap)

    selected: dict[str, dict[str, Any]] = {}
    prefix = f"{normalized_tap}/"
    for index, dependency in enumerate(runtime_dependencies):
        if not isinstance(dependency, dict):
            fail(f"runtime_dependencies[{index}] must be an object")
        full_name = require_string(
            dependency.get("full_name"), f"runtime_dependencies[{index}].full_name"
        ).lower()
        if not full_name.startswith(prefix):
            continue
        name = full_name.removeprefix(prefix)
        require_string(name, f"runtime dependency name {name!r}", FORMULA_NAME)
        if full_name in selected:
            fail(f"duplicate same-tap runtime dependency: {full_name}")
        declared_directly = require_bool(
            dependency.get("declared_directly"),
            f"runtime dependency {full_name} declared_directly",
        )
        version = dependency.get("pkg_version") or dependency.get("version")
        version = require_string(version, f"runtime dependency {full_name} version", PKG_VERSION)

        cellar_output = run_brew(brew_bin, "--cellar", full_name).strip()
        if not cellar_output.startswith("/") or "\n" in cellar_output:
            fail(f"brew --cellar returned an invalid path for {full_name}: {cellar_output!r}")
        cellar = pathlib.Path(cellar_output).resolve()
        receipt_path = cellar / version / "INSTALL_RECEIPT.json"
        receipt = load_json(receipt_path, f"{full_name} INSTALL_RECEIPT.json")
        if not isinstance(receipt, dict):
            fail(f"{full_name} INSTALL_RECEIPT.json must be an object")
        if receipt.get("built_as_bottle") is not True:
            fail(f"dependency {full_name} was not built as a bottle")
        if receipt.get("poured_from_bottle") is not True:
            fail(f"dependency {full_name} was not poured from a bottle")
        if receipt.get("installed_on_request") is not False:
            fail(f"dependency {full_name} was not installed as a dependency")
        source = receipt.get("source")
        if not isinstance(source, dict):
            fail(f"dependency {full_name} receipt source must be an object")
        if str(source.get("tap", "")).lower() != normalized_tap:
            fail(f"dependency {full_name} receipt came from a different tap")
        if source.get("tap_git_head") != args.tap_commit:
            fail(f"dependency {full_name} receipt is not bound to tap commit {args.tap_commit}")
        homebrew_version = require_string(
            receipt.get("homebrew_version"), f"dependency {full_name} Homebrew version"
        )
        if len(homebrew_version.encode("utf-8")) > 256:
            fail(f"dependency {full_name} Homebrew version is too long")

        formula_path = tap_root / "Formula" / f"{name}.rb"
        regular_file(formula_path, f"dependency {full_name} Formula", MAX_JSON_BYTES)
        formula_sha = sha256_file(formula_path)
        try:
            info = json.loads(run_brew(brew_bin, "info", "--json=v2", full_name))
        except json.JSONDecodeError as error:
            fail(f"brew info for {full_name} is invalid JSON: {error}")
        record = formula_record(info, full_name, name)
        source_checksum = record.get("ruby_source_checksum")
        if not isinstance(source_checksum, dict) or source_checksum.get("sha256") != formula_sha:
            fail(f"dependency {full_name} brew info Formula digest is not the exact tap source")
        bottle = record.get("bottle")
        stable = bottle.get("stable") if isinstance(bottle, dict) else None
        files = stable.get("files") if isinstance(stable, dict) else None
        tag = files.get(bottle_tag) if isinstance(files, dict) else None
        if not isinstance(tag, dict):
            fail(f"dependency {full_name} has no {bottle_tag} bottle")
        bottle_sha = require_string(tag.get("sha256"), f"dependency {full_name} bottle sha256", SHA256)
        bottle_url = require_string(tag.get("url"), f"dependency {full_name} bottle URL")
        expected_url = f"{args.bottle_root_url}/{name}/blobs/sha256:{bottle_sha}"
        if bottle_url != expected_url:
            fail(f"dependency {full_name} bottle URL does not match {expected_url}")
        bottle_cellar = require_string(tag.get("cellar"), f"dependency {full_name} bottle cellar")
        if bottle_cellar not in ("any", "any_skip_relocation", "/home/linuxbrew/.linuxbrew/Cellar"):
            fail(f"dependency {full_name} has unsupported bottle cellar {bottle_cellar}")
        rebuild = stable.get("rebuild")
        if not isinstance(rebuild, int) or isinstance(rebuild, bool) or rebuild < 0:
            fail(f"dependency {full_name} bottle rebuild must be a non-negative integer")
        fetch_lines, pour_lines = selected_evidence(
            log_lines, name, bottle_tag, bottle_url, bottle_sha
        )
        relative_receipt = f"Cellar/{name}/{version}/INSTALL_RECEIPT.json"
        selected[full_name] = {
            "bottle": {
                "cellar": bottle_cellar,
                "rebuild": rebuild,
                "sha256": bottle_sha,
                "tag": bottle_tag,
                "url": bottle_url,
            },
            "declared_directly": declared_directly,
            "formula": {
                "path": f"Formula/{name}.rb",
                "sha256": formula_sha,
            },
            "full_name": full_name,
            "install_log": {
                "fetch": fetch_lines,
                "pour": pour_lines,
                "source_build_absent": True,
            },
            "name": name,
            "receipt": {
                "built_as_bottle": True,
                "homebrew_version": homebrew_version,
                "installed_on_request": False,
                "path": relative_receipt,
                "poured_from_bottle": True,
                "sha256": sha256_file(receipt_path),
                "source_tap": normalized_tap,
                "source_tap_git_head": args.tap_commit,
            },
            "version": version,
        }

    if set(selected) != expected:
        missing = sorted(expected - set(selected))
        unexpected = sorted(set(selected) - expected)
        fail(
            "target receipt does not match the resolved same-tap dependency closure "
            f"(missing={missing}, unexpected={unexpected})"
        )

    output = {
        "arch": args.arch,
        "bottle_root_url": args.bottle_root_url,
        "bottle_tag": bottle_tag,
        "dependencies": [selected[name] for name in sorted(selected)],
        "formula": args.formula,
        "schema": 2,
        "tap_commit": args.tap_commit,
        "tap_name": normalized_tap,
        "tap_repository": repository,
    }
    validate_document(output, args)
    output_path = pathlib.Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.is_symlink():
        fail(f"refusing to replace symlink output: {output_path}")
    temporary = output_path.with_name(f".{output_path.name}.tmp-{os.getpid()}")
    payload = json.dumps(output, indent=2, sort_keys=True) + "\n"
    if len(payload.encode("utf-8")) > MAX_JSON_BYTES:
        fail(f"dependency provenance exceeds {MAX_JSON_BYTES} bytes")
    temporary.write_text(payload, encoding="utf-8")
    os.replace(temporary, output_path)


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def validate_evidence(lines: Any, label: str, dependency: str, marker: str) -> None:
    if not isinstance(lines, list) or not lines or len(lines) > MAX_EVIDENCE_LINES:
        fail(f"{label} must contain 1-{MAX_EVIDENCE_LINES} lines")
    for index, line in enumerate(lines):
        line = require_string(line, f"{label}[{index}]")
        if len(line.encode("utf-8")) > MAX_EVIDENCE_LINE_BYTES:
            fail(f"{label}[{index}] exceeds {MAX_EVIDENCE_LINE_BYTES} bytes")
        if any(ord(character) < 0x20 and character != "\t" for character in line):
            fail(f"{label}[{index}] contains a control character")
        if dependency not in line.lower() or marker not in line.lower():
            fail(f"{label}[{index}] does not identify {dependency} and {marker}")


def validate_document(document: Any, args: argparse.Namespace) -> None:
    root = exact_keys(
        document,
        {
            "arch",
            "bottle_root_url",
            "bottle_tag",
            "dependencies",
            "formula",
            "schema",
            "tap_commit",
            "tap_name",
            "tap_repository",
        },
        "dependency provenance",
    )
    if root["schema"] != 2:
        fail("dependency provenance schema must be 2")
    if root["formula"] != args.formula or root["arch"] != args.arch:
        fail("dependency provenance formula or architecture does not match the build")
    normalized_tap = selected_tap_name(args)
    if (
        root["tap_repository"] != args.tap_repository
        or root["tap_name"] != normalized_tap
        or root["tap_commit"] != args.tap_commit
    ):
        fail("dependency provenance tap identity does not match the build")
    if root["bottle_root_url"] != args.bottle_root_url:
        fail("dependency provenance bottle root does not match the build")
    expected_tag = f"{args.arch}_kandelo"
    if root["bottle_tag"] != expected_tag:
        fail("dependency provenance bottle tag does not match the architecture")
    dependencies = root["dependencies"]
    if not isinstance(dependencies, list) or len(dependencies) > MAX_DEPENDENCIES:
        fail(f"dependency provenance must contain at most {MAX_DEPENDENCIES} dependencies")
    seen: set[str] = set()
    prior_full_name = ""
    validation_tap_root = getattr(args, "tap_root", None)
    static_dependencies = None
    static_direct_dependencies = None
    if validation_tap_root:
        static_dependencies = exact_tap_dependencies(
            pathlib.Path(validation_tap_root),
            normalized_tap,
            args.formula,
            args.arch,
            args.bottle_root_url,
        )
        static_direct_dependencies = exact_direct_dependencies(
            pathlib.Path(validation_tap_root),
            normalized_tap,
            args.formula,
        )
    for index, dependency in enumerate(dependencies):
        dependency = exact_keys(
            dependency,
            {
                "bottle",
                "declared_directly",
                "formula",
                "full_name",
                "install_log",
                "name",
                "receipt",
                "version",
            },
            f"dependencies[{index}]",
        )
        name = require_string(dependency["name"], f"dependencies[{index}].name", FORMULA_NAME)
        full_name = require_string(dependency["full_name"], f"dependencies[{index}].full_name")
        if full_name != f"{normalized_tap}/{name}":
            fail(f"dependencies[{index}] is not from the selected tap")
        if full_name in seen or full_name <= prior_full_name:
            fail("dependency provenance must be uniquely sorted by full_name")
        seen.add(full_name)
        prior_full_name = full_name
        declared_directly = require_bool(
            dependency["declared_directly"], f"dependencies[{index}].declared_directly"
        )
        if static_direct_dependencies is not None and declared_directly != (
            full_name in static_direct_dependencies
        ):
            fail(
                f"dependencies[{index}].declared_directly differs from the exact Formula"
            )
        version = require_string(dependency["version"], f"dependencies[{index}].version", PKG_VERSION)
        formula = exact_keys(dependency["formula"], {"path", "sha256"}, f"dependencies[{index}].formula")
        if formula["path"] != f"Formula/{name}.rb":
            fail(f"dependencies[{index}] Formula path is not canonical")
        require_string(formula["sha256"], f"dependencies[{index}].formula.sha256", SHA256)
        bottle = exact_keys(
            dependency["bottle"],
            {"cellar", "rebuild", "sha256", "tag", "url"},
            f"dependencies[{index}].bottle",
        )
        bottle_sha = require_string(bottle["sha256"], f"dependencies[{index}].bottle.sha256", SHA256)
        if bottle["tag"] != expected_tag:
            fail(f"dependencies[{index}] bottle tag does not match")
        if bottle["url"] != f"{args.bottle_root_url}/{name}/blobs/sha256:{bottle_sha}":
            fail(f"dependencies[{index}] bottle URL is not digest-bound")
        if bottle["cellar"] not in ("any", "any_skip_relocation", "/home/linuxbrew/.linuxbrew/Cellar"):
            fail(f"dependencies[{index}] bottle cellar is invalid")
        if not isinstance(bottle["rebuild"], int) or isinstance(bottle["rebuild"], bool) or bottle["rebuild"] < 0:
            fail(f"dependencies[{index}] bottle rebuild is invalid")
        if static_dependencies is not None and static_dependencies.get(full_name) != bottle:
            fail(f"dependencies[{index}] bottle metadata differs from the exact tap")
        receipt = exact_keys(
            dependency["receipt"],
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
            f"dependencies[{index}].receipt",
        )
        if receipt["built_as_bottle"] is not True or receipt["poured_from_bottle"] is not True:
            fail(f"dependencies[{index}] receipt does not prove a bottle pour")
        if receipt["installed_on_request"] is not False:
            fail(f"dependencies[{index}] receipt was not installed as a dependency")
        if receipt["path"] != f"Cellar/{name}/{version}/INSTALL_RECEIPT.json":
            fail(f"dependencies[{index}] receipt path is not canonical")
        require_string(receipt["sha256"], f"dependencies[{index}].receipt.sha256", SHA256)
        require_string(receipt["homebrew_version"], f"dependencies[{index}].receipt.homebrew_version")
        if receipt["source_tap"] != normalized_tap or receipt["source_tap_git_head"] != args.tap_commit:
            fail(f"dependencies[{index}] receipt source is not the exact selected tap")
        install_log = exact_keys(
            dependency["install_log"],
            {"fetch", "pour", "source_build_absent"},
            f"dependencies[{index}].install_log",
        )
        if install_log["source_build_absent"] is not True:
            fail(f"dependencies[{index}] lacks a no-source-build assertion")
        validate_evidence(
            install_log["fetch"],
            f"dependencies[{index}].install_log.fetch",
            name,
            bottle_sha,
        )
        validate_evidence(
            install_log["pour"],
            f"dependencies[{index}].install_log.pour",
            name,
            expected_tag,
        )
        if validation_tap_root:
            formula_path = pathlib.Path(validation_tap_root) / "Formula" / f"{name}.rb"
            regular_file(formula_path, f"dependencies[{index}] exact Formula", MAX_JSON_BYTES)
            if sha256_file(formula_path) != formula["sha256"]:
                fail(f"dependencies[{index}] Formula digest differs from the exact tap")

    if static_dependencies is not None:
        static_names = set(static_dependencies)
        if seen != static_names:
            missing = sorted(static_names - seen)
            unexpected = sorted(seen - static_names)
            fail(
                "dependency provenance does not match the exact tap's static runtime closure "
                f"(missing={missing}, unexpected={unexpected})"
            )


def validate(args: argparse.Namespace) -> None:
    require_string(args.tap_commit, "tap commit", COMMIT)
    require_string(args.formula, "formula", FORMULA_NAME)
    document = load_json(pathlib.Path(args.input), "dependency provenance")
    validate_document(document, args)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--formula", required=True)
    common.add_argument("--arch", required=True)
    common.add_argument("--tap-repository", required=True)
    common.add_argument("--tap-name")
    common.add_argument("--tap-commit", required=True)
    common.add_argument("--bottle-root-url", required=True)

    capture_parser = subparsers.add_parser("capture", parents=[common])
    capture_parser.add_argument("--brew-bin", required=True)
    capture_parser.add_argument("--tap-root", required=True)
    capture_parser.add_argument("--target-receipt", required=True)
    capture_parser.add_argument("--expected-dependencies", required=True)
    capture_parser.add_argument("--install-log", required=True)
    capture_parser.add_argument("--out", required=True)
    capture_parser.set_defaults(handler=capture)

    validate_parser = subparsers.add_parser("validate", parents=[common])
    validate_parser.add_argument("--input", required=True)
    validate_parser.add_argument("--tap-root")
    validate_parser.set_defaults(handler=validate)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except ProvenanceError as error:
        print(f"homebrew-dependency-provenance.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
