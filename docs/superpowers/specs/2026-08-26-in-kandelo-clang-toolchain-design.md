# In-Kandelo Clang Toolchain: Package + SDK Integration Slice

Date: 2026-08-26
Status: Design approved in brainstorming; pending written-spec review
Branch context: adapting the exploration work in
`explore-compiling-code-within-kandelo-6vac2` onto the new local build
system on `main`.

## Why

Kandelo can already stage a C/C++ *sysroot* into a running machine (musl
headers and libraries, libc++, the Kandelo syscall glue, and a
guest-runnable `cc`/`c++` wrapper), but it cannot yet compile anything
inside the system: the compiler itself is missing. The guest `cc`
wrapper searches `/usr/lib/llvm/bin` for `clang` and `wasm-ld`, and the
`kandelo-sdk` VFS image creates that directory but leaves it empty.

An earlier exploration branch proved the compiler out — it hand-built an
LLVM/Clang toolchain to WebAssembly (`clang.wasm`, `wasm-ld.wasm`,
`llvm-ar/ranlib/nm.wasm`) and demonstrated in-guest C and C++
compilation. But it did so on the *old* heavyweight build system
(the large `build_deps.rs` machinery and Homebrew tap tooling) that the
recent local-build work replaced. Those binaries live untracked in that
worktree; there is no reproducible recipe for them on the current build
system, and there is no `clang` package on `main`.

This work makes the toolchain a first-class, reproducible package on the
new build system and wires it into the existing SDK image as a **lazy
reference** so that a program compiled inside Kandelo runs inside
Kandelo. It closes the gap between "we once built a clang.wasm" and
"Kandelo builds its own clang.wasm from source and can use it."

Who it affects: anyone who wants to compile C/C++ inside a Kandelo
machine (the C-development demo, and any future self-hosting work), and
maintainers who need the toolchain to rebuild through the normal
package path rather than from a lost manual procedure.

## Scope

In scope:

1. A reproducible from-source `clang` package on the new local build
   system, producing the five toolchain binary outputs.
2. A `clang-browser-bundle` package that repackages those binaries into a
   `clang.zip` **lazy VFS archive** (modelled on `vim-browser-bundle`).
3. An integration slice that registers that lazy archive into the
   `kandelo-sdk` image so the toolchain streams into `/usr/lib/llvm/bin`
   **on first use**, never baked into the base image bytes.
4. Node-side end-to-end validation: compile and run a non-forking C
   program entirely inside Kandelo, through the real lazy-archive path.
5. Recording the remaining self-hosting gaps as explicit future work.

Out of scope (recorded as future work, see "Future work"):

- The browser C-development preset, kernel-host lazy prefetch UX, and
  browser acceptance tests (the exploration branch's part (b)).
- An in-guest `wasm-fork-instrument`.
- A completely native, host-clang-free Kandelo-hosted SDK.
- The exploration branch's old build-system machinery and its 44 MB
  prebuilt binaries — byproducts of the old system, not carried over.

## Background: the runtime path that already exists

Traced on `main` (not assumed):

- `packages/registry/kandelo-sdk` builds `kandelo-sdk.vfs.zst`, an image
  that stages, into the guest: the sysroot at `/usr/wasm32posix/sysroot`,
  libc++ libraries and headers, the Kandelo glue and glue objects, clang
  builtin resource headers at `/usr/lib/llvm/lib/clang/21`, and a
  guest-runnable SDK `bin` tree copied to `/usr/bin` with
  `/usr/bin/cc -> wasm32posix-cc`, `/usr/bin/c++ -> wasm32posix-c++`.
- The guest `cc` wrapper (`sdk/kandelo/bin/wasm32posix-cc`, a
  ~20 KB self-contained bash script — no Node) resolves `clang` and
  `wasm-ld` by searching `WASM_POSIX_LLVM_DIR` then
  `/usr/lib/llvm/bin /usr/local/bin /usr/bin /bin`, and drives compile
  and link as **separate process invocations**.
- The SDK image builder creates `/usr/lib/llvm/bin` but installs nothing
  into it. That empty directory is the entire missing piece.

Two consequences follow directly:

- Because the guest `cc` wrapper forks/execs `clang` and `wasm-ld`
  itself, the compiler binaries do **not** need fork instrumentation to
  compile and link. `clang` uses its integrated `cc1` (in-process);
  `wasm-ld`, `llvm-ar/ranlib/nm` do not fork. A **non-forking** program
  compiled by in-guest clang and linked by in-guest wasm-ld against the
  staged musl + glue + crt objects will run in Kandelo.
- A **forking** *output* program still needs fork instrumentation
  applied to its wasm, which today is a host/Rust tool
  (`crates/fork-instrument`, `scripts/run-wasm-fork-instrument.sh`).
  There is no in-guest instrument yet, so a forking program compiled
  entirely in-guest cannot be made runnable until that exists. This is
  a documented boundary, not something this work hides.

## The `clang` package

Location: `packages/registry/clang/`.

### `package.toml`

- `kind = "program"`, `name = "clang"`, `version = "21.1.7"` (matches
  `libcxx@21.1.7`; the SDK's clang backend and the staged resource
  headers are the same LLVM 21 line).
- `kernel_abi = 43` (current `ABI_VERSION` in
  `crates/shared/src/lib.rs`).
- `depends_on = ["libcxx@21.1.7"]`.
- `arches = ["wasm32"]`.
- `[source]` — archive provider (see "Source acquisition").
- `[license]` — `Apache-2.0 WITH LLVM-exception`.
- `[build] script_path = "packages/registry/clang/build-clang.sh"`.
- `[[outputs]]` (five binaries): `clang` (`clang.wasm`),
  `wasm-ld` (`wasm-ld.wasm`), `llvm-ar` (`llvm-ar.wasm`),
  `llvm-ranlib` (`llvm-ranlib.wasm`), `llvm-nm` (`llvm-nm.wasm`). No
  separate `clang++` output: the guest `cc` wrapper selects C++ mode by
  its invoked basename, and the lazy-archive bundle adds a
  `bin/clang++ -> clang` symlink for direct `clang++` invocation.
- `[[host_tools]]`: `cmake` (`>=3.20`), `make` (`>=3.80`), `python3`
  (`>=3.8`), and host `clang` (`>=21.0`, for host tablegen and as the
  cross-compile backend behind the SDK wrappers) — mirroring how
  `kandelo-sdk` already declares its host clang.

### `build.toml`

- `script_path` mirrors `package.toml`.
- `inputs`: the build script, every file under
  `packages/registry/clang/patches/`, `scripts/package-build-roots.sh`,
  `scripts/install-local-binary.sh`, and `sdk/activate.sh` (plus any SDK
  source the build depends on, matching the `kandelo-sdk` input
  discipline).
- `repo_url` = the Kandelo repository, `commit = "UNPUBLISHED"`,
  `revision = 1`.
- No `[binary]` block: the remote binary channel was removed; resolution
  is local-first and the content-addressed cache serves rebuilt outputs.

### `.gitignore`

Ignore build scratch and produced artifacts (the 44 MB `clang.wasm` and
peers), following the `zlib` package pattern. Outputs are cache
artifacts, never committed to git.

## Source acquisition: archive tarball (decided)

`[source]`:

```toml
provider = "archive"
url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz"
sha256 = "<pinned from the verified download at implementation>"
```

Rationale, and the alternative that was rejected:

- The LLVM monorepo *source* release tarball already contains
  `llvm/ clang/ lld/ cmake/ third-party/` — everything the old script's
  sparse checkout pulled.
- Archive provider is content-addressed by SHA-256 through the shared
  source cache, is smaller than a full monorepo git checkout, and
  matches the existing `zlib`/`coreutils` recipes.
- The resolver stages the verified source, sealed, at
  `WASM_POSIX_DEP_SOURCE_DIR`; the recipe copies it below
  `WASM_POSIX_DEP_WORK_DIR` before modifying it. Patching therefore
  happens on a writable work-dir copy.
- Rejected: `[[git_inputs]]` (pinned exact commit). It is reproducible,
  but a full monorepo checkout is heavy and the resolver **seals the
  checkout read-only**, which would fight the in-place source patching
  the build needs. Archive sidesteps that entirely.

## `build-clang.sh`: adapt the proven script to the new contract

The exploration branch already has a complete 325-line `build-clang.sh`
(recoverable from commit `602d179e0`). Its LLVM configuration and source
patches are the hard-won, proven part and are preserved. What changes is
the host contract around it.

Adaptations:

1. **Build roots.** Replace the old `sdk/activate.sh`-only preamble and
   the writes to `local-binaries/programs/...` with the new contract:
   `source scripts/package-build-roots.sh`, call
   `kandelo_package_prepare_build_roots`, build under
   `$KANDELO_PACKAGE_WORK_DIR`, and install declared outputs through
   `scripts/install-local-binary.sh` into `WASM_POSIX_DEP_OUT_DIR`.
   (`sdk/activate.sh` is still sourced to put the worktree SDK wrappers
   on PATH.)
2. **Source staging.** Replace `ensure_llvm_source` (an unpinned
   `git clone --branch release/21.x`) with copying
   `WASM_POSIX_DEP_SOURCE_DIR` into the work dir.
3. **Patches as reviewable files.** Move the four inline `perl` source
   edits into `packages/registry/clang/patches/*.patch`, applied with
   `patch -p1`. Each patch carries a header documenting the Kandelo
   compatibility boundary it belongs to:
   - wasm `FileOutputBuffer`: Kandelo's file-backed mmap does not flush
     dirty pages back into the VFS file, so the linker output is written
     explicitly rather than via the mmap-and-rename path.
   - `random_device` removal in `ExponentialBackoff` and the ELF writer:
     the target has no `std::random_device` entropy source.
   - wasm-only `lld` driver trimming: build only the wasm linker driver,
     skipping COFF/ELF/MachO/MinGW.
   - `Path.inc` `statvfs`: return a defined result for a filesystem that
     does not expose BSD statvfs flags.
   Moving them to declared `inputs` puts them in the package cache key
   and satisfies the platform-values contract's "document the boundary"
   rule.
4. **Host tablegen.** Resolve `llvm-tblgen` and `clang-tblgen` from the
   dev-shell LLVM first; fall back to the existing from-source host
   tablegen build when they are not present.
5. **Dependency consumption.** Consume libc++ from
   `WASM_POSIX_DEP_LIBCXX_DIR` (the resolver surfaces the direct
   `libcxx` dependency there).
6. **Binary outputs only.** The `clang` package installs the five wasm
   binaries and nothing else. The lazy-archive `clang.zip` is produced by
   a separate `clang-browser-bundle` package (see "Delivery"), mirroring
   how `vim`'s binary and `vim-browser-bundle`'s `vim.zip` are split.

The toolchain binaries are non-forking, so
`WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto` is a no-op for this
package. That is stated as an observed property of these specific
binaries, not a general claim.

## Delivery: lazy VFS archive (the supported mechanism)

The toolchain must reach `/usr/lib/llvm/bin` in a running guest **without
baking the ~64 MB of compiler bytes into the base image**. The runtime
mechanism that does exactly this — already in production for `vim` and
`nethack` — is the **lazy VFS archive**: an image bakes in only an
archive's *metadata + URL + integrity hash*, and the archive's bytes
stream in on first access to any path it owns.

This corrects an earlier, unsupported design: mounting a distinct
`.vfs.zst` at a subpath via `source = "image"` does **not** work
(`restoreVerifiedImageMounts` reuses one base-image blob for every
`source:"image"` mount), and the `package-layer` overlay source is
declared in the descriptor schema but has **no materializer** in
`host/`/`kernel/`. The lazy-archive path needs no kernel, codec, or host
changes.

Concretely, mirroring the `vim` split:

- **`clang-browser-bundle` package** (`kind = "program"`,
  `depends_on = ["clang@21.1.7"]`, `provider = "repository"`,
  `[[outputs]] name = "clang" wasm = "clang.zip"`,
  `fork_instrumentation = "disabled"`). Its build script stages the five
  binaries from `WASM_POSIX_DEP_CLANG_DIR` into a tree
  (`bin/clang`, `bin/wasm-ld`, `bin/llvm-ar`, `bin/llvm-ranlib`,
  `bin/llvm-nm`, and a `bin/clang++ -> clang` symlink), builds a
  deterministic zip with `images/vfs/scripts/create-deterministic-zip.sh`,
  and installs it via `install_local_binary clang-browser-bundle
  "$archive" clang.zip`. This mirrors `packages/registry/vim-browser-bundle`
  + `images/vfs/scripts/build-vim-zip.sh`.
- **Lazy-archive spec.** Add a `clang` entry alongside the `vim`/`nethack`
  specs (`images/vfs/scripts/shell-lazy-archives.ts`): `dependency =
  "clang-browser-bundle"`, `resolverPath = "programs/wasm32/clang.zip"`,
  `archiveUrl = "clang.zip"`, `mountPrefix = "/usr/lib/llvm/"`,
  `requiredExecutable = "bin/clang"`. With that prefix, archive entry
  `bin/clang` becomes guest `/usr/lib/llvm/bin/clang` — the exact path the
  guest `cc` wrapper already searches.

## Integration slice: register the lazy archive into the SDK image

- The `kandelo-sdk` image build (`images/vfs/scripts/build-kandelo-sdk-vfs-image.ts`)
  gains a lazy-archive resolver and calls `registerDeclaredShellLazyArchive`
  for the `clang` spec, exactly as `shell-vfs-build.ts` does for
  `vim`/`nethack`. `/usr/lib/llvm/bin` stays present and empty in the
  baked image; only the clang archive's metadata + URL are recorded.
- `kandelo-sdk`'s `build.toml`/`package.toml` add `clang-browser-bundle`
  as a dependency (surfaces `WASM_POSIX_DEP_CLANG_BROWSER_BUNDLE_DIR`) and
  bump `kandelo-sdk`'s `revision`.
- The guest `cc` wrapper already searches `/usr/lib/llvm/bin`, so no
  wrapper change is needed. On the first in-guest `cc` invocation, the
  clang archive streams in and populates `/usr/lib/llvm/bin`.

This is genuine on-first-use laziness: the base SDK image carries no
compiler bytes, and the toolchain materializes only when a program is
actually compiled. Resource headers stay host-sourced
(`clang --print-resource-dir`, version-matched 21.1.7) in this slice;
sourcing them from the `clang` build is folded into the native-SDK future
item.

### Documented boundary

Running the clang *driver* directly to link
(`clang hello.c -o hello`) forks/execs the linker and will fail until an
in-guest fork-instrument exists. The supported in-guest path is through
the `cc`/`c++` wrapper, which drives compile and link as separate
processes. This is surfaced as a truthful limitation, not smoothed over.

## Validation

Evidence for the exact claim "Kandelo builds its own clang from source
and can use it to produce a Kandelo-runnable binary," on Node:

1. **Reproducible source build.** From a clean cache,
   `cargo xtask build-deps resolve clang --arch wasm32` builds the five
   `clang` binaries from the verified LLVM source; a second run is a cache
   hit. `resolve clang-browser-bundle` then produces `clang.zip`.
2. **Lazy-archive registration.** A host-side test registers the `clang`
   lazy-archive spec into a `MemoryFileSystem` and asserts the archive
   parses, the required `bin/clang` executable is present, and
   `/usr/lib/llvm/bin/*` resolve through the `mountPrefix` — modelled on
   `host/test/shell-lazy-archive-inputs.test.ts`.
3. **SDK image builds** with the clang archive registered and
   `/usr/lib/llvm/bin` still empty (no baked bytes).
4. **In-guest end-to-end (Node).** Boot the `kandelo-sdk` image on Node
   (via `NodeKernelHost` / `runCentralizedProgram`, the
   `host/test/node-host-mounts.test.ts` pattern); run
   `cc /home/hello.c -o /home/hello && /home/hello` and observe the
   expected stdout. The first `cc` triggers the lazy-archive stream — so
   this exercises the real delivery path, not a stand-in. Repeat for C++.
5. **Node/browser parity** for the *demo* is explicitly deferred to
   part (b); this spec claims Node in-guest compilation only, and says
   so.

The ABI contract is respected: outputs carry ABI 43 via the SDK
wrappers; no ABI-adjacent code changes here, so no `ABI_VERSION` bump or
snapshot regeneration is expected. If any toolchain-facing ABI surface
turns out to change during implementation, that is a stop-and-bump
event.

## Future work (recorded explicitly)

1. **Completely native Kandelo-hosted SDK.** Remove the host-clang / Nix
   dependence from the SDK path: source clang builtin resource headers
   from the `clang` package instead of `clang --print-resource-dir`, and
   run the SDK image build and instrumentation in-guest, so the
   toolchain self-hosts end to end.
2. **In-guest `wasm-fork-instrument`.** Port `crates/fork-instrument` /
   `scripts/run-wasm-fork-instrument.sh` to run inside Kandelo, so
   forking programs compiled in-guest become runnable and the clang
   driver can self-link without a host round-trip.
3. **Browser preset + demo delivery (part (b)).** Port the exploration
   branch's C-development preset, its prebaked C-dev image (base shell +
   SDK sysroot/wrapper + the clang lazy archive), and browser acceptance
   tests onto the current session/host code, and verify with
   `./run.sh browser`. This is where Node/browser demo parity lands.
4. **`package-layer` materializer (URL-shareable toolchain layer).** The
   descriptor schema already defines a `package-layer` mount source that
   composes up to 8 overlays at `/`, but no host/browser code materializes
   it (design-doc step 6 in
   `docs/plans/2026-05-11-shareable-computer-url-design.md`). Implementing
   it would let a toolchain layer be carried in a shareable boot URL,
   independent of the prebaked image. Not required for in-guest
   compilation; recorded for completeness.

These are recorded as `project` memories in the agent memory store in
addition to this section, so they survive across sessions.
