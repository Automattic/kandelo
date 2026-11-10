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
this document does not enforce a GitHub merge restriction.
