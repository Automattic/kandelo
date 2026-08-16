# Remove Publisher Integration From PR Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ordinary ABI and package pull requests reach useful staging work
without paying the full privileged Homebrew publisher integration cost.

**Architecture:** Remove publisher-only setup and integration steps from the
ordinary staging preflight. Keep the publisher suite and reusable publication
workflows intact, while a fast Ruby workflow contract rejects accidental
reintroduction into pull-request staging.

**Tech Stack:** GitHub Actions YAML, Ruby workflow contracts, Bash verification
through `scripts/dev-shell.sh`.

## Global Constraints

- Formula, package, ABI, request, candidate, bottle, and promotion identities
  remain unchanged.
- Candidate build and verification checks remain unchanged.
- The complete publisher integration suite remains available outside ordinary
  PR staging.
- No new path classifier or compatibility fallback is permitted.

---

### Task 1: Exclude publisher integration from PR staging

**Files:**
- Modify: `.github/scripts/test-homebrew-main-shell-change-scope.sh`
- Modify: `scripts/test-homebrew-publisher-lifecycle-source.rb`
- Modify: `scripts/check-homebrew-publish-workflow-trust.rb`
- Modify: `.github/workflows/staging-build.yml`

**Interfaces:**
- Consumes: the `preflight` job in `.github/workflows/staging-build.yml`
- Produces: a staging workflow with no publisher integration entry point and a
  trust checker whose privileged recipe job inventory contains only the two
  reusable publisher jobs

- [ ] **Step 1: Write the failing staging contract**

Rewrite `scripts/test-homebrew-publisher-lifecycle-source.rb` to require the
staging preflight to contain none of these commands or resources:

```ruby
FORBIDDEN_STAGING_FRAGMENTS = [
  "scripts/test-homebrew-publish-workflow.sh",
  "scripts/prepare-homebrew-recipe-host-runtime.py",
  "Homebrew/brew",
  "homebrew-lifecycle-source",
].freeze
```

Mutation-test each fragment by appending a representative step to a deep copy
of the preflight and requiring rejection.

- [ ] **Step 2: Run the focused contract to verify RED**

Run:

```bash
scripts/dev-shell.sh ruby scripts/test-homebrew-publisher-lifecycle-source.rb
```

Expected: failure because the current preflight contains all four forbidden
publisher-only boundaries.

- [ ] **Step 3: Remove the four publisher-only workflow steps**

Delete only these named steps from `.github/workflows/staging-build.yml`:

```text
Seal conventional host runtime ownership
Checkout exact Homebrew lifecycle source
Install JavaScript dependencies for Homebrew preflight
Validate Homebrew publisher trust contract
```

Do not edit the remaining preflight steps or job routing.

- [ ] **Step 4: Remove staging from privileged recipe job inventory**

Delete only the `.github/workflows/staging-build.yml:preflight` entry from
`PRIVILEGED_RECIPE_JOBS` in
`scripts/check-homebrew-publish-workflow-trust.rb`. The checker will continue
to discover and validate both reusable publisher jobs.

- [ ] **Step 5: Run focused verification to GREEN**

Run the focused staging contract:

```bash
scripts/dev-shell.sh ruby scripts/test-homebrew-publisher-lifecycle-source.rb
```

Expected: the command exits zero. Run the complete trust checker once to
confirm that its privileged-host-runtime self-tests still execute against the
reusable publisher jobs, but do not turn unrelated pre-existing publisher
policy drift into an ordinary-staging requirement.

- [ ] **Step 6: Verify workflow syntax and unchanged routing**

Run:

```bash
scripts/dev-shell.sh actionlint .github/workflows/staging-build.yml
scripts/dev-shell.sh bash .github/scripts/test-homebrew-main-shell-change-scope.sh
git diff --check
```

Expected: the routing contract and `git diff --check` exit zero. Compare any
`actionlint` diagnostic against the base revision and report an identical
pre-existing diagnostic without expanding this change.

- [ ] **Step 7: Commit the scoped change**

Stage only the workflow, its focused shell and Ruby contracts, this plan, and
its design. Commit with:

```text
[CI] Keep publisher integration out of PR staging
```
