"""One reviewed patch -> checks -> evidence -> checkpoint, with durable step intents."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import time
import uuid

from . import gitops as g
from .manifest import Invalid, digest, identity, load, loads, path, pinned, read_manifest, require, validate


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def tool_identity():
    files = sorted(Path(__file__).parent.glob("*.py"))
    files += sorted(Path(__file__).parent.glob("*.schema.json")) + [Path(__file__).parents[1] / "agent-integrate"]
    return digest(b"".join(p.name.encode() + p.read_bytes() for p in files))


@contextmanager
def lock(root):
    filename = g.git(root, "rev-parse", "--git-path", "agent-integrate.lock").decode().strip()
    filename = Path(filename) if Path(filename).is_absolute() else root / filename
    with filename.open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Invalid("another integration invocation holds the worktree lock")
        yield


def immutable_records(manifest, root):
    records = [manifest["patch"], *manifest["inputs"], *manifest["target_pins"],
               *manifest["evidence"], *manifest["seals"]]
    if "adapter" in manifest:
        records.append(manifest["adapter"]["state"])
    for seal in manifest["seals"]:
        pinned(root, seal)
        contents = load(path(root, seal["path"]))
        require(set(contents) == {"version", "members"} and contents["version"] == 1 and
                isinstance(contents["members"], dict) and contents["members"], "invalid seal v1")
        for name, sha in contents["members"].items():
            member = path(path(root, seal["path"]).parent, name)
            require(isinstance(sha, str) and len(sha) == 64, "invalid seal digest")
            records.append({"path": str(member.relative_to(root)), "sha256": sha})
    for record in records:
        pinned(root, record)
        require(not any(g.overlap(record["path"], own) for own in manifest["owned_paths"]),
                f"immutable input overlaps owned path: {record['path']}")
    return {r["path"]: r["sha256"] for r in records}


def preflight(root, filename):
    manifest = read_manifest(filename)
    owned = manifest["owned_paths"]
    for name in [*owned, *manifest["protected_paths"], *manifest["patch"]["before"],
                 *manifest["patch"]["after"]]:
        path(root, name)
    require(set(manifest["patch"]["before"]) == set(owned) == set(manifest["patch"]["after"]),
            "owned paths and patch before/after maps must match")
    for name in owned:
        require(not any(g.overlap(name, other) for other in manifest["protected_paths"]),
                f"owned/protected overlap: {name}")
        require(not any(g.overlap(name, other) for other in owned if name != other), "overlapping owned paths")
        require(not g.overlap(name, ".context/agent-integrations"), "owned path overlaps operation metadata")
    require(g.rev(root, "HEAD") == manifest["base_commit"], "target HEAD differs from frozen base")
    require(manifest["main"]["ref"].startswith("refs/"), "main needs a fully qualified Git ref")
    require(g.rev(root, manifest["main"]["ref"]) == manifest["main"]["commit"], "main ref moved before preflight")
    branch = g.git(root, "symbolic-ref", "-q", "HEAD").decode().strip()
    require(branch.startswith("refs/heads/"), "integration requires an existing branch")
    require(not g.git(root, "ls-files", "-u"), "unmerged index entries")
    # Inspect new files even if already staged, before rejecting dirty overlap.
    g.whitespace(root, owned)
    guards = g.dirty_guard(root, owned, manifest["protected_paths"])
    for name, sha in manifest["patch"]["before"].items():
        require(identity(root, name) == sha, f"stale worktree preimage: {name}")
    records = immutable_records(manifest, root)
    if "adapter" in manifest:
        from . import node
        node.validate(manifest["adapter"], root, require)
    source = manifest["source"]
    require({n for n in owned if manifest["patch"]["after"][n] is not None} <= source["identities"].keys(),
            "every owned postimage needs a reviewed source identity")
    source_root = Path(source["root"])
    require(source_root.is_absolute() and str(source_root.resolve()) == str(source_root), "canonical absolute source root required")
    require(g.rev(source_root, source["ref"]) == source["commit"], "reviewed source ref moved before preflight")
    for name, sha in source["identities"].items():
        require(identity(source_root, name) == sha, f"source identity drift: {name}")
        require(digest(g.git(source_root, "show", source["commit"] + ":" + name)) == sha,
                f"source commit identity mismatch: {name}")
        if name in owned:
            require(manifest["patch"]["after"][name] == sha, f"patch differs from reviewed source: {name}")
    require(len({c["id"] for c in manifest["checks"]}) == len(manifest["checks"]), "duplicate check id")
    for check in manifest["checks"]:
        require(path(root, check["cwd"], dot=True).is_dir(), "check cwd must already exist")
        require(all("\0" not in a for a in check["argv"]), "NUL in check argv")
    for ev in manifest["evidence"]:
        require(ev["reused"] or ev["source_commit"] == source["commit"], "historical evidence must be marked reused")
    content = g.prepared_patch(root, manifest, path(root, manifest["patch"]["path"]).read_bytes())
    return manifest, content, records, guards, branch


def save(op, state):
    g.atomic(op / "ledger.json", encoded(state))


def event(op, state, kind, **fields):
    state["events"].append({"at": time.time(), "kind": kind, **fields})
    save(op, state)


def operation(root, task_id):
    # Reuse the manifest identifier grammar for CLI lookups.
    import re
    require(re.fullmatch(r"[a-z][a-z0-9-]{0,47}", task_id), "noncanonical task identifier")
    return path(root, ".context/agent-integrations/" + task_id)


def create(root, filename, commit, push):
    manifest, content, records, guards, branch = preflight(root, filename)
    require(not commit or manifest.get("commit", {}).get("authorized") is True, "commit not authorized by task")
    require(not push or commit and manifest.get("push", {}).get("authorized") is True, "push requires authorized commit and push")
    op = operation(root, manifest["id"])
    require(not op.exists(), "task already exists; use resume/status, never overwrite its ledger")
    push_url = None
    if push:
        config = manifest["push"]
        require(config["ref"].startswith("refs/heads/"), "push must target a fully qualified branch")
        g.git(root, "check-ref-format", config["ref"])
        require(not config["remote"].startswith("-"), "invalid remote")
        push_url = g.git(root, "remote", "get-url", "--push", config["remote"]).decode().strip()
        require(remote_head(root, push_url, config["ref"]) == config["expected"], "remote differs from expected push preimage")
    if commit:
        require(re.match(r"^[A-Za-z][A-Za-z0-9 ]*: [^\n]+", manifest["commit"]["message"]),
                "commit subject requires an Area: Purpose prefix")
    binding = digest(encoded({"source": manifest["source"], "base": manifest["base_commit"],
                              "main": manifest["main"], "after": manifest["patch"]["after"], "inputs": records,
                              "manifest_sha256": digest(encoded(manifest))}))
    steps = [{"id": "apply", "state": "ready"}]
    steps += [{"id": "check-" + c["id"], "check_id": c["id"], "state": "ready"} for c in manifest["checks"]]
    steps += [{"id": "evidence", "state": "ready"}, {"id": "checkpoint", "state": "ready"}]
    if commit:
        steps += [{"id": "commit", "state": "ready"}]
    if push:
        steps += [{"id": "push", "state": "ready"}]
    state = {"version": 1, "root": str(root), "manifest": manifest,
             "manifest_sha256": digest(encoded(manifest)), "tool_identity": tool_identity(),
             "branch": branch, "push_url": push_url, "source_binding": binding,
             "records": records, "guards": guards, "unrelated_index": g.index_entries(root, manifest["owned_paths"]),
             "protected_inventory": g.protected_inventory(root, manifest["protected_paths"]),
             "steps": steps, "events": [], "evidence": [], "failures": [], "checkpoint": None,
             "observations": [], "result_files": {}}
    # Publish the complete operation directory at once, including frozen patch bytes.
    temporary = op.parent / (".prepare-" + uuid.uuid4().hex)
    g.mkdir_durable(temporary)
    g.atomic(temporary / "reviewed.patch", path(root, manifest["patch"]["path"]).read_bytes())
    save(temporary, state)
    os.rename(temporary, op)
    g.sync_dir(op.parent)
    event(op, state, "preflight-complete", manifest_sha256=state["manifest_sha256"])
    return op, state


def remote_head(root, url, ref):
    require(not url.startswith("-"), "unsafe push URL")
    result = g.git(root, "ls-remote", "--refs", url, ref).decode().splitlines()
    require(len(result) <= 1, "ambiguous remote ref")
    return result[0].split()[0] if result else None


def verify(state, *, applied):
    root, manifest = Path(state["root"]), state["manifest"]
    require(tool_identity() == state["tool_identity"], "tool changed since review; use original tooling to resume")
    require(digest(encoded(manifest)) == state["manifest_sha256"], "frozen manifest corrupted")
    require(g.git(root, "symbolic-ref", "-q", "HEAD").decode().strip() == state["branch"], "target branch changed")
    allowed_heads = {manifest["base_commit"]}
    for step in state["steps"]:
        if step["id"] == "commit" and step.get("commit"):
            allowed_heads = {step["commit"]} if step["state"] == "done" else allowed_heads | {step["commit"]}
    require(g.rev(root, "HEAD") in allowed_heads, "target HEAD drift; refusing mutation")
    for name, sha in state["records"].items():
        pinned(root, {"path": name, "sha256": sha})
    for name, sha in state["result_files"].items():
        pinned(root, {"path": name, "sha256": sha})
    for name, sha in state["guards"].items():
        require(g.guard_identity(root, name) == sha, f"unrelated/protected work changed: {name}")
    require(g.index_entries(root, manifest["owned_paths"]) == state["unrelated_index"], "unrelated staged work changed")
    require(g.safe_owned_index(root, manifest["patch"]["before"], manifest["patch"]["after"]),
            "unexpected staged content in owned paths; refusing to overwrite it")
    require(g.protected_inventory(root, manifest["protected_paths"]) == state["protected_inventory"],
            "protected path inventory changed")
    if applied:
        for name, sha in manifest["patch"]["after"].items():
            require(identity(root, name) == sha, f"applied source drift: {name}; evidence is stale")


def finish(op, state, step, **fields):
    step.update(state="done", **fields)
    event(op, state, "step-complete", step=step["id"])


def record_report(op, state, filename, sha256):
    """Import an explicitly reviewed observation; the manager owns its execution.

    This is an integration evidence envelope, not an assumed manager wire format.
    An adapter can translate the manager's eventual receipts into this boundary.
    """
    root, manifest = Path(state["root"]), state["manifest"]
    verify(state, applied=True)
    require(state["steps"][0]["state"] == "done", "apply must finish before recording check evidence")
    raw = filename.read_bytes()
    require(digest(raw) == sha256, "result report identity mismatch")
    report = loads(raw)
    validate(report, load(Path(__file__).with_name("result-v1.schema.json")), "result")
    require(report["source_binding"] == state["source_binding"], "stale result: source binding mismatch")
    step = next((s for s in state["steps"] if s.get("check_id") == report["check_id"]), None)
    require(step is not None, "unknown check identifier")
    check = next(c for c in manifest["checks"] if c["id"] == report["check_id"])
    require(report["argv"] == check["argv"] and report["cwd"] == check["cwd"], "result command/cwd differs from manifest")
    require(not step.get("job_id") or step["job_id"] == report["job_id"],
            "original job handle must be preserved; a new job requires a new operation")
    require(len(report["job_id"]) <= 200 and all(c.isalnum() or c in "._-" for c in report["job_id"]), "unsafe job identifier")
    path(root, report["log"]["path"])
    if any(o["sha256"] == sha256 for o in state["observations"]):
        return  # Exact duplicate import cannot duplicate events or checkpoints.
    require(step["state"] not in ("done", "failed"), "terminal check result cannot be replaced")
    require(state["checkpoint"] is None, "checkpoint already frozen")
    if report["state"] == "waiting":
        require(report["outcome"] is None and report["exit_code"] is None and report["log"]["sha256"] is None,
                "wait-window observation cannot claim a process outcome")
        require(not report["reused"], "an active wait cannot be reused evidence")
        step["state"] = "waiting"
    else:
        require(report["outcome"] is not None and report["exit_code"] is not None and report["log"]["sha256"] is not None,
                "terminal observation requires outcome, exit code and sealed log")
        require(report["outcome"] != "pass" or report["exit_code"] == 0 and report["state"] == "finished",
                "passing result requires a finished process with exit 0")
        require(report["outcome"] != "fail" or report["exit_code"] != 0, "failed process requires a nonzero exit")
        require(report["state"] != "lost" or report["outcome"] == "harness-error", "lost supervisor is a harness error")
        pinned(root, report["log"])
        require(not any(g.overlap(report["log"]["path"], p) for p in manifest["owned_paths"]), "log overlaps owned path")
        state["result_files"][report["log"]["path"]] = report["log"]["sha256"]
        step.update(state="done" if report["outcome"] == "pass" else "failed",
                    outcome=report["outcome"], exit_code=report["exit_code"])
        state["evidence"].append({**report, "dimension": check["dimension"], "scope": check["scope"],
                                  "report_sha256": sha256})
        if report["outcome"] != "pass":
            state["failures"].append({"step": step["id"], "outcome": report["outcome"],
                                      "exit_code": report["exit_code"], "log": report["log"]["path"], "at": time.time()})
    step.update(job_id=report["job_id"], log=report["log"]["path"])
    frozen = op / "results" / (sha256 + ".json")
    g.atomic(frozen, raw)
    state["result_files"][str(frozen.relative_to(root))] = sha256
    state["observations"].append({"sha256": sha256, "report": str(frozen.relative_to(root))})
    # State, evidence and the step verdict are one atomic metadata transaction.
    event(op, state, "result-imported", check=report["check_id"], observation_state=report["state"], outcome=report["outcome"])


def execute(op, state):
    root, manifest = Path(state["root"]), state["manifest"]
    verify(state, applied=state["steps"][0]["state"] == "done")
    for step in state["steps"]:
        if step["state"] == "done":
            continue
        if step["state"] in ("failed", "uncertain"):
            return 1 if step["state"] == "failed" else 2
        verify(state, applied=step["id"] != "apply")
        if "check_id" in step:
            # Validation owns execution. Never manufacture a job or restart a check.
            return 3
        was_ready = step["state"] == "ready"
        if was_ready:
            step["state"] = "started"
            event(op, state, "step-intent", step=step["id"])
        if step["id"] == "apply":
            patch_bytes = (op / "reviewed.patch").read_bytes()
            require(digest(patch_bytes) == manifest["patch"]["sha256"], "frozen patch corrupted")
            content = g.prepared_patch(root, manifest, patch_bytes)
            g.apply_files(root, manifest["patch"]["before"], manifest["patch"]["after"], content)
            verify(state, applied=True)
            finish(op, state, step)
        elif step["id"] == "evidence":
            state["evidence"] = [e for e in state["evidence"] if "check_id" in e] + [
                {**e, "current_for_reviewed_source": not e["reused"] and e["source_commit"] == manifest["source"]["commit"]}
                for e in manifest["evidence"]]
            finish(op, state, step)
        elif step["id"] == "checkpoint":
            g.whitespace(root, manifest["owned_paths"])
            if not g.index_matches(root, manifest["patch"]["after"]):
                g.git(root, "add", "--", *manifest["owned_paths"])
            require(g.index_matches(root, manifest["patch"]["after"]), "staged bytes differ from reviewed postimages")
            verify(state, applied=True)
            state["checkpoint"] = {"id": manifest["id"], "source_binding": state["source_binding"],
                                   "scope": manifest["checkpoint"]["scope"],
                                   "blockers": manifest["checkpoint"]["blockers"],
                                   "finding_closure": False, "broader_support_established": False}
            finish(op, state, step)
        elif step["id"] == "commit":
            commit_step(op, state, step)
        elif step["id"] == "push":
            push_step(op, state, step, was_ready)
    return 0


def commit_step(op, state, step):
    root, manifest = Path(state["root"]), state["manifest"]
    if "commit" not in step:
        if "identity" not in step:
            step["identity"] = {"author": g.git(root, "var", "GIT_AUTHOR_IDENT").decode().strip(),
                                "committer": g.git(root, "var", "GIT_COMMITTER_IDENT").decode().strip()}
            save(op, state)
        identity_env = {}
        for kind, value in step["identity"].items():
            match = re.fullmatch(r"(.*) <([^<>]+)> (\d+ [+-]\d{4})", value)
            require(match is not None, "invalid Git commit identity")
            for key, item in zip(("NAME", "EMAIL", "DATE"), match.groups()):
                identity_env["GIT_" + kind.upper() + "_" + key] = item
        with g.index(root, manifest["base_commit"]) as index_env:
            g.git(root, "add", "--", *manifest["owned_paths"], env=index_env)
            require(g.index_matches(root, manifest["patch"]["after"], index_env), "commit bytes differ from reviewed postimages")
            tree = g.git(root, "write-tree", env=index_env).decode().strip()
        # Create and journal the commit object before moving HEAD. CAS recovery
        # recognizes an already-completed update without invoking hooks again.
        commit = g.git(root, "commit-tree", tree, "-p", manifest["base_commit"],
                       env=identity_env, data=(manifest["commit"]["message"].rstrip() + "\n").encode()).decode().strip()
        step["commit"] = commit
        save(op, state)
    if g.rev(root, "HEAD") != step["commit"]:
        g.git(root, "update-ref", state["branch"], step["commit"], manifest["base_commit"])
    finish(op, state, step)


def push_step(op, state, step, was_ready):
    root, config = Path(state["root"]), state["manifest"]["push"]
    commit = next(s["commit"] for s in state["steps"] if s["id"] == "commit")
    current = remote_head(root, state["push_url"], config["ref"])
    if current == commit:
        finish(op, state, step, remote_commit=commit)
        return
    require(was_ready, "uncertain push outcome; remote does not contain checkpoint; inspect before any retry")
    require(current == config["expected"], "remote moved before push")
    require(g.git(root, "remote", "get-url", "--push", config["remote"]).decode().strip() == state["push_url"],
            "push URL changed")
    # Non-force, explicit object and destination; never push an implicitly moving branch.
    result = g.run(["git", "push", "--porcelain", state["push_url"], commit + ":" + config["ref"]], root,
                   ok=tuple(range(256)))
    g.atomic(op / "push.log", result.stdout + result.stderr)
    require(remote_head(root, state["push_url"], config["ref"]) == commit, "uncertain/failed push; inspect push.log")
    finish(op, state, step, remote_commit=commit)


def run_operation(op, state):
    try:
        return execute(op, state)
    except (Invalid, OSError, ValueError) as error:
        step = next((s for s in state["steps"] if s["state"] != "done"), None)
        if step:
            step["state"] = "uncertain"
        state["failures"].append({"step": step["id"] if step else None, "detail": str(error), "at": time.time()})
        event(op, state, "blocked", detail=str(error))
        return 2
