# Kandelo Homebrew Tap Template

This directory is a reviewable template for the future
`Automattic/kandelo-homebrew` tap. It lives in the main Kandelo repository so
schema, validator, workflow, and VFS-builder work can be reviewed before the
real tap repository exists.

This is not a user-facing Homebrew tap yet. Do not document `brew tap` or
`brew install` commands from this scaffold until the real tap, bottle tag
support, publish workflow, and Node/browser validation have landed.

Expected future tap shape:

```text
Formula/
  <formula>.rb
Kandelo/
  metadata.json
  formula/<formula>.json
  link/<formula>-<version>-rebuild<N>-<arch>.json
  reports/<formula>-<version>-rebuild<N>-<arch>.provenance.json
```

This template currently contains:

- placeholder `Formula/` guidance;
- JSON Schemas for the Kandelo sidecar metadata contract;
- `hello` example metadata for schema and validator development.
- an `xtask homebrew-sidecars` generator that converts produced bottle bytes
  and workflow evidence into the expected sidecar files.
- a shared host `planHomebrewVfs()` metadata planner for Node and browser VFS
  tooling.
- a Node-side `build-homebrew-vfs-image.ts` builder that verifies bottle bytes,
  pours/link-manifests them into a Homebrew prefix, and emits precomposed VFS
  images plus build reports.

The reusable trusted publisher lives in the main Kandelo repository at
`.github/workflows/reusable-homebrew-bottle-publish.yml`. It is meant to be
called by the future tap repository after its formulae exist. The workflow
builds selected formula bottles through `scripts/dev-shell.sh`, uploads bottle
bytes to the GHCR/Homebrew blob URL shape, publishes generated `Kandelo/`
sidecars into the tap, and records failed attempts under
`Kandelo/reports/failures/` without replacing the last-green
`Kandelo/metadata.json`.

Sidecar generation from produced bottle bytes is a separate handoff: the
workflow requires a trusted `sidecar-command` to populate
`$KANDELO_HOMEBREW_SIDECAR_ROOT` before sidecars are published and validated.

Homebrew formula and bottle metadata remain the contract consumed by `brew`.
Kandelo sidecar metadata is the bounded contract consumed by host VFS tooling,
Node validation, browser/gallery gates, and publication audits.
