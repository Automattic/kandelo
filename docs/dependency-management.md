# Dependency management (Wasm libraries)

How we declare, build, and cache the static libraries our ported
programs link against (zlib, ncurses, openssl, libcurl, libxml2,
libpng, sqlite — and third-party additions).

**Status**: V1, stacked on the binaries release/hosting work
(PR #298). The schema and `cargo xtask build-deps` resolver are in
place; consumer build-scripts migrate lib-by-lib.

**Scope**: static-library artifacts only. Programs continue to
statically link; this work caches the `.a` files + headers, not the
linked binaries. Runtime `.so` loading is intentionally future work —
see "Out of scope" below.

## Why

The previous state: each program's `build-<prog>.sh` called its
prerequisite lib build scripts explicitly, everything installed into
`sysroot/`, and rebuilding one program re-ran every dep from source.
That worked when we had two or three libs. Now that 7+ libs back 20+
programs, we need:

- rebuilding one program not to rebuild its deps from source;
- explicit dep ordering, not convention-by-script;
- third parties bringing their own packages without patching this
  repo;
- lib artifacts shipped alongside programs in the binaries release
  and unpacked into a shared cache on fetch;
- rebuild-in-progress in one worktree not to corrupt a sibling
  worktree's read of the same cached lib.

## Schema: `deps.toml`

Every library declares one `deps.toml` file, next to its build script:

```
examples/libs/zlib/
    deps.toml              ← declares the lib
    build-zlib.sh          ← builds it (invoked by the resolver)
```

Required fields:

```toml
name = "zlib"              # logical library name
version = "1.3.1"          # upstream version
revision = 1               # our build revision; bump when build/config changes
depends_on = []            # ["zlib@1.3.1", ...] — exact versions, no ranges

[source]
url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
sha256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"

[license]
spdx = "Zlib"              # SPDX identifier
url = "https://github.com/madler/zlib/blob/v1.3.1/LICENSE"  # optional
```

Optional sections:

```toml
[build]
script = "build-zlib.sh"   # default: build-<name>.sh in this directory

[outputs]
libs = ["lib/libz.a"]                            # must exist post-build
headers = ["include/zlib.h", "include/zconf.h"]
pkgconfig = ["lib/pkgconfig/zlib.pc"]
```

**Keep top-level arrays (`depends_on`, etc.) above the first `[section]`.**
TOML binds a bare key inside whatever section most recently opened; a
key placed after `[license]` ends up as `license.depends_on`, which
silently parses to an empty top-level list. The resolver documents
this inline but the parser cannot detect the mistake.

## Versions are exact in V1

`depends_on = ["ncurses@6.5"]` — no semver ranges, no resolver.
If two consumers of the graph ever need different versions of the
same lib, we revisit. Noted as future work; not a V1 commitment.

## Cache-key hashing

The cache-key sha for a library is computed over
`(name, version, revision, source.url, source.sha256, sorted
transitive dep cache-key shas)`. That means:

- Same inputs → same sha → same cache path → shared artifact.
- Any change in the tree (including a distant transitive dep) invalidates
  every downstream consumer. No silent staleness.
- `revision` is the knob for "same upstream, different flags": bump
  it when the build script or cross-compile config changes in a way
  that affects the output.

Inspect:

```bash
cargo xtask build-deps sha     zlib   # → 9acb9405ef818905a193…
cargo xtask build-deps path    zlib   # → ~/.cache/wasm-posix-kernel/libs/zlib-1.3.1-rev1-9acb9405
cargo xtask build-deps parse   zlib   # → normalized dump of deps.toml
cargo xtask build-deps resolve zlib   # → build-if-needed, then print the path
```

## Resolution order

`resolve <name>` walks the dep graph depth-first. For each library
in turn, it checks:

1. **`<repo>/local-libs/<name>/build/`** — hand-patched, in-progress.
   Returned as-is; the build script never runs. Per-worktree,
   gitignored. Mirrors `local-binaries/`.
2. **`<cache_root>/libs/<name>-<ver>-rev<N>-<shortsha>/`** — canonical
   cache. Trusted by presence: users invalidate by deleting the
   directory or bumping `revision`.
3. **Build from source** — run the declared `build.script`, validate
   declared outputs, atomically install into the canonical cache.

`cache_root` is `$XDG_CACHE_HOME/wasm-posix-kernel` if set, else
`$HOME/.cache/wasm-posix-kernel`.

## Build-script contract

The build script runs with these environment variables set. A script
that doesn't respect them cannot be cached safely.

| Variable | Meaning |
|---|---|
| `WASM_POSIX_DEP_OUT_DIR` | Temp dir the script must install into. Layout matches `outputs.libs` / `outputs.headers` / `outputs.pkgconfig` relative paths. |
| `WASM_POSIX_DEP_NAME` | `name` from deps.toml. |
| `WASM_POSIX_DEP_VERSION` | `version` from deps.toml. |
| `WASM_POSIX_DEP_REVISION` | `revision` from deps.toml. |
| `WASM_POSIX_DEP_SOURCE_URL` | Upstream tarball URL (`source.url` from deps.toml). |
| `WASM_POSIX_DEP_SOURCE_SHA256` | Expected sha256 of the downloaded tarball. Scripts **must** verify after download — the resolver does not fetch. |
| `WASM_POSIX_DEP_<UPPER>_DIR` | For each *direct* dep, the resolved path to that dep's build output. `<UPPER>` is the dep name upper-cased, with `-` → `_` (e.g. `zlib-ng` → `ZLIB_NG`). Transitive deps are not surfaced — scripts that need them should declare them in `depends_on`. |

After the script exits 0, the resolver verifies every path in
`outputs.{libs,headers,pkgconfig}` exists under `$WASM_POSIX_DEP_OUT_DIR`.
A missing output fails the build (and the temp dir is cleaned up,
so a retry starts clean).

## Atomic cache install

The script builds into `<canonical>.tmp-<pid>/`, not the final path.
On success the resolver calls `rename(2)` from temp to final. Readers
in other worktrees either see the full previous version of the cache
entry or the full new one — never a partial write.

If two builds of the same cache key race, the first `rename` wins.
The second notices the canonical path exists and discards its own
temp dir. Identical inputs yield identical outputs, so keeping either
copy is correct.

A crashed build (process killed mid-script) leaves its `.tmp-<pid>/`
behind. The next resolve of the same key starts a fresh temp with a
new pid — no conflict — and the leftover is harmless until manually
pruned. A future `xtask clean-deps` subcommand can sweep them.

## Registry search path

By default the resolver looks in `<repo>/examples/libs/`. Override:

```bash
WASM_POSIX_DEPS_REGISTRY="./examples/libs:~/my-wasm-packages" \
    cargo xtask build-deps sha vim
```

Colon-separated. First hit wins — later entries have lower priority,
like `$PATH`. This is how third parties bring their own packages
without patching the repo: they drop a `<lib>/deps.toml` into their
own directory tree and prepend it to the registry path.

## Out of scope for V1

- **Runtime shared `.so` libraries**: evaluated but rejected. Current
  programs static-link everything; switching to dynamic loading across
  every demo is bigger architecture than caching warrants. A follow-up
  PR can add `.so` support on top of the same graph + cache, when the
  binary-bloat savings justify the dlopen complexity.
- **Semver ranges**: exact-pinning only. Adding a resolver that picks
  one version per lib across the overall graph is real work; we punt
  until two V1 consumers actually conflict.
- **CI-driven dep builds**: deps are built manually and published
  manually via `publish-release.sh`.
