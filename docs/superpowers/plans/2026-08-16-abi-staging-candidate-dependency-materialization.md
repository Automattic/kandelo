# ABI staging candidate dependency materialization implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ABI-staging Formula builds consume the exact candidate dependency bottles already selected and downloaded by protected coordination.

**Architecture:** The tap handoff produces a deterministic prepared checkout containing only candidate dependency bottle-block changes. The exact Kandelo adapter passes that checkout and the exact local candidate archive cache to the existing normal Homebrew builder using its established public-source/prepared-checkout identity split.

**Tech Stack:** Python 3 tap handoff, Bash Kandelo adapter, Ruby Formula parsing, Python `unittest`, shell contract tests.

## Global constraints

- Preserve target Formula recipes and bottle contracts byte-for-byte.
- Keep the original tap commit as public source authority.
- Permit only exact declared dependency bottle-block changes in the prepared checkout.
- Never fetch, publish, or use credentials during candidate execution.
- Use test-first red/green cycles and repository-declared development shells.

---

### Task 1: Prepare exact dependency bottle blocks in the tap

**Files:**
- Modify: `scripts/abi_staging/handoff.py`
- Modify: `scripts/abi_staging/tests/test_handoff.py`

**Interfaces:**
- Consumes: validated `kandelo-abi-staging-build-context` and original tap checkout.
- Produces: `prepare-dependency-tap --context <json> --tap-root <root> --out <dir>`, returning a clean deterministic Git checkout whose HEAD is distinct from the public source commit only when dependencies exist.

- [ ] Write a failing test that prepares a one-dependency context, requires the candidate root/digest in the dependency Formula, and requires all non-bottle source bytes to remain equivalent.
- [ ] Run the focused handoff test and verify the prepared-checkout interface is absent.
- [ ] Implement bounded Formula bottle-block replacement, deterministic commit metadata, and exact changed-path validation.
- [ ] Run the focused test and the complete handoff test module.
- [ ] Add rejection tests for symlinked Formula paths, missing architecture tags, digest mismatch, and undeclared checkout changes; run each red then green.

### Task 2: Invoke the normal builder through the prepared checkout

**Files:**
- Modify: `scripts/abi-staging-build-bottle.sh`
- Modify: `scripts/test-abi-staging-build-bottle.sh`

**Interfaces:**
- Consumes: Task 1 `prepare-dependency-tap` command and existing materialized dependency directory.
- Produces: normal-builder invocation with `--tap-root <prepared>`, `KANDELO_HOMEBREW_TAP_SOURCE_COMMIT=<public>`, `KANDELO_HOMEBREW_PREPARED_TAP_COMMIT=<prepared>`, and `KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE=<exact layers>`.

- [ ] Add a failing adapter test whose fake normal builder rejects the original tap root, missing prepared identities, or the wrong local cache variable.
- [ ] Run the focused shell test and verify it fails at the new assertions.
- [ ] Invoke Task 1 preparation after original context/custody validation and pass only its outputs to the normal builder.
- [ ] Run the focused shell test and verify it passes.
- [ ] Run the existing ABI staging adapter test suite.

### Task 3: Cross-repository and hosted verification

**Files:**
- Modify only if a focused regression exposes a boundary missed by Tasks 1-2.

**Interfaces:**
- Consumes: both repository commits from Tasks 1-2.
- Produces: evidence that the same Formula contracts select candidate dependency URLs and local bytes without changing target recipes.

- [ ] Run the tap handoff/execution test modules in the tap development shell.
- [ ] Run the Kandelo ABI staging adapter test in the Kandelo development shell.
- [ ] Compare generated Formula plans and bottle-contract digests before and after the tap orchestration change.
- [ ] Commit and push the tap repair, merge it after required checks, and update the ABI 43 PR branch with the adapter commit while preserving existing authorship.
- [ ] Wait for the immutable request for the new ABI 43 head, dispatch one optimized reconciliation wave, and require at least one dependency-bearing required Formula to pass provenance and enter compilation.
