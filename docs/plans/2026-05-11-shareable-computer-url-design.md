# Shareable Computer URL Design

Kandelo's tagline is "Fold a computer into a URL." The important
interpretation is not that every byte of a serious computer must fit
inside the URL. A URL should be able to identify, configure, verify,
and optionally customize a computer.

The strongest direction is to share the computer topology, not the
bytes: a compact boot descriptor that names signed base images, signed
software packages, mount layout, runtime configuration, boot command,
and any small user overlay that fits inline. Large artifacts remain
content-addressed, signed, cacheable, and fetched at runtime.

## Goals

- Let users share real Kandelo computers with a link.
- Keep links useful across chat, docs, issue comments, QR codes, and
  browser address bars.
- Make serious systems possible without embedding multi-megabyte VFS
  images in the URL.
- Preserve reproducibility by pinning bases, packages, and remote
  artifacts by hash.
- Support private shares with encrypted overlays and fragment-carried
  keys.
- Keep official bases and package layers signed so a shared computer can
  be verified before boot.
- Degrade gracefully: inline tiny state, inline small deltas, reference
  larger manifests, and only use external storage when needed.

## Constraints

URLs have no single practical limit. Browsers, address bars, hosting
layers, redirects, proxies, logs, and chat clients all impose different
limits. Kandelo should treat URL size as product tiers, not a binary
capability:

| Tier | Approximate size | Use |
|---|---:|---|
| Tiny | <= 2 KB | Presets, package selections, boot commands |
| Shareable | <= 8 KB | Common chat/docs/email links |
| Power-user | <= 32 KB | Rich topology plus small overlays |
| Extended | > 32 KB | Use a hosted manifest or content-addressed blob |

The URL fragment should carry opaque state when possible because it is
not sent in HTTP requests and is less likely to land in server logs.
The route/query can still carry human-readable presets or manifest ids.

## Core Model

Treat the URL as a boot descriptor:

```text
URL = base identity
    + requested system configuration
    + mount graph
    + boot command
    + optional inline overlay
    + optional remote manifest/blob references
```

Example shape:

```json
{
  "version": 1,
  "base": "kandelo:shell@abi42",
  "runtime": {
    "arch": "wasm32",
    "kernel": "kernel@sha256:...",
    "memoryPages": 4096,
    "features": ["shared-array-buffer", "pty", "tcp-bridge"]
  },
  "packages": [
    "dash@sha256:...",
    "coreutils@sha256:...",
    "python@sha256:..."
  ],
  "mounts": [
    {
      "path": "/",
      "source": "image",
      "ref": "rootfs@sha256:...",
      "readonly": true
    },
    {
      "path": "/usr",
      "source": "package-layer",
      "ref": "python@sha256:...",
      "readonly": true
    },
    {
      "path": "/home/user",
      "source": "inline-overlay",
      "data": "base64url(zstd(cbor(...)))"
    },
    {
      "path": "/tmp",
      "source": "scratch",
      "ephemeral": true
    },
    {
      "path": "/persist",
      "source": "opfs",
      "name": "project-x"
    }
  ],
  "boot": {
    "argv": ["/bin/sh"],
    "cwd": "/home/user",
    "env": {
      "HOME": "/home/user",
      "PATH": "/bin:/usr/bin"
    }
  }
}
```

## Mount Sources

The mount graph is the main shareable structure. It can represent a
serious machine without carrying the machine's full byte content.

Potential mount sources:

- `image`: read-only VFS image restored from a signed content-addressed
  artifact.
- `package-layer`: package output mounted as a read-only filesystem
  layer.
- `inline-overlay`: small compressed CBOR operation log stored directly
  in the URL.
- `remote-overlay`: compressed overlay fetched by URL and verified by
  hash/signature.
- `scratch`: empty writable ephemeral filesystem.
- `opfs`: browser Origin Private File System persistence.
- `lazy-http`: lazy files fetched on first access.
- `archive`: zip/tar/tar.zst mounted by index or decompressed on first
  use.
- `git`: repository checkout or Git bundle mounted into the VFS.
- `cas`: content-addressed store with Merkle roots.
- `encrypted`: encrypted overlay or mount whose decryption key is stored
  in the URL fragment.
- `device`: standard generated mounts such as `/dev`, `/proc`, or
  framebuffer devices.

This lines up with Kandelo's current VFS direction: a canonical rootfs
image, scratch mounts for mutable directories, lazy files for expensive
binaries/assets, and kernel-owned filesystem boot for browser demos.

## System Configuration

The URL should be able to request system configuration without baking
policy into a specific demo page:

- Kernel/runtime version.
- ABI version.
- Target architecture, such as `wasm32` or `wasm64`.
- Maximum memory pages per process.
- Filesystem growth ceilings.
- Mount table and read-only/writable policy.
- Initial process: direct exec, shell, or dinit.
- `argv`, `cwd`, environment variables, UID/GID.
- Services to expose through the service worker bridge.
- TCP/HTTP bridge configuration.
- Framebuffer options.
- Terminal dimensions and PTY setup.
- Time mode: real time, frozen time, or deterministic test time.
- Network permissions.
- Persistence permissions.
- Package registry pins.
- Trust policy: required signatures, allowed registries, and hash
  algorithm.

The host may reject unsupported or unsafe requested configuration. A
shared link describes the desired computer; the page decides whether it
can and should boot it.

## Signed Bases And Packages

Signed, content-addressed artifacts are what make topology links serious.

Useful artifact types:

- Kernel Wasm.
- Userspace support Wasm.
- Root filesystem images.
- Package layers.
- Ported program binaries.
- Runtime trees, such as Python stdlib, vim runtime, or TeX assets.
- Source extracts needed by package builds.
- Composite application images, such as WordPress, LAMP, Redis, MariaDB,
  or nginx/PHP.

Each artifact should have:

- Logical id: `python`, `rootfs`, `coreutils`, `lamp`.
- Version and build revision.
- ABI and architecture compatibility metadata.
- Content hash.
- Signature over metadata and hash.
- License metadata.
- Optional source provenance.
- Optional decompressed size and file-count limits.

The URL should generally refer to artifacts by id plus hash. Human names
are for ergonomics; hashes are for identity.

## Overlay And Delta Formats

Inline overlays should be operation-oriented at first, not block-level
VFS diffs. Operation overlays are easier to inspect, version, merge,
sign, and carry across VFS image format changes.

Useful operations:

- `mkdir`
- `write`
- `truncate`
- `unlink`
- `rename`
- `symlink`
- `chmod`
- `chown`
- `utime`
- `whiteout`

Encoding stack:

```text
CBOR manifest or operation log
-> zstd or brotli
-> base64url without padding
-> URL fragment
```

Recommended first envelope:

```text
#k1=<base64url(zstd(cbor(payload)))>
```

Other delta options to keep on the table:

- Whole changed-file replacement.
- Text patches for source-heavy projects.
- Binary patches for known base files.
- VFS write journal replay.
- Merkle file tree diff.
- Content-defined chunking.
- CAS roots with URL-carried missing objects.
- Git packfile for source repositories.
- SQLite page deltas for database-heavy apps.
- Block-level image diffs after the operation format proves insufficient.

## Share Modes

Kandelo can choose the smallest viable mode when exporting a computer:

| Mode | Description |
|---|---|
| `preset` | Named base, packages, mount graph, boot command. No user state. |
| `inline` | Full useful state fits in the URL. |
| `delta` | Signed base plus inline compressed overlay. |
| `manifest` | URL points to a content-addressed manifest. |
| `private` | Remote ciphertext plus fragment-carried key. |
| `local` | Link references OPFS workspace names and only works in the same browser profile. |
| `recipe` | Reconstruct from package selections and deterministic setup commands. |
| `replay` | Start from clean base and replay a command transcript. |
| `live` | Connect to a collaborative or server-backed state source. |

The export UI should explain which mode was chosen and whether the link
is self-contained, content-addressed, private, or local-only.

## Security And Trust

URL-defined computers are untrusted input.

Required guardrails:

- Verify signed official bases and packages before boot.
- Hash-check every remote artifact.
- Cap compressed and decompressed overlay sizes.
- Cap mount count, file count, path length, symlink depth, and operation
  count.
- Do not allow arbitrary host filesystem mounts from shared URLs.
- Require explicit user consent for persistence, network, clipboard,
  local file handles, and other browser capabilities.
- Treat boot scripts and init commands as code execution.
- Put private decryption keys in fragments, not query strings.
- Prefer immutable remote blobs and content-addressed manifests.
- Show a manifest preview before booting powerful configurations.
- Keep official registry trust separate from user-provided artifact URLs.

## Implementation Path

1. Define the `k1` URL envelope and payload schema.
2. Implement a parser that accepts a fragment payload and returns a
   validated boot descriptor.
3. Add a small preset format for named bases, packages, mount graph, and
   boot command.
4. Add inline operation overlays for `/home/user` or another writable
   mount.
5. Add artifact references with `url`, `sha256`, size, and signature
   fields.
6. Teach browser boot code to materialize a mount graph from the
   descriptor.
7. Add a snapshot exporter that compares the current writable mounts to
   their bases and emits the smallest viable share mode.
8. Add signed base/package registry metadata.
9. Add hosted manifest support for oversized payloads.
10. Add encrypted private shares where the manifest/blob is remote and
    the decryption key stays in the fragment.

## Open Questions

- What is the first official base set: shell, Python, nginx, WordPress,
  Redis, MariaDB, LAMP?
- Should package layers be mounted directly or merged into a generated
  VFS image before boot?
- What should the signature format be: Minisign, Sigstore, TUF-style
  metadata, or a project-specific signed index?
- How much of the package-management manifest should be reused for
  runtime artifact identity?
- How should mutable service state be separated from read-only package
  layers?
- Should boot descriptors support multiple architectures in one link, or
  should links be arch-specific?
- How should OPFS-backed links communicate that they are local-only?
- Which share mode should be the default in the UI?
- What is the minimum manifest preview that gives users meaningful
  safety context without becoming noisy?
