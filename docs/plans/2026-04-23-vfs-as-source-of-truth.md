# VFS as Source of Truth — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Replace the kernel's hardcoded synthetic `/etc/*` files with a pre-seeded VFS image built from a `rootfs/` source tree + manifest. Add a `mkrootfs` TypeScript CLI to build/inspect/extract images. This is the foundation for the follow-up PR that adds full file-permission enforcement.

**Architecture:** A device-table-style manifest (`MANIFEST`) declares every file, directory, symlink, and device node that belongs in the image along with `uid:gid:mode`. File content comes from an implicit source tree (`rootfs/`), or from `src=path` overrides, or from relocatable zip archives with `base=/prefix`. The `mkrootfs` tool ingests this + the source tree and emits a `rootfs.vfs` image in `MemoryFileSystem`'s existing versioned binary format. At kernel-host init, both Node and browser load `rootfs.vfs` into a `MemoryFileSystem` that serves paths owned by the image; paths outside the image fall through to the existing `PlatformIO` backend. The kernel's `synthetic_file_content()` interception is deleted — `/etc/passwd` becomes a real file in the VFS.

**Tech Stack:** TypeScript 5 (`mkrootfs` tool, host), Rust (kernel, `no_std` on wasm), `tsup` build, `vitest` host tests, `cargo` kernel tests, SharedArrayBuffer-backed `SharedFS` for the in-memory filesystem, `Int32Array`/`DataView` for inode I/O.

---

## Scope and non-scope

**In scope (this PR):**
- Extend `SharedFS` inodes with `uid`/`gid` fields (use reserved bytes in the existing 128-byte inode — no size change, no version bump needed)
- `mkrootfs` CLI: `build`, `inspect`, `extract`, `add`
- Top-level `rootfs/` source tree + `MANIFEST`
- `scripts/build-rootfs.sh` that produces `host/wasm/rootfs.vfs`
- `build.sh` calls `build-rootfs.sh`
- `rootfs.vfs` is **not** committed to git (built on demand)
- Host init (Node + browser) loads `rootfs.vfs` into a `MemoryFileSystem`
- Kernel's `synthetic_file_content()` deleted along with its ~8 call sites
- An "overlay" PlatformIO on Node that routes paths owned by the image to `MemoryFileSystem` and everything else to `NodePlatformIO`
- Manifest grammar includes the `archive` directive with `base=/prefix` (relocatable zips) — v1 supports it end-to-end
- All 5 test suites green
- ABI snapshot check green

**Out of scope (follow-up PRs):**
- Phase 4: mount table in kernel (formal mounts for `/proc`, `/dev`)
- Phase 5: file permission enforcement (the `check_access` helper + wiring + runtime toggle)
- Lazy-loaded binary support in the core image (the `lazy=` archive variant that was mentioned as a future need)
- Per-mount config / `nosuid`/`noexec`
- Image persistence across runs (OPFS in browser, snapshot file on Node)

**Out of scope permanently / intentionally skipped:**
- Replacing `run-example.ts`'s builtin program resolver
- Changing how ported programs are stored/loaded
- Synthetic `/proc` and `/dev` interception (left alone — not in the way)

---

## Architectural decisions already made

These were settled before writing this plan. Do not re-open without a strong reason:

| Decision | Choice | Why |
|---|---|---|
| Tool language | TypeScript | Reuses `MemoryFileSystem.saveImage` directly — zero format drift risk |
| Source tree location | Top-level `rootfs/` | Matches Buildroot convention |
| Image commit to git | No, built on demand | No binary blobs in git; `build.sh` produces it |
| Manifest format | Device-table-ish (whitespace columns) | Readable, precedent in Buildroot/genext2fs/mke2fs |
| Archive support in v1 | Yes | Grammar is simple and we need it paired with a real consumer anyway |
| Archive base path | Optional `base=` field, defaults to `/` | Relocatable — same zip drops into `/usr` or `/usr/local` |
| Zip entries | Relative paths; leading `/` is tolerated with warning | Forgiving ingest, strict output |
| File collisions | Build-time error (two archives, or archive + explicit src=) | Deterministic images |
| Manifest override | Explicit manifest entry wins over archive-provided same-path | Mechanism for overriding package defaults |
| VFS image format | Same as today, no version bump | Adding uid/gid uses reserved bytes in 128-byte inode; v1 images naturally read as uid=gid=0 |

---

## Pre-flight verification (must hold before starting)

- Worktree: execute in a fresh worktree (e.g. `.worktrees/vfs-image` or a `.superset/worktrees/...` path per local convention), branch `vfs-as-source-of-truth`.
- Submodules: `git submodule update --init musl os-test libc-test` after worktree creation.
- `bash scripts/build-musl.sh` succeeds (sysroot at `sysroot/lib/libc.a`).
- `bash build.sh` succeeds (kernel wasm at `host/wasm/wasm_posix_kernel.wasm`).
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — baseline 707+ passing, 0 failing.
- `cd host && npx vitest run` — baseline 290+ passing, 0 failing.
- `scripts/run-libc-tests.sh` — 0 unexpected failures.
- `scripts/run-posix-tests.sh` — 0 FAIL.
- `scripts/run-sortix-tests.sh --all` — 0 FAIL, 0 XPASS.
- `bash scripts/check-abi-version.sh` — exit 0.

Record baseline numbers before starting Phase 0.

---

## Task list

Each task is a single TDD round + commit unless otherwise noted. Phase boundaries are just organizational — no enforced synchronization between phases; we commit frequently within each.

---

### Phase 0 — Metadata plumbing (SharedFS + kernel)

Goal: every file in the VFS can carry real `uid`/`gid`. No behavior change yet — just make the fields exist end-to-end and be readable/writable by syscalls.

---

#### Task 0.1: Add `INO_UID`/`INO_GID` offset constants to SharedFS

**Files:**
- Modify: `host/src/vfs/sharedfs-vendor.ts:94-103` (inode field offsets)
- Test: `host/test/sharedfs-uid-gid.test.ts` (create)

**Step 1: Write the failing test**

Create `host/test/sharedfs-uid-gid.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

describe("SharedFS uid/gid", () => {
  it("new file has uid=0 gid=0 by default", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", 0o1101, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
    fs.close(fd);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });
});
```

**Step 2: Run the test**

```
cd host && npx vitest run test/sharedfs-uid-gid.test.ts
```

Expected: FAIL — `StatResult.uid`/`gid` is likely undefined or returns stale SAB bytes (nonzero garbage possible on reused buffers).

**Step 3: Minimal implementation**

In `host/src/vfs/sharedfs-vendor.ts`, add under the existing `INO_*` block (after `INO_DOUBLE_INDIRECT = 92`):

```typescript
const INO_UID = 96;   // u32
const INO_GID = 100;  // u32
// 104-127 reserved for future: flags, xattrs pointer, etc.
```

Extend the `stat`/`lstat`/`fstat` paths to populate `uid` and `gid` in the returned `StatResult`. Find the existing stat builder (around `memory-fs.ts:1160` based on earlier grep — "mode: this.r32(off + INO_MODE)") and add:

```typescript
uid: this.r32(off + INO_UID),
gid: this.r32(off + INO_GID),
```

New files default to uid=0/gid=0 naturally because SAB is zero-initialized.

**Step 4: Run tests — verify passes**

```
cd host && npx vitest run test/sharedfs-uid-gid.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add host/src/vfs/sharedfs-vendor.ts host/test/sharedfs-uid-gid.test.ts
git commit -m "feat(vfs): add uid/gid inode fields to SharedFS"
```

---

#### Task 0.2: `SharedFS.chown`/`fchown` write `uid`/`gid`

**Files:**
- Modify: `host/src/vfs/sharedfs-vendor.ts` (find existing `chmod`/`fchmod` around line 1613-1634; add `chown`/`fchown` alongside)
- Test: extend `host/test/sharedfs-uid-gid.test.ts`

**Step 1: Add failing test**

Append to the describe block:

```typescript
it("chown changes uid/gid", () => {
  const sab = new SharedArrayBuffer(1024 * 1024);
  const fs = MemoryFileSystem.create(sab);
  const fd = fs.open("/hello", 0o1101, 0o644);
  fs.close(fd);
  fs.chown("/hello", 1000, 1000);
  const st = fs.stat("/hello");
  expect(st.uid).toBe(1000);
  expect(st.gid).toBe(1000);
});

it("fchown changes uid/gid via fd", () => {
  const sab = new SharedArrayBuffer(1024 * 1024);
  const fs = MemoryFileSystem.create(sab);
  const fd = fs.open("/hello", 0o1101, 0o644);
  fs.fchown(fd, 500, 600);
  fs.close(fd);
  const st = fs.stat("/hello");
  expect(st.uid).toBe(500);
  expect(st.gid).toBe(600);
});
```

**Step 2: Run — verify fails**

```
cd host && npx vitest run test/sharedfs-uid-gid.test.ts
```

Expected: FAIL — `fs.chown` likely doesn't exist on `SharedFS` (only `chmod`).

**Step 3: Implementation**

In `sharedfs-vendor.ts`, after the existing `chmod`/`fchmod` methods, add:

```typescript
chown(path: string, uid: number, gid: number): void {
  const ino = this.resolvePathToInode(path);
  const off = this.inodeOffset(ino);
  this.w32(off + INO_UID, uid);
  this.w32(off + INO_GID, gid);
  // Note: POSIX says chown may clear setuid/setgid bits; we'll handle that in
  // Phase 5 (permission enforcement). For now just store.
}

fchown(fd: number, uid: number, gid: number): void {
  const ino = this.fdToInode(fd);
  const off = this.inodeOffset(ino);
  this.w32(off + INO_UID, uid);
  this.w32(off + INO_GID, gid);
}
```

(If method names for inode resolution differ, mirror the pattern used by existing `chmod`/`fchmod`.)

Expose `chown`/`fchown` on `MemoryFileSystem` if not already done — per the earlier grep it's in the `FileSystemBackend` interface (`host/src/vfs/types.ts:33,66`). `MemoryFileSystem` should delegate:

```typescript
chown(path: string, uid: number, gid: number): void {
  this.fs.chown(path, uid, gid);
}
fchown(handle: number, uid: number, gid: number): void {
  this.fs.fchown(handle, uid, gid);
}
```

**Step 4: Run — verify passes**

```
cd host && npx vitest run test/sharedfs-uid-gid.test.ts
```

Expected: 3 passing.

**Step 5: Commit**

```bash
git add host/src/vfs/sharedfs-vendor.ts host/src/vfs/memory-fs.ts host/test/sharedfs-uid-gid.test.ts
git commit -m "feat(vfs): implement chown/fchown storing uid/gid"
```

---

#### Task 0.3: `SharedFS.open(..., mode)` seeds `INO_UID`/`INO_GID` from a caller-supplied owner

**Files:**
- Modify: `host/src/vfs/sharedfs-vendor.ts` (open — file creation path)
- Test: extend `host/test/sharedfs-uid-gid.test.ts`

The `mkrootfs` tool needs to create files with specific uid/gid at build time. Add an optional `opts` argument to `mkdir`/`open`/`symlink` OR a convenience `createWithOwner(path, type, uid, gid, mode)` helper on `SharedFS`. Pick whichever causes less churn in existing callers — likely a helper.

**Step 1: Failing test**

```typescript
it("createWithOwner sets uid/gid at creation", () => {
  const sab = new SharedArrayBuffer(1024 * 1024);
  const fs = MemoryFileSystem.create(sab);
  fs.createFileWithOwner("/etc/passwd", 0o644, 0, 0, new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"));
  const st = fs.stat("/etc/passwd");
  expect(st.uid).toBe(0);
  expect(st.gid).toBe(0);
  expect(st.mode & 0o777).toBe(0o644);
});
```

**Step 2: Run — verify fails**

Expected: FAIL — method doesn't exist.

**Step 3: Implementation**

Add `createFileWithOwner` (and `mkdirWithOwner`, `symlinkWithOwner`) to `MemoryFileSystem` that open, write, chown, chmod, close in one shot. These are convenience methods for `mkrootfs`; internals can layer on existing primitives.

**Step 4: Run — verify passes**

**Step 5: Commit**

```bash
git commit -m "feat(vfs): add createFileWithOwner/mkdirWithOwner/symlinkWithOwner helpers"
```

---

#### Task 0.4: Thread `uid`/`gid` through kernel `WasmStat`

**Files:**
- Verify: `crates/shared/src/lib.rs` (WasmStat struct — fields `st_uid`, `st_gid` should exist; they're in memory notes)
- Verify: `host/src/kernel.ts:683` (`host_stat` impl)
- Modify: if `host_stat` fills `st_uid`/`st_gid` with constants (e.g. always 0 or always 1000), change to read from `PlatformIO.stat(...).uid/gid`
- Test: `crates/kernel/src/syscalls.rs` cargo test

**Step 1: Investigate first**

```
grep -nE "st_uid|st_gid" host/src/kernel.ts
grep -nE "st_uid|st_gid" crates/kernel/src/syscalls.rs | head -20
```

If `host_stat` in `kernel.ts` already uses `stat.uid`/`stat.gid` from the `PlatformIO` return, no change needed here — skip to Step 3 verification. If it hardcodes a value, fix.

**Step 2: Write a cargo integration test (or adapt an existing one)**

In `crates/kernel/src/syscalls.rs`, add a test that creates a file via the mock host, calls `sys_stat`, and checks `st_uid`/`st_gid` reflect what the host returned. If one exists (per memory, tests at line 14137 reference synthetic passwd stat), extend rather than duplicate.

```rust
#[test]
fn test_sys_stat_returns_host_uid_gid() {
    let (mut proc, mut host) = make_proc();
    host.set_file_uid_gid("/foo", 1000, 1000);  // extend MockHost
    let st = sys_stat(&mut proc, &mut host, b"/foo").unwrap();
    assert_eq!(st.st_uid, 1000);
    assert_eq!(st.st_gid, 1000);
}
```

Extend `MockHost` in `crates/kernel/src/wasm_api.rs` or wherever the test mock lives to track uid/gid and return them in its `host_stat` impl.

**Step 3: Run — verify fails (or passes if already wired)**

```
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib test_sys_stat_returns_host_uid_gid -- --nocapture
```

**Step 4: Implement (if needed)**

**Step 5: Run full cargo test suite**

```
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
```

Expected: 707+ → 708+ (one new test), 0 failures.

**Step 6: Commit**

```bash
git commit -m "feat(kernel): propagate uid/gid through sys_stat"
```

---

#### Task 0.5: Thread `uid`/`gid` through `sys_chown`

Same pattern as Task 0.4 but for the write direction. Add a cargo test verifying `sys_chown(path, uid, gid)` calls `host.host_chown(path, uid, gid)` and a subsequent `sys_stat` returns the new values.

**Commit:** `feat(kernel): propagate uid/gid through sys_chown`

---

#### Task 0.6: Vitest round-trip — stat/chown via `MemoryFileSystem` under a simulated kernel

**Files:**
- Test: `host/test/memfs-uid-gid-kernel.test.ts` (create)

Exercise the full host-side chain: `MemoryFileSystem` used as the backing VFS for a kernel instance, user program calls stat/chown, verify the values round-trip. Use the existing centralized-test-helper.

**Commit:** `test(host): verify uid/gid round-trip through MemoryFileSystem-backed kernel`

---

### Phase 1 — `mkrootfs` TypeScript CLI

Goal: a tool that takes a source tree + manifest and emits a `.vfs` image. Covers all features we need for v1 including relocatable archives.

---

#### Task 1.1: Scaffold the tool package

**Files:**
- Create: `tools/mkrootfs/package.json`
- Create: `tools/mkrootfs/tsconfig.json`
- Create: `tools/mkrootfs/src/index.ts` (entry stub)
- Create: `tools/mkrootfs/README.md`

**Step 1: Create files**

`tools/mkrootfs/package.json`:

```json
{
  "name": "mkrootfs",
  "version": "0.1.0",
  "description": "Build and inspect wasm-posix-kernel rootfs VFS images",
  "type": "module",
  "bin": { "mkrootfs": "./bin/mkrootfs.mjs" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "wasm-posix-kernel": "file:../../host"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsup": "^8.0.0",
    "vitest": "^1.0.0"
  }
}
```

`tools/mkrootfs/src/index.ts`:

```typescript
#!/usr/bin/env node
const cmd = process.argv[2];
if (!cmd || cmd === "--help") {
  console.log("Usage: mkrootfs {build|inspect|extract|add} ...");
  process.exit(cmd ? 0 : 1);
}
console.error(`mkrootfs: unknown command "${cmd}"`);
process.exit(2);
```

**Step 2: Verify CLI runs**

```
cd tools/mkrootfs && npx tsx src/index.ts --help
```

Expected: prints usage, exits 0.

**Step 3: Commit**

```bash
git add tools/mkrootfs/
git commit -m "feat(mkrootfs): scaffold TypeScript CLI tool"
```

---

#### Task 1.2: Manifest parser — dirs and basic files

**Files:**
- Create: `tools/mkrootfs/src/manifest.ts`
- Test: `tools/mkrootfs/test/manifest.test.ts`

**Step 1: Failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/manifest";

describe("manifest parser", () => {
  it("parses directory entries", () => {
    const entries = parseManifest("/tmp  d  1777  0  0\n");
    expect(entries).toEqual([
      { kind: "node", path: "/tmp", type: "d", mode: 0o1777, uid: 0, gid: 0 },
    ]);
  });

  it("parses file entries with implicit source", () => {
    const entries = parseManifest("/etc/passwd  f  0644  0  0\n");
    expect(entries).toEqual([
      { kind: "node", path: "/etc/passwd", type: "f", mode: 0o644, uid: 0, gid: 0 },
    ]);
  });

  it("parses file entries with explicit src=", () => {
    const entries = parseManifest("/etc/foo  f  0644  0  0  src=configs/foo\n");
    expect(entries).toEqual([
      { kind: "node", path: "/etc/foo", type: "f", mode: 0o644, uid: 0, gid: 0, src: "configs/foo" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    const entries = parseManifest("# comment\n\n/tmp  d  1777\n");
    expect(entries).toHaveLength(1);
  });

  it("defaults uid/gid to 0 when omitted", () => {
    const entries = parseManifest("/tmp  d  1777\n");
    expect(entries[0]).toMatchObject({ uid: 0, gid: 0 });
  });

  it("parses octal mode without leading 0", () => {
    const entries = parseManifest("/tmp  d  755\n");
    expect(entries[0]).toMatchObject({ mode: 0o755 });
  });
});
```

**Step 2: Run — verify fails**

```
cd tools/mkrootfs && npx vitest run test/manifest.test.ts
```

Expected: FAIL (module not found).

**Step 3: Minimal implementation**

`tools/mkrootfs/src/manifest.ts`:

```typescript
export type NodeType = "d" | "f" | "l" | "c" | "b";

export interface ManifestNode {
  kind: "node";
  path: string;
  type: NodeType;
  mode: number;
  uid: number;
  gid: number;
  src?: string;
  target?: string;   // for symlinks
  major?: number;    // for devices
  minor?: number;
}

export interface ManifestArchive {
  kind: "archive";
  url: string;
  base: string;     // defaults to "/"
  fmode: number;
  dmode: number;
  uid: number;
  gid: number;
}

export type ManifestEntry = ManifestNode | ManifestArchive;

export function parseManifest(src: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/#.*$/, "").trim();
    if (!trimmed) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens[0] === "archive") {
      entries.push(parseArchive(tokens.slice(1), i + 1));
      continue;
    }
    entries.push(parseNode(tokens, i + 1));
  }
  return entries;
}

function parseNode(tokens: string[], lineNumber: number): ManifestNode {
  if (tokens.length < 3) {
    throw new Error(`manifest line ${lineNumber}: expected at least <path> <type> <mode>`);
  }
  const [path, type, modeStr, uidStr, gidStr, ...extras] = tokens;
  if (!["d", "f", "l", "c", "b"].includes(type)) {
    throw new Error(`manifest line ${lineNumber}: unknown type "${type}"`);
  }
  const node: ManifestNode = {
    kind: "node",
    path,
    type: type as NodeType,
    mode: parseOctal(modeStr, lineNumber),
    uid: uidStr ? parseInt(uidStr, 10) : 0,
    gid: gidStr ? parseInt(gidStr, 10) : 0,
  };
  for (const extra of extras) {
    const [k, v] = extra.split("=", 2);
    if (v === undefined) throw new Error(`manifest line ${lineNumber}: bad extra "${extra}"`);
    if (k === "src") node.src = v;
    else if (k === "target") node.target = v;
    else if (k === "major") node.major = parseInt(v, 10);
    else if (k === "minor") node.minor = parseInt(v, 10);
    else throw new Error(`manifest line ${lineNumber}: unknown field "${k}"`);
  }
  return node;
}

function parseArchive(tokens: string[], lineNumber: number): ManifestArchive {
  const archive: ManifestArchive = {
    kind: "archive",
    url: "",
    base: "/",
    fmode: 0o644,
    dmode: 0o755,
    uid: 0,
    gid: 0,
  };
  // First token may be base= or a positional base path (for optional /prefix syntax); keep it simple:
  // require base= explicit if overriding.
  for (const tok of tokens) {
    const [k, v] = tok.split("=", 2);
    if (v === undefined) throw new Error(`manifest line ${lineNumber}: bad archive field "${tok}"`);
    switch (k) {
      case "url":    archive.url = v; break;
      case "base":   archive.base = v; break;
      case "fmode":  archive.fmode = parseOctal(v, lineNumber); break;
      case "dmode":  archive.dmode = parseOctal(v, lineNumber); break;
      case "uid":    archive.uid = parseInt(v, 10); break;
      case "gid":    archive.gid = parseInt(v, 10); break;
      default: throw new Error(`manifest line ${lineNumber}: unknown archive field "${k}"`);
    }
  }
  if (!archive.url) {
    throw new Error(`manifest line ${lineNumber}: archive requires url=`);
  }
  return archive;
}

function parseOctal(s: string, lineNumber: number): number {
  if (!/^[0-7]+$/.test(s)) {
    throw new Error(`manifest line ${lineNumber}: invalid octal "${s}"`);
  }
  return parseInt(s, 8);
}
```

**Step 4: Run — verify passes**

```
cd tools/mkrootfs && npx vitest run test/manifest.test.ts
```

Expected: 6 passing.

**Step 5: Commit**

```bash
git commit -m "feat(mkrootfs): manifest parser for dirs, files, archives"
```

---

#### Task 1.3: Manifest parser — symlinks, device nodes, archive directives

**Files:** Extend the above tests and parser.

Test cases to add:
- `/etc/localtime  l  0777  0  0  target=/usr/share/zoneinfo/UTC`
- `/dev/null  c  0666  0  0  major=1  minor=3`
- `archive  url=./vim.zip  base=/usr  fmode=0644  dmode=0755`
- `archive  url=./system.zip  fmode=0644  dmode=0755` (default base=/)
- Error cases: `f` without src= but no implicit source (tested later); `archive` without `url=` (already enforced)

**Commit:** `test(mkrootfs): manifest parser handles symlinks, devices, archives`

---

#### Task 1.4: Image builder — directories and implicit-source files

**Files:**
- Create: `tools/mkrootfs/src/builder.ts`
- Test: `tools/mkrootfs/test/builder.test.ts`

**Step 1: Failing test**

Build an image from a minimal fixture (fixture files go in `tools/mkrootfs/test/fixtures/`):

```
fixtures/basic/rootfs/
  etc/passwd      "root:x:0:0:root:/root:/bin/sh\n"
fixtures/basic/MANIFEST:
  /         d  0755  0  0
  /etc      d  0755  0  0
  /etc/passwd  f  0644  0  0
  /tmp      d  1777  0  0
```

Test:

```typescript
import { buildImage } from "../src/builder";
import { readFileSync } from "node:fs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

it("builds an image from source tree + manifest", async () => {
  const image = await buildImage({
    sourceTree: "test/fixtures/basic/rootfs",
    manifest: "test/fixtures/basic/MANIFEST",
    repoRoot: process.cwd(),
  });
  const mfs = MemoryFileSystem.fromImage(image);
  const st = mfs.stat("/etc/passwd");
  expect(st.mode & 0o777).toBe(0o644);
  expect(st.uid).toBe(0);
  expect(st.gid).toBe(0);
  const buf = new Uint8Array(100);
  const fd = mfs.open("/etc/passwd", 0, 0);
  const n = mfs.read(fd, buf);
  mfs.close(fd);
  expect(new TextDecoder().decode(buf.subarray(0, n))).toContain("root:x:0:0");
  const tmpSt = mfs.stat("/tmp");
  expect(tmpSt.mode & 0o777).toBe(0o1777 & 0o777);
});
```

**Step 2: Run — verify fails** (builder not implemented)

**Step 3: Implementation**

`tools/mkrootfs/src/builder.ts`:

```typescript
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { parseManifest, type ManifestEntry, type ManifestNode } from "./manifest";

export interface BuildOptions {
  sourceTree: string;     // absolute or repo-relative; rootfs/ typically
  manifest: string;       // path to MANIFEST
  repoRoot: string;       // used to resolve src= paths
  sabSize?: number;       // default 16 MiB
}

export async function buildImage(opts: BuildOptions): Promise<Uint8Array> {
  const manifestText = readFileSync(resolve(opts.manifest), "utf8");
  const entries = parseManifest(manifestText);

  const sab = new SharedArrayBuffer(opts.sabSize ?? 16 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);

  // Pass 1: directories (sorted by path depth so parents exist first)
  const dirs = entries.filter(e => e.kind === "node" && e.type === "d") as ManifestNode[];
  dirs.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const d of dirs) {
    if (d.path === "/") continue;  // root exists
    mfs.mkdirWithOwner(d.path, d.mode, d.uid, d.gid);
  }

  // Pass 2: files (implicit source-tree or src=)
  const files = entries.filter(e => e.kind === "node" && e.type === "f") as ManifestNode[];
  for (const f of files) {
    const contentPath = f.src
      ? resolve(opts.repoRoot, f.src)
      : resolve(opts.sourceTree, f.path.replace(/^\//, ""));
    const content = readFileSync(contentPath);
    mfs.createFileWithOwner(f.path, f.mode, f.uid, f.gid, new Uint8Array(content));
  }

  // Pass 3: symlinks
  const symlinks = entries.filter(e => e.kind === "node" && e.type === "l") as ManifestNode[];
  for (const l of symlinks) {
    if (!l.target) throw new Error(`symlink ${l.path} missing target=`);
    mfs.symlinkWithOwner(l.target, l.path, l.uid, l.gid);
  }

  // Pass 4: archives (Task 1.7)
  // Pass 5: device nodes (v1 can skip — kernel handles /dev/* synthetically anyway)

  return mfs.saveImage();
}
```

**Step 4: Run — verify passes**

Expected: 1 passing in `test/builder.test.ts`.

**Step 5: Commit**

```bash
git commit -m "feat(mkrootfs): image builder for dirs and implicit-source files"
```

---

#### Task 1.5: Builder — explicit `src=` override

**Step 1: Add failing test**

```typescript
it("resolves src= to paths relative to repoRoot", async () => {
  // fixture: MANIFEST has "/etc/mytool  f  0644  0  0  src=extras/tool.conf"
  //         extras/tool.conf  "some config\n"
  const image = await buildImage({
    sourceTree: "test/fixtures/explicit-src/rootfs",
    manifest: "test/fixtures/explicit-src/MANIFEST",
    repoRoot: "test/fixtures/explicit-src",
  });
  const mfs = MemoryFileSystem.fromImage(image);
  // verify content
});
```

**Step 2-4:** Builder already handles `src=` via the ternary above. If test passes now, remove the test? No — keep it as a regression guard. If test fails, fix the builder.

**Step 5: Commit** `test(mkrootfs): verify explicit src= override`

---

#### Task 1.6: Builder — collision detection (within `rootfs/` vs manifest)

Rule: every file under `sourceTree` must appear in the manifest as an entry with matching path (`f` type, no `src=`, or intentional `src=` override to a different file).

**Step 1: Failing test**

Fixture that drops `rootfs/.DS_Store` without a manifest entry.

```typescript
it("errors when source tree has files not in manifest", async () => {
  await expect(buildImage({
    sourceTree: "test/fixtures/stray-file/rootfs",
    manifest: "test/fixtures/stray-file/MANIFEST",
    repoRoot: "test/fixtures/stray-file",
  })).rejects.toThrow(/not in manifest/);
});
```

**Step 3: Implementation**

Walk `sourceTree` with `fs.readdir` recursively, build a set of paths, compare against manifest `f`-entries. Error if a file-path-on-disk has no manifest entry.

**Step 5: Commit** `feat(mkrootfs): reject source-tree files missing from manifest`

---

#### Task 1.7: Builder — archive directive (relocatable, `base=`)

**Files:** extend `builder.ts`; new test fixture with a precomputed zip.

**Step 1: Add failing test**

Need a fixture zip. Easiest: commit a tiny zip directly (`test/fixtures/archive/vim-mini.zip` — contains `bin/vim` → "fake vim binary\n" and `share/vim/vim91/vimrc` → "set ai\n"). Or build it on the fly in the test setup with a small helper.

```typescript
it("registers archive entries with base= prefix", async () => {
  const image = await buildImage({
    sourceTree: "test/fixtures/archive/rootfs",
    manifest: "test/fixtures/archive/MANIFEST",  // declares archive with base=/usr
    repoRoot: "test/fixtures/archive",
  });
  const mfs = MemoryFileSystem.fromImage(image);
  // Before materialization, the lazy stub exists
  const st = mfs.stat("/usr/bin/vim");
  expect(st.mode & 0o777).toBe(0o644);  // from fmode=
  // Materialize the archive (would normally happen on first read)
  // For test: call mfs.ensureArchiveMaterialized(group) or trigger via read
  const fd = mfs.open("/usr/bin/vim", 0, 0);
  // ... read content
  mfs.close(fd);
});
```

**Step 3: Implementation**

```typescript
// In builder.ts, after Pass 3:
const archives = entries.filter(e => e.kind === "archive") as ManifestArchive[];
for (const a of archives) {
  const archivePath = resolve(opts.repoRoot, a.url);
  const zipBytes = readFileSync(archivePath);
  const { parseZipCentralDirectory, extractZipEntry } = await import("../../../host/src/vfs/zip");
  const zipEntries = parseZipCentralDirectory(new Uint8Array(zipBytes));

  // Normalize base: no trailing /, empty string if "/"
  const base = a.base === "/" ? "" : a.base.replace(/\/+$/, "");

  // Leading-slash-tolerance: strip leading / from zip entry paths
  const normalizedEntries = zipEntries.map(ze => ({
    ...ze,
    fileName: ze.fileName.replace(/^\/+/, ""),
  }));

  mfs.registerLazyArchiveFromEntries(a.url, normalizedEntries, base);
  // Apply per-archive default metadata (fmode/dmode/uid/gid) to the stubs:
  for (const ze of normalizedEntries) {
    if (ze.isDirectory) continue;
    const vfsPath = base + "/" + ze.fileName;
    mfs.chmod(vfsPath, a.fmode);
    mfs.chown(vfsPath, a.uid, a.gid);
  }
}
```

Note: `registerLazyArchiveFromEntries` as shown in `memory-fs.ts:144-190` creates stubs via `fs.open(..., 0o1101, ze.mode)` — that uses the zip's embedded mode. We override via chmod after. Alternatively, extend `registerLazyArchiveFromEntries` to accept default modes (better but bigger change). Pick the one the executing session thinks is cleaner.

**Step 4: Run — verify passes**

**Step 5: Commit** `feat(mkrootfs): support archive directive with base= prefix`

---

#### Task 1.8: Builder — collision detection between archives and explicit entries

**Step 1: Failing test** — two archives both shipping `usr/bin/foo`; explicit manifest entry overlapping with archive path.

**Step 3: Implementation**

Before writing any content, accumulate the set of paths each archive claims (from its TOC + base). Check for:
1. Path in archive A and archive B → error
2. Path in archive + explicit `f` entry with no `src=` → error (implicit overrides aren't supported; overriding requires explicit `src=`)
3. Path in archive + explicit `f` entry with `src=` → explicit wins; mark archive entry as "deleted" before stub creation (use `LazyArchiveFileEntry.deleted=true`)

**Step 5: Commit** `feat(mkrootfs): collision detection for archives + explicit entries`

---

#### Task 1.9: `mkrootfs inspect` command

**Step 1: Test** — after building the basic fixture, run inspect, expect to see `/etc/passwd` with `0644 0:0` in the output.

**Step 3: Implementation**

```typescript
// tools/mkrootfs/src/inspect.ts
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { readFileSync } from "node:fs";

export function inspectImage(imagePath: string): void {
  const image = new Uint8Array(readFileSync(imagePath));
  const mfs = MemoryFileSystem.fromImage(image);
  // Walk the VFS and print each entry:
  walk(mfs, "/");
}

function walk(mfs: MemoryFileSystem, path: string): void {
  const st = mfs.stat(path);
  const type = typeChar(st.mode);
  const modeOctal = (st.mode & 0o7777).toString(8).padStart(4, "0");
  console.log(`${type}${modeOctal}  ${st.uid}:${st.gid}  ${path}`);
  if ((st.mode & 0o170000) === 0o040000) {  // S_IFDIR
    const entries = mfs.readdir(path);
    for (const e of entries) {
      if (e.name === "." || e.name === "..") continue;
      walk(mfs, path === "/" ? `/${e.name}` : `${path}/${e.name}`);
    }
  }
}
```

Wire into `index.ts`.

**Step 5: Commit** `feat(mkrootfs): inspect command`

---

#### Task 1.10: `mkrootfs extract` command

Reverse of build — walk the image, write files to disk, emit a generated `MANIFEST` alongside. Useful for debugging images and for auditing.

**Commit:** `feat(mkrootfs): extract command`

---

#### Task 1.11: `mkrootfs add` command

Inject a single file into an existing image. Useful for development — iterate on a single file without rebuilding the whole image.

**Commit:** `feat(mkrootfs): add command`

---

#### Task 1.12: End-to-end CLI bash test

**Files:**
- Test: `tools/mkrootfs/test/cli.sh` or integrate into vitest via child_process

Exercise the full pipeline via `npx tsx src/index.ts build ...`.

**Commit:** `test(mkrootfs): end-to-end CLI smoke test`

---

### Phase 2 — Default `rootfs/` tree + build wiring

---

#### Task 2.1: Create `rootfs/etc/*` content

**Files:** `rootfs/etc/passwd`, `group`, `hosts`, `shadow`, `hostname`, `resolv.conf`, `nsswitch.conf`, `os-release`, `profile`, `motd`.

Contents listed in the earlier discussion. Content for `/etc/passwd` / `/etc/group` / `/etc/hosts` should mirror the current `synthetic_file_content()` strings so behavior parity is maintained for existing tests. Expand to include `daemon`/`nobody` entries since real programs look for them.

**Commit:** `feat(rootfs): add /etc/* content files`

---

#### Task 2.2: Create `MANIFEST`

Full device-table manifest covering all entries from the earlier discussion plus `rootfs/etc/*` with `src=` implicit.

**Commit:** `feat(rootfs): add MANIFEST with canonical directory tree`

---

#### Task 2.3: `scripts/build-rootfs.sh`

```bash
#!/bin/bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/host/wasm/rootfs.vfs"
mkdir -p "$(dirname "$OUT")"
cd "$REPO_ROOT/tools/mkrootfs"
npx tsx src/index.ts build "$REPO_ROOT/rootfs" "$REPO_ROOT/MANIFEST" -o "$OUT"
echo "Built: $OUT ($(wc -c < "$OUT") bytes)"
```

**Commit:** `feat(build): add scripts/build-rootfs.sh`

---

#### Task 2.4: Wire into `build.sh`

```bash
# After kernel wasm copy, before TypeScript host build:
echo "Building rootfs image..."
bash scripts/build-rootfs.sh
```

**Commit:** `feat(build): call build-rootfs.sh from build.sh`

---

#### Task 2.5: `.gitignore` `host/wasm/rootfs.vfs`

**Commit:** `chore: .gitignore rootfs.vfs build output`

---

### Phase 3 — Load rootfs at init; remove synthetic-file interception

---

#### Task 3.1: Investigate current VFS wiring on Node

Task for the executing engineer — produce a short Markdown note in the PR description:

- Where does `host_open` on Node actually hit disk? (Answer: `NodePlatformIO` passes through to real host fs via `fs.openSync`.)
- What happens when a program opens `/etc/passwd` today? (Answer: kernel intercepts via `synthetic_file_content()` BEFORE calling `host_open`, returning `SYNTHETIC_FILE_HANDLE = -100`. So `NodePlatformIO` never sees it.)
- For the rootfs migration, we need an overlay in the **host** that routes certain paths to a `MemoryFileSystem` loaded from `rootfs.vfs`. What does that overlay look like?

Write findings to `docs/plans/2026-04-23-vfs-as-source-of-truth-notes.md`.

**Commit:** `docs: investigation notes for VFS wiring`

---

#### Task 3.2: `OverlayPlatformIO` — host-side routing layer

**Files:**
- Create: `host/src/platform/overlay.ts`
- Test: `host/test/overlay-platform-io.test.ts`

Implements `PlatformIO` by dispatching each operation to either `MemoryFileSystem` (if the path is "owned" by the image) or a fallback `PlatformIO` (typically `NodePlatformIO`).

"Owned" = the `MemoryFileSystem` has any entry at or under that path. Implementation: at construction, walk the `MemoryFileSystem` and precompute a prefix set of owned roots. On each op, check if `path` starts with any owned root. Cache the check per path.

```typescript
export class OverlayPlatformIO implements PlatformIO {
  private ownedRoots: string[];
  constructor(
    private memfs: MemoryFileSystem,
    private fallback: PlatformIO,
  ) {
    this.ownedRoots = this.computeOwnedRoots(memfs);
  }

  private isOwned(p: string): boolean {
    for (const root of this.ownedRoots) {
      if (p === root || p.startsWith(root === "/" ? "/" : root + "/")) return true;
    }
    return false;
  }

  open(path: string, flags: number, mode: number): number {
    if (this.isOwned(path)) return this.memfsOpen(path, flags, mode);
    return this.fallback.open(path, flags, mode);
  }
  // ... etc. for every PlatformIO method
}
```

Handle handle-namespace collision: memfs handles and node fs handles overlap numerically. Either (a) offset memfs handles by a large constant (e.g. add 0x40000000) at open, strip at close/read/write; or (b) keep a `Map<handle, "memfs" | "node">`.

**Step 1-5: TDD loop** — test open/read/write/stat on both owned and fallback paths, verify they route correctly.

**Commit:** `feat(platform): OverlayPlatformIO routes paths to memfs or fallback`

---

#### Task 3.3: Load `rootfs.vfs` in `NodeKernelHost.init`

**Files:**
- Modify: `host/src/node-kernel-host.ts` (or the kernel-worker init code it drives)

Read `host/wasm/rootfs.vfs`, construct `MemoryFileSystem.fromImage()`, wrap a new `OverlayPlatformIO` around `NodePlatformIO`, pass to the kernel config.

If `rootfs.vfs` is missing, log a warning and fall back to plain `NodePlatformIO` (keeps dev loop working when someone hasn't built yet — though they'll hit missing `/etc/passwd` failures downstream).

**Commit:** `feat(host): Node kernel loads rootfs.vfs at init`

---

#### Task 3.4: Load `rootfs.vfs` in `BrowserKernel`

**Files:**
- Modify: `host/src/browser.ts` or wherever `BrowserKernel` lives

Browser path is similar but the image comes via `fetch()`. Since the browser already uses `MemoryFileSystem` exclusively (no `NodePlatformIO` fallback), the OverlayPlatformIO here is effectively just the `MemoryFileSystem` — or equivalently, just use `MemoryFileSystem` directly loaded from the image.

**Commit:** `feat(host): browser kernel loads rootfs.vfs at init`

---

#### Task 3.5: Remove synthetic file interception from the kernel

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — delete `synthetic_file_content()` (lines ~99-111) and `SYNTHETIC_FILE_HANDLE` constant (line ~100). Remove all call sites — per the earlier grep, lines 248, 469, 887, 1219-1267, 1294, 1843, 1874, 1877.
- Remove associated cargo tests that check synthetic behavior (around line 14137-14205) — or rewrite them to use mock host with pre-populated `/etc/passwd`.

**Step 1: Run the full cargo test suite**, record which tests reference synthetic behavior.

**Step 2: Delete the function and call sites.**

**Step 3: Rerun cargo tests** — synthetic-behavior tests will fail. For each, either delete (if it was testing synthetic mechanism) or rewrite (if it was testing "opening /etc/passwd returns content X" — which now goes through the VFS).

**Step 4: Run the full 5-suite gauntlet.**

```
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run && cd ..
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

Everything that passed at baseline must pass now. If a new failure appears, triage:
- Test expected synthetic content → rewrite to expect image-sourced content
- Test expected read-only semantics on `/etc/passwd` → now it's writable; either keep that in the test (expect EACCES, which won't come until Phase 5) or accept the new behavior
- Test wrote to `/etc/foo` and expected it to persist → it does, in-memory

**Commit:** `refactor(kernel): remove synthetic file interception`

---

#### Task 3.6: Smoke test — `getpwent` from rootfs image

Ship a smoke-test C program (we already prototyped one in the prior session) that exercises `setpwent`/`getpwent`/`getpwnam`/`getpwuid` and verifies the output matches what `rootfs/etc/passwd` contains. Add it to the vitest suite.

**Commit:** `test(host): getpwent round-trip via rootfs image`

---

#### Task 3.7: Update `docs/architecture.md`

Sections to update:
- VFS model: describe the rootfs image, overlay PlatformIO, where the source of truth lives
- Build: add `build-rootfs.sh` to the list of artifacts
- "Synthetic files" section, if any, should be rewritten or removed

**Commit:** `docs(arch): update VFS section for image-based rootfs`

---

#### Task 3.8: Run all 5 test suites and the ABI check — FINAL

Record the new numbers. Compare against baseline:

- cargo: baseline 707+ → now ~707 (+/- depending on deleted synthetic tests)
- vitest: baseline 290+ → now +3 (new uid/gid + getpwent tests)
- libc-test: 0 FAIL unchanged
- POSIX: 0 FAIL unchanged (XFAILs don't change — target 4 work is separate)
- sortix: 0 FAIL unchanged
- ABI: exit 0 unchanged

**Commit** (only if needed for bookkeeping; otherwise skip).

---

#### Task 3.9: Open the PR

Use `superpowers:requesting-code-review` to verify work meets requirements before pushing.

```
git push -u origin vfs-as-source-of-truth
gh pr create --title "feat: VFS as source of truth — rootfs image replaces synthetic files" --body "..."
```

PR body should include:
- Summary of the 3-phase change
- Baseline → post numbers for all 5 suites
- Note that this is foundational for the follow-up file-permissions PR
- Screenshots / output of `mkrootfs inspect host/wasm/rootfs.vfs`

Merge via the PR — do not push directly to main.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `OverlayPlatformIO` handle-namespace collision between memfs handles and Node fs handles | High | Offset memfs handles by `0x40000000` at open; strip in close/read/write; covered by the overlay tests |
| Existing tests that wrote to `/etc/foo` and expected host persistence | Low | None today (synthetic files were read-only; no test writes to /etc/*). Verify with grep before Phase 3 lands. |
| Sortix tests open paths like `/home/user/something` with host-persistence assumptions | Medium | The overlay owns `/home/user` as a directory (empty). Writes go to memfs, persist within one test process. If a test spans processes and expects cross-process persistence on the host side, it'll break — triage by name. |
| ABI change | Low | Removing `synthetic_file_content` doesn't change exports, struct layout, or syscall numbers. `check-abi-version.sh` should stay green. Bump `ABI_VERSION` only if it flags. |
| `registerLazyArchiveFromEntries` can't handle empty `mountPrefix` (base="/") | Medium | Fix the slice math in `memory-fs.ts:301`; covered by the archive tests in Task 1.7. |
| PHP/WordPress/MariaDB demos lose state because `/tmp`, `/var/*` are now in-memory | Low for v1 (demos start fresh each run anyway) | If it bites, add a "host-backed" mount at specific paths as a follow-up |
| `rootfs.vfs` not found because developer didn't run `build.sh` | Low | Host init logs a loud warning and falls back; also document in README |

---

## Definition of done

- [ ] All 9 major task groups complete and committed
- [ ] All 5 test suites pass with no regressions vs baseline
- [ ] `bash scripts/check-abi-version.sh` exits 0
- [ ] `mkrootfs build`/`inspect`/`extract`/`add` all work from CLI
- [ ] `host/wasm/rootfs.vfs` is produced by `build.sh`
- [ ] `synthetic_file_content()` and `SYNTHETIC_FILE_HANDLE` are gone from the kernel
- [ ] `/etc/passwd` read by a test program matches `rootfs/etc/passwd` byte-for-byte
- [ ] `docs/architecture.md` reflects the new model
- [ ] PR opened, reviewed, merged via PR (not direct push)

---

## Handoff for Phase 5 (next PR, not this one)

The following land cleanly on top of this PR's work:

- Every file in the VFS now has honest `uid`/`gid`/`mode` — the `check_access` helper has real data to check against
- The `OverlayPlatformIO` pattern means permission checks on the host side can be centralized in one wrapper
- Runtime toggle for permission enforcement (off by default) can be added as a single `AtomicBool` in kernel config + one branch in `check_access`
- No further VFS work needed for Phase 5 — just wire checks into `sys_open`/`sys_access`/`sys_chmod`/`sys_chown`/pathwalk

See `docs/compromising-xfails.md` target 4 for the tests this unlocks.
