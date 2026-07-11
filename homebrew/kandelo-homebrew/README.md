# Kandelo Homebrew Tap Template

This directory is a reviewable template and test fixture for the
`Automattic/kandelo-homebrew` tap. It lives in the main Kandelo repository so
schema, validator, workflow, sidecar, and VFS-builder changes can be reviewed
with the implementation that consumes them.

The live generated tap state belongs in `Automattic/kandelo-homebrew`, not in
this checked-in fixture. Do not document user-facing `brew tap` or
`brew install` commands from this scaffold until guest Homebrew install has
been validated through Kandelo.

Tap shape:

```text
Formula/
  <formula>.rb
Kandelo/
  metadata.json
  formula/<formula>.json
  link/<formula>-<version>-rebuild<N>-<arch>.json
  reports/<formula>-<version>-rebuild<N>-<arch>.provenance.json
  reports/failures/<timestamp>-run-<id>-attempt-<n>-<formula>-<arch>.json
  reports/rollbacks/<timestamp>-run-<id>-attempt-<n>-<formula>-<arch>.json
```

This template currently contains:

- `Formula/hello.rb`, the first Kandelo Homebrew formula scaffold;
- JSON Schemas for the Kandelo sidecar metadata contract;
- `hello` example metadata for schema and validator development.
- an `xtask homebrew-sidecars` generator that converts produced bottle bytes
  and workflow evidence into the expected sidecar files.
- a shared host `planHomebrewVfs()` metadata planner for Node and browser VFS
  tooling.
- a Node-side `build-homebrew-vfs-image.ts` builder that verifies bottle bytes,
  pours/link-manifests them into a Homebrew prefix, and emits precomposed VFS
  images plus build reports.
- a browser-gallery gate for wasm32 `hello` that boots the published
  Homebrew-derived VFS image before marking it browser-compatible.

The reusable trusted publisher lives in the main Kandelo repository at
`.github/workflows/reusable-homebrew-bottle-publish.yml`. It is meant to be
called by the tap repository after its formulae exist. The normal tap caller is
`.github/workflows/publish-bottles.yml`, displayed as
**Publish Kandelo bottles**.
The protected dispatch events are `publish-kandelo-bottles`,
`dry-run-kandelo-bottles`, and `maintain-kandelo-bottles`; publish and dry-run
requests must include nonempty Formula and architecture selections.

The caller grants the maximum permission ceiling. Four fresh runner roles then
downgrade it: a read-only build/test job, a `packages: write` uploader without
tap write access, a read-only anonymous/runtime verifier, and a
`contents: write` tap finalizer without package write access. Dry runs never
schedule the uploader or finalizer. Jobs exchange strict, bounded data
handoffs; Formula builds cannot pass scripts, environment files, or credentials
to a privileged runner.
Before GHCR credentials are exposed, the uploader validates the complete bottle
archive as inert data. Every Wasm member, regardless of mode or path, must match
the selected Kandelo ABI and memory width and satisfy the fork-instrumentation
contract; relocatable Wasm objects are not bottle process payloads.

The build job produces the local Homebrew bottle. A dry verifier consumes those
local bytes, while a write verifier anonymously reads back the exact GHCR
digest and verifies its SHA-256 and byte count before using it. The verifier
fetches Kandelo's complete ABI release graph only as kernel, host-runtime, and
VFS platform prerequisites; the migrated package payload comes from the
Homebrew bottle, not the package registry archive. The workflow retains browser
gallery output as run-scoped diagnostics and does not publish sidecars or
gallery assets to a GitHub Release.

Only after the complete package-scoped publication handoff is validated as
inert data does the finalizer acquire the tap lock, refresh tap state, compose
the selected static Formula bottle tag, and regenerate `Kandelo/` state. It
does not execute Formula Ruby or Homebrew with tap write credentials. Failed attempts go
under `Kandelo/reports/failures/` without replacing last-green
`Kandelo/metadata.json`. The bottle root is always derived from the lowercase
tap repository identity; callers cannot override it.

Manual rebuilds and rollback reporting are
handled by `.github/workflows/reusable-homebrew-bottle-maintenance.yml`.
Rebuild mode can skip formula/arch pairs whose current successful metadata
already carries the expected cache key, unless the caller sets `force`.
Rollback mode records a report under `Kandelo/reports/rollbacks/` while
preserving last-green metadata; package deletion is exceptional and must be
documented with both the deleted package URL and the operational reason.

Parallel peer and sibling-architecture publications compose against refreshed
tap state under the shared lock, and Formula source drift after planning aborts
publication. Older-ABI handoffs and lower bottle rebuilds for the same package
identity are rejected under that lock. New GHCR packages are private by default. Changing one to public
is an explicit approval boundary; the workflow does not change package
visibility. A write publication cannot finalize until its bottle passes
anonymous digest readback.

Homebrew formula and bottle metadata remain the contract consumed by `brew`.
Kandelo sidecar metadata is the bounded contract consumed by host VFS tooling,
Node validation, browser/gallery gates, and publication audits.

The trusted generator derives formula identity, direct runtime dependencies,
and linkable keg files from Homebrew's produced bottle JSON. Tap-native
formulae do not require duplicate `packages/registry/<name>` metadata in the
main repository.
