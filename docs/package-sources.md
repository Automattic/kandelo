# Kandelo Package Sources

A package source is a GitHub repository that hosts Kandelo package
**recipes** outside the main Kandelo repository. It owns package recipes,
VFS image recipes, and patches for its packages. Kandelo owns the toolchain,
resolver, and built-in browser gallery.

Package resolution is local-first: a package source ships recipes, not
prebuilt binaries. Consumers overlay the source into a Kandelo checkout and
source-build its packages through the same SDK/libc/resolver used for
first-party packages, caching the results locally by content hash.

The first package source is
[`brandonpayton/kandelo-software`](https://github.com/brandonpayton/kandelo-software).
Use the same shape for additional repositories.

## When To Use One

Use a package source when a package is useful to Kandelo users but is too
large, too slow, too experimental, or too domain-specific to rebuild in
the main Kandelo CI. Examples include language runtimes and large VFS
images that users can launch through a direct image URL.

Do not create a package source for small core packages that the browser
UI or tests require. Those belong in `packages/registry/`.

## Repository Layout

```text
README.md
packages.txt
packages/
  program-packages.json              # Rust-generated runtime projection
  <name>/
    package.toml                     # portable package recipe
    build.toml                       # this source's project view
    build-<name>.sh                  # Kandelo-relative build script
    patches/
```

`packages.txt` lists the source's packages in dependency order, one per
line. Blank lines and `#` comments are ignored.

If the source is used directly through `WASM_POSIX_DEPS_REGISTRY`, generate
`packages/program-packages.json` with Kandelo's authoritative parser and the
same ordered registry roots that consumers will use:

```bash
KANDELO_ROOT=/absolute/path/to/kandelo
WASM_POSIX_DEPS_REGISTRY="$PWD/packages:$KANDELO_ROOT/packages/registry" \
  cargo xtask build-deps program-index \
    --source-repo-root "$KANDELO_ROOT" \
    packages packages/program-packages.json
```

Validate all existing roots exactly as a source consumer will see them:

```bash
WASM_POSIX_DEPS_REGISTRY="$PWD/packages:$KANDELO_ROOT/packages/registry" \
  cargo xtask build-deps program-index-context-check \
    --source-repo-root "$KANDELO_ROOT"
```

The Kandelo root must be an absolute canonical path. Passing it explicitly
keeps package identities independent of whichever worktree originally built a
reused xtask executable.

Commit the result beside the package directories. Runtime consumers require it
to preserve exact first-hit output closures, per-architecture cache keys, and
fork policy without maintaining a second TOML parser. The projection also binds
each program to the identities of its complete transitive dependency closure
in that registry order. The local build checks this projection before
building, so a changed recipe or dependency cannot be built with stale
runtime identity.
Kandelo source checkouts run the same contextual Rust check before every public
program resolution. An existing configured root without an index is an error;
nonexistent optional roots are skipped. Installed host packages instead consume
the projection that Kandelo verified and copied at package-build time.

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

`package.toml` is the portable recipe. Keep it free of project-view
state (those fields live in `build.toml`):

- no `revision`
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

`build.toml` is this package source's project view. The `repo_url`,
`commit`, and `revision` are repository-specific.

```toml
script_path = "packages/registry/nethack/build-nethack.sh"
repo_url    = "https://github.com/<owner>/<package-source>.git"
commit      = "UNPUBLISHED"
revision    = 1
```

`revision` is a cache-key input: bump it when the build output legitimately
changes so consumers rebuild that package from source under the new key.

## Consuming a package source

A package source is consumed by overlaying its recipes into a Kandelo
checkout and source-building them locally. There is no per-package binary
release to publish or fetch.

Overlay the package source into a Kandelo checkout:

```bash
bash scripts/sync-package-source.sh \
  --package-source-root /path/to/package-source \
  --kandelo-root /path/to/kandelo
```

Then prepend the source's `packages/` directory to
`WASM_POSIX_DEPS_REGISTRY` so the resolver selects its recipes first, and
build from source through the normal path:

```bash
cd /path/to/kandelo
KANDELO_ROOT="$(pwd -P)"
WASM_POSIX_DEPS_REGISTRY="/path/to/package-source/packages:$KANDELO_ROOT/packages/registry" \
  bash scripts/dev-shell.sh cargo xtask build-deps resolve <name>
```

The resolver source-builds each package through the SDK/libc, verifies the
upstream source archive against `[source].sha256`, and caches the built
outputs locally by content hash — exactly as it does for first-party
recipes.

To make a package source's VFS image launchable in a browser, build the
`.vfs`/`.vfs.zst` image and host it at a URL; users launch it through the
Kandelo UI's `vfs` query parameter (see "Kandelo Demo Metadata" below).
Demo presentation metadata belongs inside the image at
`/etc/kandelo/demo.json`, not in a separately published manifest.

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

The browser demo exposes only repository-defined gallery entries. It does not
request third-party manifests, including URLs supplied through the former
`softwareManifest` query parameter or
`VITE_KANDELO_SOFTWARE_MANIFEST_URLS` build variable.

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

## Agent Checklist

When creating or maintaining a package source:

1. Read `docs/package-management.md` for `package.toml` and
   `build.toml` schema rules.
2. Put recipes in `packages/<name>/`; do not edit Kandelo's first-party
   registry unless the package should become core.
3. Use `packages/registry/<name>/...` in new `script_path` values.
4. Add packages to `packages.txt` in dependency order.
5. Generate and commit `packages/program-packages.json` so source-build
   consumers get correct per-architecture runtime identity.
6. On ABI bumps, update `kernel_abi` and re-source-build against the
   Kandelo ref containing the bump.
