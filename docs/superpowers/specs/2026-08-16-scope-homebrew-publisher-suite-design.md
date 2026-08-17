# Scope the Homebrew Publisher Suite

## Problem

The `staging-build.yml` preflight runs
`scripts/test-homebrew-publish-workflow.sh` for every ordinary package or
runtime pull request routed through the legacy preflight. The suite exercises
the complete privileged Homebrew publication lifecycle and takes about
17 minutes. Most candidate iterations do not change that lifecycle, so the
cost delays feedback without increasing evidence for the changed code.

## Decision

Run the complete publisher suite in staging only when the protected change
scope reports `package_publish_flow_changed == true`. This includes both
publisher-only changes and mixed changes that touch publisher policy.

Apply the same condition to the four publisher-only setup steps:

- seal conventional host runtime ownership;
- check out the pinned Homebrew lifecycle source;
- install JavaScript dependencies for the publisher preflight; and
- run the complete publisher trust suite.

Ordinary package, runtime, and bottle-candidate iterations retain the normal
preflight matrix, xtask build, and relevant tests. The reusable publisher
workflows keep their existing immutable workflow and implementation digests;
this change does not weaken or regenerate those publication identities.

## Boundaries

- Do not change Formula source, package manifests, bottle contracts, ABI
  identity, request identity, or candidate selection.
- Do not alter `scripts/test-homebrew-publish-workflow.sh`; it remains the
  complete publisher-policy regression suite.
- Do not add a second path classifier. Use the existing fail-closed
  `package_publish_flow_changed` output.
- Keep the pinned Homebrew checkout and explicit source environment whenever
  the suite runs.

## Validation

The workflow contract test must reject an unconditional publisher setup or
suite step, reject a different condition, and retain the exact pinned Homebrew
source and explicit environment. The existing workflow trust checker and
change-scope contracts must remain green. A hosted ordinary package PR will be
used later to measure the avoided wall time; local structural tests do not
make a hosted timing claim.
