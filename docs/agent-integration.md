# Reviewed integration CLI

`scripts/agent-integrate` keeps one reviewed change's patch, evidence and
checkpoint in a durable ledger. It runs with Python 3.10+ and Git before
Kandelo binaries exist. It changes the local development workflow only;
it makes no Node, browser, ABI, package or conformance changes.

The validation manager owns command execution, supervision and waiting.
This tool currently stops at a check barrier. Its `record` command imports
an explicitly reviewed result; it does not run, poll, retry or schedule a
check. The manager adapter and a measured end-to-end execution comparison
remain pending until that implementation lands.

## Commands

```sh
scripts/agent-integrate --root /absolute/target preflight manifest.json
scripts/agent-integrate --root /absolute/target run manifest.json
scripts/agent-integrate --root /absolute/target handoff reviewed-change --json
scripts/agent-integrate --root /absolute/target record reviewed-change \
  --report /absolute/result.json --sha256 <reviewed-report-sha256>
scripts/agent-integrate --root /absolute/target resume reviewed-change
scripts/agent-integrate --root /absolute/target status reviewed-change
```

`run` freezes the manifest and reviewed patch, applies the patch, then
returns **3** when declared checks need evidence. `record` validates and
freezes a result and continues the next ready bookkeeping steps. `resume`
uses the frozen operation, never a newly edited manifest. `preflight`
does not change worktree files, the real index or task metadata; Git may
write unreachable objects while checking the patch in a temporary index.
`status` and `handoff` read the same ledger; `--json` includes the declared
argument arrays, working directories and the exact `source_binding` a
result must carry. Relative manifest and report filenames resolve against
the invocation's working directory; paths inside them resolve against the
target root, except `source.root`, which is an absolute source checkout.

Exit codes are 0 for finished bookkeeping, 1 for a recorded nonpassing
check, 2 for invalid input or an uncertain/blocked operation, and 3 for a
check awaiting evidence, including a wait-window observation. A process
that exits 124 remains a failed process. It is not a wait-window expiry.

Optional `run --commit` and `run --commit --push` require the corresponding
manifest authorization to be true. These choices are frozen in the task;
resume cannot silently add them. Normal `run` stages the explicitly owned
paths at checkpoint but creates no commit or push. Unrelated staged files
stay in the index. A commit uses a separate index and `commit-tree`, then
updates the existing branch by comparing its old commit. It does not run
commit hooks or create a merge commit. A push names the frozen commit and
fully qualified destination, without force. There are no branch-renaming,
merge, deployment or remote-message operations.

## Manifest version 1

The authoritative machine-readable contract is
[`manifest-v1.schema.json`](../scripts/agent_integration/manifest-v1.schema.json).
The standard-library validator rejects missing/unknown fields, unknown
versions, duplicate JSON keys and noncanonical identifiers. The tests'
[`support.py`](../tests/agent-integration/support.py) constructs a complete
working manifest in disposable source and target repositories. Use it as
an executable example, rather than treating the old private Node scripts
as a schema.

| Field | Meaning |
| --- | --- |
| `version`, `id` | Version 1 and unique lowercase task identifier; an existing ledger is never overwritten. |
| `base_commit` | Exact 40-character target HEAD commit at preflight. |
| `main` | Fully qualified shared ref and reviewed exact commit; later movement is reported separately. |
| `source` | Canonical absolute checkout root, exact commit, fully qualified ref or `HEAD`, and path-to-SHA-256 identities. Every nondeleted owned postimage must be represented. |
| `owned_paths` | Exact file paths the patch changes and checkpoint may stage. No directory ownership or Git pathspec expansion. |
| `protected_paths` | Paths or prefixes the patch must not overlap; tracked and nonignored untracked inventories are guarded. |
| `patch` | Relative patch path, SHA-256, and exact `before`/`after` path-to-SHA-256 maps; JSON null means absent. Both maps must exactly match `owned_paths`. |
| `target_pins`, `inputs` | Required immutable files, each with `path` and `sha256`; no implicit download or regeneration. |
| `seals` | Pinned seal files with `{"version":1,"members":{"relative/path":"sha256"}}`; members resolve inside the seal's directory. |
| `evidence` | Required existing report identities, dimension, scope, outcome, source commit and explicit `reused` flag. Historical reports must be marked reused. |
| `checks` | Unique check id, argument array, explicit relative cwd, dimension, scope and process timeout; handed to the future manager adapter without execution here. |
| `checkpoint` | Narrow claim scope and explicit outstanding blockers. |
| `commit`, `push` | Optional task authorization and message or remote/ref/expected remote commit. A null expected remote commit means the destination must be absent. |
| `adapter` | Optional Node family validation described below. |

Paths inside a manifest are canonical relative paths using letters,
numbers, dots, underscores, hyphens and slashes. Absolute paths, traversal,
`.git`, symlink components and paths beginning with option syntax are
rejected. Owned paths must not overlap protected paths, immutable inputs,
evidence or the operation's bookkeeping directory. New owned files are
checked against `/dev/null` even if already staged, so staged additions
cannot bypass Git whitespace checks. Existing dirty owned paths are
rejected. Unrelated dirty work is preserved and its content/index guarded.

Version 1 intentionally handles ordinary file patches only. It rejects
symlinks, submodule changes and executable files in the patch.
It does not sandbox trusted check commands or infer their input closure.
Declare all inputs needed to justify the check's scope. It does not fetch
refs, update Node implementation state, reconcile compatibility findings,
or rewrite inventories. Source and documentation edits belong in the
reviewed patch, so resume never appends a documentation paragraph twice.

The small Node adapter takes:

```json
{"kind":"node","state":{"path":"tests/nodejs/outline/implementation-state.json","sha256":"<exact-sha256>"},"families":["<canonical-family-key>"]}
```

It validates each family against the pinned state's `families` object.
It never guesses an alias, edits that state, or derives runtime support
from a passing source check.

## Recording evidence without owning execution

The integration-side result envelope is documented by
[`result-v1.schema.json`](../scripts/agent_integration/result-v1.schema.json).
It is **not** an assumed validation-manager API. A future adapter can
translate that manager's receipts into this evidence boundary.

```json
{
  "version": 1,
  "source_binding": "<handoff's exact SHA-256 binding>",
  "check_id": "content",
  "argv": ["python3", "reviewed-check.py"],
  "cwd": ".",
  "job_id": "original-manager-job-handle",
  "state": "finished",
  "outcome": "pass",
  "exit_code": 0,
  "log": {"path": ".context/check.log", "sha256": "<exact-log-sha256>"},
  "reused": false
}
```

For `waiting`, outcome, exit code and log hash must all be null. The
original job handle is retained; a later observation must identify the
same job. A waiting observation cannot pass or fail a process. For
`finished` or `lost`, the log must exist and match its digest. A lost
supervisor is a `harness-error`. Only `finished` + `pass` + exit 0 satisfies
a declared check. Failures, skips, unsupported cases, process timeouts,
harness errors and reused evidence remain distinct ledger entries. A
nonpass blocks checkpointing; a new attempt requires a new reviewed task,
so a favorable retry cannot erase failure history. Exact duplicate imports
are no-ops, and terminal results cannot be replaced.

Recording a result is an explicit attestation about its origin: a matching
binding and hash do not independently prove that a command ran. The manager
adapter must obtain the binding before execution, validate the declared
inputs around the run, retain the original handle and translate the real
process result. This tool checks the current owned files, declared inputs,
reports and sealed logs before accepting evidence or checkpointing. It
cannot discover undeclared dependencies or prove historical timing from an
arbitrary user-authored JSON result.

## Ledger, interruption and drift

One structured ledger lives at
`.context/agent-integrations/<id>/ledger.json`. It holds the frozen
manifest and identities, steps, observations, evidence, failures, blockers
and checkpoint. Detailed receipts and logs are linked, not duplicated into
status documents. Imports are copied to content-addressed files in that
operation's `results/` directory. Other immutable inputs remain pinned
references: do not remove them while the task is active.

Ledger updates use a flushed temporary file, atomic rename and directory
sync. A worktree lock excludes simultaneous mutating invocations. Each
mutation has a durable intent. After interruption, patch application
accepts only the exact preimage or postimage of each file and writes only
the unfinished files. A checkpoint reconciles already-staged owned files;
a commit reconciles its journaled object and branch update. A push with
uncertain outcome only completes if the remote has the exact frozen
commit; it is never blindly retried.

Unexpected file bytes, branch movement, missing evidence or changed tools
are explicit blockers. Preserve the ledger and logs and inspect them;
do not delete the ledger and retry over a partial application. There is
no automatic rollback over another contributor's work. Abandoned
`.prepare-*` directories are unpublished operation preparations and may
be inspected after a crash; their existence is not a completed step.

Status reports later source/shared-ref drift separately from the frozen
operation. It never replaces the reviewed source, main or inputs with a
newer revision. Evidence is scoped to those frozen identities; the JSON
status's current-for-frozen-inputs flag becomes false when target files,
inputs or sealed reports drift. Source-ref movement does not rewrite an
old check's scope. Every checkpoint explicitly retains
`finding_closure=false` and `broader_support_established=false`.

## Targeted verification

```sh
scripts/dev-shell.sh python3 -m unittest discover \
  -s tests/agent-integration -p 'test_*.py' -v
```

The tests use isolated temporary Git repositories and local bare remotes.
They do not use project binaries or touch the caller's index, branch or
remote. They cover schema/family/evidence rejection, staged-new-file
whitespace, dirty preservation, injected interruption and metadata-write
failure, exact resume, checkpoint/commit deduplication, source/main drift,
scoped evidence, wait-window versus process failure and push recovery.
These tests establish the integration/evidence boundary only. Real process
supervision and the final end-to-end demonstration remain the validation
manager's integration follow-up.

[Development outcomes](../tests/agent-integration/development-results.json)
retain the initial failures and their corrections. Detailed local logs stay
under `.context/agent-integration-development/`.


## Reproduce the independent integration demonstration

```sh
scripts/dev-shell.sh python3 tests/agent-integration/demo.py \
  --output .context/agent-integration-demo-new
```

Use a new output directory for each run; earlier artifacts are retained.
The demonstration uses sparse local clones of this repository at the
current HEAD, then creates an isolated reviewed commit containing this
real documentation file and both schemas, with an isolated documentation
edit so the example also works after the tool has landed. It applies that patch to a
second isolated checkout, manually runs `python -m json.tool` against the
manifest schema, imports the narrowly scoped result and checkpoints the
changed owned files. It verifies an unchanged target HEAD, preserved
unrelated staged and unstaged work, and a resume that changes no ledger
bytes. Its only commits are in its private source clone; it does not
commit or push the user's workspace.

The output directory contains the complete manifest, source/target clones,
raw check log, compact handoffs, structured status and
`demonstration.json`. These clones share the local object store; they need
the original repository's objects to remain available. They do not copy
private prototypes or large artifact trees. The manual check establishes
JSON syntax only, not schema semantics, CLI correctness or runtime
compatibility. The targeted test suite supplies the independent CLI
behavior evidence.

An observed demonstration of this boundary succeeded on 2026-11-07 using
the repository dev shell. The full old/new round-trip, repeated-output and
manual-bookkeeping comparison is deliberately pending the real validation
manager adapter. No token, monetary or workflow-speed savings are claimed.
