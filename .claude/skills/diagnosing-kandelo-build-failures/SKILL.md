---
name: diagnosing-kandelo-build-failures
description: Use when a Kandelo package build, build-deps resolve, ./run.sh setup, or local-build fails, or when a ported wasm program traps on an unresolved import or behaves as if a library function is missing.
---

# Diagnosing Kandelo Build Failures

## Overview

Build logs run to thousands of lines, and the resolver deletes the build's work directory (including `config.log`) on failure. Summarize the captured log instead of reading it, find the FIRST failure, then trace it to its layer: package recipe, dependency declaration, SDK/sysroot, or a real platform gap.

## Quick reference

```bash
# Summarize a failed build log (first distinct failures + context + known-cause hints)
python3 .claude/skills/diagnosing-kandelo-build-failures/scripts/diagnose-build-log.py <log> [--max N]

# A built program traps or misbehaves: list its imports (needs wabt, so use the dev shell)
scripts/dev-shell.sh python3 .claude/skills/diagnosing-kandelo-build-failures/scripts/diagnose-build-log.py --imports <program.wasm>
```

No log yet? Rebuild with output redirected (`cmd > .context/<name>.log 2>&1; echo exit=$?`) or use the porting skill's `build-package.sh`, which writes the log and runs this summary for you.

## Reading the result

- The `[FIRST]` entry is usually the cause; later entries are usually fallout.
- `hint:` lines map known patterns to the doc or command that explains them. A hint is a lead, not a verdict: confirm it before acting.
- `env.*` function imports in `--imports` output are symbols no static library provided (`-Wl,--allow-undefined` turns them into imports). Unexpected ones mean a missing `LIBS` entry, an undeclared dep, or a stale sysroot archive.

## Need `config.log`?

The resolver deletes the work directory, so re-run just the configure step by hand in a scratch directory under `.context/` with the SDK activated (`source sdk/activate.sh` inside `scripts/dev-shell.sh`), then grep `config.log` for the failing `ac_cv_` test. Do not patch the build script to keep its work tree.

## Common mistakes

| Mistake | Instead |
|---|---|
| Reading the whole log, or `cat`-ing build output into the transcript | Run the summary; open the log only at the reported line numbers |
| Fixing the last error printed | Fix `[FIRST]`; rebuild; re-summarize |
| Rebuilding one artifact after a closure error ("artifact closure is incomplete") | Run the full front door, `scripts/dev-shell.sh ./run.sh setup` |
| Patching the package around a missing libc/syscall behavior | Treat it as a platform gap (`docs/agent-guidance/debugging-and-posix.md`) |
