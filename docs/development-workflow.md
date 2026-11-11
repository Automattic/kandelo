# Development and daily promotion

## Branch policy

All change PRs target `develop`, including fixes, documentation, dependencies,
and CI changes. Start branches from `origin/develop`. Maintainers may merge
reviewed changes there with targeted local validation; a full per-PR CI run
is not required. Integration failures on `develop` are an accepted cost of
merging faster and testing a larger batch together. Fix or revert failures
through another PR to `develop`.

`main` remains the stable branch and GitHub default branch. Its only routine
incoming change is promotion of a daily-tested `develop` snapshot. Do not
merge individual change PRs directly to `main`.

## Open a PR

GitHub uses the repository default branch as its default PR base. It does
not expose a separate repository setting for the PR base while keeping
`main` as the default branch. Choose `develop` in the web base selector, use
[the develop compare page](https://github.com/Automattic/kandelo/compare/develop...),
or pass the base explicitly:

```bash
git fetch origin develop
git switch -c my-change origin/develop
gh pr create --base develop
```

For a local branch, `git config branch.my-change.gh-merge-base develop`
also supplies GitHub CLI's default base. Always check the displayed base.
Existing PRs need their base changed explicitly; changing documentation or
creating `develop` does not retarget them. Review the resulting diff after
retargeting. Dependabot version updates must also target `develop`; security
updates follow GitHub's default-branch behavior and need separate review.

See GitHub's [default branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/changing-the-default-branch)
and [CLI PR documentation](https://cli.github.com/manual/gh_pr_create).

## Daily validation and promotion

The following is the required design for the replacement CI, not a claim
that automation is already running:

1. A daily workflow on the default branch captures the exact `develop` SHA
   and current `main` SHA. If there are no commits on `develop` absent from
   `main`, finish without a build or promotion. Require `main` to be an
   ancestor of the candidate; divergence needs explicit reconciliation.
2. Build and run the full daily test inventory against that fixed candidate,
   using the pinned development shell and artifacts built from its sources.
   Do not narrow the inventory with PR path filters. Cover Rust, Node.js,
   browsers, ABI, package tooling and the libc/POSIX/Sortix conformance suites;
   retain suite counts, expected failures, skips and logs. The CI review must
   explicitly account for additional acceptance and service-contract checks.
3. Promote only after every required check succeeds. Failed, skipped,
   cancelled, missing, or incomplete required jobs block promotion. Known
   expected failures retain their explicit suite accounting.
4. Advance `main` to the tested commit while preserving its ancestry (a
   fast-forward, not a squash or rebase). Recheck that `main` has not changed
   since capture. A stale or divergent base blocks promotion. Never force
   overwrite branch history. New commits on `develop` remain for a later
   daily run; they cannot inherit an earlier commit's passing result.
5. Record the tested SHA and workflow run with the promotion. Publish or
   deploy stable artifacts only from that promoted commit. Validation must
   not mutate the canonical release while it is still testing a candidate.

Serialize promotion runs. A manual retry must use the same full gate and
cannot bypass failures. Retain `develop` after promotion, and do not squash
its history into `main`: the next run must be able to distinguish already
promoted commits from new work. When a daily run fails, leave `main` in place
and continue integrating fixes into `develop`.

## Manual promotion first

Daily validation will be read-only: report the tested develop SHA, captured
main SHA, required job results and evidence URL. After inspecting that
report, `brandonpayton` performs the promotion. No App installation, personal
automation token or deploy key is needed for this phase. The current main
update restriction gives this account an explicit bypass; daily validation
is not yet implemented or enabled.

After every required daily check succeeds, use the following in Bash from
a Kandelo checkout authenticated as `brandonpayton`. Replace the two SHA
values with those from the passing report, not today's branch heads:

```bash
set -euo pipefail
tested_sha='<full-tested-develop-sha>'
expected_main_sha='<full-main-sha-captured-by-validation>'
[[ "$tested_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$expected_main_sha" =~ ^[0-9a-f]{40}$ ]]
git fetch origin refs/heads/main:refs/remotes/origin/main \
  refs/heads/develop:refs/remotes/origin/develop
test "$(git rev-parse refs/remotes/origin/main)" = "$expected_main_sha"
git merge-base --is-ancestor "$expected_main_sha" "$tested_sha"
git merge-base --is-ancestor "$tested_sha" refs/remotes/origin/develop
git push --force-with-lease="refs/heads/main:$expected_main_sha" \
  origin "$tested_sha:refs/heads/main"
```

The ancestry checks require a fast-forward; the explicit lease rejects a
concurrent main update. Do not remove a failed guard or retry with new SHA
values without new matching validation. The command checks Git state, not
test evidence: the operator must verify the complete successful report.
Record the report URL and promoted SHA in the promotion log or tracking PR.
A GitHub squash/rebase merge of develop is not equivalent: it changes commit
identities. Keep the existing deletion/history protections enabled.

`brandonpayton` retains an emergency PR-merge bypass. An emergency override
is separate from a daily-tested promotion; record the reason and skipped
checks, then reconcile main back into develop before the next daily run.
If automatic promotion is wanted later, evaluate a repository-scoped write
deploy key and its ruleset/classic-protection permissions as a separate
change. No automation credential is created by this policy.

## Transition order and current limits

1. Ship this policy as a bootstrap PR to `main`, before normal development
   moves to `develop`. Create `develop` from `main` without rewriting either
   branch. Keep the default branch named `main`.
2. Individually disable legacy Actions workflows while repository-wide
   Actions remain disabled. Review their triggers, tests, permissions,
   artifact sources and publication side effects before adapting them.
3. Replace per-PR staging and prepare-merge gates with candidate validation
   and daily promotion. Configure Dependabot version-update targets and
   contributor entry points for `develop`.
4. Validate no-change, failed-test, stale-base and concurrent-update cases;
   establish runner capacity, required suites and evidence retention before
   enabling the replacement workflows. Keep legacy workflows disabled when
   repository-wide Actions are eventually re-enabled.

Repository-wide Actions were disabled when this policy was introduced.
The legacy YAML is not an implementation of this policy. Until replacement
CI is validated and enabled, there is no automatic daily promotion and no
basis to treat a change on `develop` as fully tested. Do not promote an
untested batch to `main`. Existing branch rules must be reviewed separately;
the active main update restriction permits only the named human account
until another promotion identity is deliberately configured. This rule
restricts writers; it does not verify test evidence or the source branch.
