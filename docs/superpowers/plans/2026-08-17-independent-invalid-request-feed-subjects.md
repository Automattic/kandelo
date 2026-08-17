# Independent Invalid Request-Feed Subjects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a protected request-feed repair run skip an authenticated invalid pull request while continuing to issue staging requests for unrelated eligible pull requests.

**Architecture:** Protected `xtask` will expose a canonical feed-disposition document after completing every existing report identity check. The workflow will branch only on that authenticated document; the existing strict validator and all evidence-integrity failures remain fail-closed.

**Tech Stack:** Rust/Serde, GitHub Actions YAML and Bash, Ruby workflow contract tests, generated ABI staging request policy.

## Global Constraints

- Never trust the structural report's outcome before protected exact-source validation.
- Preserve strict `structural-report validate` behavior for all existing callers.
- Skip only registered candidate-owned structural guards; malformed or mismatched evidence remains fatal.
- Run build and verification commands through `scripts/dev-shell.sh`.
- Keep unrelated user-owned submodule and untracked changes untouched.

---

### Task 1: Add an Authenticated Feed Disposition

**Files:**
- Modify: `tools/xtask/src/abi_staging/request_derivation.rs`
- Modify: `tools/xtask/src/abi_staging/mod.rs`

**Interfaces:**
- Consumes: the existing exact-head root, protected previous ABI, pull-request identity, and structural report arguments.
- Produces: `structural-report feed-disposition --out <path>`, writing canonical JSON with `schema`, `kind`, `status`, and nullable `guard`.

- [ ] **Step 1: Write the failing Rust tests**

Add tests that call the real CLI helper with an invalid report, require the
literal canonical disposition bytes, and mutate source/checker/snapshot identity
to require an error and no output. Add a strict-validator assertion proving the
same invalid report still returns `request_invalid`.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
scripts/dev-shell.sh bash -c '
  host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
  cargo test -p xtask --target "$host_target" \
    abi_staging::request_derivation -- --nocapture
'
```

Expected: FAIL because `feed-disposition` and its document type do not exist.

- [ ] **Step 3: Implement the minimal protected disposition**

Refactor the existing validator so the shared identity and outcome-consistency
checks return the authenticated `StructuralAbiOutcomeV1`. Keep strict validation
as the current outcome-to-error mapping. Add a deny-unknown-fields serialized
disposition type and atomically write it only after validation succeeds.

- [ ] **Step 4: Run the focused Rust tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 2: Continue the Batch Past Candidate-Invalid Subjects

**Files:**
- Modify: `.github/workflows/abi-staging-request-feed.yml`
- Modify: `scripts/check-abi-staging-request-workflow.rb`

**Interfaces:**
- Consumes: the canonical disposition emitted by protected `xtask` for each enumerated subject.
- Produces: no request for candidate-invalid subjects and the unchanged canonical request/plan for every eligible subject.

- [ ] **Step 1: Write failing workflow contract mutations**

Require the derivation loop to invoke `feed-disposition`, inspect only its
canonical status and guard, continue on both registered candidate-invalid
guards, and preserve `set -euo pipefail`. Add mutations that replace the command
with direct report `jq`, swallow command failure, or turn candidate-invalid into
a job failure.

- [ ] **Step 2: Run the workflow checker and verify RED**

Run:

```bash
scripts/dev-shell.sh ruby scripts/check-abi-staging-request-workflow.rb
```

Expected: FAIL because the workflow still invokes strict validation directly.

- [ ] **Step 3: Implement the minimal workflow branch**

Write each disposition under the derived request directory. Continue with a
clear diagnostic for `candidate-invalid`; proceed only for `eligible`; reject
any other status or guard. Do not read the untrusted report with `jq` for
control flow.

- [ ] **Step 4: Run the workflow checker and actionlint**

Run:

```bash
scripts/dev-shell.sh ruby scripts/check-abi-staging-request-workflow.rb
scripts/dev-shell.sh actionlint .github/workflows/abi-staging-request-feed.yml
```

Expected: PASS.

### Task 3: Bind, Verify, and Publish the Fix

**Files:**
- Modify: `abi/staging/request-policy.toml`
- Regenerate: `abi/staging/request-policy.generated.json`

**Interfaces:**
- Consumes: the final protected workflow and Rust implementation bytes.
- Produces: a current request-policy digest and an open pull request whose exact head can receive an immutable staging request.

- [ ] **Step 1: Bump the request-policy version and regenerate last**

Run the repository's `abi-staging request-policy generate` command through the
declared dev shell after all source edits settle.

- [ ] **Step 2: Run focused and freshness validation**

Run the Rust tests, workflow checker, actionlint, request-policy check, and
`git diff --check`. Expected: all pass.

- [ ] **Step 3: Commit and push**

Commit with purpose-first subject `[ABI] Isolate invalid request-feed subjects`,
push the branch, and open a pull request whose description begins with `## Why`.

- [ ] **Step 4: Capture the immutable request before merge**

Wait for the exact-head request-feed run to publish the immutable request asset.
Use that exact URL to dispatch tap reconciliation, then merge only after the
request is durable and the focused CI is green.
