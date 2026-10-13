# October 9 integration: batch 3

## Why

The remaining browser tool-registration stack and major dependency
upgrade need review against the integrated kernel and host contracts.
Combining them after the ABI batch keeps their integration order visible.

## Planned changes

PR #1515 is merged. This batch starts from main at `fe2712d6be`.
The three browser pull requests target this batch branch and are being
adapted in the order below. Original contributor authorship is retained.

| Order | Original category | PR | Title |
| --- | --- | --- | --- |
| 1 | 6. WebMCP stack | #1407 | Browser: Add WebMCP tools for the shared guest computer |
| 2 | 6. WebMCP stack | #1414 | Browser: Register WebMCP tools declared in the booted image |
| 3 | 6. WebMCP stack | #1435 | Browser: Give every WebMCP tool one registration path and one kernel surface |
| 4 | 7. Major tooling upgrades | #1433 | Bump the npm-major group across 6 directories with 3 updates |

Integrate the WebMCP stack in the listed order. Resolve conflicts against
the completed ABI batch, preserving actual filesystem, registration,
worker and guest-computer authority. PR #1433 was closed without merging.
Defer its major tooling upgrade until the browser tools pass validation,
then prepare a separate updated replacement so dependency failures remain
distinguishable from tool failures.

PR #832 stays excluded. PR #1446 is outside the approved batch table
and is not part of this placeholder.

## Validation before merging

Run the normal build, browser production build, full host and browser
checks, tool-registration and service-worker contracts across supported
engines, and manual browser verification. Review Node/browser parity
and run conformance, ABI and benchmark checks for any affected runtime
contracts. Keep Erlang validation deferred unless the maintainer requests
its restoration.

Record exact heads, results, skipped checks and remaining risks in this
batch PR. Its placeholder commit changes documentation only; earlier
batch validation does not establish validation of these future changes.
