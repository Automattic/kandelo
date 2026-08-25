# Package-Backed Login and Homebrew-Free Images Design

## Status

Approved in conversation on 2026-08-24 for implementation in one pull
request targeting `main`. The pull request will retain a linear history and
will be integrated with GitHub's rebase-merge method.

## Why

Kandelo's default browser images currently obtain login and privilege
elevation from a private, immutable mount assembled from Homebrew bottles.
That gives three ordinary guest programs a second authority model, makes
writable VFS images artificially `nosuid`, and pulls Homebrew build and runtime
state into product images that do not need an in-guest package manager.

The intended model is the ordinary POSIX model. File ownership, mode bits, and
mount flags are the authority for set-ID execution. A writable VFS image is a
guest machine; its guest root may install or replace set-ID programs without
gaining any host privilege. First-party and custom images should use the same
boot contract rather than private host-side inspection of selected image
contents.

## Goals

1. Implement normal set-user-ID and set-group-ID execution for every VFS mount
   that is not mounted `nosuid`.
2. Make mount `nosuid` an explicit policy instead of an implicit consequence
   of using an ordinary writable filesystem.
3. Package `login`, `sudo-lite`, and upstream `sudo` through the ordinary
   Kandelo registry and install them directly in the root filesystem.
4. Replace `/etc/kandelo/shell.json` with one explicitly experimental terminal
   session configuration shared by first-party and custom images.
5. Remove Homebrew from active image products, builds, tests, continuous
   integration, publication, and aggregate developer commands while leaving
   dormant implementation available in the repository.
6. Preserve Node.js and browser parity and validate the affected POSIX, VFS,
   package, and browser contracts.

## Non-goals

- Deleting the dormant Homebrew implementation or historical documentation.
- Supporting `/etc/kandelo/shell.json` as a legacy format.
- Implementing a guest `getty` in this change.
- Giving guest set-ID programs any host privilege.

## POSIX Set-ID Mount Model

Every executable on a mount without `nosuid` receives the usual set-ID
semantics derived from its current VFS metadata:

- `S_ISUID` selects the executable file owner's uid as the new effective uid;
- `S_ISGID` selects the executable file's group as the new effective gid;
- unchanged real IDs and saved IDs follow Kandelo's existing secure-exec
  transition;
- the transition uses the executable inode that was validated for `exec`;
  and
- normal file mutation, ownership changes, and truncation retain the existing
  rules that clear unsafe set-ID bits.

The mechanism is general. It does not recognize `login`, `sudo-lite`, `sudo`,
package identities, product identities, or first-party images. Root ownership
plus mode `04755` is sufficient on any mount whose `nosuid` flag is false.

Mount policy is explicit:

- omitted `nosuid` means false;
- root images and ordinary writable VFS mounts therefore honor set-ID bits;
- callers that need a `nosuid` boundary set it explicitly;
- automatically created scratch mounts such as `/tmp` are explicitly
  `nosuid`; and
- an in-image `/tmp` remains part of that image's root mount and inherits its
  flags.

Guest root may create, replace, chown, or chmod set-ID files subject to the
ordinary VFS permission model. An unprivileged guest user remains constrained
by ownership and permission checks. Neither case grants access outside the
guest kernel or host adapter.

The private trusted-product capability, immutable privileged-program
filesystem, special publisher, Vite inputs, and login-specific mount are
removed from the active boot path. Any residual implementation that has no
independent use is removed rather than kept as a second authority model.

## Package-Backed Programs

The package registry owns three ordinary packages:

| Package | Source | Root-image install |
|---|---|---|
| `login` | `programs/login.c` | eager |
| `sudo-lite` | `programs/sudo-lite.c` | lazy |
| `sudo` | pinned upstream source plus Kandelo port inputs | lazy |

The package-built `login.wasm` is 88,980 bytes (about 86.9 KiB). It is small
and needed for the first terminal session, so the root image includes it
eagerly. The privilege-elevation programs are not required until invoked and
remain resolver-backed lazy files. Lazy materialization must preserve the
declared root ownership and `04755` mode; ordinary guest writes must continue
to clear unsafe set-ID bits.

Each recipe uses the worktree-local SDK, declares all dependencies and
outputs, installs only into `WASM_POSIX_DEP_OUT_DIR`, and applies required fork
instrumentation after final linking. The shell/rootfs package declares these
dependencies and installs the outputs at `/usr/bin/login`,
`/usr/bin/sudo-lite`, and `/usr/bin/sudo` with uid 0, gid 0, and mode `04755`.

## Experimental Terminal Session Contract

`/etc/kandelo/experimental-terminal-session.json` completely replaces
`/etc/kandelo/shell.json`. There is no compatibility fallback or dual-read
period.

The version 1 document is:

```json
{
  "kind": "kandelo-experimental-terminal-session",
  "version": 1,
  "initial": {
    "path": "/usr/bin/login",
    "argv": ["login", "-p", "-f", "maker"],
    "uid": 0,
    "gid": 0
  },
  "afterExit": {
    "path": "/usr/bin/login",
    "argv": ["login", "-p"],
    "uid": 0,
    "gid": 0
  }
}
```

`initial` is required. `afterExit` is optional; omitting it means the logical
terminal ends when the initial process exits. Paths must be absolute, argv
must be a nonempty string array, and uid/gid must be nonnegative integers in
the supported guest-ID range. Parsing rejects unknown schema versions,
malformed values, oversized files, and ambiguous fields with a visible error.

All terminal-capable first-party and custom images use this exact untrusted
configuration path and parser. The host does not infer boot policy by scanning
`passwd`, `shadow`, `sudoers`, executable bytes, passwords, package metadata,
or product identity. A terminal-capable image without a valid configuration
fails visibly instead of silently choosing a host-owned shell.

The format and filename are deliberately experimental. A guest `getty` is the
preferred long-term mechanism; this file is the explicit bridge until the
guest owns terminal login lifecycle itself.

## Root Login Flow

The first-party root image supplies the configuration above. A newly created
logical terminal starts `login -p -f maker` as guest uid/gid 0, which performs
one passwordless auto-login through the real login program. When that shell
logs out, the session policy starts `login -p`, presenting the ordinary login
prompt. Subsequent exits continue through the generic restart policy already
owned by the terminal session runtime.

The image owns the account and authorization files:

- `maker` has uid/gid 1000 and home `/home/maker`;
- the `wheel` group contains `maker`;
- sudo policy authorizes the intended wheel-group behavior; and
- environment values such as `HOME`, `USER`, `LOGNAME`, and `HISTFILE` derive
  from that account.

Custom images may choose different programs, credentials, users, or no
`afterExit` behavior without host code changes.

## Homebrew-Free Active Products

An active image, workflow, or aggregate command is one reachable from the
default product catalog, public browser routes, normal continuous integration,
release/publication workflows, or standard developer validation entry points.
Active surfaces must not build, test, publish, or depend on Homebrew.

Active image products must not contain or declare:

- `/usr/bin/brew` or related launcher commands;
- `/etc/homebrew`;
- `/opt/kandelo/homebrew`;
- Homebrew VFS metadata, bottle mirror plans, tap bundles, bootstrap archives,
  cache state, or bottle URLs;
- Homebrew composition kinds in product manifests or generated catalogs; or
- compatibility links into a Homebrew prefix.

The platform rootfs, browser shell, Node, nginx, nginx/PHP, WordPress, and LAMP
products are migrated to ordinary package-backed inputs and standard paths.
Generated catalogs and Pages inputs are rebuilt from those manifests.

Homebrew-specific source, builders, validators, fixtures, and historical plans
may remain dormant. They have no enabled workflow, publication job, aggregate
test registration, product-catalog entry, or default application route. Tests
that exist solely for Homebrew are not run as part of this pull request.

## Error Handling

- A malformed or missing experimental terminal configuration produces a
  user-visible boot/session error.
- An executable on a `nosuid` mount runs without set-ID transition.
- A set-ID transition whose executable identity changes during validation
  fails truthfully under the existing exec stability rules.
- Missing, stale, or ABI-mismatched package artifacts fail package or runtime
  validation rather than falling back to Homebrew or host authority.
- Lazy materialization failure is reported as the underlying VFS/package
  failure and does not silently alter ownership or mode.

## ABI Assessment

This work changes observable exec and mount semantics. Before integration, the
implementation is reviewed against the ABI contract, including syscall
behavior, statfs flags, secure-exec host imports, generated TypeScript
constants, and the committed ABI snapshot. If the change is incompatible, the
same pull request bumps `ABI_VERSION`, regenerates `abi/snapshot.json`, and
rebuilds every affected artifact through the normal path.

## Validation Strategy

Validation follows the repository suite-selection contract and runs through
`scripts/dev-shell.sh`. At minimum it includes:

- focused VFS and exec tests for ordinary, setuid, setgid, combined set-ID,
  `nosuid`, mutation clearing, lazy materialization, and custom images;
- Rust workspace tests and relevant libc/POSIX/Sortix conformance tests for
  exec, credentials, ownership, permissions, and mount semantics;
- host Vitest coverage in both Node and browser-oriented paths;
- package metadata, resolver, artifact, rootfs, and product-catalog tests;
- terminal parser/session tests for first launch, logout, missing config,
  malformed config, and custom image behavior;
- Playwright coverage and manual `./run.sh browser` verification of login,
  logout, failed authentication, `sudo-lite`, and upstream `sudo`;
- ABI snapshot/version validation; and
- the enabled full CI-equivalent suite after focused failures are green.

No Homebrew build or Homebrew-specific test is run. Disabled Homebrew lanes
are instead verified structurally: active workflow, product, publication, and
aggregate-test inventories contain no Homebrew entry points.

## Documentation and Delivery

Authoritative architecture, POSIX status, package, browser, and repository
documentation is updated to describe only implemented behavior. Generated
package and product metadata is regenerated when its inputs change.

The branch is rebased onto current `main`, contributor authorship is preserved
and checked with `git range-diff` and `git log --format=fuller`, and the single
pull request is force-pushed with lease. Its title follows the `Area: Purpose`
form, its description begins with `## Why`, and its target branch is `main`.

## Acceptance Criteria

The change is ready when:

1. Any valid set-ID executable on any non-`nosuid` writable VFS mount receives
   the correct guest credential transition.
2. Explicit `nosuid` mounts suppress that transition, including auto-created
   scratch mounts.
3. The default image boots through the experimental terminal config, auto-
   logs in `maker` once, and presents real login after logout.
4. A custom image uses the same config and behavior without host-side content
   recognition.
5. `login` is eager, `sudo-lite` and `sudo` are lazy, and all three are
   root-owned mode `04755` at their ordinary paths.
6. Reachable image and automation paths contain no Homebrew products, builds,
   tests, publication, or runtime state.
7. Required validation passes with exact commands and exclusions reported.
8. The rebased branch is pushed to the existing pull request targeting
   `main`, ready for rebase merge.
