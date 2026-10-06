# Ruby in the base shell image (PR 2, track 1: ruby) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `ruby` interpreter (with `gem`, `irb`, `bundle`,
`bundler`) as a lazy-archive in the browser shell image.

**Architecture:** Ruby needs its standard-library tree at runtime, so
it ships as a lazy-*archive* (a mounted zip tree), not a lazy-file.
Create a dedicated `ruby-browser-bundle` package — exactly like
`vim-browser-bundle` — that reshapes the existing `ruby` package's
artifacts (`ruby.wasm` + `ruby-runtime.zip`) into a root-relative zip
(`bin/ruby` + `bin/gem…` + `lib/ruby/4.0.0/…`), then wire it into the
shell overlay as a `lazy-archive` mounted at `/usr/`.

**Tech Stack:** Bash reshaping script + the deterministic-zip helper,
the xtask dependency resolver + program-package index generator,
TypeScript VFS composer, Vite `@binaries` asset imports.

**Spec:** `docs/superpowers/specs/2026-08-26-shell-image-lazy-refs-design.md`
(this plan implements the **ruby** slice of its "PR 2" half; python and
perl are separate tracks with their own plans).

## Global Constraints

- **Follow the vim-browser-bundle pattern exactly.** `vim` proves the
  convention: the reshaping (rename binary to `bin/<exe>`, root-relative
  deterministic zip, mount prefix `/usr/`) lives in a dedicated bundle
  package, and the underlying interpreter package is untouched.
- **Do NOT modify the `ruby` package** (`packages/registry/ruby/**`).
  The bundle only consumes its declared outputs.
- **Projection-naming (the PR-1 lesson):** the SourceOnly program-mirror
  basename is `<output.name><ext-from-output.wasm>`. So the bundle's
  single output MUST be `name = "ruby"`, `wasm = "ruby.zip"` → mirrors to
  `programs/wasm32/ruby.zip`, matching the browser import
  `@binaries/programs/ruby.zip` and the spec's `resolverPath`. Keep
  exactly one `[[outputs]]` and zero `[[runtime_files]]` (closure member
  count must stay 1, or the mirror lands in a `ruby/` subdir).
- **`bin/ruby` must be the instrumented `ruby.wasm` output**, not the
  `usr/bin/ruby` copy inside `ruby-runtime.zip` (that copy predates the
  fork-instrument + root-spill post-processing and would break
  `Process.spawn`/fork).
- **Stdlib discovery:** trust the compiled prefix. `ruby.wasm` is built
  with `--prefix=/usr`, so its baked load path finds `/usr/lib/ruby/4.0.0`
  once the archive mounts at `/usr/`. No `RUBYLIB`/`/etc/profile.d`.
- **The lazy-archive zip must be root-relative:** entries `bin/ruby`,
  `bin/gem`, …, `lib/ruby/4.0.0/…` with NO leading `usr/`. The loader
  requires exactly one regular (non-dir/non-symlink) entry named
  `bin/ruby` (`requiredExecutable`). A `usr/`-rooted zip both fails that
  check and double-mounts to `/usr/usr/…`.
- **Ruby command suite:** ship `ruby`, `gem`, `irb`, `bundle`, `bundler`.
  Normalize the `gem`/`bundle`/`bundler` wrapper shebangs from
  `#!/usr/bin/env ruby` to absolute `#!/usr/bin/ruby` (the make-install
  stubs `irb`/`erb`/… already carry `#!/usr/bin/ruby`). Document the
  `gem install` native-extension boundary as a truthful failure.
- **Generated files are regenerated, not hand-edited:**
  `packages/registry/program-packages.json` is produced by
  `cargo xtask program-package-index` — regenerate it, do not edit.
- **Build via the dev shell** (`scripts/dev-shell.sh …`). **Commits:**
  `Area: Purpose` subject, body wrapped at 72 columns, end with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**New:**
- `packages/registry/ruby-browser-bundle/package.toml` — bundle identity
  (program, depends_on `ruby@4.0.5`, single output `ruby`/`ruby.zip`).
- `packages/registry/ruby-browser-bundle/build.toml` — build state.
- `packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh` —
  entry point (mirrors `build-vim-browser-bundle.sh`): validates the
  resolver dirs, calls the reshaper, installs the output.
- `images/vfs/scripts/build-ruby-zip.sh` — the reshaper (analog of
  `build-vim-zip.sh`): stage `bin/ruby` from `ruby.wasm`, extract the
  runtime zip, strip `usr/`, normalize shebangs, deterministic-zip.

**Modified (shell wiring):**
- `images/vfs/scripts/shell-lazy-archives.ts` — generalize the spec
  types to `string`; add the ruby entry.
- `images/vfs/scripts/shell-vfs-build.ts` — add `populateRubyArchive`
  (or generalize the two positional calls to a loop).
- `images/vfs/scripts/source-rootfs-shell-overlay.ts` — add the
  `/usr/bin/ruby` → `/bin/ruby` symlink.
- `packages/registry/shell/source-rootfs-shell-dependencies.json` — add
  the `ruby-browser-bundle` lazy-archive entry.
- `packages/registry/shell/package.toml` — add the `depends_on` entry.
- `packages/registry/shell/test-build-shell.sh` — lazy-dependency count
  17 → 18.
- `packages/sets/local-supported.toml` — register `ruby-browser-bundle`
  (`class = "browser-product"`).
- `apps/browser-demos/lib/init/lazy-archives.ts` — add the `ruby.zip`
  browser asset URL.
- `apps/browser-demos/lib/init/shell-lazy-url-contract.ts` — add
  `ruby.zip` to the unresolved-archive guard.
- `web-libs/kandelo-session/src/vfs-asset-group-reference.ts` — add
  `ruby.zip` to the asset-group reference map.

**Regenerated:** `packages/registry/program-packages.json`.

---

## Task 1: Create the `ruby-browser-bundle` package

**Files:**
- Create: `packages/registry/ruby-browser-bundle/package.toml`
- Create: `packages/registry/ruby-browser-bundle/build.toml`
- Create: `packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh`
- Create: `images/vfs/scripts/build-ruby-zip.sh`

**Interfaces:**
- Consumes: the `ruby` package's resolved outputs via
  `WASM_POSIX_DEP_RUBY_DIR` — `ruby.wasm` (instrumented interpreter) and
  `ruby-runtime.zip` (`usr/bin/*` + `usr/lib/ruby/4.0.0/*`).
- Produces: a declared output `ruby.zip` (installed via
  `install_local_binary ruby-browser-bundle <archive> ruby.zip`),
  root-relative: `bin/ruby` (the instrumented interpreter), `bin/gem`,
  `bin/irb`, `bin/bundle`, `bin/bundler` (+ any other make-install
  stubs), and `lib/ruby/4.0.0/…`. Later tasks consume dependency name
  `ruby-browser-bundle@4.0.5`, output basename `ruby.zip`,
  `requiredExecutable = "bin/ruby"`.

- [ ] **Step 1: Write `package.toml`**

Model on `packages/registry/vim-browser-bundle/package.toml`. Create
`packages/registry/ruby-browser-bundle/package.toml`:

```toml
# Browser lazy-archive bundle for Ruby. Reshapes the ruby package's
# ruby.wasm + ruby-runtime.zip into a single root-relative zip
# (bin/ruby + bin/gem… + lib/ruby/4.0.0/…) that the shell overlay
# mounts at /usr/. The ruby package itself is untouched.
kind = "program"
name = "ruby-browser-bundle"
version = "4.0.5"
kernel_abi = 15
depends_on = ["ruby@4.0.5"]

[source]
url = "https://github.com/brandonpayton/kandelo"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
provider = "repository"

[license]
spdx = "Ruby OR BSD-2-Clause"
url = "https://github.com/ruby/ruby/blob/master/COPYING"

[build]
script_path = "packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh"

[[outputs]]
name = "ruby"
wasm = "ruby.zip"
fork_instrumentation = "disabled"
```

Note `kernel_abi = 15` matches the `ruby` package (vim-browser-bundle
uses 7 to match `vim`). If the build's ABI validation rejects 15 in the
shell composition (shell is ABI 7), report it — the resolution is a
platform ABI question, not a value to fudge silently.

- [ ] **Step 2: Write `build.toml`**

Set `revision = 1` and `commit` to the current HEAD
(`scripts/dev-shell.sh git rev-parse HEAD`). Create
`packages/registry/ruby-browser-bundle/build.toml`:

```toml
script_path = "packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh"
inputs = [
  "packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh",
  "images/vfs/scripts/build-ruby-zip.sh",
  "images/vfs/scripts/create-deterministic-zip.sh",
]
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "REPLACE_WITH_git_rev-parse_HEAD"
revision    = 1
```

Then replace `commit`: run `scripts/dev-shell.sh git rev-parse HEAD` and
paste the SHA.

Note: do NOT add a `[binary]` section. PR #1322 removed the remote binary
channel and the `[binary]` block from the `build.toml` schema (the parser
now uses `deny_unknown_fields`); no current `build.toml` has one.

- [ ] **Step 3: Write `build-ruby-browser-bundle.sh`**

Mirror `build-vim-browser-bundle.sh`. Create
`packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh`
(mode 0755):

```bash
#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for Ruby. Reshapes the ruby
# package's ruby.wasm + ruby-runtime.zip into a root-relative ruby.zip
# (bin/ruby + bin/gem… + lib/ruby/4.0.0/…). Consumers see the bare zip
# at programs/wasm32/ruby.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
RUBY_DIR="${WASM_POSIX_DEP_RUBY_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"

fail() { echo "build-ruby-browser-bundle: $*" >&2; exit 2; }

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in /*) ;; *) fail "$label must be an absolute resolver-owned directory: $path" ;; esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then fail "$label must be a real directory: $path"; fi
}

[ "$TARGET_ARCH" = wasm32 ] || fail "browser bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_RUBY_DIR "$RUBY_DIR"

archive="$WORK_DIR/ruby.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-ruby-zip.sh" "$RUBY_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ruby-browser-bundle "$archive" ruby.zip
```

- [ ] **Step 4: Write the reshaper `build-ruby-zip.sh`**

This is the new logic (ruby's runtime is a zip, unlike vim's plain dir).
Create `images/vfs/scripts/build-ruby-zip.sh` (mode 0755):

```bash
#!/usr/bin/env bash
#
# Build ruby.zip for the browser shell demo: a root-relative archive of
# bin/ruby (the instrumented interpreter) + the ruby command suite +
# lib/ruby/4.0.0. The shell overlay mounts it at /usr/, so entries
# become /usr/bin/ruby and /usr/lib/ruby/4.0.0/... On first exec the
# whole archive is fetched and unpacked in one go.
#
#   build-ruby-zip.sh <ruby-dependency-dir> <output.zip>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

[ "$#" -eq 2 ] || { echo "usage: $0 <ruby-dependency-dir> <output.zip>" >&2; exit 2; }
RUBY_DIR="$1"
OUTPUT_FILE="$2"

# Locate the ruby package's declared outputs. Ruby is a multi-output
# package, so the outputs may sit directly in RUBY_DIR or under a ruby/
# subdir — accept either.
find_output() {
    local name="$1" p
    for p in "$RUBY_DIR/$name" "$RUBY_DIR/ruby/$name"; do
        [ -f "$p" ] && { echo "$p"; return 0; }
    done
    return 1
}
RUBY_WASM="$(find_output ruby.wasm)" || { echo "ruby.wasm not found under $RUBY_DIR" >&2; exit 1; }
RUNTIME_ZIP="$(find_output ruby-runtime.zip)" || { echo "ruby-runtime.zip not found under $RUBY_DIR" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/ruby-zip.XXXXXX")"
    EXTRACT="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/ruby-extract.XXXXXX")"
else
    STAGING="$(mktemp -d)"; EXTRACT="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING" "$EXTRACT"' EXIT

echo "==> Extracting ruby-runtime.zip..."
unzip -q "$RUNTIME_ZIP" -d "$EXTRACT"
# runtime zip is rooted at usr/ — strip that prefix.
[ -d "$EXTRACT/usr/lib/ruby" ] || { echo "runtime zip missing usr/lib/ruby" >&2; exit 1; }
[ -d "$EXTRACT/usr/bin" ] || { echo "runtime zip missing usr/bin" >&2; exit 1; }

echo "==> Staging ruby.zip tree..."
mkdir -p "$STAGING/bin" "$STAGING/lib"
# stdlib tree (lib/ruby/4.0.0/...)
cp -R "$EXTRACT/usr/lib/ruby" "$STAGING/lib/ruby"
# command suite from the runtime bin/, EXCEPT the interpreter itself
# (we use the instrumented ruby.wasm output for bin/ruby).
for f in "$EXTRACT/usr/bin/"*; do
    base="$(basename "$f")"
    [ "$base" = ruby ] && continue
    cp "$f" "$STAGING/bin/$base"
done
# The instrumented interpreter as bin/ruby (no .wasm extension).
cp "$RUBY_WASM" "$STAGING/bin/ruby"
chmod 755 "$STAGING/bin/"*

# Normalize wrapper shebangs to absolute /usr/bin/ruby so they resolve
# without a working /usr/bin/env (the kernel does no PATH search for the
# shebang interpreter). gem/bundle/bundler ship as #!/usr/bin/env ruby;
# make-install stubs already use #!/usr/bin/ruby (harmless to re-apply).
for w in gem bundle bundler irb erb racc rdoc ri; do
    f="$STAGING/bin/$w"
    [ -f "$f" ] || continue
    # only rewrite text scripts (skip if somehow binary)
    if head -c2 "$f" | grep -q '#!'; then
        sed -i.bak '1s|^#!.*ruby.*$|#!/usr/bin/ruby|' "$f" && rm -f "$f.bak"
    fi
done

# Exactly one regular executable named bin/ruby is required by the loader.
[ -f "$STAGING/bin/ruby" ] || { echo "bin/ruby missing" >&2; exit 1; }

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"; mkdir -p "$OUTPUT_DIR"; rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
```

Make both scripts executable:
`chmod 755 packages/registry/ruby-browser-bundle/build-ruby-browser-bundle.sh images/vfs/scripts/build-ruby-zip.sh`

Note on `sed -i`: on macOS BSD `sed`, `-i.bak` then removing `.bak` is
the portable form used above. If the dev shell provides GNU sed, it
still works. Verify the shebang was rewritten in Step 6.

- [ ] **Step 5: Build the package**

Run: `scripts/dev-shell.sh cargo run -p xtask -- build-deps --arch wasm32 resolve ruby-browser-bundle`
Expected: it resolves `ruby` (cached), runs the reshaper, and produces
`ruby.zip`. If `ruby` itself must build, that is expected on a cold
cache. If ABI validation rejects `kernel_abi = 15`, report it.

- [ ] **Step 6: Verify the zip's internal layout**

Confirm the archive is root-relative with exactly one `bin/ruby`, the
suite present, the stdlib under `lib/ruby/4.0.0`, no leading `usr/`, and
the normalized shebangs. Locate the resolved dir from Step 5
(`…/ruby-browser-bundle-*/ruby.zip`) and inspect:

```bash
scripts/dev-shell.sh bash -c '
  set -euo pipefail
  Z="$(cargo run -p xtask -- build-deps --arch wasm32 resolve ruby-browser-bundle | tail -1)/ruby.zip"
  echo "zip: $Z"
  unzip -l "$Z" | grep -E "bin/(ruby|gem|irb|bundle|bundler)|lib/ruby/4.0.0/" | head
  echo "--- must be zero (no usr/ prefix) ---"; unzip -l "$Z" | grep -c "^.*usr/" || true
  echo "--- exactly one bin/ruby ---"; unzip -l "$Z" | grep -c " bin/ruby$"
  echo "--- gem shebang normalized ---"; unzip -p "$Z" bin/gem | head -1
'
```
Expected: `bin/ruby`, `bin/gem`, `bin/irb`, `bin/bundle`, `bin/bundler`
and `lib/ruby/4.0.0/…` present; zero `usr/`-prefixed entries; exactly one
` bin/ruby`; `bin/gem` first line is `#!/usr/bin/ruby`.

- [ ] **Step 7: Confirm the `ruby` package was not modified**

Run: `git status --porcelain packages/registry/ruby`
Expected: empty.

- [ ] **Step 8: Commit**

```bash
git add packages/registry/ruby-browser-bundle/ images/vfs/scripts/build-ruby-zip.sh
git commit -m "$(cat <<'EOF'
Packages: Add ruby-browser-bundle lazy-archive

Reshape the ruby package's instrumented ruby.wasm plus its runtime tree
(gem/irb/bundle/bundler + lib/ruby/4.0.0) into a single root-relative
ruby.zip, mirroring vim-browser-bundle. bin/ruby is the fork-
instrumented interpreter output (not the runtime zip's pre-instrument
copy); wrapper shebangs are normalized to /usr/bin/ruby so they resolve
without /usr/bin/env. The ruby package is untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire ruby into the shell image (Node-side)

**Files:**
- Modify: `images/vfs/scripts/shell-lazy-archives.ts`
- Modify: `images/vfs/scripts/shell-vfs-build.ts`
- Modify: `images/vfs/scripts/source-rootfs-shell-overlay.ts`
- Modify: `packages/registry/shell/source-rootfs-shell-dependencies.json`
- Modify: `packages/registry/shell/package.toml`
- Modify: `packages/registry/shell/test-build-shell.sh`
- Modify: `packages/sets/local-supported.toml`
- Regenerate: `packages/registry/program-packages.json`

**Interfaces:**
- Consumes: `ruby-browser-bundle@4.0.5` producing `ruby.zip` (Task 1).
  The composer resolves it from
  `WASM_POSIX_DEP_RUBY_BROWSER_BUNDLE_DIR/ruby.zip`.
- Produces: `/usr/bin/ruby` (+ suite + stdlib) mounted in the shell VFS
  image; `/bin/ruby` symlink.

- [ ] **Step 1: Generalize the spec types and add the ruby entry**

In `images/vfs/scripts/shell-lazy-archives.ts`, widen the
`ShellLazyArchiveSpec` literal-union fields to `string` (keep
`mountPrefix` as-is or widen too), so future tools need no type surgery:

```ts
export interface ShellLazyArchiveSpec {
  id: string;
  dependency: string;
  resolverPath: string;
  archiveUrl: string;
  mountPrefix: "/usr/";
  requiredExecutable: string;
}
```

Add a third entry to `SHELL_LAZY_ARCHIVE_SPECS` after `nethack`:

```ts
  {
    id: "ruby",
    dependency: "ruby-browser-bundle",
    resolverPath: "programs/wasm32/ruby.zip",
    archiveUrl: "ruby.zip",
    mountPrefix: "/usr/",
    requiredExecutable: "bin/ruby",
  },
```

- [ ] **Step 2: Register the ruby archive in the composer**

In `images/vfs/scripts/shell-vfs-build.ts`, add a `populateRubyArchive`
mirroring `populateVimArchive`/`populateNetHackArchive`, using
`SHELL_LAZY_ARCHIVE_SPECS[2]`, and call it next to the other two
(after `populateNetHackArchive(fs, resolveArtifact);`):

```ts
function populateRubyArchive(
  fs: MemoryFileSystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  registerDeclaredShellLazyArchive(
    fs,
    SHELL_LAZY_ARCHIVE_SPECS[2],
    resolveArtifact,
  );
}
```
and at the call site:
```ts
  populateVimArchive(fs, resolveArtifact);
  populateNetHackArchive(fs, resolveArtifact);
  populateRubyArchive(fs, resolveArtifact);
```

- [ ] **Step 3: Add the `/bin/ruby` symlink**

In `images/vfs/scripts/source-rootfs-shell-overlay.ts`, add to the
hardcoded symlink list (alongside the vim/nethack entries):

```ts
    ["/usr/bin/ruby", "/bin/ruby"],
```

- [ ] **Step 4: Add the dependency-contract entry**

In `packages/registry/shell/source-rootfs-shell-dependencies.json`, add
after the `nethack-browser-bundle` object:

```json
    {
      "name": "ruby-browser-bundle",
      "version": "4.0.5",
      "role": "lazy-archive"
    }
```
(Add a comma after the preceding `}` as needed for valid JSON.)

- [ ] **Step 5: Add the matching `depends_on`**

In `packages/registry/shell/package.toml`, add after
`"nethack-browser-bundle@3.6.7",`:

```toml
  "ruby-browser-bundle@4.0.5",
```

- [ ] **Step 6: Bump the lazy-dependency count**

In `packages/registry/shell/test-build-shell.sh`, change the assertion
from `-eq 17` to `-eq 18` and update its message string (18 lazy
resolver dependencies). Do NOT change the shell `build.toml` revision
(29/UNPUBLISHED/pending — the contract change rides it, same as PR 1).

- [ ] **Step 7: Register the package in the build set**

In `packages/sets/local-supported.toml`, add a package block matching the
`vim-browser-bundle` entry (`class = "browser-product"`):

```toml
[[packages]]
name = "ruby-browser-bundle"
class = "browser-product"
```

- [ ] **Step 8: Regenerate the program-package index**

`packages/registry/program-packages.json` is generated. Regenerate it:

Run: `scripts/dev-shell.sh cargo run -p xtask -- program-package-index`
(Discover the exact subcommand/flags with
`scripts/dev-shell.sh cargo run -p xtask -- --help` if the name differs;
it is `cmd_program_package_index` in `tools/xtask/src/build_deps.rs`.)
Confirm the diff adds a `ruby-browser-bundle` entry with
`mirrorPath: "ruby.zip"`, `outputName: "ruby"` and does not spuriously
churn unrelated entries.

- [ ] **Step 9: Run the shell self-test**

Run: `scripts/dev-shell.sh bash packages/registry/shell/test-build-shell.sh`
Expected: `ok`. It runs the contract validator (JSON == depends_on), the
18-count assertion, and the hermetic composer. A failure naming
`WASM_POSIX_DEP_RUBY_BROWSER_BUNDLE_DIR` means the contract/depends_on/id
are out of sync; a count failure means Step 6 was missed.

- [ ] **Step 10: Typecheck the composer/image code**

Run: `scripts/dev-shell.sh npx tsc --noEmit -p apps/browser-demos/tsconfig.json`
(and any tsconfig covering `images/vfs`), confirming the generalized
`ShellLazyArchiveSpec` and the new populate function typecheck. Report
the command used. Pre-existing unrelated errors in other files are not
this task's concern; no NEW errors in the touched files.

- [ ] **Step 11: Commit**

```bash
git add images/vfs/scripts/shell-lazy-archives.ts \
        images/vfs/scripts/shell-vfs-build.ts \
        images/vfs/scripts/source-rootfs-shell-overlay.ts \
        packages/registry/shell/source-rootfs-shell-dependencies.json \
        packages/registry/shell/package.toml \
        packages/registry/shell/test-build-shell.sh \
        packages/sets/local-supported.toml \
        packages/registry/program-packages.json
git commit -m "$(cat <<'EOF'
Packages: Wire ruby into the shell image as a lazy-archive

Register ruby-browser-bundle as the shell's third lazy-archive
(alongside vim and nethack): generalize the archive-spec types, add the
composer registration and the /bin/ruby symlink, extend the dependency
contract and depends_on, register it in the build set, and regenerate
the program-package index. Mounts at /usr/, so ruby/gem/irb/bundle land
at /usr/bin and the stdlib at /usr/lib/ruby/4.0.0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire ruby into the browser host

**Files:**
- Modify: `apps/browser-demos/lib/init/lazy-archives.ts`
- Modify: `apps/browser-demos/lib/init/shell-lazy-url-contract.ts`
- Modify: `web-libs/kandelo-session/src/vfs-asset-group-reference.ts`

**Interfaces:**
- Consumes: the browser projection asset `programs/ruby.zip` (arch
  auto-inserted by Vite → `programs/wasm32/ruby.zip`), produced by Task 1.
- Produces: browser-host resolution of the `ruby.zip` lazy-archive URL,
  at parity with Node.

- [ ] **Step 1: Add the browser asset URL**

In `apps/browser-demos/lib/init/lazy-archives.ts`, add the import and
record entry:

```ts
import rubyZipUrl from "@binaries/programs/ruby.zip?url";
```
and in `SHELL_LAZY_ARCHIVES`:
```ts
  "ruby.zip": rubyZipUrl,
```

- [ ] **Step 2: Extend the unresolved-archive guard**

In `apps/browser-demos/lib/init/shell-lazy-url-contract.ts`, add
`ruby.zip` to the equality check:

```ts
  const unresolvedArchives = fs.exportLazyArchiveEntries().filter((entry) =>
    entry.url === "vim.zip" || entry.url === "nethack.zip" || entry.url === "ruby.zip"
  );
```

- [ ] **Step 3: Extend the asset-group reference map**

In `web-libs/kandelo-session/src/vfs-asset-group-reference.ts`, add
`ruby.zip`:

```ts
  if (reference === "vim.zip" || reference === "nethack.zip" || reference === "ruby.zip") {
    return `assets/programs/wasm32/${reference}`;
  }
```

- [ ] **Step 4: Typecheck**

Run: `scripts/dev-shell.sh npx tsc --noEmit -p apps/browser-demos/tsconfig.json`
Expected: no new errors; the `@binaries/programs/ruby.zip` import matches
the ambient wildcard module declaration (the actual asset exists from
Task 1's projection).

- [ ] **Step 5: Commit**

```bash
git add apps/browser-demos/lib/init/lazy-archives.ts \
        apps/browser-demos/lib/init/shell-lazy-url-contract.ts \
        web-libs/kandelo-session/src/vfs-asset-group-reference.ts
git commit -m "$(cat <<'EOF'
Browser: Resolve the ruby.zip lazy-archive asset

Map the ruby.zip archive URL to its projected browser asset and add it
to the unresolved-archive guard and the asset-group reference map, at
parity with vim/nethack, so the browser host fetches ruby on first exec.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Validate ruby end-to-end and document it

**Files:**
- Modify: shell demo/tool documentation, only if an enumeration exists.

**Interfaces:**
- Consumes: the built shell image with ruby wired.
- Produces: evidence ruby/gem/irb run in Node and browser; docs.

- [ ] **Step 1: Build the shell image**

Run: `scripts/dev-shell.sh ./run.sh local-build 2>&1 | tail -60`
(foreground; most deps cached). Expected: success; `shell.vfs.zst`
produced; the run resolves `ruby-browser-bundle` with no error.

- [ ] **Step 2: Confirm ruby is mounted in the image**

Inspect `local-binaries/source-only-v1/programs/wasm32/shell.vfs.zst`
(a small tsx/node script via `host/src/vfs/memory-fs`, as done for
sqlite3): confirm the lazy-archive registers `/usr/bin/ruby`,
`/usr/bin/gem`, `/usr/bin/irb`, `/bin/ruby`, and a `/usr/lib/ruby/4.0.0`
entry. Also confirm `local-binaries/source-only-v1/programs/wasm32/ruby.zip`
exists (browser asset). Report actual output.

- [ ] **Step 3: Node-host functional proof**

Boot the shell image under the Node host (as the sqlite3 track did) and
run:
- `ruby -e 'puts [1,2,3].sum'` → `6`
- `ruby -rjson -e 'puts JSON.generate({a:1})'` → `{"a":1}` (stdlib load)
- `gem --version` → a version string
- `irb` starting and evaluating `1+1` → `2` (REPL; reline/io-console)
Report exact commands + output. If a step legitimately cannot run,
report it honestly.

- [ ] **Step 4: Live browser proof**

Serve the app (`./run.sh browser` on a free port, avoiding stale servers
on 5401/5403 — export `WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and
`WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` if driving Vite directly) and drive
a Playwright check (model on
`apps/browser-demos/test/kandelo-merge-gate.spec.ts` +
`test/support/terminal-command.ts`): in the shell demo terminal,
`ruby -e 'puts [1,2,3].sum'` → `6`, `gem --version` → a version,
`command -v ruby` → `/usr/bin/ruby`. Delete the temp spec (do not
commit). Report the actual terminal text. Do NOT claim browser-verified
without the output.

- [ ] **Step 5: Document the native-extension boundary + toolset**

Update wherever the shell toolset is enumerated (grep as in the sqlite3
track — if none exists, no change). Document that `gem install` of gems
with native C extensions fails under Wasm today (a truthful boundary to
revisit when in-image native builds land); pure-Ruby gems and `irb`
work. Commit any doc change separately; skip if none.

---

## Self-Review

**Spec coverage (ruby slice):** dedicated `*-browser-bundle` package
(Task 1); reshape to root-relative `bin/<exe>`+stdlib (Task 1 Step 4);
`requiredExecutable` = `bin/ruby` and mount `/usr/` (Task 2 Step 1);
trust compiled prefix, no env file (Global Constraints; validated Task 3
Step 3/4); full ruby suite with normalized shebangs (Task 1 Step 4);
generalize archive-spec types (Task 2 Step 1); browser parity (Task 3);
native-extension boundary documented (Task 4 Step 5).

**Placeholder scan:** only intentional fill-in is `build.toml` `commit`
(Task 1 Step 2), flagged with the command to produce it.

**Type/name consistency:** dependency `ruby-browser-bundle@4.0.5`,
output `name = "ruby"` / `wasm = "ruby.zip"`, mirror `programs/wasm32/
ruby.zip`, `archiveUrl`/browser import `ruby.zip`, env key
`WASM_POSIX_DEP_RUBY_BROWSER_BUNDLE_DIR` (composer) and
`WASM_POSIX_DEP_RUBY_DIR` (bundle build), `requiredExecutable = "bin/ruby"`,
stdlib dir `4.0.0` — used consistently.

## Notes for the executor

- If `kernel_abi = 15` on the bundle conflicts with the shell image's
  ABI during composition, that is a real platform ABI question — report
  it with the exact error; do not silently change the value to make the
  build pass.
- If `cargo xtask program-package-index` churns unrelated entries or
  needs a specific flag, surface it; the generated file must be produced
  by the tool, not hand-edited.
- The `ruby` package's `ruby-runtime.zip` `usr/bin/ruby` is a
  pre-instrument copy — the reshaper deliberately drops it and uses the
  `ruby.wasm` output instead. Do not "simplify" by taking bin/ruby from
  the runtime zip.
