# Wasm Package Management — Future Work

Forward-looking list of items deferred from the package management
system as it stands today. The system is described in
`docs/package-management.md`; this file is the home for what's still
on the table.

Some items are blocked on real demand (e.g., semver ranges, WASI artifact
caching); some are purely additive polish (`--gc`, `--format=json`).
None is on a committed schedule — pick up when the use case arrives.

## Execution

### Retry a failed node during an active aggregate

Today a failed local DAG build keeps running other independent nodes, then
exits after the graph drains. After fixing the recipe, rerunning the same
`local-build run` command reuses successful content-addressed nodes and runs
the missing work.

A future additive command could retry a failed node while that original
aggregate is still active. It would need to coordinate with the active run so
it neither duplicates a node that is still building nor changes the behavior
of the existing single-run scheduler. This is explicitly deferred until the
workflow has enough real demand to justify that coordination.

## Schema / artifact

### WASI artifact caching

`target_arch` is a closed enum: `wasm32 | wasm64`.  WASI binaries
are handled today by the runtime shim, not the artifact cache.  Decide
between composite enum values (`wasi-preview1-wasm32`) or splitting the
axis into `target_arch` / `target_abi` when we have a real first WASI
artifact to cache.

### Semver range resolution for libraries / programs

The system keeps exact version pinning for `depends_on`.  A
resolver that picks one version per logical lib across the dep graph
becomes load-bearing once two consumers want different patch versions
of the same library.  Until then, exact-pinning is a feature, not a bug
— it forces reproducibility.

### Compound version constraints for host-tools

The `version_constraint = ">=X.Y[.Z]"` syntax is intentionally minimal.
Compound forms (`>=3.20,<4.0` to exclude known-bad major versions)
become useful when a real case lands.

## Consumer convenience

### `--format=json` for `build-deps env`

`xtask build-deps env vim` emits POSIX shell exports today.  A JSON
shape would let non-bash callers (e.g. Makefile-style or Python build
helpers) consume it without parsing shell.  Add behind a flag the day
a non-shell caller needs it.

### `--gc` cron-style cache clean

`xtask build-deps clean` is manual.  Add a hands-off mode with
conservative defaults: only entries older than N days, unreferenced by
any registry root.  Users would `0 4 * * 0 cargo xtask build-deps gc`
to trim weekly.

## Build tooling

### Auto-install of host tools

Resolver presence-checks host tools (cmake, wasm-opt, etc.) and prints
install hints on failure.  Auto-running `brew install cmake` was
explicitly rejected during system design — risky, users want control over
their machines.  Reopen if a consumer migration becomes painful enough
to justify it.

### Per-platform tool name aliases

macOS may have `gmake` instead of GNU `make`; Debian-derivatives may
ship `cmake` as `cmake3`.  Probe could try multiple commands.  Defer
until a real conflict.

### Hard-coded version strings in build scripts (lint)

A `build-<name>.sh` that hard-codes an upstream version string can drift
from its `package.toml`'s `version` field — `xtask build-deps check` would
ideally catch this.  Today the only signal is a sha mismatch on the
fetched source tarball.  Lower priority since the sha catches the case
eventually; useful if cache invalidation becomes a debugging chore.

## Security & trust

### Package signing

**Deferred from `docs/plans/2026-05-05-decoupled-package-builds-design.md` (§7, §10).**

Today's trust model for a package's upstream source is rooted in
`[source].sha256` in the `package.toml` recipe plus HTTPS for transport.
That covers integrity for already-pinned sources and tampering by random
network adversaries. The threat it does not cover:

- **Recipe tampering by a compromised package source.** A consumer who
  adds a third-party package source (an extra registry root on
  `WASM_POSIX_DEPS_REGISTRY`) trusts the recipes it ships. If that source
  is compromised, an attacker could change a recipe to pin a different
  upstream URL with a matching (attacker-chosen) sha. Signing the recipes
  and their provenance would let consumers verify authorship.

Cryptographic signing of recipes addresses this. Implementation requires
picking a scheme (minisign / sigstore / GPG / similar), a key-management
story, key distribution for third-party sources, and consumer-side
verification UX. Real engineering scope — defer until a heterogeneous
third-party source ecosystem or a trust-authority concept (e.g. "this
recipe must chain to the Kandelo root key") lands.

The schema reserves no placeholder field; sign-related fields are
designed properly when the feature lands rather than retrofitted into
a stub.

### Auto-update / update-check

A future "is there a newer version of package X in source Y?" check would
be a fetch + diff over a package source's recipes. Not implemented.
Triggers when consumers want a non-manual upgrade path. Couples with
package signing — auto-adopting a new recipe (and its source pin) without
a signature check is the threat model that motivates signing.

## Resolver internals

### `compute_sha` memo keyed on arch

Surfaced during E.3 / E.4: `compute_sha`'s `memo` parameter is keyed by
`name@version`, not arch.  The hash itself includes arch, so re-using a
memo across arches returns a stale sha for the second arch.  Every
caller currently allocates a fresh memo per (manifest, arch) pair to
sidestep this.

Cleanup: fold arch into the memo key inside `compute_sha` itself.
Saves one allocation per arch, prevents future callers from hitting the
trap.

## Workflow

No packages are bypassed today. (TexLive's source build was thought
to be blocked on a `pmpost` → `gmp.h` chain, but that turned out
to be a stale diagnosis: the bundled `libs/gmp/native/` builds fine
under `nix develop --ignore-environment` on at least Mac aarch64.
Dropped from the bypass list along with the diagnosis.)
