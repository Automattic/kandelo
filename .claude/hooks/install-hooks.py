#!/usr/bin/env python3
"""Install, update, check, or remove Kandelo's opt-in agent hooks.

Why it exists: a hook saves tokens only once it is wired into a settings
file, and that file also holds plugins, permissions, and other hooks. Doing
it by hand risks breaking those, or leaves a stale copy behind after the
hook changes. This script makes installing, updating, and removing it one
safe, repeatable command.

Deterministic and idempotent: running it twice changes nothing the second
time. It edits only its own hook entry in the selected client's settings and
keeps every other setting; the previous file is saved next to it as
<file>.bak before any change.

  python3 .claude/hooks/install-hooks.py --user           # ~/.claude/settings.json
  python3 .claude/hooks/install-hooks.py --project-local  # this checkout's .claude/settings.local.json
  python3 .claude/hooks/install-hooks.py --user --check   # exit 1 if missing or out of date
  python3 .claude/hooks/install-hooks.py --user --update-from-main  # existing opt-ins only; no downgrade
  python3 .claude/hooks/install-hooks.py --user --uninstall
  python3 .claude/hooks/install-hooks.py --user --hook context
  python3 .claude/hooks/install-hooks.py --user --hook context --client codex

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
  --hook context selects the independent, advisory context-checkpoint hook.
                 PreToolUse/all tools, once per agent at 250k context tokens.
                 Does not enable wait-guard or rotate workers.

Codex context hooks use an existing hooks.json, or a marked block in
config.toml when that is the layer's representation. Other settings and
hook trust records are preserved. Registration does not grant trust: Codex
requires reviewing the new definition in /hooks before it executes.
"""
import argparse
import filecmp
import fcntl
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
MARKER = "wait-guard.py"  # identifies our entry in either scope
PROFILES = {
    "wait": ("wait-guard.py", "kandelo-wait-guard.py", "Bash"),
    "context": ("context-checkpoint.py", "kandelo-context-checkpoint.py", ""),
}
CODEX_BLOCK = re.compile(
    r"\n\n# BEGIN Kandelo context checkpoint hook\n.*?"
    r"# END Kandelo context checkpoint hook\n", re.S)
USER_COPY = os.path.expanduser("~/.claude/hooks/kandelo-wait-guard.py")
VERSION_LINE = re.compile(r"^HOOK_VERSION = (\d+)$", re.M)


def target(args, filename, user_copy):
    if args.client == "codex":
        directory = os.path.expanduser("~/.codex") if args.user else os.path.join(REPO, ".codex")
        hooks = os.path.join(directory, "hooks.json")
        path = hooks if os.path.exists(hooks) else os.path.join(directory, "config.toml")
        source = user_copy if args.user else os.path.join(HERE, filename)
        return path, f"python3 {shlex.quote(source)} hook-codex"
    if args.user:
        return (os.path.expanduser("~/.claude/settings.json"),
                f"python3 {shlex.quote(user_copy)}")
    return (os.path.join(REPO, ".claude", "settings.local.json"),
            f'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/{filename}"')


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def ours(hook, marker=MARKER):
    return marker in (hook.get("command") or "")


def without_ours(settings, marker=MARKER):
    """Settings with every entry of ours removed (empty groups dropped)."""
    out = json.loads(json.dumps(settings))
    groups = out.get("hooks", {}).get("PreToolUse", [])
    kept = []
    for group in groups:
        hooks = [h for h in group.get("hooks", []) if not ours(h, marker)]
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


def with_ours(settings, command, marker=MARKER, matcher="Bash"):
    out = without_ours(settings, marker)
    out.setdefault("hooks", {}).setdefault("PreToolUse", []).append(
        {"matcher": matcher, "hooks": [{"type": "command", "command": command, "timeout": 10}]})
    return out


def codex_toml(current, command, uninstall=False):
    import tomllib
    tomllib.loads(current)
    stripped = CODEX_BLOCK.sub("", current)
    if "# BEGIN Kandelo context checkpoint hook" in stripped or "# END Kandelo context checkpoint hook" in stripped:
        raise ValueError("incomplete Kandelo hook block; restore its markers before updating")
    if uninstall:
        wanted = stripped
    else:
        # JSON quoting of this single string is also valid TOML basic-string
        # quoting. The rest of config.toml is preserved byte for byte.
        wanted = stripped + (
            '\n\n# BEGIN Kandelo context checkpoint hook\n'
            '[[hooks.PreToolUse]]\nmatcher = ""\n'
            '[[hooks.PreToolUse.hooks]]\ntype = "command"\n'
            f'command = {json.dumps(command)}\ntimeout = 10\n'
            '# END Kandelo context checkpoint hook\n')
    tomllib.loads(wanted)
    return wanted


def write(path, settings):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        if isinstance(settings, str):
            f.write(settings)
        else:
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
                      help="update an existing user wait guard from fetched origin/main, without downgrading")
    ap.add_argument("--hook", choices=PROFILES, default="wait",
                    help="independent hook to install/check/remove (default: wait)")
    ap.add_argument("--client", choices=("claude", "codex"), default="claude")
    args = ap.parse_args()
    if args.update_from_main:
        if not args.user:
            ap.error("--update-from-main requires --user")
        if args.hook != "wait" or args.client != "claude":
            ap.error("--update-from-main supports only --hook wait --client claude")
    if args.client == "codex" and args.hook != "context":
        ap.error("the Codex adapter supports --hook context; wait-guard is Claude Code-only")

    filename, installed_name, matcher = PROFILES[args.hook]
    source = os.path.join(HERE, filename)
    client_dir = ".codex" if args.client == "codex" else ".claude"
    user_copy = os.path.expanduser("~/" + client_dir + "/hooks/" + installed_name)
    path, command = target(args, filename, user_copy)
    if args.update_from_main:
        return update_from_main(path)
    if args.client == "codex" and path.endswith(".toml"):
        try:
            with open(path) as stream:
                current = stream.read()
        except FileNotFoundError:
            current = ""
        wanted = codex_toml(current, command, uninstall=args.uninstall)
    else:
        current = load(path)
        wanted = without_ours(current, filename) if args.uninstall else with_ours(current, command, filename, matcher)
    settings_ok = current == wanted
    copy_ok = not args.user or args.uninstall or (
        os.path.exists(user_copy) and filecmp.cmp(source, user_copy, shallow=False))

    if args.check:
        if settings_ok and copy_ok:
            print(f"up to date: {path}")
            return 0
        print(f"out of date: {path}" + ("" if copy_ok else f" (hook copy {user_copy} differs or is missing)"))
        print("run without --check to update")
        return 1

    if args.user and args.uninstall and os.path.exists(user_copy):
        os.remove(user_copy)
        print(f"removed {user_copy}")
    if args.user and not args.uninstall and not copy_ok:
        os.makedirs(os.path.dirname(user_copy), exist_ok=True)
        shutil.copy2(source, user_copy)
        print(f"copied {source} -> {user_copy}")
    if settings_ok:
        print(f"no change to {path}")
    else:
        write(path, wanted)
        print(f"{'removed from' if args.uninstall else 'installed in'} {path} (previous file: {path}.bak)")
    if args.client == "codex" and not args.uninstall:
        print("Codex registration is ready; review the new/changed definition in /hooks before it can run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
