# Independent Invalid Request-Feed Subjects

## Problem

The protected request feed enumerates as many as 256 open same-repository pull
requests during a policy-change or repair run. Each structural report is
revalidated by protected `xtask`, but the first report whose canonical outcome
is `invalid` returns the `request_invalid` guard as a process failure. Because
the workflow loop runs under `set -e`, that one candidate-owned failure aborts
derivation for every later subject. An old invalid draft pull request can
therefore prevent unrelated eligible pull requests from receiving immutable
staging requests.

## Decision

Add a protected structural-report feed-disposition command. It performs the
same bounded parsing, canonical-JSON check, exact source/tree checkout check,
protected previous-ABI check, checker-byte check, snapshot-byte check, and
target-ABI check as strict validation. Only after those checks succeed does it
write one canonical disposition document:

- `eligible` for `compatible` and `bumped-with-snapshot` reports;
- `candidate-invalid` plus the registered guard code for
  `changed-without-bump` and `invalid` reports.

The existing `structural-report validate` command remains strict and continues
to fail for both candidate-invalid outcomes. The batch request-feed workflow
uses the new disposition command, skips only authenticated
`candidate-invalid` subjects, and continues to derive requests for eligible
subjects. Any malformed document, source mismatch, checkout mismatch,
protected-ABI mismatch, checker mismatch, snapshot mismatch, or target mismatch
still fails the whole protected derivation job.

## Alternatives Rejected

Parsing the validator's stderr would couple control flow to diagnostic text.
Reading `.outcome` with `jq` before validation would let untrusted evidence
choose whether validation runs. Running one GitHub job per subject would isolate
failures but add substantial workflow and runner overhead for a behavior that a
small authenticated disposition already models.

## Testing

Rust tests will prove that the disposition is written only after exact identity
validation, maps both candidate-owned invalid outcomes to registered guards,
and leaves strict validation unchanged. Workflow contract mutations will prove
that candidate-invalid subjects are skipped, eligible subjects continue, and
the disposition command cannot be replaced with direct `jq` inspection or a
swallowed validator failure. The existing request-policy freshness check will
bind the changed workflow and protected implementation.
