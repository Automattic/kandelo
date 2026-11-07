#!/usr/bin/env python3
"""Install, update, check, or remove Kandelo's opt-in agent hooks.

Why it exists: a hook saves tokens only once it is wired into a settings
file, and that file also holds plugins, permissions, and other hooks. Doing
it by hand risks breaking those, or leaves a stale copy behind after the
hook changes. This script makes installing, updating, and removing it one
safe, repeatable command.

Deterministic and idempotent: running it twice changes nothing the second
time. It edits only its own hook entry in a Claude Code settings file and
keeps every other setting; the previous file is saved next to it as
<file>.bak before any change.

  python3 .claude/hooks/install-hooks.py --user           # ~/.claude/settings.json
  python3 .claude/hooks/install-hooks.py --project-local  # this checkout's .claude/settings.local.json
  python3 .claude/hooks/install-hooks.py --user --check   # exit 1 if missing or out of date
  python3 .claude/hooks/install-hooks.py --user --update-from-main  # existing opt-ins only; no downgrade
  python3 .claude/hooks/install-hooks.py --user --uninstall

--user copies the hook to ~/.claude/hooks/kandelo-wait-guard.py and points
user settings at that copy, rather than at a file inside whichever project is
open: a user-level hook that ran a repository's own file would run whatever
any repository put there. Main agents use --user --update-from-main after
fetching origin main to maintain existing opt-ins from the merged branch,
without downgrades. Plain --user remains the explicit install/update path;
--check says when the copy differs, and the installed hook itself shows a
notice once per session when the checkout has a higher HOOK_VERSION.
--project-local points this checkout's
untracked settings.local.json at the checked-in hook, so it follows the
branch you are on.

Hooks installed:
  wait-guard.py  PreToolUse/Bash: blocks sleep-then-peek polls, `pgrep -f`
                 waiters, and subagents running whole-tree builds or full
                 suites. See evals/build-waiting/README.md (tools 8 and 8b).
"""
import argparse
import filecmp
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HOOK = os.path.join(HERE, "wait-guard.py")
MARKER = "wait-guard.py"  # identifies our entry in either scope
USER_COPY = os.path.expanduser("~/.claude/hooks/kandelo-wait-guard.py")
VERSION_LINE = re.compile(r"^HOOK_VERSION = (\d+)$", re.M)


def target(args):
    if args.user:
        return (os.path.expanduser("~/.claude/settings.json"),
                f"python3 {USER_COPY.replace(os.path.expanduser('~'), '~', 1)}")
    return (os.path.join(REPO, ".claude", "settings.local.json"),
            'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/wait-guard.py"')


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def ours(hook):
    return MARKER in (hook.get("command") or "")


def without_ours(settings):
    """Settings with every entry of ours removed (empty groups dropped)."""
    out = json.loads(json.dumps(settings))
    groups = out.get("hooks", {}).get("PreToolUse", [])
    kept = []
    for group in groups:
        hooks = [h for h in group.get("hooks", []) if not ours(h)]
        if hooks:
            kept.append(dict(group, hooks=hooks))
    if "hooks" in out:
        if kept:
            out["hooks"]["PreToolUse"] = kept
        else:
            out["hooks"].pop("PreToolUse", None)
        if not out["hooks"]:
            out.pop("hooks")
    return out


def with_ours(settings, command):
    out = without_ours(settings)
    out.setdefault("hooks", {}).setdefault("PreToolUse", []).append(
        {"matcher": "Bash", "hooks": [{"type": "command", "command": command, "timeout": 10}]})
    return out


def write(path, settings):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def update_from_main(path):
    """Refresh an existing opt-in using only the fetched origin/main files.

    Never turn a feature branch into globally executed code, or let a
    concurrent agent on an older revision downgrade a newer installed hook.
    The hook itself still only reports staleness; the main agent initiates
    this explicit update after fetching the trusted branch.
    """
    def installed():
        return any(ours(h) for g in load(path).get("hooks", {}).get("PreToolUse", [])
                   for h in g.get("hooks", []))

    if not installed():
        print("user wait guard is not installed; leaving opt-in unchanged")
        return 0
    os.makedirs(os.path.dirname(USER_COPY), exist_ok=True)
    with open(USER_COPY + ".update.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not installed():  # another agent or the user may have uninstalled it
            return 0
        files = {}
        for name in ("wait-guard.py", "install-hooks.py"):
            result = subprocess.run(["git", "show", f"origin/main:.claude/hooks/{name}"], cwd=REPO,
                                    capture_output=True, check=True)
            files[name] = result.stdout
        source = VERSION_LINE.search(files["wait-guard.py"].decode())
        if not source:
            raise ValueError("origin/main wait guard has no HOOK_VERSION; refusing automatic update")
        versions = []
        for name in ("kandelo-wait-guard.py", "wait-guard.py"):
            candidate = os.path.join(os.path.dirname(USER_COPY), name)
            if os.path.isfile(candidate):
                with open(candidate) as f:
                    version = VERSION_LINE.search(f.read())
                if version:
                    versions.append(int(version.group(1)))
        # Unversioned copies predate v3. Equal versions need no reinstall;
        # edits require a version bump, including changes to denial messages.
        if int(source.group(1)) <= max(versions, default=0):
            print(f"user wait guard is already at least origin/main v{source.group(1)}; no change")
            return 0
        with tempfile.TemporaryDirectory(prefix="kandelo-hook-update-") as tmp:
            hooks = os.path.join(tmp, ".claude", "hooks")
            os.makedirs(hooks)
            for name, content in files.items():
                with open(os.path.join(hooks, name), "wb") as f:
                    f.write(content)
            # The merged installer owns settings migration/backups. Never run
            # the feature branch's installer to change the user-level entry.
            return subprocess.run([sys.executable, os.path.join(hooks, "install-hooks.py"), "--user"],
                                  check=True).returncode


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    scope = ap.add_mutually_exclusive_group(required=True)
    scope.add_argument("--user", action="store_true")
    scope.add_argument("--project-local", action="store_true")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    mode.add_argument("--update-from-main", action="store_true",
                      help="update an existing user installation from fetched origin/main, without downgrading")
    args = ap.parse_args()
    if args.update_from_main and not args.user:
        ap.error("--update-from-main requires --user")

    path, command = target(args)
    if args.update_from_main:
        return update_from_main(path)
    current = load(path)
    wanted = without_ours(current) if args.uninstall else with_ours(current, command)
    settings_ok = current == wanted
    copy_ok = not args.user or args.uninstall or (
        os.path.exists(USER_COPY) and filecmp.cmp(HOOK, USER_COPY, shallow=False))

    if args.check:
        if settings_ok and copy_ok:
            print(f"up to date: {path}")
            return 0
        print(f"out of date: {path}" + ("" if copy_ok else f" (hook copy {USER_COPY} differs or is missing)"))
        print("run without --check to update")
        return 1

    if args.user and args.uninstall and os.path.exists(USER_COPY):
        os.remove(USER_COPY)
        print(f"removed {USER_COPY}")
    if args.user and not args.uninstall and not copy_ok:
        os.makedirs(os.path.dirname(USER_COPY), exist_ok=True)
        shutil.copy2(HOOK, USER_COPY)
        print(f"copied {HOOK} -> {USER_COPY}")
    if settings_ok:
        print(f"no change to {path}")
    else:
        write(path, wanted)
        print(f"{'removed from' if args.uninstall else 'installed in'} {path} (previous file: {path}.bak)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
