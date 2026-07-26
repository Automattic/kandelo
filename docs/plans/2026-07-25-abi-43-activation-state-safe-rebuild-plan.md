# ABI 43 activation-state-safe artifact rebuild plan

Status: development plan only. No canonical package, bottle, index, shell, or
VFS publication is authorized by this document.

## Why

ABI 43 changes the ownership contract for fork continuations. A fresh child
must reconstruct reference locals, exceptions, mutable reference globals, and
mutable tables from activation/process-owned state; an ABI 42 artifact cannot
be made safe by relabeling it. The ABI number and
`FORK_CAP_ACTIVATION_STATE_SAFE` capability must therefore move together
through every executable, archive, index, and derived image.

This rebuild must not delay, mutate, reuse, or publish over the separate ABI 42
Bash/Homebrew proof. In particular, do not modify the
`emdash/homebrew-complete-qk044` worktree, PR #1094, its branch, its commits, or
its publication namespaces.

## Frozen-input gate

Do not start a publishable rebuild until all of the following are true:

1. The instrumenter, host imports, table journal, pthread path, side-module
   replay, and cleanup contracts have stopped changing.
2. `ABI_VERSION` is 43, `abi/snapshot.json` and generated TypeScript constants
   are regenerated, and both ABI checks pass.
3. The source-controlled program-package projection is regenerated after the
   final instrumenter/tool digest. A stale projection must fail the limited
   rootfs-scope derivation instead of selecting an incomplete rebuild.
4. Fresh-instance Node and browser tests, pthread fork, side-module/dlopen
   replay, artifact guards, and the selected POSIX/package gates are green.
5. Brandon has explicitly approved the exact final head for kernel/fork
   integration. This plan does not authorize merge or publication.

## Kandelo package archive scope

The guest ABI is an input to every library/program cache key. The registry
currently contains 77 ABI-bound packages:

- 10 libraries, producing 14 architecture generations:
  `icu`, `libcurl`, `libcxx`, `libiconv`, `libpng`, `libxml2`, `libzip`,
  `openssl`, `sqlite`, and `zlib`;
- 67 programs, producing 69 architecture generations. The committed program
  projection covers 65 of those packages/67 generations; the special `kernel`
  and `userspace` packages add one wasm32 generation each.

That is 83 ABI-bound `(package, architecture)` archive generations. The
source-only `pcre2-source` package is not itself a guest-ABI artifact; it is
rebuilt only if its own source-package identity changes. Do not bump package
`revision` merely for the ABI epoch: ABI 43 already changes the cache key.

Of the 65 projected program packages, 57 packages/59 generations contain an
output whose fork-instrumentation policy is `auto`. These outputs must be
rebuilt from raw linker output with the ABI 43 instrumenter. The eight
all-disabled packages (`homebrew-bootstrap`, `nginx-php-vfs`, `nginx-vfs`,
`node`, `node-vfs`, `redis-vfs`, `spidermonkey`, and
`spidermonkey-node`) still need ABI 43 archive generations because the archive
ledger and any embedded ABI-bound dependencies are single-epoch; disabling
fork instrumentation is not permission to reuse an ABI 42 archive.

Build libraries before their transitive program consumers, then publish only
to an isolated PR-staging or run-specific merge-candidate ledger. The complete
candidate index must have top-level ABI 43, contain only `-abi43-` archive
identities, and pass archive/artifact guards before it can be considered for
canonical activation.

## Rootfs and derived image scope

The exact current wasm32 rootfs closure is 15 package generations:

`bash`, `bc`, `coreutils`, `dash`, `diffutils`, `file`, `findutils`, `gawk`,
`grep`, `m4`, `make`, `ncurses`, `posix-utils-lite`, `sed`, and `rootfs`.

A local source build of this closure is useful early evidence, but the
`stage-rootfs-closure-only` path is deliberately incomplete and cannot be used
for prepare-merge. After the final tool digest, regenerate the package
projection, derive the scope mechanically, and require it to select these
generations with their new cache keys.

After the full dependency archive set is available, rebuild every composite
runtime/image output whose cache key or embedded executable changes. The
current projection includes:

- `rootfs.vfs`, `shell.vfs.zst`, and `kandelo-sdk.vfs.zst`;
- `erlang-vfs`, `lamp`, `mariadb-test`, `mariadb-vfs`, `nginx-php-vfs`,
  `nginx-vfs`, `node-vfs`, `perl-vfs`, `python-vfs`, `redis-vfs`, and
  `wordpress` VFS outputs;
- CPython/Ruby runtime archives, Nethack/Vim browser bundles, and the Texlive
  bundle where their owning package generation changes.

The browser-facing checked or published images must be created from the exact
ABI 43 candidate index and tested as immutable candidate bytes in Node and
Chromium/Firefox/WebKit. Do not copy an ABI 42 executable into a new image or
rewrite its metadata.

## Homebrew scope and isolation

Homebrew uses the separate `bottles-abi-v43` namespace and Formula-controlled
bottle identities. An ABI 43 acceptance run must rebuild the 36 direct roots
in `homebrew/main-shell.Brewfile` plus the exact transitive bottle closure,
regenerate sidecars/provenance, and build a new content-addressed Homebrew VFS
acceptance image. Formula revision/bottle-rebuild changes belong to that
coordinated run; do not make speculative bumps in the fork implementation PR.

The existing ABI 42 Bash/Homebrew proof remains an independent input and
historical result. Do not edit its worktree, commits, sidecars, bottle
namespace, index, shell lock files, or VFS image to make ABI 43 validation pass.
ABI 43 must succeed from its own rebuilt bytes.

## Ordered execution

1. Freeze code and generated ABI/package metadata.
2. Run focused instrumenter/host/fresh-instance tests and the full required
   dev-shell validation on the implementation head.
3. Rebuild the 15-generation rootfs closure locally as an early source-build
   proof; do not publish it.
4. Build all 83 ABI-bound registry generations into isolated staging,
   dependency order first, and seal one complete ABI 43 candidate index.
5. Build all derived VFS/runtime/bundle artifacts from that exact candidate.
6. Run Node, browser, pthread, side-module/dlopen, libc/POSIX/Sortix, Bash,
   shell, package-guard, and lifecycle coverage against the candidate bytes.
7. In a separate coordinated Homebrew run, build the ABI 43 bottle closure,
   sidecars, shell closure, and content-addressed VFS evidence without touching
   the ABI 42 proof.
8. Report exact successful, failed, and unrun generations/tests. Canonical
   index activation, bottle publication, VFS publication, and merge require
   explicit coordination and Brandon's approval of the exact head.

ABI 42 releases remain immutable historical state. If ABI 43 validation fails,
leave its candidate/staging evidence isolated and fix the platform or rebuild
input; do not fall back to a mixed-ABI index or relabeled artifact.
