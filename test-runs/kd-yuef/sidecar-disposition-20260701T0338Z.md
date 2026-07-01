# kd-yuef -- VFS-Critical Language Sidecar Disposition

Packages: **cpython, perl, erlang**
Bead: kd-yuef (umbrella kd-1mr / initiative homebrew-all)
Session: kg-ydrd / porter-adhoc-49d9da88f8
Generated: 2026-07-01T03:38Z
Worktree: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-yuef-vfs-language-sidecars`
Branch: `gascity/kd-1mr/kd-yuef-vfs-language-sidecars` @ convoy base `f4339836e`

## Summary

| Package | Publishable sidecar? | Disposition | Node smoke | Browser smoke |
|---|---|---|---|---|
| cpython 3.13.3 | No | **BLOCKED** | Not runnable (no bottle) | Not runnable (no bottle) |
| perl 5.40.3   | No | **BLOCKED** | Not runnable (no bottle) | Not runnable (no bottle) |
| erlang 28.2   | No | **BLOCKED** | Not runnable (no bottle) | Not runnable (no bottle) |

**kd-v3fs composites unblocked by this bead: 0.** python-vfs, perl-vfs, and
erlang-vfs each remain blocked (see "Effect on kd-v3fs").

A publishable sidecar cannot be produced by any porter/local session for these
packages in their current state. This is a structural pipeline constraint plus
a coordination hazard, not a per-package build defect. Details and the exact
unblock path follow.

## Root cause (shared across all three packages)

### 1. Publishable sidecars structurally require trusted CI + GHCR write

Per `docs/homebrew-publishing.md` and the schema/gate code, a *publishable*
sidecar requires a bottle `url` that matches `^https://\S+$`:

- `homebrew/kandelo-homebrew/Kandelo/metadata.schema.json` defines the bottle
  `url` as `httpsUrl` = `"pattern": "^https://[^\\s]+$"`. A local/dry-run bottle
  yields a `file://` path, which **fails schema validation**
  (`cargo xtask homebrew-validate`).
- `scripts/homebrew-generate-sidecars-from-env.sh` sets the sidecar bottle `url`
  from `KANDELO_HOMEBREW_BOTTLE_URL`, which is populated **only** after
  `scripts/homebrew-ghcr-upload.sh` uploads bottle bytes to GHCR inside the
  trusted publish workflow.
- `.github/workflows/reusable-homebrew-bottle-publish.yml` is `workflow_call`
  only, requires `permissions: contents: write` + `packages: write`, and is
  invoked from the tap repo (`Automattic/kandelo-homebrew`) CI. The doc is
  explicit: "PRs from untrusted forks must not receive those permissions" and
  "Dry-run bottle evidence remains local evidence until the trusted workflow
  publishes GHCR bottle bytes and tap sidecars."

The kd-v3fs composite gate enforces the same bar. In
`scripts/homebrew-composite-status.ts`, `bottleMetadataBlocker()` rejects any
bottle whose `url` fails `HTTPS_URL_RE = /^https:\/\/\S+$/`, or which lacks a
valid `sha256`, positive `bytes`, `cache_key_sha`, `link_manifest`, valid
`fork_instrumentation`, or `status === "success"`.

**Consequence:** No local session (including this one) can emit a non-`file://`
bottle URL. Producing a *publishable* cpython/perl/erlang sidecar requires the
trusted tap CI to build + upload bottles to GHCR -- a coordinator/CI action, not
a porter action.

### 2. The formulae/build edits exist only as uncommitted active-worktree state

The cpython/perl/erlang Homebrew formulae and their build-script edits currently
exist **only as uncommitted changes in the active kd-p3hr worktree**, which this
bead is explicitly forbidden from editing or duplicating.

Verified (see Evidence):
- No `Formula/cpython.rb`, `Formula/perl.rb`, or `Formula/erlang.rb` exists on
  **any** `origin` ref.
- The kd-p3hr branch (`gascity/kd-1mr/kd-p3hr-homebrew-language-runtimes`) is
  **not pushed** to origin; its formula drafts are untracked (`??`) files and
  its build-script edits are unstaged (` M`) in that worktree only.
- No committed real (non-example) sidecar `metadata.json` exists on any origin
  ref, for any package -- the sidecar pipeline has never published committed
  output for even the pilot packages.

Because a checkpoint (commit + push) of those formulae belongs to the kd-p3hr
owner and must not be duplicated here, the formulae are a stranded prerequisite
that this bead can only *coordinate*, not author.

## Evidence (reproducible)

Run from `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-yuef-vfs-language-sidecars`:

```
# No cpython/perl/erlang Formula on any origin ref  -> "NONE"
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin/); do
  for f in cpython perl erlang; do
    git cat-file -e "$ref:homebrew/kandelo-homebrew/Formula/$f.rb" 2>/dev/null \
      && echo "FOUND $f in $ref"; done; done

# kd-p3hr branch not pushed  -> empty
git ls-remote origin 'refs/heads/*kd-p3hr*'

# No committed real sidecar metadata on any origin ref  -> "NONE"
# (Kandelo/metadata.json present only under .../examples/)

# Schema requires https bottle url:
git show origin/main:homebrew/kandelo-homebrew/Kandelo/metadata.schema.json \
  | grep -A2 '"httpsUrl"'   # pattern ^https://[^\s]+$

# Composite gate requires https bottle url + sha + bytes + cache_key + link_manifest:
git show origin/gascity/kd-1mr/kd-v3fs-composite-vfs:scripts/homebrew-composite-status.ts \
  | grep -n 'HTTPS_URL_RE\|bottleMetadataBlocker\|not publishable'

# Publish workflow is workflow_call-only + packages:write:
git show origin/main:.github/workflows/reusable-homebrew-bottle-publish.yml \
  | grep -n 'workflow_call\|packages: write'
```

kd-p3hr uncommitted state observed (read-only, `git -C <kd-p3hr worktree> status --short`):
`?? Formula/{cpython,perl,erlang,php,ruby,sqlite,texlive,zlib}.rb`;
` M packages/registry/{cpython,perl,erlang,php,ruby,sqlite,texlive,zlib}/build-*.sh` (subset);
` M scripts/homebrew-{bottle-build,generate-sidecars-from-env,package-*-smoke}.*`.

## Per-package disposition

Registry packages exist at convoy base `f4339836e` (build scripts + manifests);
only the Homebrew Formula/bottle/sidecar layer is missing/unpublishable.

### cpython 3.13.3 (`kind = program`)
- Registry: `packages/registry/cpython/{package.toml,build.toml,build-cpython.sh}` present.
- Draft formula (kd-p3hr, uncommitted): depends_on `zlib`; installs `python.wasm`
  -> `cpython`; installs stdlib tree; `test do` node smoke =
  `python -S -c "import os; print(os.path.join('a','b'))"`.
- fork_instrumentation: `not-required` (no `outputs.*.fork_instrumentation`
  override; generator default). Valid for schema -- not a blocker itself.
- Blocked by shared root cause (no published bottle -> no https sidecar url).

### perl 5.40.3 (`kind = program`)
- Registry: `packages/registry/perl/{package.toml,build.toml,build-perl.sh}` present.
- Draft formula (kd-p3hr, uncommitted): installs `perl.wasm` -> `perl`; installs
  perl runtime tree with wasm32 source patches; `test do` node smoke =
  `perl -e "use strict; use warnings; print 2 + 3"`.
- fork_instrumentation: `not-required` (generator default). Not a blocker itself.
- Blocked by shared root cause.

### erlang 28.2 (`kind = program`)
- Registry: `packages/registry/erlang/{package.toml,build.toml,build-erlang.sh,patches/}` present.
  Outputs: `erlang`, `erlang-otp`. Host build deps: `erl >=16.0`, `make >=3.80`.
- Draft formula (kd-p3hr, uncommitted): SOURCE_URL = OTP-28.2 GitHub tarball;
  installs `erlang.wasm` -> `erlang`; unpacks `erlang-otp.tar.zst` into
  `libexec/erlang`; `kandelo_assert_wasm`.
- fork_instrumentation: `not-required` (generator default). Not a blocker itself.
- Blocked by shared root cause.

## Host smoke status (Node + browser)

- **Node smoke:** Not runnable. `scripts/homebrew-package-node-smoke.ts` builds
  a Homebrew VFS from generated sidecars; with no published bottle/sidecar there
  is nothing to pour. Each draft formula *defines* a `test do` node smoke (above)
  that would execute through Kandelo during a trusted bottle build.
- **Browser smoke:** Not runnable, and cannot be claimed. Per doc, sidecars may
  record `runtime_support=["node","browser"]` / `browser_compatible=true` only
  after a passing wasm32 `scripts/homebrew-package-browser-smoke.ts` run against
  published sidecars. No bottle -> no browser smoke -> these stay Node-only-eligible
  at best until a bottle exists. Target intent per kd-v3fs design is both-host.

## Upstream / full-test status metadata

Not available in this wave. No upstream full-test command has been run for
cpython/perl/erlang under Homebrew, and no `test-runs/kd-p3hr` outcome-list for
these three was committed (the kd-p3hr `test-runs/kd-p3hr/` dir is untracked in
that worktree). Recorded as `unavailable: no committed upstream full-test
artifacts; bottle builds never completed in the language-runtime wave` -- see the
kd-p3hr standown note (first dry-run did not reach the Perl build:
`scripts/homebrew-bottle-build.sh: TAP_SOURCE: unbound variable`, sysroot
missing).

## Effect on kd-v3fs (which composites are unblocked)

- **python-vfs** (needs cpython): still BLOCKED -- no publishable cpython sidecar.
- **perl-vfs** (needs perl): still BLOCKED -- no publishable perl sidecar.
- **erlang-vfs** (needs erlang): still BLOCKED -- no publishable erlang sidecar.

This matches the kd-v3fs composite-status run already on record (0 passed / 0
failed / 16 skipped) and its note that these three are "blocked by missing
cpython/perl/erlang Homebrew sidecar metadata."

## Precise unblock path (ordered)

1. **Checkpoint kd-p3hr:** its owner commits + pushes the cpython/perl/erlang
   `Formula/*.rb` and `build-*.sh` edits to a durable ref (or lands them in the
   tap `Automattic/kandelo-homebrew`). Until then the formulae are stranded and
   must not be duplicated here.
2. **Trusted tap CI publish:** the tap repo calls
   `reusable-homebrew-bottle-publish.yml` (`contents:write` + `packages:write`)
   for `formulae: cpython perl erlang`, `arches: wasm32`, building bottles
   through the Kandelo SDK and uploading bytes to GHCR. This is a coordinator /
   `@brandon` action; a porter session cannot supply GHCR write.
3. **Generate + validate sidecars:** `cargo xtask homebrew-sidecars` via
   `scripts/homebrew-generate-sidecars-from-env.sh`, then
   `cargo xtask homebrew-validate` -- now with real https bottle urls.
4. **Node smoke** (`homebrew-package-node-smoke.ts`), then **wasm32 browser
   smoke** (`homebrew-package-browser-smoke.ts`) to earn `browser_compatible`.
5. **Re-run kd-v3fs composite status** -- python-vfs / perl-vfs / erlang-vfs rows
   should move from skip -> pass once each language bottle metadata is publishable.

A prerequisite tooling defect to fix before step 2 succeeds even in dry-run:
`scripts/homebrew-bottle-build.sh` `TAP_SOURCE: unbound variable` (observed in
kd-p3hr). Owned by the language-runtime wave (kd-p3hr), not this bead.
