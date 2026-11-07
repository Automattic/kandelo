# Campaign checkpoints

Agents manage their own checkpoints; the user keeps assigning and steering
work normally. Preserve their scope and delegation preferences. This guide
adds checkpoint support, not automatic worker rotation. The quality/cost
trial and keep rule are in `evals/agent-skills/README.md`.

When delegating a long campaign, give each worker a bounded phase with
acceptance checks. Keep decisions, job ownership and integration with the
coordinator. The existing validation guide assigns long builds/full suites
to the coordinator; do not create another worker just to wait on them.
Return a short result and evidence paths rather than full source/log dumps.

At a completed milestone, save a concise note with `scripts/agent-checkpoint
save <name>` (stdin, or `--from <file>`). Target about 8k characters; keep
details in evidence files. Use these exact Markdown headings, each filled
with concrete information or explicit None/unknown:

```markdown
## Goal and acceptance
## Decisions and rejected approaches
## Changes
## Evidence and limitations
## Live jobs and ownership
## Open failures
## Next step
```

Include invariants and why alternatives were rejected, modified/untracked
paths, exact test commands and results with artifact provenance, unresolved
failures, live job ids and their owner, and the next check. A checkpoint is
not a completion claim. Do not ask the user to write or relay this note.

The helper records worktree, HEAD, tracked diff hash and git status, and
saves an immutable note under `.context/agent-checkpoints/`. Return its
printed path to the coordinator. `scripts/agent-checkpoint check <path>`
checks required sections and whether that recorded state still matches.
It does not verify prose, tests, ignored files or untracked file contents.
Review those against source/evidence before relying on the note. Refresh
the checkpoint if its state is stale; a new save never overwrites an old one.

For an approved handoff trial, the coordinator reviews the note and starts
a fresh worker with its path, the bounded next phase and acceptance checks.
Do not resume the old conversation or inherit it into the fresh worker.
The recipient reads required guidance and relevant source, verifies the
evidence and preserves live job ownership. Never edit a tree under active
validation. If a note omits essential reasoning, obtain it from the prior
worker instead of guessing; charge that recovery to the trial.

## Client coverage

| Client | Checkpoint helper and repository guidance | Automatic context reminder |
|---|---|---|
| Claude Code | Yes | Opt-in hook below |
| Codex | Yes | Opt-in hook below; requires Codex hook trust review |
| Other coding agents | Helper is usable; instruction loading depends on the client | No adapter in this implementation |

## Quiet context reminders

Install/update independently of the wait guard:

```bash
python3 .claude/hooks/install-hooks.py --user --hook context
python3 .claude/hooks/install-hooks.py --user --hook context --check
python3 .claude/hooks/install-hooks.py --user --hook context --client codex
```

This installs standalone copies under `~/.claude/hooks/` or `~/.codex/hooks/`
and adds only its own entry in the selected client's settings, preserving
other hooks. Codex uses an existing `hooks.json`, or a marked block in
`config.toml`, preserving the layer's format and existing trust records.
[Codex requires review of a new/changed hook in `/hooks`](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
before it executes; installation and `--check` confirm registration, not
trust. No trust records are added by the installer. The hook acts only
in Kandelo checkouts with `scripts/agent-job`. Once per agent transcript,
at 250k recorded input-context tokens, it reminds the agent to checkpoint
at its next safe milestone. It makes no tool decision, spawns no agents,
does not end work, and asks nothing of the user. Missing/malformed usage
fails open. Reads are bounded to a 512 KiB transcript tail; Codex also checks
up to 512 KiB of the rollout header to verify the executing thread's identity.
Codex counts `last_token_usage.input_tokens` once, including cached input;
Claude adds its separate input/cache counts. Neither uses session totals.
These are observed transcript adapters, not stable client APIs; unknown
formats stay silent. JSON records
under `~/.cache/kandelo/agent-context/` record issued reminders for review.

The reminder includes a command using the installed helper, so it works
on older Kandelo branches without the repository wrapper. Other agent
clients can use the same checkpoint helper and guidance; automatic telemetry
requires a client adapter. Existing sessions may need to reload hook settings;
newly started sessions load registered hooks, subject to Codex trust review.

Remove only this hook with `install-hooks.py --user --hook context
--uninstall`. Use `--project-local` instead of `--user` to configure one
checkout. Add `--client codex` to check/update/remove only Codex's adapter.
Neither mode enables the independent Claude Code wait guard.
