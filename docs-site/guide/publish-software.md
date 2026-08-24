# Publish Software For Kandelo

::: warning API stability
The package-source workflow, gallery manifest shape, and release index contract are still evolving. Pin the Kandelo ref used by your publish workflow and expect to update package recipes after ABI changes.
:::

There are two useful ways to publish browser-bootable Kandelo software:

1. host a direct `.vfs` or `.vfs.zst` image and share a `?vfs=` URL;
2. publish a package-source repository with `gallery.json`, `index.toml`, and release archives.

Use direct VFS links to launch images in the demo app. Use package sources when
you want repeatable builds, release history, published metadata, or multiple
related packages.

## Direct VFS URL

Host an image somewhere the Kandelo UI can fetch:

```text
https://example.com/images/site.vfs.zst
```

Then share:

```text
https://automattic.github.io/kandelo/?vfs=https://example.com/images/site.vfs.zst
```

The image host should serve CORS or compatible cross-origin resource policy headers because Kandelo runs in a cross-origin-isolated page.

## Package Source Repository

A package source is a repository that owns package recipes, VFS image recipes, and release state outside the main Kandelo repository.

Recommended layout:

```text
README.md
packages.txt
gallery.json
packages/
  <name>/
    package.toml
    build.toml
    build-<name>.sh
    patches/
```

Use package sources for:

- language runtimes;
- large VFS images;
- software with published metadata for consumers outside the demo app;
- software that is too large, slow, experimental, or domain-specific for the main Kandelo CI.

## Gallery Manifest

`gallery.json` is optional presentation metadata. `index.toml` is availability
state. The current Kandelo demo app does not request third-party gallery
manifests, but package sources can continue to publish and validate them for
other consumers.

```json
{
  "source_id": "my-software",
  "entries": [
    {
      "id": "python-vfs",
      "title": "Python VFS",
      "description": "CPython with the standard library in a VFS image.",
      "packages": [
        { "name": "cpython", "version": "3.13.3" },
        { "name": "python-vfs", "version": "0.1.0" }
      ]
    }
  ]
}
```

Rules:

- `source_id` becomes the gallery entry namespace.
- `entries[].id` and package names should use lowercase IDs.
- `entries[].packages` must include every package required to launch.
- A consumer should show an entry only when every listed package has a
  successful `wasm32` record in the ABI-matching `index.toml`.

Test a manifest against an index:

```bash
node scripts/validate-software-gallery.mjs \
  --gallery /path/to/package-source/gallery.json \
  --index /tmp/index.toml
```

## Test A Published Image

Validate the optional gallery metadata with the command above. To test the
actual image in the demo app, publish it and open its direct `?vfs=` URL.

## Reusable Publish Workflow

Kandelo provides a reusable GitHub Actions workflow for package-source repositories:

```yaml
name: Publish Kandelo packages

on:
  workflow_dispatch:
    inputs:
      packages:
        description: Comma-separated package names, or all.
        default: all
      kandelo-ref:
        description: Kandelo ref to build against.
        default: main

permissions:
  contents: write

jobs:
  publish:
    uses: Automattic/kandelo/.github/workflows/reusable-package-source-publish.yml@main
    with:
      kandelo-ref: ${{ inputs.kandelo-ref }}
      packages: ${{ inputs.packages }}
```

For stricter reproducibility, pin `@main` to a tag or commit.

## ABI Bumps

VFS images that contain Kandelo ABI-bound Wasm programs should declare `kernelAbi` metadata. When Kandelo's ABI changes:

1. update package `kernel_abi` fields;
2. rebuild packages and VFS images against the new Kandelo ref;
3. publish a new `binaries-abi-v<N>` release;
4. verify `gallery.json` against the new `index.toml`;
5. test the published image through a public direct VFS URL.
