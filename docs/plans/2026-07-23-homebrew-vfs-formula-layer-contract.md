# Homebrew VFS Formula layer contract

Status: validation substrate only. This note does not claim that Kandelo can
publish or consume a VFS Formula yet.

## Decision shared by both transport options

A VFS Formula is an ordinary Homebrew Formula. Its normal `depends_on`
declarations remain the only dependency source of truth, including fully named
cross-tap dependencies. Kandelo resolves that dependency closure from immutable
tap metadata before inspecting the root Formula bottle.

The root Formula bottle owns its layer-specific system files at two fixed
locations inside its keg:

- `share/kandelo/vfs-layer.json` is the bounded, URL-free manifest.
- `libexec/kandelo-vfs-layer/rootfs/` is projected onto `/`.

Configuration, service definitions, writable-state setup, and presentation
metadata such as `/etc/kandelo/demo.json` are ordinary files below that rootfs
directory. They therefore travel with the Formula that owns them instead of
living in a package-name-specific browser rule.

The schema-1 manifest binds the full Formula name, the fixed payload mapping,
and boot-prefetch or first-use activation policy. It deliberately does not
repeat dependencies, bottle hashes, public URLs, release tags, or acceptance
evidence. Dependencies already belong to the Formula and tap metadata.
Publication URLs and release tags cannot be embedded in immutable bottle bytes
without making publication provenance circular.

`host/src/homebrew-vfs-formula-layer.ts` implements the common source contract:

- exact manifest parsing and bounds;
- one explicitly requested, dependency-first Formula closure;
- fixed manifest and payload presence in the root bottle;
- canonical path, directory, mode, symlink, hard-link, and activation checks;
- deterministic cross-layer package and target ownership preflight; and
- image-wide package, entry, and payload budgets after shared ownership is
  deduplicated.

Two selected layers may share an ordinary Formula dependency. Composition
installs it once when both plans bind the exact same bottle, link projection,
and immutable provenance; two different identities for the same full Formula
name fail before filesystem staging begins.

Per-layer bounds are not sufficient on their own: several valid layers can
still exceed one VFS image's retained-resource budget. Composition therefore
charges the final deduplicated package and path inventory before a descriptor
builder or staged filesystem is allowed to mutate state.

The existing runtime-layer consumer remains the composition endpoint. It
already verifies descriptor and content hashes, the exact base image and ABI,
aggregate resource budgets, package ownership, base and cross-layer path
collisions, and all selected layers before publishing its staged filesystem.
The new source contract must feed that path rather than create a second browser
mount implementation.

## Remaining transport decision

Two implementations can derive the same checked target inventory:

1. Reuse the original bottle as the deferred payload. The descriptor maps
   regular payload members from their private keg paths to final rootfs paths,
   creates structural directories and symlinks from checked metadata, and
   fetches the original bottle once. This preserves the strongest
   bottle-to-runtime byte identity, but the current schema-5 direct-bottle
   binder needs an explicit, reviewed VFS-payload mapping rule.
2. Derive a rootfs-only immutable archive from the verified bottle payload.
   The existing generic deferred-tree decoder can consume it with fewer schema
   changes, but the release mirrors bytes already present in the bottle and
   must bind that derived archive back to the exact source bottle and manifest.

The current change does not choose between them. Both require exactly the
manifest, dependency closure, payload projection, and collision preflight
implemented here. A follow-up should select the transport after measuring the
release/storage cost and the complexity of extending the direct-bottle
descriptor without weakening its source-inventory checks.

## Acceptance still required

Before this becomes supported behavior:

1. Bind the projected inventory into a draft runtime-layer descriptor using one
   of the transport options above.
2. Prove two independently bottled VFS Formulae, including one cross-tap
   dependency, through the exact Node.js and Chromium composition path.
3. Prove deterministic composition in either selected order, or a truthful
   collision before any staged filesystem is published.
4. Publish immutable bottle, descriptor, transport, Node.js, and browser
   evidence through the normal tap workflow.
5. Document Formula authoring and user-facing layer selection only after those
   artifacts and tests are live.
