# In-Kandelo Clang Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kandelo build its own LLVM/Clang WebAssembly toolchain from
source on the new local build system and deliver it into a running guest
as a lazy VFS archive, so a C/C++ program compiles and runs entirely
inside Kandelo.

**Architecture:** A `clang` package cross-builds `clang`, `wasm-ld`, and
`llvm-{ar,ranlib,nm}` to wasm32 using the worktree SDK wrappers and a host
tablegen. A `clang-browser-bundle` package repackages those binaries into
`clang.zip`. The `kandelo-sdk` image registers that zip as a lazy VFS
archive (the `vim`/`nethack` mechanism), so its bytes stream into
`/usr/lib/llvm/bin` on first `cc` invocation — the path the guest `cc`
wrapper already searches — without baking compiler bytes into the base
image.

**Tech Stack:** Bash build scripts, CMake + Unix Makefiles, LLVM 21.1.7,
the Kandelo `cargo xtask build-deps` resolver, TypeScript VFS image
builders, Vitest (Node host tests), `scripts/dev-shell.sh` (Nix).

**Spec:** `docs/superpowers/specs/2026-08-26-in-kandelo-clang-toolchain-design.md`

## Global Constraints

- LLVM/Clang version is exactly **21.1.7** (matches `libcxx@21.1.7`);
  every version string and the clang major (`21`) derive from it.
- Target ABI is **43** (`ABI_VERSION` in `crates/shared/src/lib.rs`); set
  `kernel_abi = 43` in every new `package.toml`.
- Target arch is **wasm32** only (`arches = ["wasm32"]`).
- `package.toml` must **not** contain `revision`, `[build].repo_url`, or
  `[build].commit` — those live only in `build.toml`, or the manifest is
  rejected (`tools/xtask/src/pkg_manifest.rs:1541-1552`).
- `install_local_binary <package> <source> [declared-artifact]` installs
  **one** artifact per call; call it once per `[[outputs]]` entry, passing
  the exact declared `wasm` path as the third argument.
- Source acquisition uses `provider = "archive"` with a pinned nonzero
  lowercase SHA-256; the resolver stages verified bytes at
  `WASM_POSIX_DEP_SOURCE_DIR` and the script must copy them under
  `WASM_POSIX_DEP_WORK_DIR` before modifying.
- All build/verify commands run through `scripts/dev-shell.sh` (Nix dev
  shell), never undeclared host tools.
- New packages are auto-discovered by directory scan; no central manifest
  edit is needed to register one.
- Do not commit build scratch or built artifacts (the ~44 MB `clang.wasm`,
  the `clang.zip`); `.gitignore` them per the `zlib` pattern.

---

### Task 1: Scaffold the `clang` package manifest and pin the source

**Files:**
- Create: `packages/registry/clang/package.toml`
- Create: `packages/registry/clang/build.toml`
- Create: `packages/registry/clang/.gitignore`

**Interfaces:**
- Produces: a registry package named `clang@21.1.7`, `kind = "program"`,
  outputs `clang.wasm`, `wasm-ld.wasm`, `llvm-ar.wasm`,
  `llvm-ranlib.wasm`, `llvm-nm.wasm`; consumed by Tasks 3–4 and by
  `clang-browser-bundle` (Task 4) via `depends_on`.

- [ ] **Step 1: Pin the LLVM source SHA-256**

Run (in the dev shell) and record the digest:

```bash
scripts/dev-shell.sh bash -lc '
  url="https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz"
  curl -fL "$url" -o /tmp/llvm-21.1.7.src.tar.xz
  shasum -a 256 /tmp/llvm-21.1.7.src.tar.xz
'
```

Use the printed 64-char lowercase hex as `<LLVM_SHA256>` below. Keep the
downloaded tarball at `/tmp/llvm-21.1.7.src.tar.xz` for Task 2.

- [ ] **Step 2: Write `packages/registry/clang/package.toml`**

```toml
kind = "program"
name = "clang"
version = "21.1.7"
kernel_abi = 43
depends_on = ["libcxx@21.1.7"]
arches = ["wasm32"]

[source]
url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz"
sha256 = "<LLVM_SHA256>"
provider = "archive"

[license]
spdx = "Apache-2.0 WITH LLVM-exception"
url = "https://github.com/llvm/llvm-project/blob/llvmorg-21.1.7/LICENSE.TXT"

[build]
script_path = "packages/registry/clang/build-clang.sh"

[[outputs]]
name = "clang"
wasm = "clang.wasm"

[[outputs]]
name = "wasm-ld"
wasm = "wasm-ld.wasm"

[[outputs]]
name = "llvm-ar"
wasm = "llvm-ar.wasm"

[[outputs]]
name = "llvm-ranlib"
wasm = "llvm-ranlib.wasm"

[[outputs]]
name = "llvm-nm"
wasm = "llvm-nm.wasm"

[[host_tools]]
name = "cmake"
version_constraint = ">=3.20"
probe = { args = ["--version"], version_regex = "cmake version (\\d+\\.\\d+(?:\\.\\d+)?)" }
install_hints = { darwin = "run through scripts/dev-shell.sh", linux = "run through scripts/dev-shell.sh" }

[[host_tools]]
name = "make"
version_constraint = ">=3.80"
probe = { args = ["--version"], version_regex = "GNU Make (\\d+\\.\\d+(?:\\.\\d+)?)" }
install_hints = { darwin = "run through scripts/dev-shell.sh", linux = "run through scripts/dev-shell.sh" }

[[host_tools]]
name = "python3"
version_constraint = ">=3.8"
probe = { args = ["--version"], version_regex = "Python (\\d+\\.\\d+(?:\\.\\d+)?)" }
install_hints = { darwin = "run through scripts/dev-shell.sh", linux = "run through scripts/dev-shell.sh" }

[[host_tools]]
name = "clang"
version_constraint = ">=21.0"
probe = { args = ["--version"], version_regex = "clang version (\\d+\\.\\d+(?:\\.\\d+)?)" }
install_hints = { darwin = "run through scripts/dev-shell.sh", linux = "run through scripts/dev-shell.sh" }
```

- [ ] **Step 3: Write `packages/registry/clang/build.toml`**

```toml
script_path = "packages/registry/clang/build-clang.sh"
inputs = [
  "packages/registry/clang/build-clang.sh",
  "packages/registry/clang/patches/0001-wasm-fileoutputbuffer-explicit-write.patch",
  "packages/registry/clang/patches/0002-remove-random-device.patch",
  "packages/registry/clang/patches/0003-wasm-only-lld-driver.patch",
  "packages/registry/clang/patches/0004-wasm-path-statvfs.patch",
  "scripts/package-build-roots.sh",
  "scripts/install-local-binary.sh",
  "sdk/activate.sh",
]
repo_url    = "https://github.com/Automattic/kandelo.git"
commit      = "UNPUBLISHED"
revision    = 1
```

- [ ] **Step 4: Write `packages/registry/clang/.gitignore`**

```gitignore
# Build scratch and produced artifacts are cache outputs, never committed.
/bin/
/build-*/
/llvm-project-*/
/clang-work/
*.wasm
*.zip
```

- [ ] **Step 5: Verify the manifest parses**

Run:
```bash
scripts/dev-shell.sh bash -lc '
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  cargo run -p xtask --target "$host_target" -- build-deps parse clang
'
```
Expected: prints the parsed manifest (name `clang`, version `21.1.7`, five
outputs) and exits 0. If it errors about `revision`/`repo_url`/`commit`,
they were placed in `package.toml` — remove them.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/clang/package.toml packages/registry/clang/build.toml packages/registry/clang/.gitignore
git commit -m "Packages: scaffold clang toolchain package manifest"
```

---

### Task 2: Extract the LLVM source patches into reviewable `.patch` files

The old `build-clang.sh` (commit `602d179e0`) patched LLVM in place with
`perl`. The read-only source-staging contract and reviewability both want
real patch files. This task regenerates them once from the perl transforms.

**Files:**
- Create: `packages/registry/clang/patches/0001-wasm-fileoutputbuffer-explicit-write.patch`
- Create: `packages/registry/clang/patches/0002-remove-random-device.patch`
- Create: `packages/registry/clang/patches/0003-wasm-only-lld-driver.patch`
- Create: `packages/registry/clang/patches/0004-wasm-path-statvfs.patch`

**Interfaces:**
- Produces: four `-p1` patches that apply cleanly to an extracted
  `llvm-project-21.1.7.src` tree; consumed by `build-clang.sh` (Task 3).

- [ ] **Step 1: Extract a pristine source tree and snapshot it**

```bash
cd /tmp
rm -rf llvm-project-21.1.7.src llvm-pristine
tar xf /tmp/llvm-21.1.7.src.tar.xz
cp -a llvm-project-21.1.7.src llvm-pristine
```

- [ ] **Step 2: Recover and run the historical perl transforms**

Retrieve the `patch_llvm_source` function body from the old script and run
its perl edits against `/tmp/llvm-project-21.1.7.src`:

```bash
git -C /Users/brandon/emdash/worktrees/Kandelo/emdash/explore-compiling-code-within-kandelo-6vac2 \
  show 602d179e0:packages/registry/clang/build-clang.sh > /tmp/old-build-clang.sh
# Copy the perl edits from patch_llvm_source() in /tmp/old-build-clang.sh,
# pointing LLVM_SRC_DIR at /tmp/llvm-project-21.1.7.src, and run them once.
```

The four boundaries the perl edits implement (verify each landed by
grepping the files named in the old script):
1. `llvm/lib/Support/FileOutputBuffer.cpp` — explicit-write path for wasm
   (Kandelo mmap does not flush dirty pages to the VFS file).
2. `llvm/include/llvm/Support/ExponentialBackoff.h` +
   `llvm/lib/Support/ExponentialBackoff.cpp` + `lld/ELF/Writer.cpp` —
   remove `std::random_device` (no entropy source on target).
3. `lld/CMakeLists.txt` + `lld/tools/lld/CMakeLists.txt` +
   `lld/tools/lld/lld.cpp` — wasm-only lld driver (skip COFF/ELF/MachO/
   MinGW).
4. `llvm/lib/Support/Unix/Path.inc` — defined `statvfs` result for the
   Kandelo VFS.

- [ ] **Step 3: Generate the four patch files by grouped diff**

```bash
cd /tmp
mkdir -p /Users/brandon/conductor/workspaces/kandelo/austin/packages/registry/clang/patches
diff -ruN llvm-pristine/llvm/lib/Support/FileOutputBuffer.cpp \
          llvm-project-21.1.7.src/llvm/lib/Support/FileOutputBuffer.cpp \
  | sed 's#llvm-pristine/#a/#; s#llvm-project-21.1.7.src/#b/#' \
  > .../patches/0001-wasm-fileoutputbuffer-explicit-write.patch
```

Repeat, grouping the files per boundary above into `0002`, `0003`, `0004`.
Prepend each patch with a comment header naming the Kandelo compatibility
boundary it belongs to (per the platform-values contract). Ensure paths
are `a/…` `b/…` so `patch -p1` applies from the source root.

- [ ] **Step 4: Verify the patches apply cleanly to a fresh extraction**

```bash
cd /tmp && rm -rf verify && mkdir verify && cd verify
tar xf /tmp/llvm-21.1.7.src.tar.xz
cd llvm-project-21.1.7.src
for p in 0001 0002 0003 0004; do
  patch -p1 --dry-run < /Users/brandon/conductor/workspaces/kandelo/austin/packages/registry/clang/patches/${p}-*.patch \
    || { echo "PATCH $p FAILED"; exit 1; }
done
echo "all patches apply"
```
Expected: `all patches apply`.

- [ ] **Step 5: Commit**

```bash
git add packages/registry/clang/patches/
git commit -m "Packages: add reviewable clang wasm source patches"
```

---

### Task 3: Adapt `build-clang.sh` to the new build contract and build it

**Files:**
- Create: `packages/registry/clang/build-clang.sh`

**Interfaces:**
- Consumes: `WASM_POSIX_DEP_SOURCE_DIR` (staged LLVM source),
  `WASM_POSIX_DEP_LIBCXX_DIR` (libc++), `WASM_POSIX_DEP_WORK_DIR`,
  `WASM_POSIX_DEP_OUT_DIR`, the four patches from Task 2, the worktree SDK
  (`wasm32posix-cc/c++/ar/ranlib/nm`).
- Produces: `$WASM_POSIX_DEP_OUT_DIR/{clang,wasm-ld,llvm-ar,llvm-ranlib,llvm-nm}.wasm`.

- [ ] **Step 1: Write the build script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Cross-build clang, wasm-ld, and llvm-{ar,ranlib,nm} to wasm32 for Kandelo.
# Preserves the proven LLVM CMake configuration from the exploration branch;
# adapts the host contract to the new local build system.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/clang-work" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
LLVM_MAJOR=21
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-<LLVM_SHA256>}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

LLVM_SRC_DIR="$WORK_DIR/llvm-project-${LLVM_MAJOR}"
HOST_BUILD_DIR="$WORK_DIR/build-host-tablegen-${LLVM_MAJOR}"
BUILD_DIR="$WORK_DIR/build-wasm32"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

[ "$ARCH" = wasm32 ] || { echo "ERROR: clang supports wasm32 only" >&2; exit 1; }
[ -f "$SYSROOT/lib/libc.a" ] || { echo "ERROR: sysroot missing; run scripts/build-musl.sh" >&2; exit 1; }
command -v wasm32posix-c++ >/dev/null || { echo "ERROR: SDK wrappers not on PATH" >&2; exit 1; }

# libc++ from the resolved dependency; fall back to an in-sysroot copy.
if [ -z "$LIBCXX_DIR" ] && [ -f "$SYSROOT/lib/libc++.a" ]; then LIBCXX_DIR="$SYSROOT"; fi
[ -f "$LIBCXX_DIR/lib/libc++.a" ] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }

CC_TOOL="$(command -v wasm32posix-cc)"
CXX_TOOL="$(command -v wasm32posix-c++)"
AR_TOOL="$(command -v wasm32posix-ar)"
RANLIB_TOOL="$(command -v wasm32posix-ranlib)"
NM_TOOL="$(command -v wasm32posix-nm)"

# --- Stage verified LLVM source into the writable work dir ---
if [ ! -f "$LLVM_SRC_DIR/llvm/CMakeLists.txt" ]; then
  echo "==> Staging verified LLVM ${LLVM_MAJOR} source..."
  kandelo_package_stage_verified_source clang "$LLVM_SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

  echo "==> Applying Kandelo wasm patches..."
  for p in "$SCRIPT_DIR"/patches/*.patch; do
    patch -p1 -d "$LLVM_SRC_DIR" < "$p"
  done
fi

# --- Host tablegen: prefer dev-shell LLVM, else build from source ---
find_host_tool() {
  local name="$1" c
  for c in "${WASM_POSIX_LLVM_DIR:-}/$name" "$HOST_BUILD_DIR/bin/$name" "$(command -v "$name" 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
LLVM_TABLEGEN_BIN="$(find_host_tool llvm-tblgen || true)"
CLANG_TABLEGEN_BIN="$(find_host_tool clang-tblgen || true)"
if [ -z "$LLVM_TABLEGEN_BIN" ] || [ -z "$CLANG_TABLEGEN_BIN" ]; then
  echo "==> Building host llvm-tblgen and clang-tblgen..."
  cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/llvm" -B "$HOST_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release -DLLVM_ENABLE_PROJECTS="clang" \
    -DLLVM_TARGETS_TO_BUILD="WebAssembly" -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF 2>&1 | tail -20
  cmake --build "$HOST_BUILD_DIR" --target llvm-tblgen clang-tblgen \
    -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -20
  LLVM_TABLEGEN_BIN="$HOST_BUILD_DIR/bin/llvm-tblgen"
  CLANG_TABLEGEN_BIN="$HOST_BUILD_DIR/bin/clang-tblgen"
fi

# --- Configure the wasm32 cross build (verbatim from the proven recipe) ---
COMMON_FLAGS=(-O1 -g0 -fno-exceptions -fno-rtti -DCLANG_BUILD_STATIC -DLLVM_BUILD_STATIC -DLLVM_ON_UNIX=1)
LINK_FLAGS=("$LIBCXX_DIR/lib/libc++.a" "$LIBCXX_DIR/lib/libc++abi.a")

cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/llvm" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_SYSTEM_NAME=Generic \
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_C_COMPILER="$CC_TOOL" -DCMAKE_CXX_COMPILER="$CXX_TOOL" \
  -DCMAKE_AR="$AR_TOOL" -DCMAKE_RANLIB="$RANLIB_TOOL" -DCMAKE_NM="$NM_TOOL" \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_FLAGS="${COMMON_FLAGS[*]}" -DCMAKE_CXX_FLAGS="${COMMON_FLAGS[*]}" \
  -DCMAKE_EXE_LINKER_FLAGS="${LINK_FLAGS[*]}" \
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY \
  -DLLVM_TABLEGEN="$LLVM_TABLEGEN_BIN" -DCLANG_TABLEGEN="$CLANG_TABLEGEN_BIN" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_BUILD_TOOLS=ON -DLLVM_INCLUDE_TOOLS=ON -DLLVM_INCLUDE_UTILS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_DIA_SDK=OFF \
  -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBCXX=ON -DLLVM_BUILD_LLVM_DYLIB=OFF -DLLVM_LINK_LLVM_DYLIB=OFF \
  -DBUILD_SHARED_LIBS=OFF -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_PLUGIN_SUPPORT=OFF \
  2>&1 | tail -40

echo "==> Building clang tools..."
cmake --build "$BUILD_DIR" --target clang lld llvm-ar llvm-ranlib llvm-nm \
  -j"${KANDELO_CLANG_BUILD_JOBS:-1}" 2>&1 | tail -40

# --- Install the five declared outputs ---
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary clang "$BUILD_DIR/bin/clang"        clang.wasm
install_local_binary clang "$BUILD_DIR/bin/wasm-ld"      wasm-ld.wasm
install_local_binary clang "$BUILD_DIR/bin/llvm-ar"      llvm-ar.wasm
install_local_binary clang "$BUILD_DIR/bin/llvm-ranlib"  llvm-ranlib.wasm
install_local_binary clang "$BUILD_DIR/bin/llvm-nm"      llvm-nm.wasm

echo "==> clang package build complete."
```

Replace `<LLVM_SHA256>` with the digest from Task 1. `chmod +x` the file.

- [ ] **Step 2: Build the package from source**

```bash
scripts/dev-shell.sh bash -lc '
  set -euo pipefail
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  cargo run -p xtask --target "$host_target" -- build-deps resolve clang --arch wasm32
'
```
Expected: prints the resolved cache dir and exits 0. (Note: this compiles
LLVM and can take a long time.)

- [ ] **Step 3: Verify the five wasm outputs exist and are wasm**

```bash
scripts/dev-shell.sh bash -lc '
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  dir=$(cargo run -p xtask --target "$host_target" -- build-deps resolve clang --arch wasm32)
  for f in clang wasm-ld llvm-ar llvm-ranlib llvm-nm; do
    test -f "$dir/$f.wasm" || { echo "MISSING $f.wasm"; exit 1; }
    head -c4 "$dir/$f.wasm" | xxd | grep -q "0061 736d" || { echo "$f.wasm not wasm"; exit 1; }
  done
  echo "all five wasm outputs present"
'
```
Expected: `all five wasm outputs present`.

- [ ] **Step 4: Verify a no-op rebuild is a cache hit**

Re-run Step 2. Expected: returns near-instantly (cache hit), no rebuild.

- [ ] **Step 5: Commit**

```bash
git add packages/registry/clang/build-clang.sh
git commit -m "Packages: build clang wasm toolchain from source on local-build"
```

---

> **SUPERSEDED (2026-08-27):** Tasks 4–6 below were revised during
> execution per a user directive. The toolchain is delivered as a SINGLE
> lazy VFS archive (`kandelo-sdk-browser-bundle` → `kandelo-sdk.zip`,
> containing the compiler binaries AND the sysroot/wrapper/headers/glue)
> registered in the BASE SHELL demo image — not a separate
> `clang-browser-bundle` nor a dedicated SDK image. The authoritative
> revised Task 4–6 definitions live in the SDD ledger
> (`.superpowers/sdd/2026-08-27-in-kandelo-clang-toolchain/progress.md`,
> "REVISED T5-6 DESIGN" + "SINGLE-BUNDLE RESTRUCTURE"). Tasks 1–3 above
> are unchanged and complete. The text below is kept for history.

### Task 4: `clang-browser-bundle` package + deterministic zip builder

**Files:**
- Create: `packages/registry/clang-browser-bundle/package.toml`
- Create: `packages/registry/clang-browser-bundle/build.toml`
- Create: `packages/registry/clang-browser-bundle/build-clang-browser-bundle.sh`
- Create: `images/vfs/scripts/build-clang-zip.sh`

**Interfaces:**
- Consumes: `WASM_POSIX_DEP_CLANG_DIR` (the five wasm binaries from Task 3).
- Produces: package `clang-browser-bundle@21.1.7` with output
  `clang.zip`, whose entries are `bin/clang`, `bin/wasm-ld`,
  `bin/llvm-ar`, `bin/llvm-ranlib`, `bin/llvm-nm`, and a
  `bin/clang++ -> clang` symlink. Consumed by Task 5.

- [ ] **Step 1: `images/vfs/scripts/build-clang-zip.sh`**

Model on `images/vfs/scripts/build-vim-zip.sh`. Two-arg form
`<clang-dir> <output.zip>` stages the tree and zips it deterministically:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLANG_DIR="$1"
OUTPUT_FILE="$2"

for f in clang wasm-ld llvm-ar llvm-ranlib llvm-nm; do
  test -f "$CLANG_DIR/$f.wasm" || { echo "missing $f.wasm in $CLANG_DIR" >&2; exit 1; }
done

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
  STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/clang-zip.XXXXXX")"
else
  STAGING="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING"' EXIT

mkdir -p "$STAGING/bin"
# Store binaries with no .wasm extension, matching the VFS bin/ layout.
for f in clang wasm-ld llvm-ar llvm-ranlib llvm-nm; do
  cp "$CLANG_DIR/$f.wasm" "$STAGING/bin/$f"
  chmod 755 "$STAGING/bin/$f"
done
ln -s clang "$STAGING/bin/clang++"

mkdir -p "$(dirname "$OUTPUT_FILE")"
rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
ls -lh "$OUTPUT_FILE"
```

- [ ] **Step 2: `packages/registry/clang-browser-bundle/package.toml`**

```toml
kind = "program"
name = "clang-browser-bundle"
version = "21.1.7"
kernel_abi = 43
depends_on = ["clang@21.1.7"]
arches = ["wasm32"]

[source]
url = "https://github.com/Automattic/kandelo"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
provider = "repository"

[license]
spdx = "Apache-2.0 WITH LLVM-exception"
url = "https://github.com/llvm/llvm-project/blob/llvmorg-21.1.7/LICENSE.TXT"

[build]
script_path = "packages/registry/clang-browser-bundle/build-clang-browser-bundle.sh"

[[outputs]]
name = "clang"
wasm = "clang.zip"
fork_instrumentation = "disabled"
```

- [ ] **Step 3: `packages/registry/clang-browser-bundle/build.toml`**

```toml
script_path = "packages/registry/clang-browser-bundle/build-clang-browser-bundle.sh"
inputs = [
  "packages/registry/clang-browser-bundle/build-clang-browser-bundle.sh",
  "images/vfs/scripts/build-clang-zip.sh",
  "images/vfs/scripts/create-deterministic-zip.sh",
  "scripts/install-local-binary.sh",
]
repo_url    = "https://github.com/Automattic/kandelo.git"
commit      = "UNPUBLISHED"
revision    = 1
```

- [ ] **Step 4: `build-clang-browser-bundle.sh`** (model on `build-vim-browser-bundle.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:?resolver build required}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:?resolver build required}"
CLANG_DIR="${WASM_POSIX_DEP_CLANG_DIR:?clang dependency required}"
[ "${WASM_POSIX_DEP_TARGET_ARCH:-}" = wasm32 ] || { echo "wasm32 only" >&2; exit 2; }

archive="$WORK_DIR/clang.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-clang-zip.sh" "$CLANG_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary clang-browser-bundle "$archive" clang.zip
```

`chmod +x` both new scripts.

- [ ] **Step 5: Build the bundle and inspect the zip**

```bash
scripts/dev-shell.sh bash -lc '
  set -euo pipefail
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  dir=$(cargo run -p xtask --target "$host_target" -- build-deps resolve clang-browser-bundle --arch wasm32)
  unzip -l "$dir/clang.zip"
'
```
Expected: the listing shows `bin/clang`, `bin/wasm-ld`, `bin/llvm-ar`,
`bin/llvm-ranlib`, `bin/llvm-nm`, and `bin/clang++`.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/clang-browser-bundle/ images/vfs/scripts/build-clang-zip.sh
git commit -m "Packages: add clang-browser-bundle lazy-archive zip"
```

---

### Task 5: Register the clang lazy archive into the SDK image

**Files:**
- Modify: `images/vfs/scripts/shell-lazy-archives.ts` (add the `clang` spec
  + widen the literal types)
- Modify: `images/vfs/scripts/build-kandelo-sdk-vfs-image.ts` (register the
  archive)
- Modify: `packages/registry/kandelo-sdk/package.toml` (add dependency)
- Modify: `packages/registry/kandelo-sdk/build.toml` (add input, bump
  revision)
- Modify: `packages/registry/kandelo-sdk/build-kandelo-sdk.sh` (pass the
  bundle dir through)
- Test: `host/test/clang-lazy-archive.test.ts`

**Interfaces:**
- Consumes: `clang-browser-bundle`'s `clang.zip` (via
  `WASM_POSIX_DEP_CLANG_BROWSER_BUNDLE_DIR`).
- Produces: a `kandelo-sdk.vfs.zst` whose lazy-archive table includes
  `clang.zip` at `mountPrefix = "/usr/lib/llvm/"`; consumed by Task 6.

- [ ] **Step 1: Add the `clang` lazy-archive spec**

In `images/vfs/scripts/shell-lazy-archives.ts`, widen the `id`,
`dependency`, `resolverPath`, `archiveUrl`, `mountPrefix`, and
`requiredExecutable` literal unions in `ShellLazyArchiveSpec` to include
the clang values, and append to `SHELL_LAZY_ARCHIVE_SPECS`:

```ts
  {
    id: "clang",
    dependency: "clang-browser-bundle",
    resolverPath: "programs/wasm32/clang.zip",
    archiveUrl: "clang.zip",
    mountPrefix: "/usr/lib/llvm/",
    requiredExecutable: "bin/clang",
  },
```

(Type additions: `id: … | "clang"`, `dependency: … | "clang-browser-bundle"`,
`resolverPath: … | "programs/wasm32/clang.zip"`,
`archiveUrl: … | "clang.zip"`, `mountPrefix: "/usr/" | "/usr/lib/llvm/"`,
`requiredExecutable: … | "bin/clang"`.)

- [ ] **Step 2: Write the failing registration test**

Create `host/test/clang-lazy-archive.test.ts`, modelled on
`host/test/shell-lazy-archive-inputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  registerDeclaredShellLazyArchive,
  SHELL_LAZY_ARCHIVE_SPECS,
} from "../../images/vfs/scripts/shell-lazy-archives";
import { resolveBuiltArtifact } from "./helpers/resolve-built-artifact"; // existing resolver helper used by the vim/nethack test

describe("clang lazy archive", () => {
  const spec = SHELL_LAZY_ARCHIVE_SPECS.find((s) => s.id === "clang")!;
  it("registers clang.zip and exposes /usr/lib/llvm/bin/clang", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024 * 1024));
    const archive = registerDeclaredShellLazyArchive(fs, spec, resolveBuiltArtifact);
    expect(archive.entries.some((e) => e.fileName === "bin/clang")).toBe(true);
    const st = fs.lstat("/usr/lib/llvm/bin/clang");
    expect(st.mode & 0o111).not.toBe(0); // executable
  });
});
```

(Use the same artifact-resolver helper the vim/nethack test uses; match its
import path.)

- [ ] **Step 3: Run the test to confirm it fails**

Run: `scripts/dev-shell.sh bash -lc 'npx vitest run host/test/clang-lazy-archive.test.ts'`
Expected: FAIL — either the `clang` spec is not found yet, or `clang.zip`
cannot be resolved (bundle not built).

- [ ] **Step 4: Make it pass — build the bundle, then register in the SDK image**

Build `clang-browser-bundle` (Task 4 Step 5) so the resolver can find
`clang.zip`. Then in `images/vfs/scripts/build-kandelo-sdk-vfs-image.ts`,
after the existing staging, add a lazy-archive resolver and register the
clang spec (mirroring `shell-vfs-build.ts:750-763`):

```ts
import {
  registerDeclaredShellLazyArchive,
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";

// …inside buildKandeloSdkVfsImage, before saveImage:
const resolveArtifact: ShellLazyArchiveResolver = inputs.resolveArtifact;
const clangSpec = SHELL_LAZY_ARCHIVE_SPECS.find((s) => s.id === "clang");
if (clangSpec) registerDeclaredShellLazyArchive(fs, clangSpec, resolveArtifact);
```

Thread a `resolveArtifact` input into `buildKandeloSdkVfsImage` and its
`main()` (resolving `programs/wasm32/clang.zip` from
`WASM_POSIX_DEP_CLANG_BROWSER_BUNDLE_DIR` / the built-binaries dir, matching
the resolver shell-vfs-build uses).

- [ ] **Step 5: Wire the kandelo-sdk dependency**

- `packages/registry/kandelo-sdk/package.toml`: add
  `"clang-browser-bundle@21.1.7"` to `depends_on`.
- `packages/registry/kandelo-sdk/build.toml`: add
  `"images/vfs/scripts/shell-lazy-archives.ts"`,
  `"images/vfs/scripts/build-clang-zip.sh"`, and
  `"images/vfs/scripts/create-deterministic-zip.sh"` to `inputs`; bump
  `revision` by 1.
- `packages/registry/kandelo-sdk/build-kandelo-sdk.sh`: export
  `WASM_POSIX_DEP_CLANG_BROWSER_BUNDLE_DIR` through to the image builder
  (pass it as the `resolveArtifact` source).

- [ ] **Step 6: Run the test to confirm it passes**

Run: `scripts/dev-shell.sh bash -lc 'npx vitest run host/test/clang-lazy-archive.test.ts'`
Expected: PASS.

- [ ] **Step 7: Rebuild the SDK image and confirm no baked compiler bytes**

```bash
scripts/dev-shell.sh bash -lc '
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  dir=$(cargo run -p xtask --target "$host_target" -- build-deps resolve kandelo-sdk --arch wasm32)
  ls -lh "$dir/kandelo-sdk.vfs.zst"
'
```
Expected: builds successfully; the image size does not grow by ~64 MB
(only lazy-archive metadata is added, not the clang bytes).

- [ ] **Step 8: Commit**

```bash
git add images/vfs/scripts/shell-lazy-archives.ts images/vfs/scripts/build-kandelo-sdk-vfs-image.ts packages/registry/kandelo-sdk/ host/test/clang-lazy-archive.test.ts
git commit -m "SDK: register clang toolchain as a lazy VFS archive"
```

---

### Task 6: Node in-guest end-to-end compile-and-run test

**Files:**
- Test: `host/test/clang-in-guest.test.ts`

**Interfaces:**
- Consumes: the `kandelo-sdk.vfs.zst` from Task 5 (SDK sysroot + `cc`
  wrapper + clang lazy archive).

- [ ] **Step 1: Write the failing end-to-end test**

Model boot + capture on `host/test/node-host-mounts.test.ts`. Boot the SDK
image as root, run the guest `cc` on the bundled `/home/hello.c`, then run
the produced binary, asserting its stdout:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveSdkImagePath } from "./helpers/resolve-sdk-image"; // resolves kandelo-sdk.vfs.zst via xtask

describe("clang compiles and runs in-guest", () => {
  let image: Uint8Array;
  beforeAll(() => { image = new Uint8Array(readFileSync(resolveSdkImagePath())); });

  it("cc hello.c && run prints the greeting", async () => {
    let out = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, d) => { out += new TextDecoder().decode(d); },
      onStderr: (_pid, d) => { out += new TextDecoder().decode(d); },
    });
    await host.init();
    const rc = await host.spawnFromVfs("/bin/bash", [
      "bash", "-lc",
      "cc /home/hello.c -o /home/hello && /home/hello",
    ], { cwd: "/home", uid: 0, gid: 0 }).then((h) => h.exit);
    expect(rc, out).toBe(0);
    expect(out).toContain("hello from Kandelo clang");
  }, 120_000);
});
```

(Match the exact `spawnFromVfs`/`NodeKernelHost` option names to
`host/src/node-kernel-host.ts`; adjust `/bin/bash` if the SDK image's shell
path differs. The `/home/hello.c` file is already written by the SDK image
builder.)

- [ ] **Step 2: Run it to confirm it fails first (before Task 5 wiring, if run out of order) or passes end to end**

Run: `scripts/dev-shell.sh bash -lc 'npx vitest run host/test/clang-in-guest.test.ts'`
Expected initially: FAIL if the lazy archive is not yet streamed/resolvable
in the Node host path (diagnose via captured stderr — e.g. `cc: clang not
found` means the archive did not mount at `/usr/lib/llvm/bin`).

- [ ] **Step 3: Make it pass**

Ensure the Node host materializes the SDK image's lazy archive on first
access to `/usr/lib/llvm/bin/clang` (this is the same lazy-archive path the
`vim` in-guest flow uses; confirm the test's artifact resolver points the
archive URL at the built `clang.zip`). Re-run until PASS.

- [ ] **Step 4: Confirm the produced binary is a Kandelo wasm program**

Extend the test (or add a second case) to assert the guest wrote
`/home/hello` and that re-running it a second time still prints the
greeting (the artifact persists in the guest FS), proving a real
Kandelo-runnable output rather than a one-shot.

- [ ] **Step 5: Commit**

```bash
git add host/test/clang-in-guest.test.ts
git commit -m "SDK: verify clang compiles and runs a program in-guest on Node"
```

---

## Notes for the executor

- **Long builds:** Task 3 compiles LLVM; expect a long first build.
  `KANDELO_CLANG_BUILD_JOBS` controls parallelism (default 1 for memory
  safety; raise if the host has RAM).
- **Lazy-archive resolver plumbing (Task 5 Step 4):** the exact
  `resolveArtifact` wiring for the SDK image builder mirrors what
  `shell-vfs-build.ts` already does for vim/nethack — read that file's
  resolver construction and copy the pattern rather than inventing one.
- **If the Node host cannot stream a lazy archive at `/usr/lib/llvm/bin`**
  (Task 6): that would be a real host-runtime gap, not a test bug. Stop and
  report it — it would mean lazy archives are browser-only today, which
  changes the delivery story and must go back to design, not be worked
  around by baking clang into the image.
- **Do not** convert any failure into synthetic success (platform-values
  contract). A missing tool, a link error, or an ABI mismatch must surface
  as the real failure.
