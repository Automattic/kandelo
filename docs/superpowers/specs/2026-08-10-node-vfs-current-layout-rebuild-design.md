# Restore ABI-42 Shell and Node VFS Publication

## Status

Approved direction, pending implementation.

## Why

The published ABI-42 `node-vfs` revision 14 image was composed from the
retired lazy Homebrew shell. Its deferred bottle trees use the retired guest
Homebrew prefix, while the current host relocates receipt-owned Homebrew files
for `/opt/kandelo/homebrew`. When the old image first
materializes a changed bottle member, the bytes no longer match the size and
digest registered in the image. The VFS rejects the tree before `npm` runs.

The package resolver correctly refuses to reuse that archive for the current
source identity. Its source-build fallback also correctly stops because the
next canonical `shell` revision is still `pending`: the old shell recipe
depends on a retired selection campaign whose locks were intentionally closed
during the flat-VFS migration. Marking that revision ready would assert that
an artifact exists when its declared build inputs cannot produce one.

The replacement Homebrew product already exists. The tap publishes an
immutable, digest-bound, self-contained flat VFS whose 41-bottle closure has
been booted in both Node.js and Chromium. A diagnostic Node image composed
from that product completed the real browser proxy path for
`npm install --verbose cowsay` and ran the installed command. It is currently
an experimental Homebrew product rather than the canonical Kandelo shell, so
copying it directly into a package release would bypass package identity,
browser configuration, provenance, and merge-candidate validation.

Publication is also blocked independently. Scheduled merge-candidate
activation encounters a rejected candidate from before GitHub release
immutability was enabled. That release is published and mutable but already
contains a valid `rejected.json`. The reconciler validates its obsolete
lifecycle shape before checking terminal markers, so one terminal historical
record prevents all newer candidates from being considered.

These failures form one release-path incident. Rebuilding only `node-vfs`
would leave the canonical shell unavailable, every other shell-derived image
stale, activation blocked, and GitHub Pages racing package publication.

## Contracts Touched

This work changes package recipes and revisions, VFS image provenance,
merge-candidate reconciliation, and browser publication. It must preserve:

- package artifacts are built and activated only through the normal package
  resolver and merge-candidate workflows;
- the shell and every derived image are self-contained, digest-bound products
  whose metadata describes the bytes actually published;
- GitHub Pages consumes canonical package assets and never becomes a second
  package publisher;
- rejected candidates remain immutable terminal audit records;
- lifecycle compatibility is narrow, explicit, and fail-closed;
- Node.js and browser hosts consume the same VFS format and observable guest
  state; and
- ABI 42 remains unchanged because no syscall, process, channel, memory, or VFS
  serialization contract changes.

## Decision

Promote the current flat Homebrew closure through the canonical `shell`
package, rebuild the complete shell-dependent package closure, repair
activation so terminal legacy records cannot block current candidates, and
sequence Pages deployment after successful package activation.

The implementation has four connected parts.

### 1. Canonical self-contained shell

Check in a canonical shell selection derived mechanically from the tap's
published 41-bottle ABI-42 selection. Bottle identities, URLs, sizes, and
digests remain exact. Only product-owned fields change:

- the product name identifies the canonical main shell;
- the requested output filename is `shell.vfs.zst`; and
- the resource policy is the canonical main-shell policy.

The experimental product uses a 768 MiB maximum VFS size. The canonical shell
must retain its 512 MiB profile so derived images have their existing 768 MiB
headroom. Add a main-shell flat-VFS resource policy with the same per-bottle
and aggregate safety limits and a 512 MiB output limit. Do not change the
experimental policy. The current flat image is about 345 MiB uncompressed, so
the canonical build should fit; the build must prove that rather than assume
it.

Refactor `packages/registry/shell/build-shell.sh` to build the product entirely
from declared inputs:

1. validate the resolver-owned output directory and wasm32 target;
2. prepare an isolated source snapshot and repository-locked JavaScript tools;
3. build the ABI-42 platform-only base rootfs from `images/rootfs`, without
   depending on the current lazy `rootfs` package artifact;
4. invoke the digest-bound flat-VFS builder with the checked-in canonical
   selection and public bottle cache;
5. bind the canonical shell and browser demo configuration into the image; and
6. install only the declared `shell.vfs.zst` output.

The platform-only base contains Kandelo-owned eager files. The flat builder
then fully materializes the selected bottles under `/opt/kandelo/homebrew`.
It projects every selected `bin/*` command into the conventional `/bin` and
`/usr/bin` namespaces and installs the explicit compatibility aliases from the
shell product contract, including `sh`. Reserved extraction commands remain
bound to their designated bottles. Publication inspection requires eager,
root-owned `bash`, `sh`, `env`, and `brew` entrypoints. The output contains no
deferred trees, bootstrap archive, mirror plan, or mutable runtime download
authority.

Extend the generic flat builder with an optional demo-configuration input.
Validate it through the existing demo-config contract, write
`/etc/kandelo/demo.json`, and bind its digest and byte length in generic image
metadata. Keep the `homebrewFlat` proof exact so existing experimental builds
remain reproducible when the option is absent. The canonical shell continues
to bind `/etc/kandelo/shell.json` through `shellConfig`.

Set shell revision 23 to `ready` only after its recipe and declared inputs are
self-contained and buildable. Replace the retired campaign locks in
`build.toml` with the flat selection, builder, policies, configuration, and
transitive build sources. Keep authored provenance `UNPUBLISHED`; the package
workflow stamps and verifies the exact producer commit.

### 2. Truthful derived-image provenance

The shared shell-derived-image helper currently recognizes source-rootfs and
legacy lazy-Homebrew lineages. Add a third, mutually exclusive flat-Homebrew
lineage. It must:

- validate and preserve the exact `homebrewFlat` and `shellConfig` bindings;
- preserve the canonical shell artifact as the direct `baseImage` input;
- preserve generic demo-config ownership until a derived builder replaces the
  file; and
- recompute the demo-config digest and byte length when Node, LAMP, WordPress,
  or nginx image construction writes product-specific demo metadata.

It must not synthesize legacy `packageDeferredTrees`, `homebrewBootstrap`,
`homebrew`, or mirror claims. Ambiguous or incomplete lineage metadata fails
visibly.

Advance every package whose output legitimately changes with the new shell:

| Package | Current revision | New revision |
|---|---:|---:|
| `node-vfs` | 14 | 15 |
| `lamp` | 11 | 12 |
| `wordpress` | 12 | 13 |
| `nginx-vfs` | 2 | 3 |
| `nginx-php-vfs` | 2 | 3 |

Update their declared shell inputs and comments, keep new authored provenance
as `UNPUBLISHED`, and regenerate the authoritative program-package index.
The package candidate matrix may stage dependencies through its existing
workflow artifacts, but the resulting candidates must use the same package
recipes and resolver path used after publication.

### 3. Terminal-aware merge-candidate reconciliation

Reorder candidate reconciliation around durable state rather than GitHub's
historical release presentation:

1. validate tag identity, target commit, and required boolean field types;
2. list and validate terminal `activated.json` and `rejected.json` markers;
3. reject an ambiguous candidate containing both markers;
4. skip a valid terminal candidate before requiring the current release
   lifecycle shape; and
5. require every nonterminal candidate to be either a draft mutable candidate
   or a published immutable sealed candidate.

The compatibility exception is intentionally narrow. A published mutable
release is tolerated only when it already has one valid terminal marker. A
nonterminal published mutable release still fails closed, and malformed
terminal metadata still fails. The old rejected release remains in place as
an audit record; no release deletion, tag-specific exception, or forced
activation is involved.

Add fixture-based regression coverage for the grandfathered rejected state,
the corresponding activated state, ambiguous markers, malformed markers, and
a nonterminal published-mutable release.

### 4. Activation-owned Pages sequencing

Cut the browser deployment workflow over from the retired lazy-shell campaign
to canonical package resolution. It must fetch the current shell and Node VFS
from the ABI-42 package release, inspect their flat provenance against the
checked-in selection and configuration, verify the exact bytes emitted into
the site, and boot them in Chromium. It must not fetch a bootstrap archive,
construct a mirror plan, or publish a replacement package.

The old Homebrew main-shell staging proof cannot remain a required proof of
the new product. Normal package staging now owns the canonical shell build and
browser acceptance. Keep any historical reusable workflow only as inert
recovery machinery; route the required staging aggregate through the generic
package test gate so branch protection retains a stable check name without
asserting obsolete lazy-shell behavior.

A push-triggered Pages run can race post-merge package activation and fail
fetch-only resolution before the new revisions exist. Have the activation
workflow record whether it activated at least one candidate and dispatch the
Pages workflow on the default branch after reconciliation. Grant only the
required Actions permission. Dispatch even if a later candidate fails after a
prior activation, and do not dispatch for an empty scheduled scan. Existing
Pages concurrency cancels the early push run when the post-activation run
starts.

## Publication Flow

The resulting release path is:

1. A pull request builds shell revision 23 and all changed dependents from the
   synthetic merge tree.
2. Package tests inspect their provenance and browser acceptance runs
   `npm install --verbose cowsay` against the staged Node image.
3. Prepare-merge seals the exact successful candidates as immutable releases.
4. After merge, the reconciler ignores valid historical terminal records,
   verifies the merge relationship, and atomically activates the candidates
   into `binaries-abi-v42`.
5. Activation dispatches Pages after canonical package indexes have changed.
6. Pages resolves and verifies those canonical assets and deploys the site.

No job copies the experimental VFS into the canonical release, and Pages does
not build or activate package candidates.

## Alternatives Rejected

### Mark shell revision 23 ready without changing its recipe

The declared retired selection product does not exist. Changing only state
would turn an honest pending package into a false publication promise.

### Reopen the retired lazy-shell selection campaign

That would reverse the flat-VFS migration, restore external mirror and
bootstrap authority, and preserve the layout-sensitive artifact responsible
for the incident.

### Publish the experimental VFS bytes directly as `shell.vfs.zst`

Those bytes have experimental product identity, a 768 MiB policy, and no
canonical browser demo binding. Copying them would bypass package provenance
and make a release asset claim a recipe did not produce.

### Patch lazy materialization or relocate old bytes at runtime

That would hide a stale artifact behind a compatibility shim and make runtime
host defaults part of authenticated image content. The current product can be
rebuilt cleanly, so no compatibility boundary justifies such a change.

### Rebuild only `node-vfs`

The canonical Node package depends on a canonical shell, and all other
shell-derived outputs change with that base. A one-package rebuild would leave
the package graph and live browser publication internally inconsistent.

### Delete or special-case the blocking historical candidate

The release is a valid rejected audit record. Reconciliation should understand
terminal state generically instead of erasing evidence or naming one tag.

## Deferred Platform Work

Add an explicit item to `docs/future-improvements.md` for compatibility with
downloaded, shared, historical, or eventually persisted lazy VFS images.
Kandelo does not currently persist machine images, and this repair targets the
canonical current artifact. If durable restoration is later supported, image
admission must authenticate the relocation inputs needed to reproduce deferred
bytes or reject an incompatible image before it boots. It must not consult
mutable host defaults and then fail on first file access.

This future item records unsupported future work; it does not claim that old
lazy images become compatible after the rebuild.

## Validation

Validation supports the complete current-publication claim, not historical
image compatibility:

1. Run fixture tests proving terminal legacy candidates are skipped and
   nonterminal or malformed legacy candidates remain blocked.
2. Build the canonical shell through `scripts/dev-shell.sh`; inspect the exact
   bottle selection, `/opt/kandelo/homebrew` layout, configuration bindings,
   ABI, self-contained state, and 512 MiB resource ceiling.
3. Exercise flat-lineage metadata tests for preservation, derived demo-config
   replacement, and rejection of ambiguous or fabricated lineages.
4. Build and inspect all five shell-derived package revisions through the
   package-owned resolver path.
5. Run package schema, cache-key, generated-index, workflow-structure,
   documentation, and shell-script checks affected by the changes.
6. Boot the staged canonical shell in Node.js and Chromium.
7. Boot the exact staged Node image in Chromium and run the existing
   `npm install --verbose cowsay` proxy acceptance, requiring a zero exit
   status, no VFS materialization error, and successful `cowsay` output.
8. Push the reviewed repair, observe required pull-request checks, merge the
   exact tested tree, and monitor merge-candidate activation.
9. Verify the anonymous canonical ABI-42 indexes and asset digests, the
   post-activation Pages deployment, and the same cowsay acceptance against
   the live deployed assets.

Claims about browser behavior require the browser checks above; Node-only
tests are not substitutes. Final reporting names every validation command and
any check that could not be run.

## Rollback and Failure Behavior

Before activation, a failed build or test leaves current canonical indexes
unchanged. After activation, package releases remain immutable and auditable;
any correction advances package revisions through another candidate rather
than mutating published bytes. A Pages failure does not alter package assets
and stays visible as a deployment failure. A candidate that cannot prove its
identity, lifecycle, merge relationship, or terminal state fails closed.

## Non-Goals

- Supporting old, downloaded, saved, shared, or persisted lazy VFS images.
- Adding a deferred-tree byte transform or compatibility schema.
- Changing Homebrew runtime relocation behavior.
- Changing syscall, kernel, process, or host-runtime semantics.
- Bumping the kernel/process ABI.
- Making GitHub Pages a package publisher.
