# Kandelo Package Sources

A package source is a GitHub repository that publishes Kandelo packages
outside the main Kandelo repository. It owns package recipes, VFS image
recipes, and release state for its packages. Kandelo owns the toolchain,
resolver, archive format, and browser-gallery consumer.

The first package source is
[`brandonpayton/kandelo-software`](https://github.com/brandonpayton/kandelo-software).
Use the same shape for additional repositories.

## When To Use One

Use a package source when a package is useful to Kandelo users but is too
large, too slow, too experimental, or too domain-specific to rebuild in
the main Kandelo CI. Examples include language runtimes, large VFS
images, and demos that should appear in the Kandelo gallery only when
their release artifacts are available.

Do not create a package source for small core packages that the browser
UI or tests require. Those belong in `packages/registry/`.

## Repository Layout

```text
README.md
packages.txt
gallery.json                         # optional browser-gallery metadata
packages/
  program-packages.json              # Rust-generated runtime projection
  <name>/
    package.toml                     # portable package recipe
    build.toml                       # this source's publish/index state
    build-<name>.sh                  # Kandelo-relative build script
    patches/
```

`packages.txt` lists publishable packages in dependency order, one per
line. Blank lines and `#` comments are ignored by
`scripts/publish-package-source.sh`.

If the source is used directly through `WASM_POSIX_DEPS_REGISTRY`, generate
`packages/program-packages.json` with Kandelo's authoritative parser and the
same ordered registry roots that consumers will use:

```bash
WASM_POSIX_DEPS_REGISTRY="$PWD/packages:/path/to/kandelo/packages/registry" \
  cargo xtask build-deps program-index packages packages/program-packages.json
```

Commit the result beside the package directories. Runtime consumers require it
to preserve exact first-hit output closures, per-architecture cache keys, and
fork policy without maintaining a second TOML parser. The projection also binds
each program to the identities of its complete transitive dependency closure
in that registry order. The reusable publication workflow checks this
projection before building, so a changed recipe or dependency cannot be
published with stale runtime identity.

The external index is a complete `external:main` projection. It contains
identities for every first-hit package and projections for every selected
program, including programs whose physical manifests remain in the main
registry. Identical shadows keep the same identity. A changed direct or
transitive external dependency gives each affected lower program a newly
computed combined-context cache key and closure, so normal resolution can fetch
or build that exact generation without copying the program recipe into the
external repository. Consumers use this highest-priority complete index; they
never merge it with lower policy. The main registry's own index remains a
self-contained fallback when the external root is not configured or present.

Use Kandelo's current package layout in new recipes:

```toml
[build]
script_path = "packages/registry/nethack/build-nethack.sh"
```

For older package-source repositories, `scripts/sync-package-source.sh`
also mirrors a package into `examples/libs/<name>/` when its
`package.toml` or `build.toml` still references `examples/libs/`.
That compatibility path is for migration only.

## `package.toml`

`package.toml` is the portable recipe. Keep it free of publish state:

- no `revision`
- no `[binary]`
- no `[build].repo_url`
- no `[build].commit`

For packages with a build script, set `kernel_abi` to the Kandelo ABI
the package source currently targets.

```toml
kind = "program"
name = "nethack"
version = "3.6.7"
kernel_abi = 11
depends_on = ["ncurses@6.5"]

[source]
url = "https://www.nethack.org/download/3.6.7/nethack-367-src.tgz"
sha256 = "98cf67df6debf9668a61745aa84c09bcab362e5d33f5b944ec5155d44d2aacb2"

[license]
spdx = "NGPL"
url = "https://nethack.org/common/license.html"

[build]
script_path = "packages/registry/nethack/build-nethack.sh"

[[outputs]]
name = "nethack"
wasm = "nethack.wasm"
```

## `build.toml`

`build.toml` is this package source's publish view. The `repo_url`,
`revision`, and `[binary] index_url` are repository-specific.

```toml
script_path = "packages/registry/nethack/build-nethack.sh"
repo_url    = "https://github.com/<owner>/<package-source>.git"
commit      = "UNPUBLISHED"
revision    = 1

[binary]
index_url = "https://github.com/<owner>/<package-source>/releases/download/binaries-abi-v{abi}/index.toml"
```

Keep `{abi}` in the URL. The resolver substitutes Kandelo's
`ABI_VERSION` at resolve time, so the same file survives ABI bumps.

## Reusable Publish Workflow

Kandelo ships a reusable workflow so package-source repositories do not
need to copy release logic. Add this to the package-source repository:

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

Pin `@main` to a tag or commit for stricter reproducibility.

The workflow checks out the package source and Kandelo, builds Kandelo's
sysroots, overlays `packages/*` into Kandelo, then runs
`scripts/publish-package-source.sh`. Archives and `index.toml` are
published to the package-source repository's
`binaries-abi-v<N>` release.

## Script API

The reusable workflow is a thin wrapper over scripts that also work
locally and are the preferred interface for automation agents.

Overlay a package source into a Kandelo checkout:

```bash
bash scripts/sync-package-source.sh \
  --package-source-root /path/to/package-source \
  --kandelo-root /path/to/kandelo
```

Build and publish packages from inside Kandelo's dev shell:

```bash
cd /path/to/kandelo
bash scripts/dev-shell.sh bash scripts/publish-package-source.sh \
  --package-source-root /path/to/package-source \
  --kandelo-root /path/to/kandelo \
  --repo <owner>/<package-source> \
  --packages all
```

The publish script:

- reads `ABI_VERSION` from Kandelo
- defaults the release tag to `binaries-abi-v<N>`
- stages one package archive with `xtask archive-stage`
- records success or failure in release `index.toml`
- uploads `gallery.json` when the package source provides it

## Browser Gallery Contract

A package source can publish `gallery.json` beside `index.toml`.
Kandelo's browser gallery treats `gallery.json` as presentation
metadata and `index.toml` as availability state.

```json
{
  "source_id": "kandelo-software",
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

- `source_id` identifies the package source in Gallery entry IDs. If it
  is omitted, Kandelo derives one from `repository` or the manifest URL.
- `entries[].id` and package names use lowercase IDs:
  `^[a-z0-9][a-z0-9._-]*$`
- `entries[].packages` lists every package required to launch the
  demo.
- The browser shows an entry only when every listed package has a
  `wasm32` `status = "success"` record, an `archive_url`, and
  `browser_compatible = true` in the matching `index.toml`.
- `browser_compatible = true` is a runtime claim. Set it only after a
  browser smoke has launched the archive-backed image through the Kandelo UI.
- If `gallery.json` or `index.toml` is temporarily unavailable, the
  core Kandelo gallery remains available and third-party entries are
  skipped.
- If a listed archive is deleted after the index says it exists, launch
  fails visibly in the Kandelo syslog and the gallery remains usable.

Validate a gallery manifest against an index:

```bash
node scripts/validate-software-gallery.mjs \
  --gallery /path/to/package-source/gallery.json \
  --index /tmp/index.toml
```

## Kandelo Demo Metadata

Package-source VFS images can opt into Kandelo's built-in demo guide by writing
`/etc/kandelo/demo.json` during image construction. Keep this metadata in the
VFS package, not in the Kandelo app. The loader resolves metadata by gallery
entry ID after restoring the image.

For REPL demos in `kandelo-software`, add a `guide` next to the image's
`presentation`:

```typescript
writeKandeloDemoConfig(fs, {
  version: 1,
  profiles: {
    "kandelo-software-python-vfs": {
      presentation: {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer"
      },
      guide: {
        title: "Python demo",
        groups: [
          {
            title: "REPL",
            actions: [
              {
                id: "open-repl",
                label: "Open REPL",
                kind: "terminal.run",
                payload: "python3"
              },
              {
                id: "send-expression",
                label: "Send expr",
                kind: "terminal.write",
                payload: "import sys; sys.version\n"
              }
            ]
          }
        ]
      }
    }
  }
});
```

Action kinds:

- `terminal.run` sends the payload as a shell command to the persistent
  PTY-backed shell.
- `terminal.write` sends raw text to that PTY, so it can enter input into an
  already-running REPL.

Optional companion HTML can be embedded as `guide.companion.srcDoc`. It runs in
a sandboxed iframe and cannot call the kernel directly. It asks Kandelo to run
known actions with:

```js
parent.postMessage({ type: "kandelo.demoAction", actionId: "send-expression" }, "*");
```

Kandelo validates `actionId` against the actions declared in the same VFS
metadata before touching the running machine. Omitting `guide` means no demo
panel is shown.

The arguments may also be `https://` URLs.

The browser UI uses `kandelo-software` by default. For local testing
of another package source, pass one or more manifest URLs with the
`softwareManifest` query parameter:

```text
/?softwareManifest=https://example.com/releases/download/binaries-abi-v11/gallery.json
```

For a local build, `VITE_KANDELO_SOFTWARE_MANIFEST_URLS` may contain a
comma- or whitespace-separated manifest URL list.

Direct VFS image links do not need a gallery manifest. The Kandelo UI
also accepts a `vfs` query parameter whose value is an `http` or `https`
URL to a `.vfs` or `.vfs.zst` image:

```text
/?vfs=https://example.com/images/site.vfs.zst
```

Gallery launches update this `vfs` parameter and reload the Kandelo app
from the new URL. `demo` is not a supported boot parameter.

The browser must be allowed to fetch the image under Kandelo's
cross-origin-isolated page. In practice, third-party image hosts should
serve the file with CORS or compatible cross-origin resource policy
headers.

Homebrew browser-gallery assets use the same package-source contract only for
the browser-launchable VFS image. The actual Homebrew bottle remains owned by
the tap formula, GHCR bottle URL, and `Kandelo/` sidecars described in
[docs/homebrew-publishing.md](homebrew-publishing.md). The trusted publisher
writes a precomposed `.vfs.zst` into a package-source-shaped archive only after
the published wasm32 Homebrew bottle has been poured into a VFS image and
booted by the browser smoke. Bottles without that smoke remain Node-only and
must keep `browser_compatible = false`.

## Agent Checklist

When creating or maintaining a package source:

1. Read `docs/package-management.md` for `package.toml` and
   `build.toml` schema rules.
2. Put recipes in `packages/<name>/`; do not edit Kandelo's first-party
   registry unless the package should become core.
3. Use `packages/registry/<name>/...` in new `script_path` values.
4. Add packages to `packages.txt` in dependency order.
5. Keep `build.toml`'s `index_url` pointed at the package-source
   repository and keep `{abi}` in the URL.
6. Add `gallery.json` only for demos that can launch from published
   artifacts and have `browser_compatible = true` package records.
7. Run `scripts/validate-software-gallery.mjs` after publishing an
   index.
8. On ABI bumps, update `kernel_abi`, run the reusable workflow against
   the Kandelo ref containing the bump, and verify the new
   `binaries-abi-v<N>` release.
