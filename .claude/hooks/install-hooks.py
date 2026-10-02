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
  python3 .claude/hooks/install-hooks.py --user --uninstall

--user copies the hook to ~/.claude/hooks/kandelo-wait-guard.py and points
user settings at that copy, rather than at a file inside whichever project is
open: a user-level hook that ran a repository's own file would run whatever
any repository put there. Re-run --user after pulling a newer hook; --check
says when the copy is stale. --project-local points this checkout's
untracked settings.local.json at the checked-in hook, so it follows the
branch you are on.

Hooks installed:
  wait-guard.py  PreToolUse/Bash: blocks sleep-then-peek polls, `pgrep -f`
                 waiters, and subagents running whole-tree builds or full
                 suites. See evals/build-waiting/README.md (tools 8 and 8b).
"""
import argparse
import filecmp
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HOOK = os.path.join(HERE, "wait-guard.py")
MARKER = "wait-guard.py"  # identifies our entry in either scope
USER_COPY = os.path.expanduser("~/.claude/hooks/kandelo-wait-guard.py")


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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    scope = ap.add_mutually_exclusive_group(required=True)
    scope.add_argument("--user", action="store_true")
    scope.add_argument("--project-local", action="store_true")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    path, command = target(args)
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
