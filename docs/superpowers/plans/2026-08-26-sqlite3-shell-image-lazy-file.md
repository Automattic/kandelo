# sqlite3 CLI in the base shell image (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `sqlite3` command-line client as a lazy-file in the
browser shell image, built through the normal package path.

**Architecture:** Turn the non-building `sqlite-cli` package stub into a
real `kind = "program"` package that depends on the existing `sqlite`
library and links only the CLI frontend (`shell.c`) against the
prebuilt `libsqlite3.a` — no recompiled engine, no change to the
`sqlite` library, so PHP is not rebuilt. Then wire it into the shell
overlay exactly like `git`: dependency contract entry, `depends_on`,
`SHELL_LAZY_BINARY_SPECS` placement, and the browser asset-URL map.

**Tech Stack:** Bash build scripts + the Kandelo SDK
(`wasm32posix-cc`), the xtask dependency resolver (`cargo xtask
build-deps`), TypeScript VFS image composer, Vite `@binaries` asset
imports.

**Spec:** `docs/superpowers/specs/2026-08-26-shell-image-lazy-refs-design.md`
(read it — this plan implements only its "PR 1" half; python/perl/ruby
are a separate later plan).

## Global Constraints

- **ABI unchanged:** `kernel_abi = 7` on the new package, matching
  `sqlite` and `shell`. No ABI-adjacent change is intended.
- **One SQLite version:** `sqlite-cli` is version `3.49.1` and links
  `sqlite@3.49.1`. Its own `[source]` fetches the **3.49.1
  amalgamation** only for `shell.c`:
  URL `https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip`,
  sha256 `6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3`,
  `provider = "archive"`.
- **Do not modify the `sqlite` library package** (`package.toml`,
  `build-sqlite.sh`, `build.toml`). PHP must not be rebuilt.
- **Feature consistency:** compile `shell.c` with the same flags the
  library uses, including `-DSQLITE_OMIT_LOAD_EXTENSION` (so `.load` is
  absent and `sqlite3_load_extension` is not referenced). Diverging
  risks an unresolved-symbol link failure.
- **Fork instrumentation required:** the CLI's `.shell`/`.system`/
  `.import` fork, so apply `scripts/run-wasm-fork-instrument.sh` as the
  final build step, like `git`/`vim`.
- **Host parity:** the browser asset-URL map
  (`apps/browser-demos/lib/init/shell-lazy-files.ts`) is updated in the
  same task as the VFS spec, so Node and browser expose `sqlite3`
  identically.
- **Build via the dev shell:** run build/verification through
  `scripts/dev-shell.sh` (e.g.
  `scripts/dev-shell.sh cargo run -p xtask -- ...`).
- **Commits:** subject `Area: Purpose`; body wrapped at 72 columns;
  end every commit with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `packages/registry/sqlite-cli/package.toml` — **modify.** Package
  identity: real program that depends on `sqlite@3.49.1`, version
  3.49.1, amalgamation source for `shell.c`, declared output
  `sqlite3.wasm`, `[build] script_path`.
- `packages/registry/sqlite-cli/build.toml` — **create.** Kandelo build
  state: selected script, provenance, revision, binary index URL.
- `packages/registry/sqlite-cli/build-sqlite-cli.sh` — **create.** The
  build recipe: stage source for `shell.c`, link against the resolved
  `sqlite` library, fork-instrument, publish.
- `packages/registry/shell/source-rootfs-shell-dependencies.json` —
  **modify.** Add the `lazy-file` contract entry.
- `packages/registry/shell/package.toml` — **modify.** Add the
  `depends_on` entry (must match the contract exactly).
- `images/vfs/lib/init/shell-binaries.ts` — **modify.** Add the
  `SHELL_LAZY_BINARY_SPECS` placement.
- `apps/browser-demos/lib/init/shell-lazy-files.ts` — **modify.** Add
  the browser asset-URL import and record entry (TypeScript requires
  this or the record type fails to compile).

---

## Task 1: Make `sqlite-cli` a buildable program that links libsqlite3.a

**Files:**
- Modify: `packages/registry/sqlite-cli/package.toml`
- Create: `packages/registry/sqlite-cli/build.toml`
- Create: `packages/registry/sqlite-cli/build-sqlite-cli.sh`

**Interfaces:**
- Consumes: the `sqlite` library's resolved outputs via
  `WASM_POSIX_DEP_SQLITE_DIR` — `lib/libsqlite3.a`, `include/sqlite3.h`,
  `include/sqlite3ext.h`.
- Produces: a fork-instrumented Wasm program installed as
  `sqlite3.wasm` (into `WASM_POSIX_DEP_OUT_DIR/sqlite3.wasm` in resolver
  mode, or via `install_local_binary sqlite-cli` in developer mode).
  Later tasks reference dependency name `sqlite-cli`, version `3.49.1`,
  and output basename `sqlite3.wasm`.

- [ ] **Step 1: Replace the stub `package.toml`**

Overwrite `packages/registry/sqlite-cli/package.toml` with:

```toml
# CLI-only companion to the `sqlite` library. Links the sqlite3 shell
# frontend (shell.c) against the library's prebuilt libsqlite3.a so the
# engine has a single source of truth and PHP is never rebuilt. The
# amalgamation source below is fetched ONLY for shell.c; the engine
# comes from depends_on = ["sqlite@3.49.1"].
kind = "program"

name = "sqlite-cli"
version = "3.49.1"
kernel_abi = 7
depends_on = ["sqlite@3.49.1"]

[source]
url = "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip"
sha256 = "6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3"
provider = "archive"

[license]
spdx = "blessing"
url = "https://www.sqlite.org/copyright.html"

[build]
script_path = "packages/registry/sqlite-cli/build-sqlite-cli.sh"

[[outputs]]
name = "sqlite-cli"
wasm = "sqlite3.wasm"
```

- [ ] **Step 2: Create `build.toml`**

Model on `packages/registry/sqlite/build.toml`. Set `revision = 1`
(new package) and `commit` to the current worktree HEAD
(`git rev-parse HEAD`). Create
`packages/registry/sqlite-cli/build.toml`:

```toml
script_path = "packages/registry/sqlite-cli/build-sqlite-cli.sh"
inputs = [
  "packages/registry/sqlite-cli/build-sqlite-cli.sh",
  "scripts/run-wasm-fork-instrument.sh",
]
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "REPLACE_WITH_git_rev-parse_HEAD"
revision    = 1

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

Then replace the `commit` value:

Run: `scripts/dev-shell.sh git rev-parse HEAD`
Copy the printed SHA into the `commit` field.

- [ ] **Step 3: Create the build script**

Create `packages/registry/sqlite-cli/build-sqlite-cli.sh` (mode 0755).
It mirrors the netcat resolver-vs-developer publish pattern and the
git fork-instrument step, and mirrors the `sqlite` library's
`SQLITE_CFLAGS` so the CLI is feature-consistent:

```bash
#!/usr/bin/env bash
#
# Build the sqlite3 command-line client for wasm32-posix-kernel by
# linking the shell.c frontend against the sqlite library package's
# prebuilt libsqlite3.a. The amalgamation source is staged ONLY for
# shell.c; the engine comes from the resolved sqlite dependency.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: sqlite-cli is packaged for wasm32 only, got $TARGET_ARCH" >&2
    exit 2
fi
kandelo_package_prepare_build_roots "$SCRIPT_DIR/sqlite-cli-work" "$TARGET_ARCH"

# Worktree-local SDK on PATH.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
CC="${TARGET_ARCH}posix-cc"
if ! command -v "$CC" &>/dev/null; then
    echo "ERROR: $CC not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

# --- sqlite library dependency (depends_on = ["sqlite@3.49.1"]) ---
SQLITE_DIR="${WASM_POSIX_DEP_SQLITE_DIR:?resolver did not provide the sqlite dependency}"
if [ ! -f "$SQLITE_DIR/lib/libsqlite3.a" ]; then
    echo "ERROR: libsqlite3.a missing in $SQLITE_DIR/lib" >&2
    exit 1
fi

# --- Stage OUR source purely for shell.c (matches lib version 3.49.1). ---
SQLITE_VERSION="${WASM_POSIX_DEP_VERSION:-3.49.1}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3}"
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/source"
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified SQLite $SQLITE_VERSION source (for shell.c)..."
    kandelo_package_stage_verified_source sqlite-cli "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi
[ -s "$SRC_DIR/shell.c" ] || { echo "ERROR: shell.c missing from staged source" >&2; exit 1; }

# Keep the CLI feature-consistent with the shipped library. These match
# packages/registry/sqlite/build-sqlite.sh SQLITE_CFLAGS.
SQLITE_MAX_COMPOUND_SELECT="${SQLITE_MAX_COMPOUND_SELECT:-50}"
SQLITE_MAX_EXPR_DEPTH="${SQLITE_MAX_EXPR_DEPTH:-100}"
SQLITE_JSON_MAX_DEPTH="${SQLITE_JSON_MAX_DEPTH:-100}"
SQLITE_MAX_TRIGGER_DEPTH="${SQLITE_MAX_TRIGGER_DEPTH:-50}"
SQLITE_CFLAGS="-O2 \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_THREADSAFE=1 \
    -DSQLITE_DEFAULT_SYNCHRONOUS=0 \
    -DSQLITE_ENABLE_SETLK_TIMEOUT=2 \
    -DSQLITE_MAX_COMPOUND_SELECT=$SQLITE_MAX_COMPOUND_SELECT \
    -DSQLITE_MAX_EXPR_DEPTH=$SQLITE_MAX_EXPR_DEPTH \
    -DSQLITE_JSON_MAX_DEPTH=$SQLITE_JSON_MAX_DEPTH \
    -DSQLITE_MAX_TRIGGER_DEPTH=$SQLITE_MAX_TRIGGER_DEPTH \
    -DHAVE_PREAD=1 \
    -DHAVE_PWRITE=1 \
    -DSQLITE_ENABLE_FTS5 \
    -DSQLITE_ENABLE_JSON1 \
    -DSQLITE_ENABLE_MATH_FUNCTIONS \
    -DSQLITE_ENABLE_COLUMN_METADATA"

BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
mkdir -p "$BIN_DIR"
OUT="$BIN_DIR/sqlite3.wasm"

echo "==> Linking sqlite3 CLI against libsqlite3.a..."
# shellcheck disable=SC2086
"$CC" $SQLITE_CFLAGS \
    -I"$SQLITE_DIR/include" \
    "$SRC_DIR/shell.c" \
    -L"$SQLITE_DIR/lib" -lsqlite3 -lm \
    -Wl,-z,stack-size=1048576 -Wl,--export=__abi_version \
    -o "$OUT"

echo "==> Applying fork instrumentation (.shell/.system/.import fork)..."
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$OUT" -o "$OUT.instr"
mv "$OUT.instr" "$OUT"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    if ! wasm_is_binary "$OUT"; then
        echo "ERROR: refusing non-Wasm sqlite3 artifact: $OUT" >&2
        exit 1
    fi
    wasm_require_no_legacy_asyncify "$OUT"
    wasm_require_fork_instrumentation_if_needed "$OUT"
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/sqlite3.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/sqlite3.wasm (resolver scratch)"
else
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary sqlite-cli "$OUT"
fi

ls -lh "$OUT"
```

Make it executable:

Run: `chmod 755 packages/registry/sqlite-cli/build-sqlite-cli.sh`

- [ ] **Step 4: Build the package and verify it fails cleanly first (sanity)**

Before the resolver has the new script wired, confirm the resolver can
even see the package. Run the resolve; it should now build (not error
with "no build script"):

Run: `scripts/dev-shell.sh cargo run -p xtask -- build-deps --arch wasm32 resolve sqlite-cli`
Expected: the build runs the new script, links `shell.c`, applies fork
instrumentation, and prints a resolved path. If it fails on an
unresolved `sqlite3_load_extension` symbol, the `-DSQLITE_OMIT_LOAD_EXTENSION`
flag is missing from the compile — fix and re-run.

- [ ] **Step 5: Verify the produced artifact**

Confirm the resolved output is a real, fork-instrumented Wasm binary
(not a stub or asyncify artifact). Locate the resolved path printed in
Step 4 (it ends in `sqlite3.wasm`) and check it:

Run:
```bash
scripts/dev-shell.sh bash -c '
  set -euo pipefail
  P="$(cargo run -p xtask -- build-deps --arch wasm32 resolve sqlite-cli | tail -1)"
  echo "resolved: $P"
  source scripts/wasm-artifact-guards.sh
  wasm_is_binary "$P" && echo "is-wasm: yes"
  wasm_require_no_legacy_asyncify "$P" && echo "no-legacy-asyncify: ok"
  wasm_require_fork_instrumentation_if_needed "$P" && echo "fork-instrument: ok"
'
```
Expected: `is-wasm: yes`, `no-legacy-asyncify: ok`, `fork-instrument: ok`.

- [ ] **Step 6: Confirm the `sqlite` library was not rebuilt or modified**

Run: `git status --porcelain packages/registry/sqlite`
Expected: no output (the library package is untouched).

- [ ] **Step 7: Commit**

```bash
git add packages/registry/sqlite-cli/package.toml \
        packages/registry/sqlite-cli/build.toml \
        packages/registry/sqlite-cli/build-sqlite-cli.sh
git commit -m "$(cat <<'EOF'
Packages: Build sqlite-cli by linking the sqlite library

The sqlite-cli package was a non-building stub. Make it a real program
that depends on the sqlite library and links only the sqlite3 shell
frontend (shell.c) against the prebuilt libsqlite3.a. This gives one
SQLite engine version in the image, leaves the sqlite library (and
therefore PHP) untouched, and produces a fork-instrumented sqlite3.wasm
so the CLI's .shell/.system/.import commands work.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire sqlite3 into the shell image as a lazy-file

**Files:**
- Modify: `packages/registry/shell/source-rootfs-shell-dependencies.json`
- Modify: `packages/registry/shell/package.toml`
- Modify: `images/vfs/lib/init/shell-binaries.ts`
- Modify: `apps/browser-demos/lib/init/shell-lazy-files.ts`

**Interfaces:**
- Consumes: dependency `sqlite-cli@3.49.1` producing `sqlite3.wasm`
  (from Task 1). The resolver reads the artifact from
  `WASM_POSIX_DEP_SQLITE_CLI_DIR/sqlite3.wasm` (dependency name upper-
  cased, `-`→`_`).
- Produces: `/usr/bin/sqlite3` (+ `/bin/sqlite3` symlink) as a lazy file
  in the shell VFS image, on both Node and browser hosts.

- [ ] **Step 1: Add the dependency-contract entry**

In `packages/registry/shell/source-rootfs-shell-dependencies.json`, add
a `lazy-file` entry after the `nano` line (line 21):

```json
    { "name": "nano", "version": "8.0", "role": "lazy-file" },
    { "name": "sqlite-cli", "version": "3.49.1", "role": "lazy-file" },
```

- [ ] **Step 2: Add the matching `depends_on` entry**

In `packages/registry/shell/package.toml`, add to the `depends_on`
array after `"nano@8.0",` (line 26). The contract reader asserts this
list and the JSON are identical, so the name+version must match Step 1:

```toml
  "nano@8.0",
  "sqlite-cli@3.49.1",
```

- [ ] **Step 3: Add the VFS placement spec**

In `images/vfs/lib/init/shell-binaries.ts`, add an entry to
`SHELL_LAZY_BINARY_SPECS` after the `nano` entry (line 112). The `id`
must be `sqlite-cli` (→ `WASM_POSIX_DEP_SQLITE_CLI_DIR`) and the
`resolverPath` basename must be `sqlite3.wasm`:

```ts
  { id: "nano", resolverPath: "programs/nano.wasm", vfsPath: "/usr/bin/nano", symlinks: ["/bin/nano"] },
  { id: "sqlite-cli", resolverPath: "programs/sqlite3.wasm", vfsPath: "/usr/bin/sqlite3", symlinks: ["/bin/sqlite3"] },
```

- [ ] **Step 4: Add the browser asset-URL import and record entry**

In `apps/browser-demos/lib/init/shell-lazy-files.ts`:

Add the import after the `nano` import (line 35):

```ts
import nanoWasmUrl from "@binaries/programs/wasm32/nano.wasm?url";
import sqlite3WasmUrl from "@binaries/programs/wasm32/sqlite3.wasm?url";
```

Add the record entry after the `nano` entry (line 63). The key is the
spec `id`; `SHELL_LAZY_ASSET_URLS` is typed
`Record<SHELL_LAZY_BINARY_SPECS[number]["id"], string>`, so the
TypeScript build fails unless this entry is present:

```ts
  nano: nanoWasmUrl,
  "sqlite-cli": sqlite3WasmUrl,
```

- [ ] **Step 5: Typecheck the browser app and image code**

The `Record` type and the `as const satisfies` on
`SHELL_LAZY_BINARY_SPECS` catch a missing/mismatched wiring at compile
time. Run the repo's typecheck:

Run: `scripts/dev-shell.sh npm run typecheck`
Expected: PASS (no type errors). If it reports a missing key in
`SHELL_LAZY_ASSET_URLS`, Step 4 was skipped.

(If the repo uses a different typecheck entry point, discover it with
`scripts/dev-shell.sh cat package.json` and run the corresponding
`tsc`/`vue-tsc` script.)

- [ ] **Step 6: Build the shell VFS image from source and confirm sqlite3 resolves**

Build the local VFS products, which composes `browser-main-shell` from
source (building `sqlite-cli` via Task 1's script) and registers the
lazy file:

Run: `scripts/dev-shell.sh ./run.sh local-build`
Expected: completes successfully; the shell product builds. The
dependency-contract validator (run inside `build-shell.sh`) passes,
proving the JSON and `package.toml` agree. A failure naming
`WASM_POSIX_DEP_SQLITE_CLI_DIR` means the contract/`depends_on`/spec id
are out of sync.

- [ ] **Step 7: Commit**

```bash
git add packages/registry/shell/source-rootfs-shell-dependencies.json \
        packages/registry/shell/package.toml \
        images/vfs/lib/init/shell-binaries.ts \
        apps/browser-demos/lib/init/shell-lazy-files.ts
git commit -m "$(cat <<'EOF'
Packages: Add sqlite3 as a lazy-file in the shell image

Wire the sqlite-cli program into the browser shell overlay the same way
git and less are: a dependency-contract entry, a matching depends_on, a
SHELL_LAZY_BINARY_SPECS placement at /usr/bin/sqlite3 (+ /bin/sqlite3),
and the browser asset-URL map so Node and browser expose it identically.
The real Wasm is fetched on first exec.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Validate sqlite3 end-to-end and document it

**Files:**
- Modify: shell demo/tool documentation, only where a tool list is
  already enumerated (discovered in Step 4).

**Interfaces:**
- Consumes: the built shell image from Task 2.
- Produces: evidence that `sqlite3` runs in both hosts, and (only after
  that passes) documentation naming it.

- [ ] **Step 1: Browser validation — the primary gate**

This is a browser-facing change; per the validation contract it is not
complete on code reasoning alone.

Run: `scripts/dev-shell.sh ./run.sh browser`
Then, in the shell demo terminal, verify:

```
sqlite3 :memory: "create table t(x); insert into t values(1),(2); select sum(x) from t;"
```
Expected output: `3`.

Then verify the interactive client and a fork path:

```
sqlite3
sqlite> .shell echo forked-ok
sqlite> .quit
```
Expected: `forked-ok` prints (exercises fork instrumentation), and
`.quit` exits cleanly. Confirm `which sqlite3` reports `/usr/bin/sqlite3`
and that `/bin/sqlite3` also runs (the symlink).

- [ ] **Step 2: Node host parity**

Confirm the same client works under the Node host path (not only the
browser). Use the repo's Node shell/demo runner for the
`browser-main-shell` image; discover it with
`scripts/dev-shell.sh ./run.sh --help` and run the Node-host shell
target, then execute the same `create table / select sum` command.
Expected: `3`.

- [ ] **Step 3: Confirm no unintended rebuild of the sqlite library / PHP**

Run: `git status --porcelain packages/registry/sqlite packages/registry/php`
Expected: no output. The library and PHP packages are untouched.

- [ ] **Step 4: Update documentation where the shell toolset is listed**

Find where the shell demo enumerates its available commands (welcome
banner or docs), then add `sqlite3` alongside the existing tools:

Run:
```bash
scripts/dev-shell.sh bash -c '
  grep -rn "nano\|vim\|less" \
    packages/registry/shell/source-rootfs-shell-demo.json \
    packages/registry/shell/source-rootfs-shell-demo-profiles.json \
    docs/package-management.md 2>/dev/null
'
```
For each place that enumerates the interactive tool set (e.g. a demo
welcome message listing `git`, `vim`, `less`, ...), add `sqlite3`. If no
such enumeration exists, record that no doc change was needed (do not
invent a new list). Do not document `sqlite3` as available anywhere
unless Steps 1-2 passed.

- [ ] **Step 5: Commit (skip if Step 4 made no changes)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Docs: Note sqlite3 in the shell demo toolset

sqlite3 now ships as a lazy-file in the browser shell image and runs on
both the Node and browser hosts (verified with an in-memory query and a
.shell fork). List it alongside the other interactive tools.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage (PR 1 half of the spec):**
- "Un-stub `sqlite-cli` as `kind=program` linking `libsqlite3.a`" →
  Task 1.
- "Own source fetch for `shell.c` at 3.49.1" → Task 1 Step 1/3.
- "Fork-instrument" → Task 1 Step 3/5.
- "Mirror `-DSQLITE_OMIT_LOAD_EXTENSION` / feature flags" → Task 1
  Step 3 (Global Constraints).
- "No PHP rebuild / library untouched" → Task 1 Step 6, Task 3 Step 3.
- "3-place lazy-file wiring + browser URL map" → Task 2 Steps 1-4.
- "Browser + Node validation via `./run.sh browser`" → Task 3
  Steps 1-2.
- "Docs only after validation passes" → Task 3 Step 4.

**Placeholder scan:** the only intentional fill-in is `build.toml`'s
`commit` (Task 1 Step 2), which must be a live `git rev-parse HEAD`
value, not a literal — flagged explicitly with the command to produce
it.

**Type/name consistency:** dependency name `sqlite-cli`, version
`3.49.1`, output basename `sqlite3.wasm`, spec `id` `sqlite-cli`, env
key `WASM_POSIX_DEP_SQLITE_CLI_DIR`, and record key `"sqlite-cli"` are
used consistently across Tasks 1-2.

## Notes for the executor

- If `./run.sh local-build` or the resolver requires refreshing a
  generated binary index / `program-packages.json` projection for the
  new package, run the repo's canonical regeneration path and observe
  its output rather than hand-editing generated files — a stale
  generated artifact should fail loudly, not be papered over.
- If `run-wasm-fork-instrument.sh` reports the binary imports no fork
  paths, that is acceptable (it is then effectively a no-op); do not
  remove the step, since `.shell`/`.system` do fork.
