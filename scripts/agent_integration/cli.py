import argparse
import json
from pathlib import Path
import sys
import time

from . import engine, gitops as g
from .manifest import Invalid, identity, load, require


def current_status(op, state):
    manifest, root = state["manifest"], Path(state["root"])
    drift = {"source": [], "main": [], "target": [], "inputs": []}
    source = manifest["source"]
    for kind, location, ref, expected in [
            ("source", Path(source["root"]), source["ref"], source["commit"]),
            ("main", root, manifest["main"]["ref"], manifest["main"]["commit"])]:
        try:
            actual = g.rev(location, ref)
        except (Invalid, OSError):
            actual = "unavailable"
        if kind == "source":
            current_source_commit = actual
        if actual != expected:
            drift[kind].append({"ref": ref, "frozen": expected, "current": actual})
    allowed_head = next((s["commit"] for s in state["steps"] if s["id"] == "commit" and s.get("commit")), manifest["base_commit"])
    head = g.rev(root, "HEAD")
    if head != allowed_head:
        drift["target"].append({"ref": "HEAD", "frozen": allowed_head, "current": head})
    for kind, location, identities in [
            ("source", Path(source["root"]), source["identities"]),
            ("inputs", root, {**state["records"], **state["result_files"]}),
            ("target", root, manifest["patch"]["after"] if state["steps"][0]["state"] == "done" else manifest["patch"]["before"])]:
        for name, expected in identities.items():
            try:
                actual = identity(location, name)
            except (Invalid, OSError):
                actual = "unavailable"
            if actual != expected:
                drift[kind].append({"path": name, "frozen": expected, "current": actual})
    steps = [dict(step) for step in state["steps"]]
    active = [{"step": step["id"], "id": step["job_id"], "state": step["state"], "log": step.get("log")}
              for step in state["steps"] if step.get("job_id") and step["state"] in ("waiting", "uncertain")]
    pending = next((s for s in steps if s["state"] != "done"), None)
    if pending is None:
        next_action = "complete; inspect scoped evidence and declared blockers"
    elif pending["state"] in ("failed", "uncertain"):
        next_action = f"inspect {pending['id']} failure/log; automatic repetition is blocked"
    elif pending.get("check_id"):
        next_action = f"await validation manager result for {pending['check_id']}; import with record"
    else:
        next_action = f"agent-integrate resume {manifest['id']}"
    return {"id": manifest["id"], "source_commit": source["commit"], "source_binding": state["source_binding"],
            "frozen_main": manifest["main"], "drift": drift,
            "evidence_current_for_frozen_inputs": bool(state["evidence"]) and not drift["inputs"] and not drift["target"],
            "completed_steps": [s["id"] for s in steps if s["state"] == "done"], "steps": steps,
            "active_jobs": active, "failures": state["failures"],
            "blockers": manifest["checkpoint"]["blockers"], "next_action": next_action,
            "scope": manifest["checkpoint"]["scope"], "ledger": str(op / "ledger.json"),
            "checkpoint": state["checkpoint"], "source_root": source["root"],
            "current_source_ref_commit": current_source_commit,
            "current_target_commit": head, "check_requests": manifest["checks"],
            "evidence": [{k: v for k, v in e.items() if k not in ("argv",)} for e in state["evidence"]]}


def display(op, state, as_json=False):
    status = current_status(op, state)
    if as_json:
        print(json.dumps(status, indent=2))
        return
    print(f"{status['id']} frozen_source={status['source_commit']} frozen_main={status['frozen_main']['commit']}")
    print("done: " + (", ".join(status["completed_steps"]) or "none"))
    for kind, entries in status["drift"].items():
        if entries:
            print(f"{kind} drift: " + json.dumps(entries, separators=(",", ":")))
    print(f"scope: {status['scope']}; evidence current for frozen inputs: {status['evidence_current_for_frozen_inputs']}")
    for job in status["active_jobs"]:
        print(f"job: {job['id']} ({job['state']}); log: {job['log']}")
    for failure in status["failures"][-3:]:
        detail = failure.get("detail", f"{failure.get('outcome')} (exit {failure.get('exit_code')}); log: {failure.get('log')}")
        print(f"failure: {failure['step']}: {detail}")
    for blocker in status["blockers"]:
        print("blocker: " + blocker)
    print("next: " + status["next_action"])
    print("ledger: " + status["ledger"])


def main():
    parser = argparse.ArgumentParser(description="Apply one reviewed manifest, journal checks and checkpoint owned paths.")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "run"):
        command = sub.add_parser(name)
        command.add_argument("manifest", type=Path)
        if name == "run":
            command.add_argument("--commit", action="store_true")
            command.add_argument("--push", action="store_true")
    command = sub.add_parser("resume")
    command.add_argument("id")
    command = sub.add_parser("record", help="import reviewed evidence; never execute a check")
    command.add_argument("id")
    command.add_argument("--report", type=Path, required=True)
    command.add_argument("--sha256", required=True)
    for name in ("status", "handoff"):
        command = sub.add_parser(name)
        command.add_argument("id")
        command.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        require(g.git(root, "rev-parse", "--show-toplevel").decode().strip() == str(root), "root must be the Git worktree root")
        if args.command == "preflight":
            manifest, _, _, _, _ = engine.preflight(root, args.manifest.resolve())
            print(json.dumps({"ok": True, "id": manifest["id"], "source_commit": manifest["source"]["commit"],
                              "base_commit": manifest["base_commit"], "main": manifest["main"]}))
            return 0
        if args.command in ("status", "handoff"):
            op = engine.operation(root, args.id)
            state = load(op / "ledger.json")
            require(state["root"] == str(root), "operation belongs to another worktree")
            display(op, state, args.json)
            return 0
        with engine.lock(root):
            if args.command == "run":
                op, state = engine.create(root, args.manifest.resolve(), args.commit, args.push)
            else:
                op = engine.operation(root, args.id)
                state = load(op / "ledger.json")
                require(state["root"] == str(root), "operation belongs to another worktree")
            if args.command == "record":
                try:
                    engine.record_report(op, state, args.report.resolve(), args.sha256)
                except (Invalid, OSError, ValueError, KeyError) as error:
                    # A rejected report must not publish any in-memory partial
                    # evidence update. Record the rejection on the durable state.
                    durable = load(op / "ledger.json")
                    durable["failures"].append({"step": "record", "detail": str(error), "at": time.time()})
                    engine.event(op, durable, "result-rejected", detail=str(error), report=str(args.report))
                    raise
            code = engine.run_operation(op, state)
            display(op, state)
            return code
    except (Invalid, OSError, ValueError, KeyError) as error:
        print(f"agent-integrate: {error}", file=sys.stderr)
        return 2
