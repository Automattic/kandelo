# Restore the Lightweight Lazy Shell from the Active Selection

## Status

Approved design, pending implementation.

This design supersedes the eager-shell decision in
`2026-08-10-node-vfs-current-layout-rebuild-design.md`. That earlier repair
correctly restored package activation and GitHub Pages sequencing, but it
incorrectly changed the canonical shell product from a lightweight lazy image
into a fully materialized image.

## Why

The current public ABI-42 shell is about 45.6 MB compressed. The last sealed
mostly-lazy shell was about 5.75 MB compressed. The size increase is not a
compression regression: shell revision 23 pours all 41 selected Homebrew
bottles into the boot image and the Pages proof requires an empty lazy state.

That product contradicts the intended shell contract. The boot image should
contain the platform and the small closure needed to start the selected shell.
Other Homebrew commands should retain authenticated deferred-tree references
and download their exact bottle-derived payloads on first use. A user should
not have to transfer every selected command before seeing a prompt.

The active flat selection is still the correct package authority. It records
the admitted ABI, architecture, bottle URLs, byte counts, digests, dependency
identities, link ownership, resource policy, and runtime-support product. The
error was treating that selection as a mandate to embed every selected bottle.
It can instead feed the existing lazy VFS composer.

The retired selection campaign and its pending lazy-artifact lock are not
current authority. Reopening them would create a second source of bottle
identity and would reintroduce stale tap and relocation inputs. This repair
must derive the lazy image directly from the active flat selection.

## Contracts Touched

This work changes package recipes, Homebrew VFS composition, deferred asset
publication, shell-derived image provenance, and GitHub Pages acceptance. It
must preserve these invariants:

- the active canonical selection is the only bottle-identity authority;
- every embedded or deferred byte is derived from and verified against that
  selection;
- the shell package and its mirror are immutable, content-bound products;
- package activation precedes Pages deployment;
- Pages consumes canonical package assets rather than publishing substitutes;
- Node.js and browsers restore the same deferred-tree state; and
- ABI 42 remains unchanged because the existing VFS and deferred-tree schemas
  are reused without an incompatible wire-format change.

## Decision

Keep `homebrew/main-shell-flat-selection.json` as the sole admitted selection,
adapt its exact plan to the existing lazy composer, embed only the reviewed
boot closure, publish every remaining tree through the existing immutable
mirror lane, and rebuild the complete shell-derived package closure.

The canonical product remains a normal `shell` package. The words "flat
selection" describe its authoritative input format; they no longer imply an
eager output image.

## Selection-Backed Composition

`planHomebrewVfsSelection()` already validates canonical selection bytes and
returns a `HomebrewFlatVfsPlan`. The lazy composer currently accepts only the
older `HomebrewVfsPlan`, whose catalog and campaign fields do not exist in the
flat selection.

Introduce a narrow composition-plan contract containing only facts that both
paths can truthfully supply: ABI, architecture, ordered bottle descriptors,
resource and link policy, output identity, and the digest of the authoritative
selection. Generalize the original-bottle collection and composer over that
contract, or add an equivalent explicit flat-plan entry point. Do not invent
old tap, campaign, cache-key, or migration-lock provenance to satisfy a type.

The composer continues to perform one complete pour in a private scratch VFS
to calculate exact file ownership, relocation, links, collisions, and source
inventories. It then projects those verified results into embedded and
deferred trees. This preserves the current flat builder's exact ownership
proof while avoiding eager serialization of every selected payload.

The composition report and image metadata bind the canonical selection digest
and distinguish this lineage from both the retired campaign-based lazy image
and the eager flat image. Imported or derived images with ambiguous lineage
fail closed.

## Materialization Policy

`homebrew/main-shell-materialization-policy.json` remains the boot policy. Its
embedded root is Bash, and its ordered closure is `libcxx`, `ncurses`, and
`bash`. Those bottle trees are materialized before serialization so the prompt
and conventional `sh` and `bash` entry points require no network access.

Every other selected bottle must remain represented by authenticated deferred
state or, for `homebrew-bootstrap`, be the authenticated source of the
existing deferred bootstrap ZIP tree. Each selected descriptor belongs to
exactly one composition partition, and the union of those identities must
equal the canonical selection exactly. An empty deferred partition is a build
error.

Homebrew runtime activation is derived from the selected descriptors and a
selection-relative product policy. The current campaign-era runtime-support
file must not supply a second bottle list or stale tap commit. The composer
must validate the selected `homebrew-bootstrap` support outputs and the exact
Ruby dependency closure, register each bottle tree once, and preserve the
existing atomic activation semantics for `/usr/bin/brew`. Dependencies shared
with ordinary deferred commands remain one authenticated tree rather than
duplicated payloads.

For the current 41-descriptor selection, the mechanically derived partition
is:

- embedded boot bottles: `libcxx`, `ncurses`, and `bash`;
- the `homebrew-bootstrap` descriptor, which authenticates the bootstrap ZIP
  and environment instead of registering its bottle as a guest keg tree;
- runtime-support additions absent from the 38-package base order:
  `libyaml` followed by `ruby`; and
- the remaining 35 descriptors as ordinary independent deferred bottle trees.

The bootstrap ZIP tree and the two runtime-support additions form the sealed
runtime activation cohort. The other 35 bottle trees stay independently
deferred. Tests derive these sets from the current selection, dependency
edges, materialization policy, and runtime roots, then assert the counts above
as current-product evidence. A later selection change must update the derived
evidence rather than a second hand-maintained bottle list.

## Immutable Deferred Mirror

Browsers cannot consume authenticated GHCR bottle blobs directly through the
current anonymous fetch path. The composer therefore continues to produce a
content-addressed bottle-mirror plan and one exact payload per deferred
original-bottle tree.

Reuse the existing Homebrew main-shell mirror publisher and immutable GitHub
Release format. The mirror contains the 37 deferred original-bottle trees: 35
ordinary trees plus `libyaml` and `ruby`. Its release identity is derived from
the complete payload collection. The embedded plan records only immutable
public URLs, digests, sizes, package identities, and tree identities.
Publication rejects missing, extra, mutable, privately readable, or
byte-mismatched assets.

The authenticated bootstrap ZIP, its environment, and its package-tree
descriptor remain separate closed companion assets because their runtime
format is not an original-bottle tree. Their identities are sealed into the
same candidate and activation proof. They do not create a second selection or
permit mutable input.

Package activation may not expose a shell whose mirror is unavailable. The
trusted flow must publish and anonymously read back the exact mirror before it
activates the package generation that references it. Existing package
candidate identity, exact-main authority, and release immutability checks stay
in force.

The mirror is a companion transport product, not a second selection authority.
Changing a mirror URL or payload changes the embedded plan and therefore the
shell package bytes and revision.

## Shell-Derived Images

The shell-derived image helper must preserve the exact deferred-tree registry,
mirror plan, selection binding, resource capacity, and ABI when it adds a
package-specific eager layer. It must not reject deferred input state or
materialize shell trees while reading or serializing the base image.

Advance every reverse-dependent package whose bytes change, including
`node-vfs`, `lamp`, `wordpress`, `nginx-vfs`, and `nginx-php-vfs`. Their
package-owned builders continue to replace only their own demo metadata and
eager program files. Each derived image records the exact canonical shell
archive as its direct base.

The Node image contains Node and npm eagerly but retains the shell's deferred
Homebrew state. Installing an npm package must not cause a Homebrew bottle
download unless the guest actually executes a deferred Homebrew command.

## Publication and Pages Flow

The corrected release sequence is:

1. Pull-request staging builds the lazy shell and every changed dependent from
   the exact synthetic merge tree.
2. The same candidate yields the sealed mirror and bootstrap companion
   bundles, shell, derived images, selection/report evidence, and browser
   fixtures.
3. Tests prove the embedded/deferred partition, immutable URLs, boot behavior,
   and first-use downloads in Node.js and browsers.
4. Prepare-merge seals the successful package candidates and exact mirror
   handoff without rebuilding either product.
5. After merge, trusted current-main code publishes and anonymously reads back
   the mirror, then activates the package generation.
6. Activation dispatches Pages with the exact source, candidate, and package
   index identities.
7. Pages resolves the canonical shell and Node archives from a fresh
   fetch-only cache, verifies them, imports those exact bytes into Vite, and
   deploys only after the browser acceptance checks pass.

No push or pull-request Pages job can publish a mirror or package. A premature
Pages run fails visibly and is superseded by the post-activation dispatch.

## Product and Acceptance Evidence

Image inspection must prove all of the following before publication:

- the shell binds the exact active selection digest and ABI 42;
- the embedded package order is exactly the reviewed Bash closure;
- the deferred package set is nonempty and completes the selection exactly;
- the embedded mirror plan is nonempty and matches the publication bundle;
- all deferred tree URLs, sizes, digests, inventories, and ownership records
  are closed and reloadable;
- Bash's executable closure is embedded and does not depend on a deferred
  bottle, even if the reviewed Homebrew bootstrap policy performs a separate
  prefetch;
- invoking a selected deferred command downloads its exact tree and records a
  completed lazy-download summary;
- invoking that command again performs no second download; and
- save/restore and every shell-derived image preserve the same pending state.

The compressed canonical shell is capped at 10 MiB. This is a release
invariant, not a performance estimate: it leaves margin above the prior
5.75 MB artifact while preventing another complete 45.6 MB bottle closure
from being mislabeled as a lightweight shell. Any intentional increase beyond
that cap requires a reviewed product-policy change with measured asset data.

The existing bootstrap policy is `boot-prefetch`, so shell readiness requires
completed ledger entries for the bootstrap ZIP and its sealed runtime cohort.
The acceptance proof then invokes at least one independently deferred command
and requires the ledger to grow with its completed tree. This distinguishes a
genuinely lazy image from both a broken mirror and an eager image with nothing
left to fetch.

## Failure and Rollback Behavior

Composition fails before publication for a changed selection digest, wrong
ABI, invalid bottle, ownership conflict, incomplete partition, empty mirror,
stale runtime policy, or materialized non-boot tree. Mirror publication or
anonymous readback failure blocks package activation. Package activation or
Pages failure leaves the previously admitted generation and public assets
unchanged.

Published package and mirror assets remain immutable. A correction advances
package revisions and content-derived mirror identity; it does not edit or
delete the failed evidence in place.

## Alternatives Rejected

### Keep the eager shell and rely on compression

Compression cannot remove the selected programs' real payload bytes. This
preserves the 45.6 MB startup transfer and the empty deferred product.

### Reopen the retired closed-selection campaign

Its locks identify obsolete campaign and tap state. Restoring it would create
two authorities for the same current bottle closure.

### Construct old rich-plan fields from the flat selection

The flat selection does not authenticate those historical fields. Fabricating
them would make reports look stronger than their inputs.

### Rebuild only Node

Node consumes the canonical shell. Rebuilding it alone would retain the eager
base and leave the reverse-dependent package graph inconsistent.

## Validation

Implementation starts with failing tests for flat-plan lazy composition,
partition completeness, runtime activation, derived-image preservation, and
workflow ordering. Validation then includes:

- focused host tests for planners, bottle collection, composition, mirror
  plans, deferred trees, and shell-derived images;
- package recipe, revision, cache-key, and generated-index tests;
- workflow structure, mutation, action-pin, and shell-script checks;
- canonical shell and complete reverse-dependent package builds through
  `scripts/dev-shell.sh`;
- image inspection and compressed-size measurement;
- Node.js boot, deferred-command, and save/restore checks;
- Chromium, Firefox, and WebKit deferred-tree contract checks where the shared
  browser behavior changes;
- Chromium staging acceptance for the exact shell and Node products;
- immutable mirror and package readback after merge; and
- live Pages verification of the served shell digest, transfer size,
  first-use ledger, and npm acceptance.

Exact commands and any omitted validation will be reported with the
implementation. Browser evidence is required for browser claims; Node-only
results are insufficient.

## Non-Goals

- Supporting restored lazy images from earlier releases.
- Reopening or republishing the retired selection campaign.
- Changing bottle contents, the guest Homebrew prefix, or ABI 42.
- Making GitHub Pages a package or mirror publisher.
- Persisting lazy-download history across kernel replacement.
