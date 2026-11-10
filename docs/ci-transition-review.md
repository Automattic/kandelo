# CI review for develop integration

Review baseline: `6d5ebb19b24572480edebd5dc355dfca36ae63c6`.
This is the adaptation review for the develop/daily-promotion policy proposed
in [PR #1689](https://github.com/Automattic/kandelo/pull/1689).
Replacement daily automation is not implemented or enabled by this review.

## Disabled execution entry points

After the policy PR was opened, `develop` was created at the baseline above.
GitHub repository-wide Actions remained disabled. Every registered workflow
whose path starts with `.github/workflows/` was verified as
`disabled_manually`. The three remaining individually active workflows were
Determinism check, Spacefast service contracts, and Rust development clean
environment. GitHub-managed Pages, Dependabot, and Copilot entries are not
repository CI YAML workflows and were not changed.

These are server-side settings, not a guarantee carried by this checkout.
Before enabling Actions, query `/repos/Automattic/kandelo/actions/workflows`
and verify legacy workflow states again. YAML triggers still describe the
old behavior; do not enable old workflows wholesale. Additional registered
workflows absent from the current tree (including the old CI, benchmarks,
and Homebrew probes) were already individually disabled and remain so.

## Main update restriction and emergency merges

The active [Main promotion writers ruleset](https://github.com/Automattic/kandelo/rules/26974711)
restricts updates to `refs/heads/main`. Its current bypass list contains only
`brandonpayton` (GitHub user ID 530877), with `always` bypass. GitHub confirms
that this account can bypass the rule. The rule does not affect `develop`.
Other users cannot merge or push updates to `main` through this rule;
repository administrators can still edit rulesets as part of their admin
permissions. This is an update restriction, not a source-branch validator.

For an emergency, review the PR and its latest head, then use GitHub's admin
merge override while authenticated as `brandonpayton`. The CLI equivalent is:

```bash
gh pr view <number> --repo Automattic/kandelo --json baseRefName,headRefOid
# Confirm baseRefName is main and pin the reviewed head SHA below.
gh pr merge <number> --repo Automattic/kandelo --admin --squash \
  --match-head-commit <reviewed-head-sha>
```

This permits an emergency PR merge; it does not grant a non-fast-forward
force-push. The separate default-branch ruleset still blocks deletion and
history rewrites with no bypass actors. Emergency PR squash/rebase merges
may cause `main` and `develop` to diverge: reconcile main back into develop
through a reviewed PR before resuming ancestry-checked daily promotion.
Record the reason and any skipped validation with an emergency merge.

## Manual promotion before automation

The selected first phase uses read-only daily validation followed by a human
promotion. No GitHub App installation or automation credential is required.
The report must identify the exact tested develop SHA, captured main SHA,
all required job results and evidence URLs. After verifying the report,
`brandonpayton` fast-forwards main to that tested SHA with ancestry checks
and an explicit lease against the captured main SHA. The guarded command is
in the policy proposed by [PR #1689](https://github.com/Automattic/kandelo/pull/1689).
Do not substitute the latest develop tip or a squash/rebase merge.

The live update restriction already permits this operator. Existing classic
main protection requires PRs with admin enforcement off, so the named admin
can perform the direct fast-forward. No branch was promoted to test this
configuration, and no passing daily report exists yet. The writer rule does
not itself verify tests; the human operator must inspect the full report.

Automatic promotion is deferred. If it is wanted later, evaluate a write
deploy key scoped to Kandelo, private credential storage, key rotation,
existing deploy keys, the ruleset's deploy-key bypass scope, and interaction
with classic PR protection. Retain the named human emergency bypass and the
separate deletion/history protections. No App, deploy key, or personal token
is created as part of this phase.

## Review decisions by workflow

| Existing workflow | Current role | Adaptation decision |
|---|---|---|
| `staging-build.yml` | Per-PR scope classification, package builds and tests | Replace with a fixed develop candidate; retain suite runners and evidence accounting, remove per-PR release staging and path-filter bypasses from the daily gate. |
| `prepare-merge.yml` | Label-triggered synthetic merge, package candidate sealing, PR-head merge status | Retire the ready-to-ship/merge-gate entry path; daily tests must refer to the captured develop SHA, not synthetic individual PR merges. |
| `activate-merge-candidate.yml` | PR-close and scheduled canonical artifact activation | Retire PR-close activation. Stable publication must follow successful promotion of the same tested SHA. |
| `recover-rejected-merge-candidate.yml` | Manual recovery of old package candidates | Leave disabled; replace only if daily candidates need equivalent recovery, with no test bypass. |
| `staging-cleanup.yml` | PR-close and scheduled release cleanup | Separate legacy cleanup from future run-based evidence retention. Never delete an in-flight daily candidate. |
| `force-rebuild.yml` | Exact-main build and durable release publication, with optional test bypass | Keep disabled. Reuse source-build knowledge only; the daily promotion gate must not inherit the skip-tests option or publish during validation. |
| `preserve-pr-package-generation.yml` | Preserve package closure from a PR producer | Leave disabled; reconsider retention by tested candidate SHA rather than PR. |
| `promote-package-generation.yml` | Publish a durable generation validated by exact current main | Keep publication separate from branch promotion. Rework provenance for the exact promoted SHA before reuse. |
| `reusable-package-source-publish.yml` | Callable source-package release publisher with write permission | Keep disabled until callers and authority are reviewed. It is publication, not validation. |
| `browser-demos-ci.yml` | Path-filtered PR/main docs build, host typecheck, browser unit/memory checks and three-engine smoke | Retain these checks in daily coverage; remove path filters from the full daily gate. No deployment is performed here. |
| `spacefast-services-ci.yml` | Path-filtered PR/main proxy tests and real PHP/MariaDB service contracts | Retain as daily service-contract checks, including real database tests; do not silently replace them with unit-only mocks. |
| `determinism-check.yml` | Scheduled two-build reproducibility check | Keep as a separate expensive validation lane until capacity and required-gate status are deliberately settled; do not discard its failures as passes. |
| `rust-development.yml` | Manual clean-cache compiler and Node/browser Rust acceptance | Retain as an explicit expensive acceptance lane; decide required cadence after measuring runner cost. |

The small configuration adaptation in this PR routes both Dependabot
version-update configurations to `develop`. Separate default-branch configurations retain security-update grouping and
disable default-branch version PRs with a zero open-PR limit. GitHub security
updates remain a default-branch concern; inspect and explicitly retarget eligible PRs after
reviewing their diffs. Existing PR bases were not automatically changed. Dependabot reads its
configuration from `main`; routing takes effect once this configuration is
included in a validated promotion/bootstrap to the default branch. See
[GitHub’s Dependabot configuration documentation](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates).

## Daily coverage to carry forward

Use `scripts/dev-shell.sh` and the source build path. The old release-based
workspace transport is not a prerequisite for locally source-built tests.
Provision pinned submodules, both SDKs, supported packages, canonical images
and fixture programs before selecting suites. Preserve quiet Playwright
fixtures and complete suite-health evidence.

The old gate already partitions workspace Rust, xtask, Vitest (two shards
plus resource-isolated cases), libc (functional/regression and math), POSIX,
and Sortix (include, basic and runtime); prepare-merge also includes browser
coverage. `scripts/ci-run-test-suite.sh` preserves those partitions and checks
the live Vitest inventory. Reuse it rather than reproducing the old release
and approval orchestration.

Do not substitute `./run.sh test all` for an audited full inventory: its
current cargo case hardcodes a macOS target, its `all` selection uses the
non-slow browser subset, and it omits separate xtask, ABI and service gates.
The replacement must explicitly account for:

- Workspace Rust and xtask, with the detected native target.
- Complete host Vitest coverage, including resource-isolated cases.
- ABI snapshot and source/package artifact identity checks.
- libc, POSIX and Sortix through Node and browser hosts.
- Browser product/assets, docs publication build, host typecheck, browser
  unit tests and the existing Chromium/Firefox/WebKit smoke inventory.
- Browser-memory ownership, lifecycle and repeated three-engine switching.
- Proxy policy plus real MariaDB/PHP signalling and service contracts.
- SDK tests, runtime-workaround repros, package-owned acceptance tests, slow
  browser cases, determinism and clean Rust acceptance: explicitly document
  their required daily or separate cadence before claiming a full gate.

Expected failures and supported/excluded package sets retain their existing
owners. Missing artifacts, missing suites, zero collected tests, timeouts,
and incomplete jobs cannot become successful validation.

## Implementation and enablement sequence

1. Land the branch policy and route change PRs to `develop`. Existing main
   rules prevent deletion and non-fast-forward updates; the new main update
   rule admits the named human operator for normal and emergency promotion. Classic
   protection requires PRs but excludes admins. No daily tests are enforced.
2. Implement a read-only daily candidate build/test workflow, scheduled from
   `main` with an explicit captured `develop` checkout. Skip the build only
   when no commits need promotion. Reject divergent ancestry.
3. Validate the whole required inventory on a capable runner and retain
   commit-linked counts and logs. Measure whether separate jobs or runners
   are needed; the compiler acceptance lane alone has a six-hour timeout.
4. Produce a report only when every required job actually succeeds. A human
   verifies it and promotes the exact tested candidate using the captured
   main SHA and ancestry guards. Test no-change, failure, missing/skipped job,
   cancellation, stale-main, divergent-history and develop-advances cases
   before relying on the report for routine promotion.
5. Install the reviewed scheduler on `main` as an explicit bootstrap step:
   GitHub schedules use the default branch, so YAML present only on develop
   cannot start the first daily promotion. Record bootstrap validation;
   never infer it from an untested develop workflow or bypass the test gate
   to promote a whole batch.
6. Review branch enforcement and the manual promotion procedure, then enable only the
   replacement workflows. Keep all legacy entries disabled. Stable artifact
   publication is a subsequent consumer of the promoted SHA, never a
   prerequisite write side effect of testing it. Automatic promotion and
   deploy-key credentials remain a separate later decision.

No source/runtime tests were run for this review and Dependabot routing
change. It does not establish daily runner readiness, a passing full suite,
a working promotion writer, or a test/source-branch gate for the emergency actor.
