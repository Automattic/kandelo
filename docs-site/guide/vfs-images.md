# VFS Images

::: warning API stability
The VFS binary format, image metadata, and helper APIs are experimental. Images should declare their intended kernel ABI, and maintainers should expect to rebuild images after ABI or tooling changes.
:::

A Kandelo VFS image is a serialized `MemoryFileSystem`. It stores directories, files, symlinks, mode bits, ownership, lazy-file metadata, lazy-archive metadata, and optional image metadata. Browser apps fetch the image and restore it in a worker instead of recreating thousands of filesystem entries at runtime.

Kandelo accepts:

- `.vfs` - uncompressed image bytes;
- `.vfs.zst` - zstd-compressed image bytes.

`restoreVerifiedVfsImage()` auto-detects zstd-compressed images and
authenticates imported atomic lazy-tree seals before returning a filesystem.
Use the low-level synchronous `MemoryFileSystem.fromImage()` parser only for
private format work that does not inspect, mutate, or boot imported state
before separately completing that verification.

## When To Use A VFS Image

Use a VFS image when a browser machine needs:

- an interpreter or shell plus runtime files;
- Unix-style configuration under `/etc`;
- service supervision with dinit;
- many read-only files;
- reproducible launch behavior;
- direct launch from the Kandelo UI with `?vfs=...`.

For a single tiny Wasm program and no filesystem tree, a custom lab can still write files into a temporary `MemoryFileSystem`, but that is not the preferred path for user-facing demos.

## Build From A Manifest

The `mkrootfs` CLI builds, inspects, extracts, and edits VFS images.

From the repo root:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs build MANIFEST images/rootfs \
  -o host/wasm/rootfs.vfs.zst \
  --kernel-abi 11
```

The canonical rootfs build is wrapped by:

```bash
bash scripts/build-rootfs.sh
```

For custom images, use your own source tree and manifest:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs build ./MY-MANIFEST ./rootfs \
  -o ./dist/my-machine.vfs \
  --kernel-abi 11
```

## Manifest Grammar

Each non-comment manifest line is one node or archive directive:

```text
<path>  <type>  <mode>  [<uid>]  [<gid>]  [key=value ...]
archive url=<path-or-url> [base=/prefix] [fmode=0644] [dmode=0755] [uid=0] [gid=0]
```

Node types:

| Type | Meaning |
| --- | --- |
| `d` | directory |
| `f` | regular file |
| `l` | symlink |
| `c` | character device |
| `b` | block device |

Common fields:

| Field | Applies To | Meaning |
| --- | --- | --- |
| `src=<path>` | file | Use a source file other than `sourceTree/<path>`. |
| `lazy_url=<url>` | file | Register a URL-backed file stub. |
| `lazy_size=<n>` | file | Required with `lazy_url`. |
| `target=<path>` | symlink | Symlink target. |
| `major=<n>` / `minor=<n>` | device | Device numbers. |

Example:

```text
/etc             d  0755  0     0
/home            d  0755  0     0
/home/maker      d  0755  1000  1000
/etc/passwd      f  0644  0     0
/bin/sh          l  0777  0     0  target=/usr/bin/bash
/usr/bin/bash    f  0755  0     0  lazy_url=binaries/programs/wasm32/bash.wasm lazy_size=1234567
archive          url=./runtime.zip base=/usr fmode=0644 dmode=0755 uid=0 gid=0
```

## Inspect An Image

```bash
node tools/mkrootfs/bin/mkrootfs.mjs inspect ./dist/my-machine.vfs --metadata
```

JSON output is available for scripts:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs inspect ./dist/my-machine.vfs \
  --metadata \
  --format json
```

## Extract And Round Trip

Extract a VFS image to a host directory:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs extract ./dist/my-machine.vfs ./out/rootfs \
  --manifest
```

`--manifest` writes a sidecar manifest that preserves mode, uid, and gid values that the host filesystem usually cannot represent.

## Patch An Existing Image

Use `mkrootfs add` for a small ad-hoc edit:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs add ./dist/my-machine.vfs /etc/motd \
  --file ./motd \
  --mode 0644 \
  --uid 0 \
  --gid 0 \
  --force
```

Other forms:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs add ./dist/my-machine.vfs /opt --dir --mode 0755
node tools/mkrootfs/bin/mkrootfs.mjs add ./dist/my-machine.vfs /bin/sh --symlink /usr/bin/bash --force
```

For repeatable images, prefer changing the source tree or manifest and rebuilding.

## Demo Metadata

Images consumed by the Kandelo UI can include:

```text
/etc/kandelo/demo.json
```

This file lets the image declare presentation preferences, guide actions,
companion HTML, assets, what the machine runs (`init`), an optional
fixed-path file ingest, and whether the demo wants an on-screen touch
control overlay on coarse-pointer devices (`presentation.touchControls`).

The file is not generated at build time. Commit the JSON next to the
package that owns the image, list it in `TRACKED_DEMO_CONFIG_SOURCES`
(`images/vfs/scripts/tracked-demo-config.ts`), and have the build script
copy it in verbatim:

```ts
writeTrackedDemoConfig(fs, "packages/registry/my-image/my-demo.json");
```

`writeTrackedDemoConfig` writes the reviewed file byte-for-byte, so the
bytes you review are the bytes that ship. The tracked file looks like this:

```json
{
  "version": 1,
  "defaultProfile": "my-demo",
  "profiles": {
    "my-demo": {
      "identity": {
        "title": "My demo",
        "summary": "What this machine is, in one line.",
        "accent": "#3858e9",
        "glyph": "my"
      },
      "presentation": {
        "bootPrimary": "syslog",
        "runningPrimary": ["terminal", "syslog"],
        "terminalAccess": "primary",
        "internalsAccess": "drawer"
      },
      "guide": {
        "title": "My demo",
        "groups": [
          {
            "title": "Try it",
            "actions": [
              {
                "id": "run-version",
                "label": "Show version",
                "kind": "terminal.run",
                "payload": "my-program --version"
              }
            ]
          }
        ]
      },
      "ingest": {
        "accept": [".rom"],
        "targetPath": "/inputs/game.rom",
        "maxBytes": 8388608,
        "label": "Load ROM",
        "onLoad": { "restart": "emulator /inputs/game.rom" }
      }
    }
  }
}
```

Every block below belongs to a profile. Only `version`, `defaultProfile`,
and `profiles` may appear at the top level; a machine block declared there
is rejected.

A profile may also declare:

- `identity` — `title`, `summary`, `accent` (`#rrggbb`), `glyph` (1–4
  characters), and optionally `packages`.
- `runtime` — `features` (`framebuffer`, `kms`, `evdev-input`) and
  `requests` (`memoryPages`, `maxWorkers`), which the host clamps to its
  own policy.
- `init` — what this machine runs, in exactly one of three shapes:
  `{ "target": "<dinit service>" }` for a bare service name matching
  `/etc/dinit.d/<name>`; `{ "program", "args", "cwd"?, "uid", "gid" }` to
  exec a program in the image directly as pid 1 (`uid` and `gid` are
  required, so the privilege pid 1 gets is stated, not defaulted); or
  `{ "shellCommand": "..." }` for a command run in the machine's login
  shell after boot.
- `web` — `requiredPorts`, `probeHttp` (defaults to true), and an optional
  plain absolute `probePath`.
- `display` — `minWidth`/`minHeight`, the smallest usable surface.
- `defaultProfile`, at the top level — which profile a bare `?vfs=` URL boots.

These blocks are validated and carried in the image today; the Kandelo
browser app does not read them yet.

If metadata changes for a package-backed image, bump that package's `build.toml` `revision` so published archives rebuild.

## Lazy Files And Lazy Archives

Lazy files and archives keep initial downloads small. A VFS image can contain a stub for a large file or archive. The real bytes are fetched only when the guest accesses the path.

Use lazy files for a few large binaries. Use lazy archives for runtime trees with many files, such as Vim runtime data or Python standard-library content.

When hosting an image, host every lazy asset at the URLs encoded in the image, or boot with a `lazyUrlBase` that resolves relative URLs correctly.
