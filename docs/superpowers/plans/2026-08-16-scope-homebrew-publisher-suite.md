# Scope the Homebrew Publisher Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop running the complete Homebrew publisher integration suite for pull requests that do not change publisher policy.

**Architecture:** Reuse the existing `package_publish_flow_changed` output as the single routing authority. Apply one identical GitHub Actions condition to the publisher-only setup and validation steps, and enforce it with mutation-style Ruby contract tests.

**Tech Stack:** GitHub Actions YAML, Ruby workflow contract tests, Bash verification through `scripts/dev-shell.sh`.

## Global Constraints

- Formula, package, ABI, request, candidate, and bottle identities must remain unchanged.
- Mixed changes that touch publisher policy must run the complete suite.
- The pinned Homebrew source and explicit source environment remain mandatory when the suite runs.
- No new path classifier or compatibility fallback is permitted.

---

### Task 1: Enforce publisher-only preflight routing

**Files:**
- Modify: `scripts/test-homebrew-publisher-lifecycle-source.rb`
- Modify: `.github/workflows/staging-build.yml`

**Interfaces:**
- Consumes: `needs.change-scope.outputs.package_publish_flow_changed`
- Produces: four steps with the exact condition `${{ needs.change-scope.outputs.package_publish_flow_changed == 'true' }}`

- [ ] **Step 1: Write the failing workflow contract assertions**

Require the host-sealing, lifecycle checkout, JavaScript install, and publisher
validation steps to have the exact publisher-flow condition. Add mutations
that remove or change the condition and require rejection.

- [ ] **Step 2: Run the focused contract to verify RED**

Run:

```bash
scripts/dev-shell.sh ruby scripts/test-homebrew-publisher-lifecycle-source.rb
```

Expected: failure because the four steps are currently unconditional.

- [ ] **Step 3: Add the minimal workflow conditions**

Set the same `if` expression on exactly the four publisher-only steps. Preserve
their existing command bodies, source pin, and ordering.

- [ ] **Step 4: Run focused verification to GREEN**

Run:

```bash
scripts/dev-shell.sh ruby scripts/test-homebrew-publisher-lifecycle-source.rb
scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
scripts/dev-shell.sh bash .github/scripts/test-homebrew-main-shell-change-scope.sh
```

Expected: all commands exit zero.

- [ ] **Step 5: Verify workflow syntax and scoped diff**

Run:

```bash
scripts/dev-shell.sh actionlint .github/workflows/staging-build.yml
git diff --check
git diff --name-only origin/main...HEAD
```

Expected: actionlint and diff checks exit zero; only the two docs, workflow,
and lifecycle-source contract test differ.

- [ ] **Step 6: Commit**

```bash
git add \
  .github/workflows/staging-build.yml \
  scripts/test-homebrew-publisher-lifecycle-source.rb \
  docs/superpowers/specs/2026-08-16-scope-homebrew-publisher-suite-design.md \
  docs/superpowers/plans/2026-08-16-scope-homebrew-publisher-suite.md
git commit -m "[CI] Reserve publisher integration for policy changes"
```
