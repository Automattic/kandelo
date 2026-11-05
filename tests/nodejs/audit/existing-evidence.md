# Existing evidence review

This review reads prior reports only. No native reference, guest test,
browser probe or compilation was executed during this audit checkpoint.
The [evidence catalog](existing-evidence.json) preserves original counts,
source/artifact identities, report hashes and case-ledger hashes for the
inspected historical suites. This is a partial evidence audit.

## Completed initial baseline

The authoritative completed baseline reports are
`.context/node26-v3-full-{node,chromium,firefox,webkit}/summary.json`,
with matching `manifest.json` and `results.jsonl` in each directory.

| Host | Finalized / inventory | Pass | Fail | Upstream skip | Unsupported | Timeout | Harness error |
|---|---|---|---|---|---|---|---|
| Node | 5147 / 5147 | 3 | 3721 | 0 | 1423 | 0 | 0 |
| Chromium | 5147 / 5147 | 3 | 3721 | 0 | 1423 | 0 | 0 |
| Firefox | 5147 / 5147 | 3 | 3721 | 0 | 1423 | 0 | 0 |
| WebKit | 5147 / 5147 | 3 | 3721 | 0 | 1423 | 0 | 0 |

These counters report completed **accounting**, not complete Node API
coverage or passing compatibility. The initial selection covers parallel
and sequential tests, not every relevant public-API suite. The first
record in the Node case ledger, for example, is unsupported because the
guest CLI lacks verified mappings for its required flags. It did not run
and pass the test body.

The Node manifest identifies git head
`66db9db1f640afdb57a1a91e79c06df4653c74de`, kernel SHA-256
`36d97bfbef2e46a8813de186742daf4b1cc07803822b3830bfdca96e37393258`,
and guest Node archive SHA-256
`5cb7399b6115732c92c68bc1b76a142f425b040bc6c0ff1be18b820625f52a41`.
Each host's own identities remain in the catalog; do not substitute the
Node host's complete identity for the browser hosts'. These reports are
not evidence for the current unbuilt source candidate.

Earlier `node26-full-*` and `node26-v2-full-*` directories contain
incomplete runs. Their original counters and pending totals are retained
in the catalog. They must not replace the completed v3 baseline or be
combined with it into an artificial pass total.

## What the baseline failures establish

Read-only examination of the preserved baseline stderr found **3,687 of
3,721 failures per host** have the first diagnostic
`net.getDefaultAutoSelectFamilyAttemptTimeout is not a function`.
The upstream `test/common/index.js`:207 calls that accessor while loading
the shared helper, before most test-specific assertions. These failures
show a shared prerequisite failure on those artifacts; they do not show
3,687 independent module-specific semantic failures. Their original fail
statuses remain unchanged.

`baseline-failure-analysis.json` retains every affected case key, original
ledger hashes, exact first-diagnostic groups and example stderr hashes.
Current bootstrap:4824 defines the accessor, a later source difference;
that observation does not validate the new source or reveal which later
assertions would fail. Only an authorized subsequent run can expose them.

The three baseline passes on each host are test-regression-object-prototype,
test-vm-not-strict and test-zlib-no-stream. Their narrow coverage must not
be generalized to those families.

## Selected event evidence

| Historical run | Finalized / inventory | Pass | Fail | Upstream skip | Unsupported | Timeout | Harness error |
|---|---|---|---|---|---|---|---|
| Native event upstream selection | 36 / 36 | 36 | 0 | 0 | 0 | 0 | 0 |
| Node event upstream r2 | 36 / 36 | 22 | 10 | 0 | 4 | 0 | 0 |
| Chromium event upstream r2 | 36 / 36 | 22 | 10 | 0 | 4 | 0 | 0 |
| Firefox event upstream r2 | 36 / 36 | 22 | 10 | 0 | 4 | 0 | 0 |
| WebKit event upstream r2 | 19 / 36 | 13 | 5 | 0 | 0 | 0 | 1 |

The WebKit selection has 17 pending cases. Preserve its original
`harness-error` classification rather than reclassifying an interrupted
run as passing or unsupported. The underlying error record and launcher
behavior still need examination before assigning a root cause.

The preserved harness-error case is test-event-emitter-once.js and records
`page.evaluate: Target page, context or browser has been closed`.
That is a launcher/context failure record, not evidence that EventEmitter
or the WebKit engine caused the shutdown. It must remain unresolved
without a source/artifact-specific causal trace.

There are also four historical `node26-events-runtime-*/result.json`
reports containing seven selected passing controls each. Their embedded
source and artifact provenance is preserved separately in the catalog.
These controls do not establish the entire EventEmitter/EventTarget
surface, other module families or the current candidate's behavior.

## Durable preservation and accounting review

`historical-evidence.tar.gz` preserves 156 pre-existing node-prefixed
summary/control reports, their available manifests/preflight records,
original case ledgers and every referenced stdout/stderr log. The archive
contains 61,456 files; its original member hashes and archive SHA-256 are
recorded in `historical-evidence-index.json`. It excludes large images,
binaries and source trees; their original manifest identities remain.

The accounting review parsed existing ledgers, checked duplicate case
keys and fingerprints, compared status counts/finalized/pending totals
with summaries and checked referenced logs. No accounting mismatch or
missing referenced log was found in those suite reports. This is metadata
inspection, not new runtime execution or independent proof that every
original status classification/assertion is correct.

Additional historical networking reports include native targeted 8/8
passing versus all four guest hosts failing 8/8. Later selected networking
controls on four hosts report exit 0 and node-network-client-ok, on other
identified artifacts. These scopes/identities must remain separate; the
controls do not supersede upstream failures or establish full networking.
Selected result formats vary, so unrecognized result shapes are retained
without inventing a pass/fail count.

## Remaining evidence audit

- Match individual findings to actual test cases and control assertions;
  a similarly named file is only a validation candidate.
- Review raw result classification against exit status, assertions, skips,
  required flags, fixture activation and test-body execution.
- Inspect assertion/skip and launch classifiers against preserved raw logs
  and fixture sources. The accounting is reconciled; semantic correctness
  and API-specific applicability still require review.
- Reconcile other existing networking, timers, process and event reports
  and the coverage checkpoint files. Stale prose in a checkpoint may
  describe source that has since changed.
  For example, `coverage/net.json` describes old duplicate-listener
  removal behavior, while the current EventEmitter searches backward
  and removes one match. This source difference does not retroactively
  change that report or validate the current source.
- Review all 39 upstream categories and nested fixtures for public-API
  applicability, required launchers and actual capability prerequisites.
- Keep the durable archive and index together; later runs must preserve
  equivalent case-level evidence and artifact identities. The archive
  does not include executable/image bytes or every historical source tree.

Missing native controls, incomplete runs, unsupported cases and unreviewed
categories remain explicit gaps in conformance evidence. They are not
accepted platform boundaries and do not count as passes.
