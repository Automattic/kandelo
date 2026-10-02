#!/usr/bin/env python3
"""PreToolUse hook for Bash: block the waiting patterns that cost the most.

Measured over Aug-Sep 2026 Kandelo transcripts (evals/build-waiting):
  - `sleep N; tail log` poll turns: each re-reads the whole context;
  - `until ! pgrep -f "<pattern>"` waiters: the waiting shell's own command
    line contains the pattern, so they never exit;
  - subagents running whole-tree builds in the foreground: a subagent's prompt
    cache lives 5 minutes, so every long blocking call rewrites its context
    (938M input-equivalent tokens in the baseline, the largest waiting cost).

Each denial says what to do instead (scripts/agent-job). A command containing
the marker `agent-job: allow-wait` passes; that override is logged, and the
eval counts overrides as evasions. Every decision is appended to
~/.cache/kandelo/agent-jobs/hook-log.jsonl for review.

Opt-in. Install or update it with .claude/hooks/install-hooks.py (see that
file, or "Waiting on long builds and suites" in
docs/agent-guidance/validation.md). It acts only inside a checkout that has
scripts/agent-job, the tool its advice points to; everywhere else it allows
every command.

Judged by evals/build-waiting/README.md (tools 8 and 8b). Fails open: any
error allows the command.
"""
import json
import os
import re
import shlex
import sys
import time

LOG = os.path.expanduser(os.environ.get("KANDELO_AGENT_JOBS_DIR", "~/.cache/kandelo/agent-jobs"))
# An escape hatch for the rare legitimate case the rules misjudge. Every
# use is logged, and the eval counts overrides as evasions, so a rule that
# keeps getting overridden shows up as a rule to fix.
OVERRIDE = "agent-job: allow-wait"
# Short sleeps (letting a server bind, waiting after a kill) are not poll
# turns. 30 s and up, followed by a look at the output, is the
# turn-per-check pattern this hook exists to stop.
POLL_SLEEP_SECONDS = 30

# A loop waiting on `pgrep -f`. The loop's own shell has the pattern on
# its command line, so pgrep always finds it and the wait never ends.
PGREP_WAITER = re.compile(r"\b(until|while)\b[^\n]*?\bpgrep\s+(-\w*\s+)*-\w*f")
# A loop in one command blocks inside a single tool call, so it is not a
# turn-per-check poll. It is left to the other rules.
LOOP = re.compile(r"\b(until|while|for)\b.*\bdo\b", re.S)
PEEK = re.compile(r"tail|cat|grep|rg|wc|ls|ps|pgrep|lsof|du|head|stat|sed|awk")
WRAPPER = re.compile(r"^(\S*dev-shell\.sh|bash|sh|zsh|-l|-e|-euo|-eu|pipefail|nohup|env|time|exec|command)$")
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Heredoc bodies (commit messages, inline scripts) are text, not commands.
# Matching inside them denied `git commit` for mentioning `./run.sh setup`.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)", re.S)
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", ";;", "\n"}


def invoked_commands(cmd, depth=0):
    """The words of every simple command the shell line would run.

    Uses a shell tokenizer, so quoted strings stay whole (`grep -E "a|run.sh"`
    is one grep), heredoc bodies (commit messages, inline scripts) are
    skipped, and `bash -c '<body>'` bodies are scanned recursively. Wrappers
    (dev-shell.sh, bash, timeout N, env assignments) are skipped, so a script
    is matched only where it is run, not where it is mentioned.
    """
    if depth > 3:
        return
    body = HEREDOC.sub("", cmd)
    lex = shlex.shlex(body.replace("\n", " ; "), posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    lex.commenters = "#"
    try:
        tokens = list(lex)
    except ValueError:
        return  # unbalanced quotes: fail open
    words = []
    for tok in tokens + [";"]:
        if tok not in SEPARATORS and not set(tok) <= set(";&|()"):
            words.append(tok)
            continue
        toks = words
        words = []
        while toks:
            if toks[0] in ("-c", "-lc") and len(toks) > 1:
                yield from invoked_commands(toks[1], depth + 1)
                toks = []
            elif WRAPPER.match(toks[0]) or ASSIGN.match(toks[0]):
                toks = toks[1:]
            elif toks[0] == "timeout":
                rest = [t for t in toks[1:] if not t.startswith("-")]
                toks = rest[1:]
            elif toks[0] in ("cd", "do", "then", "else", "!", "{", "}"):
                toks = toks[2:] if toks[0] == "cd" else toks[1:]
            else:
                break
        clean, skip = [], False
        for t in toks:  # drop redirections and their targets
            if skip:
                skip = False
            elif re.match(r"^\d*(>>?|<)&?\d*$", t):
                skip = not re.search(r"&\d+$", t)
            elif not re.match(r"^\d*(>>?|<)", t):
                clean.append(t)
        if clean:
            yield clean


def whole_tree_run(cmd):
    """True when the line runs a whole-tree build or a full suite.

    Per-package builds and named test files or interfaces are left alone:
    porting and debugging subagents exist to run them.
    """
    for toks in invoked_commands(cmd):
        head = os.path.basename(toks[0])
        args = [t for t in toks[1:] if not t.startswith("-")]
        if head == "run.sh" and args[:1] and args[0] in ("setup", "local-build", "prepare-browser", "build-browser",
                                                          "test"):
            return True
        if head in ("setup.sh", "ci-run-test-suite.sh"):
            return True
        if re.match(r"run-(libc|posix|sortix)-tests\.sh$", head) and not args and \
                not {"--list", "--help", "-h"} & set(toks):
            return True
        if "bootstrap" in toks and (head.endswith("xtask") or head == "cargo"):
            after = toks[toks.index("bootstrap") + 1:]
            if not [t for t in after if not t.startswith("-")] and not {"--help", "-h"} & set(after):
                return True  # bare bootstrap = ./run.sh setup; `bootstrap <target>` is targeted
        if (head == "npx" and args[:2] == ["vitest", "run"] and len(args) == 2) or \
                (head == "vitest" and args == ["run"]):
            return True
    return False


def decide(payload):
    # Returns (rule, reason). A reason means deny, and it always says what to
    # do instead, because a bare denial just gets retried in another form.
    inp = payload.get("tool_input") or {}
    cmd = inp.get("command") or ""
    if not cmd:
        return None, None
    if OVERRIDE in cmd:
        return "override", None
    if PGREP_WAITER.search(HEREDOC.sub("", cmd)):
        return "pgrep-waiter", (
            "This waits on `pgrep -f <pattern>`, which also matches the waiting shell's own command line, "
            "so the loop never exits and its elapsed times describe the waiter. Wait on a PID instead: "
            "start the work with `scripts/agent-job start -- <command>` and run "
            "`scripts/agent-job wait <id>` (blocks up to 9 min; exit 124 means still running, run it again). "
            "For a process you did not start, `while kill -0 <pid>; do sleep 30; done`.")
    # Only subagents carry agent_id. A main session's prompt cache lasts an
    # hour, so it can wait cheaply. A subagent's lasts 5 minutes, so a long
    # blocking call rewrites its whole context: 938M input-equivalent tokens
    # in Aug-Sep 2026, the largest waiting cost measured.
    if payload.get("agent_id") and whole_tree_run(cmd):
        return "subagent-whole-tree", (
            "Subagents must not wait on whole-tree builds or full suites: a subagent's prompt cache expires "
            "after 5 minutes, so a long blocking call rewrites your whole context, and the parent session "
            "can wait for free. Stop here and report back to your parent exactly what needs to be built or "
            "run (the command) and why; it will run it and give you the result. Per-package builds and "
            "single vitest files are fine to run yourself.")
    commands = list(invoked_commands(cmd))
    sleeps = [int(t[1]) for t in commands if t[0] == "sleep" and len(t) > 1 and t[1].isdigit()]
    peeks = [t for t in commands if PEEK.fullmatch(os.path.basename(t[0]))]
    if sleeps and max(sleeps) >= POLL_SLEEP_SECONDS and peeks and not LOOP.search(HEREDOC.sub("", cmd)):
        return "sleep-poll", (
            f"`sleep {max(sleeps)}` followed by a peek is a poll turn: each one re-reads your whole context "
            "and the work is no further along. Under 10 minutes, run the work itself in the foreground in one "
            "call. Longer: `scripts/agent-job start -- <command>`, then `scripts/agent-job wait <id>` "
            "(blocks up to 9 min; exit 124 means still running, run it again). To see progress without "
            "waiting, `scripts/agent-job status <id>`.")
    return None, None


def log(payload, rule, denied):
    # Every decision is kept so denials can be reviewed for false positives;
    # the keep rule needs at least 90% of denials to be real wait loops.
    try:
        os.makedirs(LOG, exist_ok=True)
        with open(os.path.join(LOG, "hook-log.jsonl"), "a") as f:
            f.write(json.dumps({
                "at": time.time(), "rule": rule, "denied": denied,
                "session_id": payload.get("session_id"), "agent_id": payload.get("agent_id"),
                "cwd": payload.get("cwd"), "command": (payload.get("tool_input") or {}).get("command", "")[:500],
            }) + "\n")
    except OSError:
        pass


def in_agent_job_checkout(cwd):
    """True when cwd is inside a checkout that ships scripts/agent-job.

    The hook may be installed for every project (user settings); its advice
    only makes sense where agent-job exists, including older Kandelo branches
    that predate it, so elsewhere it stays out of the way.
    """
    path = os.path.abspath(cwd or os.getcwd())
    while True:
        if os.path.isfile(os.path.join(path, "scripts", "agent-job")):
            return True
        parent = os.path.dirname(path)
        if parent == path:
            return False
        path = parent


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    if payload.get("tool_name") != "Bash":
        return
    if not in_agent_job_checkout(payload.get("cwd")):
        return
    rule, reason = decide(payload)
    if not rule:
        return
    log(payload, rule, bool(reason))
    if reason:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never break Bash because of this guard
