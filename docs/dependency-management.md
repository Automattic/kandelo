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

## Source-kind manifests

V2 introduces `kind = "source"` for declaring source trees that
consumers vendor or sub-build but that we do **not** publish as
standalone library or program artifacts. Typical cases:

- **PCRE2 inside MariaDB** — MariaDB's CMake expects to compile
  PCRE2 against its own internal headers and link statically into
  `mariadbd`. The PCRE2 sources are unpacked once into a shared
  cache and reused across MariaDB rebuilds.
- **PHP extensions** — extensions live in PHP's source tree and
  link into the PHP build, not as separate libs.
- **Erlang vendored code** — OTP ships several third-party libs
  inside its own tarball; they are arch-agnostic at the source
  level.

Source manifests are arch-agnostic and ABI-agnostic — they describe
unpacked source trees, not built artifacts.

**Schema fields**

Required:
- `kind = "source"`
- `name`, `version`, `revision`
- `[source].url`, `[source].sha256`
- `[license].spdx`

Optional:
- `depends_on` — same syntax as library/program manifests.
- `[build].script` — see "Override" below.
- `[[host_tools]]` — see the Host-tool requirements section below.

Rejected at parse time (the parser surfaces a clear error):
- `[outputs]` and `[[outputs]]` — sources have no built-artifact
  layout.
- `[binary]` and `[compatibility]` — those describe published
  binaries; sources are not published.

**Default fetch+extract behavior**

When `[build].script` is absent, the resolver fetches `source.url`,
verifies `source.sha256`, and extracts in-place. Format detection
is by URL extension: `.tar.gz` / `.tgz`, `.tar.xz` / `.txz`,
`.tar.bz2` / `.tbz2` / `.tbz`, `.tar.zst` / `.tzst`, `.zip`, and
plain `.tar`. Unrecognized extensions fail loudly rather than
guessing.

If the archive contains a single top-level directory (the
`pcre2-10.42/` shape), that wrapper is stripped — the cache
directory's contents are the contents of that single top-level
directory. Multi-top-level archives are kept as-is.

**Override `[build].script`**

When the default extract is not enough (patches, code generation,
in-tree configure), declare a script. The contract is the same as
library and program builds: the script reads the same
`WASM_POSIX_DEP_*` environment variables, installs into
`$WASM_POSIX_DEP_OUT_DIR`, and the resolver fails the build if
`OUT_DIR` is empty after the script returns.

**Cache layout**

```
<cache_root>/sources/<name>-<version>-rev<N>-<shortsha>/
```

No `<arch>` segment — sources are arch-agnostic by definition.
That is the visible difference from the `libs/` and `programs/`
cache trees.

**Direct-dep env var: `_SRC_DIR`**

A consumer (lib, program, or another source) listing a source-kind
manifest in `depends_on` gets `WASM_POSIX_DEP_<NAME>_SRC_DIR`
exported into its build script. The `_SRC_DIR` suffix (vs `_DIR`
for library/program deps) is the contract: scripts pointing at a
source dep know they receive an unpacked source tree, not a
built-artifact prefix.

See decisions 9 (kind discriminator) and 12 (default fetch+extract)
in `docs/plans/2026-04-22-deps-management-v2-design.md`.

## Host-tool requirements

V2 lets a manifest declare host-side prerequisites — `cmake`,
`make`, `patch`, `autoconf`, etc. — inline. The resolver probes
each one before invoking the build script, so a missing or
too-old tool fails up front with a platform-keyed install hint
rather than mid-build with a cryptic shell error.

**Inline declaration**

`[[host_tools]]` is an array-of-tables on the consumer manifest
(library, program, or source):

```toml
[[host_tools]]
name = "cmake"
version_constraint = ">=3.20"

[host_tools.probe]
args = ["--version"]
version_regex = '(\d+\.\d+(?:\.\d+)?)'

[host_tools.install_hints]
darwin = "brew install cmake"
linux = "apt install cmake (or your distro's equivalent)"
```

Per-entry fields:

- **`name`** (required) — executable name resolved against `PATH`.
- **`version_constraint`** (required) — see syntax below.
- **`probe`** (optional) — overrides the defaults below.
- **`install_hints`** (optional) — platform-keyed help strings,
  printed verbatim when the probe fails.

**Probe defaults**

If `probe` is omitted, the resolver uses:

- `args = ["--version"]`
- `version_regex = (\d+\.\d+(?:\.\d+)?)`

It runs `<name> <args...>`, captures combined stdout+stderr (some
tools print their version to stderr), matches against
`version_regex`, and parses capture group 1 as a numeric version
(`major.minor` or `major.minor.patch`).

**Version-constraint syntax**

Only `>=X.Y` and `>=X.Y.Z` are accepted. The parser rejects
anything else at manifest-load time:

- Other operators (`>`, `<`, `==`, `^`, `~`).
- Compound constraints (`>=3.20,<4.0`).
- Prerelease or build-metadata suffixes (`>=3.20.0-rc1`,
  `>=3.20.0+build5`).

Comparison is **numeric**, not lexicographic — `3.20` is greater
than `3.9`, never less.

**`install_hints` platform keys**

Use unix-style names. `darwin` matches `uname -s` on macOS;
`linux`, `windows`, and `freebsd` are the other recognised keys.
The resolver maps Rust's `target_os = "macos"` to the user-facing
key `darwin` so manifest authors don't have to think about
Rust-specific naming.

**Cache-key impact: zero**

Host-tool declarations do **not** contribute to the consumer's
cache-key sha. A `cmake` upgrade on a developer machine does not
invalidate the MariaDB cache entry. If a tool change actually
affects build output (a new compiler bug-fix that changes
generated code, say), bump the consumer's `revision` — that is
the existing knob. See decision 10.

**`xtask build-deps check`**

The `check` subcommand lints cross-consumer consistency: if two
manifests declare the same host-tool `name` with different
`version_constraint` or different `probe` settings, `check`
reports it. The intent is to keep the project's host-toolchain
floor coherent — one project-wide minimum per tool — without
forcing a single shared declaration file.

See decisions 10 (cache-key impact) and 11 (probe + install hint
contract) in `docs/plans/2026-04-22-deps-management-v2-design.md`.

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
