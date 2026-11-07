#!/usr/bin/env python3
"""Once-per-stream context reminder, plus agent-owned checkpoint storage.

No model calls, tool denials, worker rotation, or transcript writes. Install
the standalone trusted copy with install-hooks.py --user --hook context.
Without arguments this is a PreToolUse hook; save/check are also usable by
agents whose client does not support Claude Code hooks.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import uuid

HOOK_VERSION = 1
CONTEXT_THRESHOLD = 250_000
TAIL_BYTES = 512 * 1024
NOTE_BYTES = 64 * 1024
SECTIONS = (
    "Goal and acceptance", "Decisions and rejected approaches", "Changes",
    "Evidence and limitations", "Live jobs and ownership", "Open failures",
    "Next step",
)
PREFIX = "<!-- kandelo-checkpoint "


def checkout(start):
    path = Path(start).resolve()
    for parent in (path, *path.parents):
        if (parent / "scripts/agent-job").is_file():
            return parent
    return None


def transcript(payload):
    main = Path(os.path.expanduser(payload["transcript_path"]))
    agent = payload.get("agent_id")
    if not agent:
        return main
    # Tool hooks usually name the parent's transcript even inside a child.
    # Never attribute the parent's large context to a small subagent.
    if not re.fullmatch(r"[A-Za-z0-9_-]+", agent):
        return None
    name = agent if agent.startswith("agent-") else "agent-" + agent
    if main.parent.name == "subagents" and main.stem == name:
        return main
    child = main.with_suffix("") / "subagents" / (name + ".jsonl")
    return child if child.is_file() else None


def last_context(path):
    with path.open("rb") as stream:
        size = stream.seek(0, os.SEEK_END)
        offset = max(0, size - TAIL_BYTES)
        stream.seek(offset)
        lines = stream.read(TAIL_BYTES).splitlines()
    if offset:
        lines = lines[1:]  # first record may have been cut in the middle
    for line in reversed(lines):
        try:
            row = json.loads(line)
            if row.get("type") != "assistant":
                continue
            usage = (row.get("message") or {}).get("usage") or {}
            values = [usage.get(k, 0) for k in (
                "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
            if all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in values):
                if sum(values):
                    return sum(values)
        except (ValueError, AttributeError, TypeError):
            continue
    return None


def reminder(payload):
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    root = checkout(payload.get("cwd") or os.getcwd())
    if root is None or not payload.get("transcript_path"):
        return None
    path = transcript(payload)
    if path is None:
        return None
    identity = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
    state = Path(os.path.expanduser(os.environ.get(
        "KANDELO_CONTEXT_CACHE_DIR", "~/.cache/kandelo/agent-context")))
    marker = state / (identity + ".json")
    if marker.exists():
        return None
    tokens = last_context(path)
    if tokens is None or tokens < CONTEXT_THRESHOLD:
        return None
    command = (f"cd {shlex.quote(str(root))} && python3 "
               f"{shlex.quote(str(Path(__file__).resolve()))} save context-{identity[:12]}")
    message = (
        f"Kandelo context checkpoint: this agent's latest recorded input context is {tokens:,} tokens. "
        "At the next completed milestone, save a concise checkpoint without asking the user to manage it. "
        f"Pipe a Markdown note to `{command}`. Use these exact ## sections: "
        + "; ".join(SECTIONS) + ". "
        "Target about 8k characters; link detailed evidence. Record unverified claims and job ownership. "
        "Return the saved path to the coordinator. The coordinator retains long builds/suites and verifies "
        "the note against source and evidence. Keep working until a safe milestone; preserve the user's "
        "scope and delegation preferences. Automatic worker rotation remains experimental under "
        "evals/agent-skills/README.md; do not reset or stop just because of this reminder. "
        "This reminder appears once per agent and makes no tool decision."
    )
    state.mkdir(parents=True, exist_ok=True)
    # Parallel tool calls must not inject the same reminder repeatedly.
    try:
        with marker.open("x") as stream:
            json.dump(dict(version=HOOK_VERSION, context_tokens=tokens,
                           session_id=payload.get("session_id"), agent_id=payload.get("agent_id"),
                           worktree=str(root), transcript=str(path)), stream)
    except FileExistsError:
        return None
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": message}}


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30).stdout


def snapshot(root):
    return dict(worktree=str(root), head=git(root, "rev-parse", "HEAD").decode().strip(),
                tracked_diff_sha256=hashlib.sha256(git(root, "diff", "HEAD", "--binary")).hexdigest(),
                status=git(root, "status", "--short").decode())


def validate_note(note):
    headings = list(re.finditer(r"^## (.+?)\s*$", note, re.M))
    found = {}
    for i, heading in enumerate(headings):
        title = heading[1]
        if title in found:
            raise ValueError(f"duplicate section: {title}")
        end = headings[i + 1].start() if i + 1 < len(headings) else len(note)
        found[title] = note[heading.end():end].strip()
    for title in SECTIONS:
        body = found.get(title, "")
        if not body or body.lower() in ("todo", "tbd", "[fill in]", "..."):
            raise ValueError(f"fill section: {title} (say None explicitly when appropriate)")


def save(root, name, note):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", name):
        raise ValueError("name must be 1–80 letters, digits, hyphens or underscores")
    if len(note.encode()) > NOTE_BYTES:
        raise ValueError("note exceeds 64 KiB; link detailed evidence instead")
    validate_note(note)
    before = snapshot(root)
    # A concurrent edit invalidates the provenance; never label mixed inputs
    # as a single checkpoint. This only observes tracked state, not tests.
    if before != snapshot(root):
        raise ValueError("checkout changed while recording; retry at a stable milestone")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    metadata = dict(version=1, recorded_at=stamp, **before)
    directory = root / ".context/agent-checkpoints"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{name}-{stamp}-{uuid.uuid4().hex[:8]}.md"
    content = PREFIX + json.dumps(metadata) + " -->\n\n" + note.strip() + "\n"
    # Immutable, uniquely named notes prevent overlapping phases overwriting
    # the file a parent has already cited. Do not maintain a shared 'latest'.
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        os.link(temporary, target)  # exclusive publication, never overwrite a cited note
    finally:
        temporary.unlink(missing_ok=True)
    return target


def check(root, path):
    if path.stat().st_size > NOTE_BYTES + 1024 * 1024:
        raise ValueError("checkpoint is too large")
    text = path.read_text()
    first, _, note = text.partition("\n")
    if not first.startswith(PREFIX) or not first.endswith(" -->"):
        raise ValueError("not a versioned Kandelo checkpoint")
    metadata = json.loads(first[len(PREFIX):-4])
    if not isinstance(metadata, dict) or metadata.get("version") != 1:
        raise ValueError("unsupported checkpoint version")
    validate_note(note)
    current = snapshot(root)
    for key in ("worktree", "head", "tracked_diff_sha256", "status"):
        if metadata.get(key) != current[key]:
            raise ValueError(f"checkpoint is stale or belongs to a different checkout: {key}")


def cli():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    writer = commands.add_parser("save", help="save an immutable checkpoint from stdin or --from")
    writer.add_argument("name")
    writer.add_argument("--from", dest="source", type=Path)
    reader = commands.add_parser("check", help="check format and recorded checkout state, not correctness")
    reader.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        root = checkout(Path.cwd())
        if root is None:
            raise ValueError("run inside a Kandelo checkout with scripts/agent-job")
        if args.command == "save":
            if args.source and args.source.stat().st_size > NOTE_BYTES:
                raise ValueError("note exceeds 64 KiB")
            note = args.source.read_text() if args.source else sys.stdin.read(NOTE_BYTES + 1)
            print(save(root, args.name, note))
        else:
            check(root, args.path)
            print("Checkpoint metadata matches; verify decisions, evidence and untracked file contents before handoff.")
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"agent-checkpoint: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raise SystemExit(cli())
    try:
        result = reminder(json.load(sys.stdin))
        if result:
            print(json.dumps(result))
    except Exception:
        pass  # advisory only: malformed/missing state must never block tools
