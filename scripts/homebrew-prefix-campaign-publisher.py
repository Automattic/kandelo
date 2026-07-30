#!/usr/bin/env python3
"""Prepare one reusable publisher checkout for a sealed prefix campaign."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
CAMPAIGN_TOOL = ROOT / "scripts/homebrew-prefix-campaign.py"
EXECUTOR_TOOL = ROOT / "scripts/homebrew-prefix-campaign-executor.py"
COMMIT = re.compile(r"^[0-9a-f]{40}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
CAMPAIGN_TAG = re.compile(
    r"^homebrew-prefix-campaign-sha256-([0-9a-f]{64})$"
)
HANDOFF_TAG = re.compile(
    r"^homebrew-prefix-handoff-sha256-([0-9a-f]{64})$"
)
MAX_DEPENDENCY_INPUT_BYTES = 65_536
MAX_DEPENDENCIES = 256
FIXED_GIT_DATE = "2000-01-01T00:00:00Z"
GUEST_LAYOUT_PATH = "homebrew/kandelo-guest-layout.json"


class PublisherCampaignError(RuntimeError):
    """A fail-closed publisher campaign preparation error."""


def fail(message: str) -> NoReturn:
    raise PublisherCampaignError(message)


def load_tool(name: str, path: pathlib.Path) -> Any:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        fail(f"cannot load reviewed tool {path}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


CAMPAIGN = load_tool("homebrew_prefix_campaign_publisher_campaign", CAMPAIGN_TOOL)
EXECUTOR = load_tool("homebrew_prefix_campaign_publisher_executor", EXECUTOR_TOOL)


def pretty_json(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def compact_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def git_environment(
    additional: dict[str, str] | None = None,
) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    if additional:
        environment.update(additional)
    return environment


def run_git(
    root: pathlib.Path,
    *arguments: str,
    environment: dict[str, str] | None = None,
) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=git_environment(environment),
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"cannot inspect campaign tap checkout: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[:8_192]
        fail(
            "campaign tap Git command failed: "
            f"git {' '.join(arguments)}: {detail}"
        )
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        fail(f"campaign tap Git output is not UTF-8: {error}")


def real_git_checkout(
    value: pathlib.Path,
    expected_commit: str,
) -> pathlib.Path:
    if value.is_symlink() or not value.is_dir():
        fail("tap checkout must be one real directory")
    root = value.resolve()
    if pathlib.Path(run_git(root, "rev-parse", "--show-toplevel")) != root:
        fail("tap checkout must be the exact Git worktree root")
    git_directory = root / ".git"
    if git_directory.is_symlink() or not git_directory.is_dir():
        fail("tap checkout must own one real .git directory")
    if run_git(root, "rev-parse", "HEAD") != expected_commit:
        fail("tap checkout HEAD differs from the admitted source commit")
    if run_git(root, "status", "--short", "--untracked-files=all"):
        fail("tap checkout must be clean before campaign materialization")
    return root


def parse_dependency_request(
    raw: str,
) -> tuple[tuple[str, str], ...]:
    if (
        not raw
        or "\0" in raw
        or len(raw.encode("utf-8")) > MAX_DEPENDENCY_INPUT_BYTES
    ):
        fail("campaign dependency request is missing or too large")
    try:
        value = json.loads(
            raw,
            object_pairs_hook=EXECUTOR.duplicate_rejecting_object,
            parse_constant=lambda item: fail(
                f"campaign dependency request contains {item}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"campaign dependency request is invalid JSON: {error}")
    if raw != compact_json(value):
        fail("campaign dependency request is not canonical compact JSON")
    value = EXECUTOR.exact_keys(
        value,
        {"dependencies", "schema"},
        "campaign dependency request",
    )
    dependencies = value["dependencies"]
    if (
        value["schema"] != 1
        or not isinstance(dependencies, list)
        or len(dependencies) > MAX_DEPENDENCIES
    ):
        fail("campaign dependency request has an unsupported contract")
    result: list[tuple[str, str]] = []
    prior = ""
    for index, record in enumerate(dependencies):
        record = EXECUTOR.exact_keys(
            record,
            {"formula", "tag"},
            f"campaign dependency request #{index}",
        )
        formula = EXECUTOR.require_string(
            record["formula"],
            f"campaign dependency request #{index} Formula",
            FORMULA,
        )
        tag = EXECUTOR.require_string(
            record["tag"],
            f"campaign dependency request #{index} tag",
            HANDOFF_TAG,
        )
        match = HANDOFF_TAG.fullmatch(tag)
        assert match is not None
        if formula <= prior or set(match.group(1)) == {"0"}:
            fail(
                "campaign dependencies must be unique, sorted, and non-inert"
            )
        prior = formula
        result.append((formula, tag))
    return tuple(result)


def topological_dependencies(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula: str,
) -> tuple[str, ...]:
    tap_name = campaign["authority"]["tap_name"]
    result: list[str] = []
    reached: set[str] = set()
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            fail(f"campaign dependency graph cycles at {name}")
        if name in reached:
            return
        visiting.add(name)
        for dependency in EXECUTOR.dependency_names(
            index[name], tap_name
        ):
            visit(dependency)
        visiting.remove(name)
        reached.add(name)
        result.append(name)

    for dependency in EXECUTOR.dependency_names(
        index[formula], tap_name
    ):
        visit(dependency)
    return tuple(result)


def validate_campaign_authority(
    campaign: dict[str, Any],
    *,
    kandelo_commit: str,
    tap_repository: str,
    tap_name: str,
    source_tap_commit: str,
    source_materialization: dict[str, Any],
) -> None:
    authority = campaign["authority"]
    expected = {
        "kandelo_commit": kandelo_commit,
        "source_tap_commit": source_tap_commit,
        "tap_name": tap_name.lower(),
        "tap_repository": tap_repository.lower(),
    }
    for key, value in expected.items():
        actual = authority.get(key)
        if isinstance(actual, str):
            actual = actual.lower() if key.startswith("tap_") else actual
        if actual != value:
            fail(f"campaign {key} differs from reusable publisher authority")
    if authority.get("source_materialization") != source_materialization:
        fail(
            "campaign target-source materialization differs from the "
            "protected tap"
        )


def campaign_guest_layout(campaign: dict[str, Any]) -> dict[str, str]:
    guest_layout = EXECUTOR.exact_keys(
        campaign["authority"].get("guest_layout"),
        {"path", "sha256"},
        "campaign guest layout",
    )
    if guest_layout["path"] != GUEST_LAYOUT_PATH:
        fail("campaign guest layout uses an unexpected contract path")
    digest = EXECUTOR.require_string(
        guest_layout["sha256"],
        "campaign guest layout SHA-256",
        EXECUTOR.SHA256,
    )
    contract = EXECUTOR.regular_file(
        ROOT / GUEST_LAYOUT_PATH,
        "Kandelo guest layout contract",
        EXECUTOR.MAX_JSON_BYTES,
    )
    if EXECUTOR.sha256_file(contract) != digest:
        fail("Kandelo guest layout differs from campaign authority")
    return {"path": GUEST_LAYOUT_PATH, "sha256": digest}


def replace_worktree(
    tap_root: pathlib.Path,
    target_root: pathlib.Path,
) -> None:
    # WHY: the source commit intentionally stores the reviewed overlay next to
    # the last live tap. Publisher tools must see the reconstructed target as
    # one ordinary clean checkout, not a mixture of live and candidate files.
    for child in tap_root.iterdir():
        if child.name == ".git":
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in target_root.iterdir():
        destination = tap_root / child.name
        if child.is_dir() and not child.is_symlink():
            shutil.copytree(child, destination, symlinks=True)
        else:
            shutil.copy2(child, destination, follow_symlinks=False)


def deterministic_commit(
    tap_root: pathlib.Path,
    *,
    parent: str,
    tree: str,
    label: str,
) -> str:
    if COMMIT.fullmatch(parent) is None or COMMIT.fullmatch(tree) is None:
        fail("campaign local commit received an invalid Git identity")
    environment = {
        "GIT_AUTHOR_DATE": FIXED_GIT_DATE,
        "GIT_AUTHOR_EMAIL": "campaign@kandelo.invalid",
        "GIT_AUTHOR_NAME": "Kandelo Homebrew Campaign",
        "GIT_COMMITTER_DATE": FIXED_GIT_DATE,
        "GIT_COMMITTER_EMAIL": "campaign@kandelo.invalid",
        "GIT_COMMITTER_NAME": "Kandelo Homebrew Campaign",
    }
    result = subprocess.run(
        ["git", "-C", str(tap_root), "commit-tree", tree, "-p", parent],
        input=(
            "Kandelo Homebrew campaign publisher snapshot\n\n"
            f"Purpose: {label}\n"
            f"Protected source: {parent}\n"
        ).encode("utf-8"),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=git_environment(environment),
        timeout=60,
    )
    if result.returncode != 0:
        fail(
            "cannot create campaign-local Git snapshot: "
            + result.stderr.decode("utf-8", errors="replace")[:8_192]
        )
    commit = result.stdout.decode("ascii", errors="strict").strip()
    if COMMIT.fullmatch(commit) is None:
        fail("campaign-local Git snapshot returned an invalid commit")
    run_git(
        tap_root,
        "update-ref",
        "--no-deref",
        "HEAD",
        commit,
        parent,
    )
    if run_git(tap_root, "rev-parse", "HEAD") != commit:
        fail("campaign-local Git snapshot did not become checkout HEAD")
    if run_git(tap_root, "status", "--short", "--untracked-files=all"):
        fail("campaign-local Git snapshot is not clean")
    return commit


def commit_materialized_target(
    tap_root: pathlib.Path,
    target_root: pathlib.Path,
    *,
    source_commit: str,
    target_tree: str,
) -> str:
    replace_worktree(tap_root, target_root)
    run_git(tap_root, "add", "-A")
    actual_tree = run_git(tap_root, "write-tree")
    if actual_tree != target_tree:
        fail("publisher materialized a different campaign target tree")
    return deterministic_commit(
        tap_root,
        parent=source_commit,
        tree=actual_tree,
        label="sealed target source",
    )


def default_fetch_campaign(
    repository: str,
    tag: str,
    output: pathlib.Path,
    receipt: pathlib.Path,
) -> None:
    EXECUTOR.fetch_campaign_release(
        repository=repository,
        tag=tag,
        output=output,
        receipt_output=receipt,
    )


def default_fetch_handoff(
    campaign_path: pathlib.Path,
    tag: str,
    output: pathlib.Path,
    receipt: pathlib.Path,
    dependency_roots: list[pathlib.Path],
) -> None:
    EXECUTOR.fetch_release(
        campaign_path=campaign_path,
        tag=tag,
        output=output,
        receipt_output=receipt,
        dependency_roots=dependency_roots,
    )


def bottle_input(
    handoff_root: pathlib.Path,
    handoff: dict[str, Any],
    arch: str,
    campaign: dict[str, Any],
    canonical_root: pathlib.Path,
) -> tuple[pathlib.Path, str, str, str]:
    name = handoff["formula"]["name"]
    publication = EXECUTOR.handoff_publication(
        handoff,
        arch,
        f"dependency {name}",
    )
    bottle_json = handoff_root / f"payload/{arch}/build/bottle.json"
    archive_record = EXECUTOR.handoff_publication_file(
        publication,
        f"payload/{arch}/build/bottle.tar.gz",
        f"dependency {name}/{arch}",
    )
    try:
        canonical, digest, root_url, cellar = (
            EXECUTOR.validate_dependency_bottle_input(
                bottle_json=bottle_json,
                handoff=handoff,
                arch=arch,
                archive_record=archive_record,
                campaign=campaign,
            )
        )
    except EXECUTOR.ExecutorError as error:
        fail(str(error))
    canonical_path = EXECUTOR.private_destination(
        canonical_root,
        f"{name}.json",
        f"{name}/{arch} canonical bottle JSON",
    )
    # WHY: Homebrew's original build JSON is retained in the sealed handoff as
    # evidence, but the Formula merger deliberately accepts a much smaller
    # schema. Derive that schema only after validating the original bytes.
    with canonical_path.open("xb") as output:
        output.write(EXECUTOR.pretty_json(canonical))
    return canonical_path, digest, root_url, cellar


def default_merge_dependency(
    *,
    tap_root: pathlib.Path,
    tap_repository: str,
    tap_name: str,
    formula: str,
    arch: str,
    release_tag: str,
    bottle_json: pathlib.Path,
    sha256: str,
    root_url: str,
    cellar: str,
) -> None:
    command = [
        "bash",
        str(ROOT / "scripts/homebrew-merge-bottle-json.sh"),
        "--tap-root",
        str(tap_root),
        "--tap-repository",
        tap_repository,
        "--tap-name",
        tap_name,
        "--formula",
        formula,
        "--arch",
        arch,
        "--release-tag",
        release_tag,
        "--bottle-json",
        str(bottle_json),
        "--expected-sha256",
        sha256,
        "--expected-root-url",
        root_url,
        "--expected-cellar",
        cellar,
    ]
    result = subprocess.run(
        command,
        cwd=ROOT,
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=300,
    )
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[:16_384]
        fail(f"cannot compose dependency bottle for {formula}/{arch}: {detail}")


FetchCampaign = Callable[
    [str, str, pathlib.Path, pathlib.Path],
    None,
]
FetchHandoff = Callable[
    [
        pathlib.Path,
        str,
        pathlib.Path,
        pathlib.Path,
        list[pathlib.Path],
    ],
    None,
]
MergeDependency = Callable[..., None]


@dataclasses.dataclass(frozen=True)
class PreparationDependencies:
    fetch_campaign: FetchCampaign = default_fetch_campaign
    fetch_handoff: FetchHandoff = default_fetch_handoff
    merge_dependency: MergeDependency = default_merge_dependency


def prepare(
    *,
    tap_root: pathlib.Path,
    kandelo_commit: str,
    tap_repository: str,
    tap_name: str,
    source_tap_commit: str,
    campaign_tag: str,
    dependency_request: str,
    formula: str,
    arch: str | None,
    work_root: pathlib.Path,
    receipt_output: pathlib.Path,
    github_env: pathlib.Path | None = None,
    github_output: pathlib.Path | None = None,
    dependencies: PreparationDependencies = PreparationDependencies(),
) -> dict[str, Any]:
    for value, label in (
        (kandelo_commit, "Kandelo commit"),
        (source_tap_commit, "source tap commit"),
    ):
        if COMMIT.fullmatch(value) is None:
            fail(f"{label} is invalid")
    formula = EXECUTOR.require_string(formula, "campaign Formula", FORMULA)
    campaign_match = CAMPAIGN_TAG.fullmatch(campaign_tag)
    if campaign_match is None or set(campaign_match.group(1)) == {"0"}:
        fail("campaign tag is invalid or inert")
    if arch not in (None, "wasm32", "wasm64"):
        fail("campaign publisher architecture is invalid")
    tap_root = real_git_checkout(tap_root, source_tap_commit)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    receipt_output.parent.mkdir(parents=True, exist_ok=True)
    output_inputs = [tap_root]
    if github_env is not None and (
        github_env.exists() or github_env.is_symlink()
    ):
        output_inputs.append(github_env)
    if github_output is not None and (
        github_output.exists() or github_output.is_symlink()
    ):
        output_inputs.append(github_output)
    work_root, receipt_output = EXECUTOR.validate_output_pair(
        work_root,
        "campaign publisher work root",
        receipt_output,
        "campaign publisher receipt",
        output_inputs,
    )
    requested = parse_dependency_request(dependency_request)
    requested_tags = dict(requested)

    transaction = pathlib.Path(
        tempfile.mkdtemp(
            prefix=f".{work_root.name}.transaction-",
            dir=work_root.parent,
        )
    )
    temporary = transaction / "work"
    temporary.mkdir()
    staged_receipt = transaction / "receipt.json"
    campaign_path = temporary / "campaign.json"
    campaign_receipt = temporary / "campaign-readback.json"
    source_snapshot = temporary / "source"
    try:
        dependencies.fetch_campaign(
            tap_repository,
            campaign_tag,
            campaign_path,
            campaign_receipt,
        )
        campaign, campaign_payload, index = EXECUTOR.load_campaign(
            campaign_path
        )
        guest_layout = campaign_guest_layout(campaign)
        if sha256_bytes(campaign_payload) != campaign_match.group(1):
            fail("campaign tag differs from the fetched campaign")
        if formula not in index:
            fail(f"Formula {formula} is outside the campaign")
        materialized, source_materialization = (
            CAMPAIGN.candidate_source_snapshot(
                CAMPAIGN.git_authority(
                    tap_root,
                    source_tap_commit,
                    "publisher campaign tap",
                ),
                source_tap_commit,
                source_snapshot,
            )
        )
        validate_campaign_authority(
            campaign,
            kandelo_commit=kandelo_commit,
            tap_repository=tap_repository,
            tap_name=tap_name,
            source_tap_commit=source_tap_commit,
            source_materialization=source_materialization,
        )
        expected_dependencies = EXECUTOR.dependency_closure(
            campaign, index, formula
        )
        if tuple(sorted(requested_tags)) != expected_dependencies:
            fail(
                "campaign dependency request differs from the exact "
                "Formula closure"
            )
        target_tree = EXECUTOR.source_tree_identity(campaign["authority"])
        target_commit = commit_materialized_target(
            tap_root,
            materialized,
            source_commit=source_tap_commit,
            target_tree=target_tree,
        )

        fetched: dict[str, pathlib.Path] = {}
        fetched_records: list[dict[str, str]] = []
        prepared_commit = target_commit
        if arch is not None:
            handoff_root = temporary / "handoffs"
            readback_root = temporary / "handoff-readbacks"
            canonical_root = temporary / "canonical-bottle-inputs"
            handoff_root.mkdir()
            readback_root.mkdir()
            canonical_root.mkdir()
            for name in topological_dependencies(campaign, index, formula):
                dependency_roots = [
                    fetched[dependency]
                    for dependency in EXECUTOR.dependency_closure(
                        campaign, index, name
                    )
                ]
                output = handoff_root / name
                receipt = readback_root / f"{name}.json"
                dependencies.fetch_handoff(
                    campaign_path,
                    requested_tags[name],
                    output,
                    receipt,
                    dependency_roots,
                )
                handoff, handoff_payload = EXECUTOR.load_handoff(
                    output, campaign, campaign_payload
                )
                actual_name = handoff["formula"]["name"]
                actual_tag = EXECUTOR.handoff_tag(handoff_payload)
                if actual_name != name or actual_tag != requested_tags[name]:
                    fail(
                        f"downloaded dependency handoff differs from {name}"
                    )
                bottle_json, digest, root_url, cellar = bottle_input(
                    output,
                    handoff,
                    arch,
                    campaign,
                    canonical_root,
                )
                dependencies.merge_dependency(
                    tap_root=tap_root,
                    tap_repository=tap_repository,
                    tap_name=tap_name,
                    formula=name,
                    arch=arch,
                    release_tag=(
                        "bottles-abi-v"
                        f"{campaign['authority']['current_kandelo_abi']}"
                    ),
                    bottle_json=bottle_json,
                    sha256=digest,
                    root_url=root_url,
                    cellar=cellar,
                )
                fetched[name] = output
                fetched_records.append(
                    {"formula": name, "tag": actual_tag}
                )
            run_git(tap_root, "add", "-A")
            changed = tuple(
                line
                for line in run_git(
                    tap_root,
                    "diff",
                    "--cached",
                    "--name-only",
                    target_commit,
                ).splitlines()
                if line
            )
            expected_changed = tuple(
                f"Formula/{name}.rb" for name in sorted(fetched)
            )
            if changed != expected_changed:
                fail(
                    "dependency bottle composition changed files outside "
                    "its exact Formula closure"
                )
            prepared_tree = run_git(tap_root, "write-tree")
            prepared_commit = deterministic_commit(
                tap_root,
                parent=target_commit,
                tree=prepared_tree,
                label=f"{formula}/{arch} dependency bottles",
            )
        else:
            prepared_tree = target_tree

        receipt = {
            "campaign": {
                "guest_layout": guest_layout,
                "sha256": sha256_bytes(campaign_payload),
                "tag": campaign_tag,
            },
            "dependency_handoffs": [
                {"formula": name, "tag": tag}
                for name, tag in requested
            ],
            "fetched_dependency_handoffs": fetched_records,
            "formula": formula,
            "kind": "kandelo-homebrew-prefix-publisher-checkout",
            "preparation": {
                "arch": arch,
                "commit": prepared_commit,
                "tree_git_oid": prepared_tree,
            },
            "schema": 1,
            "source": {
                "commit": source_tap_commit,
                "materialized_commit": target_commit,
                "target_tree_git_oid": target_tree,
            },
        }
        staged_receipt.write_bytes(pretty_json(receipt))
        verify(tap_root=tap_root, receipt_path=staged_receipt)
        EXECUTOR.commit_output_pair(
            temporary,
            work_root,
            staged_receipt,
            receipt_output,
        )
        if github_env is not None:
            with github_env.open("a", encoding="utf-8") as output:
                output.write(
                    "KANDELO_HOMEBREW_PREPARED_TAP_COMMIT="
                    f"{prepared_commit}\n"
                )
                output.write(
                    "KANDELO_HOMEBREW_PREPARED_TAP_TREE="
                    f"{prepared_tree}\n"
                )
                output.write(
                    "KANDELO_HOMEBREW_PREFIX_CAMPAIGN_RECEIPT="
                    f"{receipt_output.resolve()}\n"
                )
                output.write(
                    "KANDELO_HOMEBREW_PREFIX_CAMPAIGN_LAYOUT_SHA256="
                    f"{guest_layout['sha256']}\n"
                )
        if github_output is not None:
            with github_output.open("a", encoding="utf-8") as output:
                output.write(
                    "prefix-campaign-layout-sha256="
                    f"{guest_layout['sha256']}\n"
                )
        return receipt
    finally:
        if transaction.exists():
            shutil.rmtree(transaction)


def verify(*, tap_root: pathlib.Path, receipt_path: pathlib.Path) -> None:
    value, payload = EXECUTOR.load_json_bytes(
        receipt_path, "campaign publisher checkout receipt"
    )
    if payload != pretty_json(value):
        fail("campaign publisher checkout receipt is not canonical")
    value = EXECUTOR.exact_keys(
        value,
        {
            "campaign",
            "dependency_handoffs",
            "fetched_dependency_handoffs",
            "formula",
            "kind",
            "preparation",
            "schema",
            "source",
        },
        "campaign publisher checkout receipt",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-prefix-publisher-checkout"
    ):
        fail("campaign publisher checkout receipt is unsupported")
    campaign = EXECUTOR.exact_keys(
        value["campaign"],
        {"guest_layout", "sha256", "tag"},
        "campaign publisher campaign",
    )
    EXECUTOR.require_string(
        campaign["sha256"],
        "campaign publisher campaign SHA-256",
        EXECUTOR.SHA256,
    )
    EXECUTOR.require_string(
        campaign["tag"],
        "campaign publisher campaign tag",
        CAMPAIGN_TAG,
    )
    guest_layout = EXECUTOR.exact_keys(
        campaign["guest_layout"],
        {"path", "sha256"},
        "campaign publisher guest layout",
    )
    if guest_layout["path"] != GUEST_LAYOUT_PATH:
        fail("campaign publisher guest layout path is not canonical")
    EXECUTOR.require_string(
        guest_layout["sha256"],
        "campaign publisher guest layout SHA-256",
        EXECUTOR.SHA256,
    )
    preparation = EXECUTOR.exact_keys(
        value["preparation"],
        {"arch", "commit", "tree_git_oid"},
        "campaign publisher preparation",
    )
    source = EXECUTOR.exact_keys(
        value["source"],
        {"commit", "materialized_commit", "target_tree_git_oid"},
        "campaign publisher source",
    )
    for identity, label in (
        (preparation["commit"], "prepared commit"),
        (preparation["tree_git_oid"], "prepared tree"),
        (source["commit"], "source commit"),
        (source["materialized_commit"], "materialized commit"),
        (source["target_tree_git_oid"], "target tree"),
    ):
        EXECUTOR.require_string(identity, label, COMMIT)
    root = pathlib.Path(tap_root).resolve()
    if run_git(root, "rev-parse", "HEAD") != preparation["commit"]:
        fail("campaign publisher checkout moved from its prepared commit")
    if (
        run_git(root, "rev-parse", f"{preparation['commit']}^{{tree}}")
        != preparation["tree_git_oid"]
    ):
        fail("campaign publisher prepared commit has the wrong tree")
    if (
        run_git(root, "rev-parse", f"{source['materialized_commit']}^{{tree}}")
        != source["target_tree_git_oid"]
    ):
        fail("campaign publisher materialized commit has the wrong tree")
    if run_git(root, "status", "--short", "--untracked-files=all"):
        fail("campaign publisher checkout changed after preparation")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--tap-root", required=True)
    prepare_parser.add_argument("--kandelo-commit", required=True)
    prepare_parser.add_argument("--tap-repository", required=True)
    prepare_parser.add_argument("--tap-name", required=True)
    prepare_parser.add_argument("--source-tap-commit", required=True)
    prepare_parser.add_argument("--campaign-tag", required=True)
    prepare_parser.add_argument("--dependencies", required=True)
    prepare_parser.add_argument("--formula", required=True)
    prepare_parser.add_argument("--arch", choices=("wasm32", "wasm64"))
    prepare_parser.add_argument("--work-root", required=True)
    prepare_parser.add_argument("--receipt-out", required=True)
    prepare_parser.add_argument("--github-env")
    prepare_parser.add_argument("--github-output")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--tap-root", required=True)
    verify_parser.add_argument("--receipt", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "prepare":
            prepare(
                tap_root=pathlib.Path(arguments.tap_root),
                kandelo_commit=arguments.kandelo_commit,
                tap_repository=arguments.tap_repository,
                tap_name=arguments.tap_name,
                source_tap_commit=arguments.source_tap_commit,
                campaign_tag=arguments.campaign_tag,
                dependency_request=arguments.dependencies,
                formula=arguments.formula,
                arch=arguments.arch,
                work_root=pathlib.Path(arguments.work_root),
                receipt_output=pathlib.Path(arguments.receipt_out),
                github_env=(
                    pathlib.Path(arguments.github_env)
                    if arguments.github_env
                    else None
                ),
                github_output=(
                    pathlib.Path(arguments.github_output)
                    if arguments.github_output
                    else None
                ),
            )
        elif arguments.command == "verify":
            verify(
                tap_root=pathlib.Path(arguments.tap_root),
                receipt_path=pathlib.Path(arguments.receipt),
            )
        else:
            raise AssertionError(arguments.command)
        return 0
    except (
        PublisherCampaignError,
        EXECUTOR.ExecutorError,
        CAMPAIGN.CampaignError,
        OSError,
        UnicodeError,
    ) as error:
        print(
            f"homebrew-prefix-campaign-publisher.py: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
