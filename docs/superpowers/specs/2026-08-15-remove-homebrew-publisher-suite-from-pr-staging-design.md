# Remove Publisher Integration From PR Staging

## Problem

The ordinary `staging-build.yml` preflight provisions a pinned Homebrew
checkout, installs JavaScript dependencies, seals publisher-only host paths,
and runs `scripts/test-homebrew-publish-workflow.sh`. That integration suite
takes about 17 minutes and currently fails for publisher-policy drift that is
unrelated to whether an ABI candidate bottle can build.

Candidate reconciliation already validates the candidate request, Formula,
dependencies, bottle bytes, and tap-side records. Re-running the full
privileged publication lifecycle before each candidate wave does not add
evidence about those build contracts. It instead serializes useful build
feedback behind publisher-policy work.

## Decision

Ordinary pull-request staging must never run the full Homebrew publisher
integration suite. Remove the four steps that exist only for that suite:

- seal conventional host runtime ownership;
- check out the pinned Homebrew lifecycle source;
- install JavaScript dependencies for publisher preflight; and
- validate the Homebrew publisher trust contract.

Keep `scripts/test-homebrew-publish-workflow.sh`, its trust checker, and the
reusable publisher workflows intact. They remain validation authorities for
publisher-policy development and the actual publication/promotion boundary.

A fast structural contract must reject wiring the publisher suite, its
external lifecycle checkout, or its publisher-only host preparation back into
ordinary staging preflight. This change does not claim that unrelated existing
publisher-policy checks are green; those checks stay at their publication
boundary rather than blocking ordinary candidate work.

## Boundaries

- Do not change Formula source, package manifests, ABI identity, immutable
  request identity, candidate selection, bottle identity, or promotion data.
- Do not weaken candidate build or verification checks.
- Do not delete or relax the publisher integration suite.
- Do not add another path classifier or conditional PR route for the suite.
- Successful candidate bottles remain reusable because this is only a staging
  workflow orchestration change.

## Validation

The focused staging contract must first fail against the current workflow and
then pass after the four steps are removed. It must mutation-test each forbidden
publisher entry point. The focused staging and routing contracts must pass. The
complete publisher trust checker and `actionlint` remain separately observable;
pre-existing failures outside this diff must be reported rather than attributed
to this orchestration change.

Hosted candidate results remain the evidence for candidate build behavior;
the local workflow contract does not make a hosted timing claim.
