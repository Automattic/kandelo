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
  reports/failures/<timestamp>-<formula>-<arch>.json
  reports/rollbacks/<timestamp>-<formula>-<arch>.json
```

This template currently contains:

- `Formula/hello.rb`, the first Kandelo Homebrew formula scaffold;
- `Formula/zlib.rb`, the first static-library formula scaffold;
- `Formula/sqlite.rb`, `Formula/bzip2.rb`, and `Formula/xz.rb`, the first
  post-hello pilot package formulae;
- dependency-root and hybrid package formulae for `openssl`, `libcxx`,
  `libxml2`, `libpng`, `libcurl`, and `ncurses`;
- service-runtime package formulae for `redis`, `nginx`, and `mariadb`;
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
called by the tap repository after its formulae exist. The workflow
builds selected formula bottles through `scripts/dev-shell.sh`, uploads bottle
bytes to the GHCR/Homebrew blob URL shape, publishes generated `Kandelo/`
sidecars into the tap, publishes browser gallery assets only after a successful
browser smoke, and records failed attempts under
`Kandelo/reports/failures/` without replacing the last-green
`Kandelo/metadata.json`.

Manual rebuilds, repair-only metadata regeneration, and rollback reporting are
handled by `.github/workflows/reusable-homebrew-bottle-maintenance.yml`.
Rebuild mode can skip formula/arch pairs whose current successful metadata
already carries the expected cache key, unless the caller sets `force`.
Repair-only mode bypasses bottle build and upload and expects the trusted
sidecar command to regenerate metadata from existing bottle evidence. Rollback
mode records a report under `Kandelo/reports/rollbacks/` while preserving
last-green metadata; package deletion is exceptional and must be documented with
both the deleted package URL and the operational reason.

Sidecar generation from produced bottle bytes is a separate handoff: the
workflow requires a trusted `sidecar-command` to populate
`$KANDELO_HOMEBREW_SIDECAR_ROOT` before sidecars are published and validated.

Homebrew formula and bottle metadata remain the contract consumed by `brew`.
Kandelo sidecar metadata is the bounded contract consumed by host VFS tooling,
Node validation, browser/gallery gates, and publication audits.
