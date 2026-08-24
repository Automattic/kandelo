# Package-Backed Login and Homebrew-Free Images Design

## Status

Approved in conversation on 2026-08-24 for implementation in one pull
request targeting `main`. The pull request will retain a linear history and
will be integrated with GitHub's rebase-merge method.

## Why

Kandelo currently has two competing definitions of its production system
images. The ordinary package registry builds `rootfs.vfs` and `shell.vfs.zst`
from resolver-owned package outputs at standard POSIX paths. The VFS product
catalog still describes the root filesystem, main shell, and several derived
browser images as Homebrew bottle compositions under
`/opt/kandelo/homebrew`.

The private root-login prototype uses the second path because its reviewed
`login`, `sudo-lite`, and upstream `sudo` programs currently come from
Homebrew bottles. That substitution places the complete Homebrew runtime into
the default root image: the `brew` launcher, bootstrap source tree,
environment, mutable prefix, cache, bottle mirror, tap bundle, runtime-support
closure, and Homebrew-specific image metadata. Login and privilege elevation
do not require an in-guest package manager, and the default machine should not
claim that they do.

The split also causes repository contradictions. The package named `shell` is
an ordinary package-backed image, while the Homebrew release finalizer still
expects it to depend only on `homebrew-bootstrap`. Some tests still assume old
exec authority or host-worker ownership contracts. PHP side modules are
published without the fork instrumentation required by their runtime. These
failures make it impossible to validate and merge the root-login work
truthfully.

## Goals

1. Boot the default browser root route from the ordinary package-backed shell
   image.
2. Build `login`, `sudo-lite`, and upstream `sudo` as ordinary Kandelo package
   outputs.
3. Publish those three programs through the existing immutable, reviewed
   privileged-program mount without granting set-ID authority to the writable
   root image.
4. Remove the Homebrew runtime, prefix, metadata, deferred archives, closed
   mirror, and compatibility links from every production VFS product.
5. Keep Homebrew build, publication, and lifecycle testing available only
   through explicitly named Homebrew development or test products.
6. Use `maker` and `/home/maker` consistently for the unprivileged demo
   account.
7. Repair the deterministic test failures found while rebasing so the one pull
   request can be validated against `main`.
8. Preserve Node.js and browser behavior, including login, logout, failed
   authentication, `sudo-lite`, and upstream `sudo`.

## Non-goals

- Removing Homebrew publishing tools, bottle validators, historical plans, or
  the explicitly named Homebrew test page.
- Treating Homebrew bottles as runtime package authority for ordinary images.
- Weakening set-ID, exec, fork-owner, ABI, VFS, or package resolver checks to
  accept stale artifacts or test harnesses.
- Changing the guest ABI. If implementation discovers an actual incompatible
  ABI change, work stops for an explicit ABI review rather than silently
  including it in this migration.
- Claiming browser, POSIX, ABI, or full-suite success without running the
  corresponding validation.

## Product Boundary

A production VFS product is any image selected by the generated product
catalog, the default root route, a public browser gallery entry, or a derived
service image published for ordinary users. Such an image must not contain or
declare any of the following:

- `/usr/bin/brew`;
- `/etc/homebrew`;
- `/opt/kandelo/homebrew`;
- `/etc/kandelo/homebrew-vfs.json`;
- a Homebrew bottle-mirror plan or local tap bundle;
- `homebrewBootstrap`, `homebrewFlat`, `homebrewFlatLazy`, or `homebrew`
  image-metadata claims;
- a deferred `homebrew-bootstrap.zip` tree;
- a symlink whose target is below `/opt/kandelo/homebrew`;
- a `software.homebrew` declaration in its product manifest; or
- presentation text that says a package-backed command comes from Homebrew.

An explicitly named Homebrew development or test product may retain those
features. It must not be inherited by a production product and must not be
selected for the default root route. Homebrew capability is therefore an
explicit test surface, not ambient production image state.

## Package-Backed Privileged Programs

### Package recipes

The package registry will own three program packages:

- `login`, built from `programs/login.c`;
- `sudo-lite`, built from `programs/sudo-lite.c`; and
- `sudo`, built from the pinned upstream sudo source and the Kandelo porting
  inputs required for the wasm32 POSIX target.

Each recipe will use the worktree-local SDK, install only into
`WASM_POSIX_DEP_OUT_DIR`, declare its source and build inputs, produce one
named Wasm output, and run fork instrumentation after final linking when the
program uses fork or vfork. The first-party programs will stop being
test-fixture-only builds once their package outputs exist; tests may still use
separate fixture copies when they are explicitly testing source behavior.

The `shell` package will depend on the privileged programs through a separate
privileged-product package or builder input, not copy them into the writable
shell tree with set-ID bits. Ordinary image filesystems remain `nosuid`.

### Neutral provenance

The production privileged-product policy will authenticate package identity,
package version, output name, artifact SHA-256 digest, destination path, owner,
mode, and mount identity. It will not require a Homebrew Formula name, bottle
digest, or Cellar-relative source path.

The existing publisher remains responsible for:

- accepting exactly `/usr/bin/login`, `/usr/bin/sudo-lite`, and
  `/usr/bin/sudo`;
- copying each authenticated source into a fresh isolated filesystem;
- setting root ownership before mode `04755`;
- proving each destination has one inode and no writable alias;
- serializing the independent product and browser mount; and
- minting the private capability consumed by the kernel host.

Homebrew-specific projection parsing may remain for the dedicated Homebrew
test lane, but the root product must use the neutral package-output policy.
Neither structurally similar JSON nor an unreviewed VFS image may mint the
privileged mount capability.

## Root Login Build and Boot Flow

The root build will consume exactly:

1. the resolver-owned `shell.vfs.zst` package output;
2. the three resolver-owned privileged program outputs;
3. a package-output identity document covering their names, versions, output
   names, byte lengths, and SHA-256 digests; and
4. the serialized immutable privileged product derived from those outputs.

It will no longer consume a Homebrew main-shell image, composition report,
bootstrap archive, `brew.env`, bottle mirror, tap bundle, Cellar inventory, or
Homebrew lifecycle fixture.

At browser build time, the private Vite input validates the exact regular-file
set and embeds only the shell image, the neutral identity document, and the
serialized privileged product. At runtime, the root loader reconstructs and
authenticates the privileged product from the package outputs or from a
build-owned package projection whose bytes are checked against that identity.
It compares the resulting serialized product with the build-declared artifact
before passing the branded product to `BrowserKernel`.

The default `/` route uses this product only when no custom VFS or demo is
selected. Custom images and gallery products cannot inherit the private
privileged capability. Login initialization continues through
`initFromPublishedPrivilegedProgramProduct`, preserving the read-only
`/usr/bin` mount and secure-exec behavior.

## Production Image Migration

The generated VFS product catalog will describe package inputs rather than
Homebrew Formulae. The following product manifests require migration:

- `platform-rootfs`;
- `browser-main-shell`;
- `browser-node`;
- `browser-nginx`;
- `browser-nginx-php`;
- `browser-wordpress`; and
- `browser-lamp`.

`platform-rootfs` and `browser-main-shell` will be projections of the existing
`rootfs` and `shell` package recipes. Derived products will consume the
package-backed shell and their declared program packages, then install
executables at standard paths such as `/usr/bin`, `/usr/sbin`, and `/sbin`.
They will not rewrite those paths to Cellar entries.

Once no production manifest uses Homebrew inputs, production-only special
cases in the staged product builder will be removed or narrowed to the
explicit Homebrew test product. The generated catalog and Pages product
registry will be regenerated from the migrated manifests.

Derived image metadata will retain `shellComposition = { schema: 1,
kind: "source-rootfs" }` and must reject inherited Homebrew claims. Lazy
package URLs remain resolver-owned package artifacts rather than bottle URLs.

## Account and Presentation Cleanup

All ordinary images and boot descriptors will use:

- user `maker`;
- uid and gid `1000`;
- home `/home/maker`; and
- `HOME`, `HISTFILE`, `USER`, and `LOGNAME` values derived from that account.

`/home/user` will not be created by the shell runtime layout. The source-shell
demo metadata will move out of the `homebrew/` authority directory and will
describe resolver-owned package artifacts accurately. Existing Homebrew test
products that still use the demo account will also use `maker`; this is an
account correction, not permission for production images to retain Homebrew
cache state.

## Explicit Homebrew Test Lane

Homebrew build and lifecycle behavior remains valuable platform evidence. It
will live behind an explicitly Homebrew-named product or test route and may
continue to exercise:

- `/usr/bin/brew` activation;
- the Homebrew prefix and mutable cache;
- bottle and tap installation;
- closed mirror binding;
- atomic runtime-support materialization; and
- guest lifecycle commands.

Its fixtures, finalizer, and release checks must name that Homebrew product
directly. They must not claim that the ordinary `shell` package is the
Homebrew bootstrap package. The finalizer test will either target the explicit
Homebrew product identity or be retired if no public Homebrew image remains.

## Deterministic Test Repairs

The same pull request will repair the baseline failures identified during the
rebase. Each repair preserves the current platform contract:

1. The Homebrew test consumer uses `/home/maker` when the explicit Homebrew
   lane remains.
2. The nginx integration harness uses the shared ABI 43 process-owner runtime
   for fork host imports and externref generations.
3. Every PHP side module loaded into the fork-capable PHP process receives the
   required ABI 43 side-boundary instrumentation after final linking. Package
   validation checks the complete side-module closure.
4. Dash/coreutils and MariaDB exec tests stage executable bytes in a
   kernel-owned VFS instead of treating `execPrograms` or host paths as exec
   authority.
5. The spawn-credential fixture implements
   `kernel_process_secure_exec` so the production post-commit security check
   can run.
6. The Homebrew finalizer no longer assigns its bootstrap-only dependency
   contract to the package-backed `shell` package.
7. The complete Vitest shard is rerun with the official resource-isolated
   runner. Any remaining non-terminating test is isolated before completion;
   worker pressure is not reported as a proven cause without reproduction.

These repairs do not relax runtime checks, make stale artifacts acceptable, or
restore host-path exec authority.

## Error Handling and Trust Boundaries

Every build and boot boundary fails closed:

- Missing package outputs, wrong versions, digest mismatches, symlinks, extra
  files, or unexpected destinations reject the private root product.
- A production image containing a forbidden Homebrew path, metadata claim,
  deferred tree, URL, or symlink target fails its image contract test.
- A privileged program that lacks instrumentation, expected exports, exact
  bytes, root ownership, mode `04755`, or a unique inode is not published.
- Custom and shared VFS inputs never receive the build-owned privileged
  capability.
- Node.js and browser loaders validate the same identities before process
  startup.

## Testing Strategy

Implementation follows red-green-refactor cycles. New assertions first prove
that the current Homebrew-backed path or stale fixture fails for the intended
reason. The minimal implementation then makes that behavior pass before the
next contract is changed.

Focused validation includes:

- package manifest, isolated build, and artifact-policy tests for `login`,
  `sudo-lite`, `sudo`, and the privileged product;
- VFS scans proving every production image has no forbidden Homebrew state;
- rootfs and shell composition tests proving standard paths and `maker`
  ownership;
- derived Node, nginx, nginx/PHP, WordPress, and LAMP image tests;
- neutral privileged-product unit tests, including forged identity and
  writable-alias rejection;
- Node login, logout, failed-password, `sudo-lite`, and upstream `sudo`
  lifecycle tests;
- Chromium, Firefox, and WebKit root-login lifecycle tests;
- focused tests for nginx process ownership, PHP side modules, VFS exec
  authority, spawn credentials, and the explicit Homebrew lane; and
- generated catalog and Pages registry checks.

Before completion, validation runs through `scripts/dev-shell.sh` and includes
the complete Vitest suite, relevant package-system and build-script suites,
browser asset checks, the three-engine root-login test, Chromium's ordinary
browser suite, and the ABI snapshot check. The implementation does not alter
kernel, syscall, libc, or guest ABI behavior, so POSIX and libc conformance are
not required unless the actual diff expands into those areas. Any unrun suite
is named explicitly in the final report.

## Documentation and Publication

Current reference documentation will describe the package-backed shell,
standard-path programs, immutable privileged mount, and Homebrew test-only
boundary. Historical Homebrew plans remain unchanged as records.

Package revisions change only when output bytes change. Generated catalogs are
regenerated by their supported tools. Package archives are rebuilt through the
normal resolver and publication path; existing Homebrew archives are not
rewritten to pretend they are package outputs.

The pull request title and commits use purpose-led area prefixes. Its
description begins with `## Why`, explains the production-image contract in
plain language, and records exact validation. Contributor attribution on the
rebased root-login work is preserved and checked with `git range-diff` and
`git log --format=fuller` before the force-with-lease push.

## Acceptance Criteria

The change is ready to push and retarget only when all of the following are
true:

1. The ordinary root route performs automatic maker login, logout and login
   prompting, failed-password rejection, `sudo -l`, `sudo-lite`, and upstream
   `sudo` through real guest programs.
2. The root route boots the resolver-owned package shell rather than a
   Homebrew main-shell image.
3. Every production VFS product passes the complete Homebrew-absence scan.
4. The explicit Homebrew test lane, if retained, remains isolated and its
   focused tests pass.
5. All deterministic failures listed above pass without weakening their
   platform contracts.
6. The complete selected local validation exits successfully with no hanging
   Vitest worker.
7. The branch is rebased on current `origin/main`, attribution is preserved,
   and the pull request targets `main` as one linear rebase-merge change.
