# ABI staging candidate dependency materialization

## Purpose

ABI-staging builds must compile against the exact dependency bottles selected
by protected coordination.  The coordinator already downloads and hashes those
bottles, but the build adapter currently leaves the source tap's production
bottle blocks unchanged and exports the downloaded directory under a variable
the normal Homebrew builder does not consume.  Homebrew therefore pours the
production bottle named by the source Formula and the provenance check rejects
its production URL when the build expects the candidate namespace.

## Design

The protected tap handoff creates a temporary prepared tap checkout after it
has validated the original tap plan and the exact dependency layers.  For each
direct dependency, it changes only the selected architecture's bottle digest
and the bottle root to the common ABI candidate parent.  It makes one
deterministic local commit and emits the original public tap commit plus the
prepared checkout commit as separate identities.

The exact-head Kandelo ABI adapter continues to validate the request, Formula
plan, bottle contract, and original tap checkout before preparation.  It then
invokes the normal Homebrew builder with the prepared checkout, the original
tap commit in `KANDELO_HOMEBREW_TAP_SOURCE_COMMIT`, the prepared commit in
`KANDELO_HOMEBREW_PREPARED_TAP_COMMIT`, and the exact downloaded dependency
directory in `KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE`.  Existing prepared-tap
support makes Homebrew receipts and provenance distinguish public source from
the local materialization.

No target Formula recipe, bottle contract, request ABI, candidate publication
namespace, or canonical tap metadata changes.  A dependency without one exact
declared candidate layer, a noncanonical Formula bottle block, a symlink, a
digest mismatch, an unexpected checkout change, or a nondeterministic prepared
commit fails before Formula execution.

## Alternatives rejected

- Accept the production URL while silently pouring a candidate archive.  This
  would make Formula metadata disagree with the bytes Homebrew selected.
- Manually unpack dependency bottles.  This bypasses Homebrew's normal bottle
  installation and receipt path.
- Promote every dependency before downstream staging.  That destroys the
  purpose of candidate dependency waves and makes partial failures impossible
  to isolate.

## Validation

Tap tests cover deterministic preparation, exact bottle-block replacement,
multi-dependency closure, architecture selection, symlink/digest rejection,
and unchanged non-bottle Formula bytes.  Kandelo adapter tests prove the normal
builder receives the prepared checkout identities and exact local cache.  A
real focused cross-repository test resolves a prepared dependency URL to the
candidate repository and hashes the selected local archive.  Hosted proof is a
fresh ABI 43 reconciliation wave in which a required downstream Formula passes
dependency provenance and enters compilation.
