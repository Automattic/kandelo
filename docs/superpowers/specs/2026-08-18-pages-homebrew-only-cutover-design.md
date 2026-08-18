# Pages Homebrew-Only Product Cutover

## Purpose

The production Pages product graph is still hybrid. Kandelo has built
and verified ABI 43 Homebrew bottles, but several VFS manifests continue
to consume Kandelo `software.package` outputs. This duplicates builds,
hides incomplete tap promotion, and lets local fixtures pass without
exercising the graph shipped to Pages.

This change completes the migration for the seven production Pages
products. Their application and userland software will come exclusively
from `kandelo-dev/homebrew-tap-core` bottles. The exact Kandelo kernel
and
build runtime remain protected platform/toolchain inputs, not Homebrew
packages.

## Scope

The required production product set is:

- `platform-rootfs`
- `browser-main-shell`
- `browser-node`
- `browser-nginx`
- `browser-nginx-php`
- `browser-lamp`
- `browser-wordpress`

The final recursive graph for these products must contain no
`[[software.package]]` declarations and no resolved `package-output`
inputs. Other, non-Pages VFS products will be audited after this cutover
and do not block this deployment.

## Current State

The Pages graph still takes Kandelo package outputs for the base
command-line tools, Homebrew bootstrap, Node, nginx, PHP, MariaDB,
dinit,
and msmtpd. PHP and the kernel also appear as build-only package inputs.

Most corresponding Formulae already exist in the tap. Node, PHP, and
MariaDB need new tap-owned Formulae. Fifteen existing Formulae currently
have public ABI 43 candidates but no canonical package:

- `dinit`
- `homebrew-bootstrap`
- `libpng`
- `libxml2`
- `login`
- `msmtpd`
- `nginx`
- `patch`
- `pax`
- `python`
- `redis`
- `sqlite`
- `sudo`
- `sudo-lite`
- `what`

The nginx candidate has a successful eligible verification receipt but
has not completed canonical publication. `login`, `sudo-lite`, and
`sudo` are the only missing canonical bottles in the current main-shell
Homebrew claim.

## Distribution Boundary

All Formula-owned build outputs are published only under the
`kandelo-dev/homebrew-tap-core` GHCR namespaces. The cutover must not
publish packages under `Automattic/kandelo` GHCR.

Tap recipes may invoke reviewed build helpers from an exact Kandelo
source checkout. They must build their own bottle bytes in the tap
workflow; they must not consume Kandelo package-registry build outputs.
Immutable GitHub Releases in `Automattic/kandelo` may continue to supply
shared platform/toolchain inputs where the tap build contract already
permits them.

## Canonical Bottle Completion

The existing fifteen candidate-only Formulae are reconciled to canonical
ABI 43 packages. Candidates that already have a successful eligible
verification are promoted without rebuilding. Candidates that are not
eligible are repaired and rerun independently. Promotion work proceeds
in parallel by dependency level and does not serialize unrelated
Formulae.

Canonical publication has a minimal shipping contract:

- the Formula name, version, revision, architecture, and ABI match the
  tap;
- the selected candidate manifest is immutable;
- bottle and composition layers match their OCI digests and byte counts;
  and
- the Formula metadata points to those exact canonical bytes.

Publisher-policy suites, product evidence, and cross-Formula admission
ordering are not prerequisites for this Pages cutover.

## New Formulae

The tap gains Formulae and ABI 43 bottles for:

- Node, including the installed Node executable;
- PHP, including CLI, FPM, and opcache outputs; and
- MariaDB, including the server and installed system-table resources
  needed to initialize the runtime image.

The Formulae own their recipes, patches, dependency declarations, and
installed payloads. Existing Kandelo build scripts may be reused as
reviewed build helpers while the recipes are migrated, but no Kandelo
package output is an input.

## Product Ownership

`platform-rootfs` owns the base shell and POSIX userland bottle set.
Those bottles retain lazy materialization wherever they are currently
lazy, so the root VFS stays small and commands such as coreutils, Vim,
and NetHack remain deferred bottle trees.

`browser-main-shell` embeds `platform-rootfs` and adds only the
interactive and demo bottle set that is not already owned by the base
product. It consumes the Homebrew bootstrap bottle rather than the
Kandelo bootstrap package.

The service products consume exact bottles as follows:

- `browser-node`: Node;
- `browser-nginx`: nginx and dinit;
- `browser-nginx-php`: nginx, PHP, and dinit;
- `browser-lamp`: nginx, PHP, MariaDB, dinit, and msmtpd; and
- `browser-wordpress`: nginx, PHP, dinit, and msmtpd, while retaining
  the reviewed WordPress source/archive inputs.

The existing Homebrew composition descriptors remain authoritative for
keg layout, links, path entries, privileged modes, and support outputs.
Builders must not recreate those rules from Kandelo package metadata.

## Build-Only Inputs

The PHP bottle used at runtime is also the declared source of any PHP
build-time operation. The builder must not fetch a second Kandelo PHP
package.

The kernel is not Formula-owned software. Product builders receive the
exact kernel through a protected `toolchain-output` or exact-runtime
input derived from the prepared runtime bundle. The Pages graph must not
describe the kernel as `software.package`.

## Producer And Workflow

The Pages producer resolves Homebrew claims from the exact public tap
checkout, downloads immutable bottle and composition layers, and
verifies their OCI digests and byte counts while consuming them. It no
longer accepts or prepares Kandelo package roots for the seven
production products.

A cheap closure preflight runs before kernel/runtime compilation. It
enumerates the Formula names in the real seven-product manifests and
confirms that each has one canonical ABI 43 package. It reports all
missing names together. The preflight performs availability checks only;
it does not rerun publisher trust, evidence, or admission validation and
does not download all bottle bodies.

The production Pages workflow removes package-cache materialization and
`fetch-binaries.sh` paths for this graph. Its remaining inputs are the
exact tap checkout, canonical bottle objects, reviewed
archives/repository paths, and the protected runtime/toolchain.

## Enforced Invariants

A protected checker recursively loads the seven manifests and fails
when:

- any manifest declares `software.package`;
- any resolved Pages input has kind `package-output`;
- a declared Homebrew Formula lacks an exact canonical ABI bottle;
- one resolved product graph selects conflicting bottle identities for
  the same Formula;
- a production Pages workflow materializes a Kandelo package root; or
- an assembled VFS contains an undeclared or candidate bottle reference.

Generated catalogs and request-policy identities are regenerated only
after the source contracts settle.

## Validation And Deployment

Validation supports the exact shipping claim:

1. Build and test each new or repaired Formula through the tap's normal
   bottle path.
2. Confirm all fifteen existing candidate-only Formulae and the three
   new Formulae have public canonical ABI 43 packages.
3. Run manifest/catalog/checker tests proving zero Pages
   `software.package` and `package-output` inputs.
4. Compose all seven real products from canonical bottle fixtures and
   then from the live public tap closure.
5. Run the assembled-site Chromium test against the exact returned tree,
   including eager/lazy request timing and service startup.
6. Deploy that exact smoke-tested tree and verify its deployment
   manifest and public VFS inventory.

Failures are reported as complete dependency sets where possible.
Successful bottle builds and canonical publications are retained across
retries; a failure in one Formula or product does not invalidate
unrelated completed work.

## Completion Criteria

The cutover is complete when the public Pages deployment for ABI 43 is
built from the seven required products, every Formula-owned byte comes
from a canonical `kandelo-dev/homebrew-tap-core` bottle, no production
Pages manifest or resolved input uses a Kandelo package output, and the
exact assembled tree passes Chromium before deployment.
