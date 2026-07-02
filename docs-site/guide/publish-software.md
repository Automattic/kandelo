# Publish Software For Kandelo

::: warning API stability
The package-source workflow, gallery manifest shape, and release index contract are still evolving. Pin the Kandelo ref used by your publish workflow and expect to update package recipes after ABI changes.
:::

There are two useful ways to publish browser-bootable Kandelo software:

1. host a direct `.vfs` or `.vfs.zst` image and share a `?vfs=` URL;
2. publish a package-source repository with `gallery.json`, `index.toml`, and release archives.

Use direct VFS links for one-off images. Use package sources when you want repeatable builds, release history, gallery entries, or multiple related packages.

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
- demos that should appear in the browser gallery only when release artifacts exist;
- software that is too large, slow, experimental, or domain-specific for the main Kandelo CI.

## Gallery Manifest

`gallery.json` is presentation metadata. `index.toml` is availability state.

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
- The UI shows an entry only when every listed package has a successful `wasm32` record in the ABI-matching `index.toml`.

Test a manifest against an index:

```bash
node scripts/validate-software-gallery.mjs \
  --gallery /path/to/package-source/gallery.json \
  --index /tmp/index.toml
```

## Test A Manifest Locally

Point a local Kandelo UI at your manifest:

```bash
cd apps/browser-demos
VITE_KANDELO_SOFTWARE_MANIFEST_URLS='https://example.com/releases/download/binaries-abi-v11/gallery.json' \
  npm run dev
```

Or use the public UI:

```text
https://automattic.github.io/kandelo/?softwareManifest=https://example.com/releases/download/binaries-abi-v11/gallery.json
```

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
5. test a public `softwareManifest` URL in the browser UI.
