# Browser VFS Persistence: OPFS Snapshot Prototype

## Goal

Prototype persistent browser VFS images with OPFS only. The first version should
prove the load/save loop for a `MemoryFileSystem` image without introducing
IndexedDB, a journal format, or a chunk manifest yet.

## Prototype Scope

- Add a small OPFS-backed image store for whole VFS images.
- Keep the runtime filesystem memory-backed for syscall performance.
- Persist explicit snapshots by calling `MemoryFileSystem.saveImage()`.
- Restore snapshots by reading OPFS bytes and calling
  `MemoryFileSystem.fromImage()`.
- Use OPFS as an implementation detail, not as a direct mount for `/`.
- Keep project ids simple and path-safe: ASCII letters, numbers, `.`, `_`, `-`.

This is intentionally a snapshot primitive. The current API can support a
future async journal/checkpoint layer without changing the VFS image format.

## Current Implementation

`host/src/vfs/opfs-image-store.ts` exports `OpfsVfsImageStore`.

The store layout under the OPFS root is:

```text
kandelo-vfs-images/
  <project-id>/
    manifest-a.json
    manifest-b.json
    images/
      <generation>-<random>.vfs
```

Each save writes the image file first, then commits a small manifest to the
alternate manifest slot. Loads read both manifest slots, discard invalid JSON or
unknown versions, and use the highest valid generation. This gives the
prototype a simple recovery path if a tab closes while a manifest is being
written.

Example:

```typescript
import { MemoryFileSystem, OpfsVfsImageStore } from "wasm-posix-host/browser";

const store = await OpfsVfsImageStore.open({
  requestPersistentStorage: true,
});

const restored = await store.load("site-1", {
  maxByteLength: 1024 * 1024 * 1024,
});

const fs = restored ?? MemoryFileSystem.fromImage(baseImage, {
  maxByteLength: 1024 * 1024 * 1024,
});

// Run the kernel against fs, then snapshot at an app-defined moment.
await store.save("site-1", fs, {
  materializeAll: false,
  keepRevisions: 2,
});
```

## Expected Use

The first integration should be an explicit "Save site" / "Load site" path in a
demo, not autosave. That avoids conflating OPFS correctness with scheduling,
dirty tracking, and app UX.

## Handoff Status

This branch is a continuation prototype, not a final persistence system. It is
intended to give the next agent a working OPFS snapshot primitive plus enough
design context to integrate and harden it.

Implemented in this branch:

- `OpfsVfsImageStore.open()` opens a store directory below the origin private
  file system root and can request persistent browser storage as a best-effort
  hint.
- `save(projectId, fs)` snapshots a `MemoryFileSystem` through
  `MemoryFileSystem.saveImage()` and stores the bytes under OPFS.
- `saveBytes(projectId, image)` stores an already-built VFS image, which gives
  tests and future tooling a path that does not need a live filesystem object.
- `load(projectId)` reads the latest valid image and restores it through
  `MemoryFileSystem.fromImage()`.
- `loadBytes(projectId)` returns the raw image bytes for diagnostics, export
  flows, or tests.
- `getManifest(projectId)`, `listProjects()`, and `delete(projectId)` provide
  basic project management.
- The store validates project ids to a path-safe ASCII subset:
  letters, numbers, `.`, `_`, and `-`.
- Browser-facing exports were added from `host/src/browser.ts` and
  `host/src/vfs/index.ts`.
- `docs/architecture.md` now documents the snapshot-store pattern and links
  here for the longer design notes.

Known gaps before treating this as production-ready:

- Add automated tests for `OpfsVfsImageStore`. The cleanest unit tests should
  mock `FileSystemDirectoryHandle` / `FileSystemFileHandle` enough to cover
  manifest slot selection, corrupt-manifest fallback, pruning, delete, and
  project-id validation without depending on a real browser.
- Add at least one browser integration test that exercises real OPFS in
  Chromium. That test should save a small `MemoryFileSystem`, reload the page or
  reconstruct the store, and verify the filesystem contents survive.
- Wire a demo-level explicit Save/Load path. Do this before adding autosave so
  persistence bugs are separable from scheduling and UI policy.
- Decide where user-visible quota, persistence-denied, and OPFS-unavailable
  errors should surface. The store exposes storage estimate and persisted-state
  helpers, but it intentionally does not own app UX.
- Add multi-tab coordination before any background checkpoint loop. The current
  two-manifest commit scheme is crash-tolerant for a single writer, but it does
  not serialize concurrent writers from multiple tabs.
- Decide whether stored image files should use `.vfs` or `.vfs.zst` in the OPFS
  path. The bytes may already be compressed depending on `saveImage()` options;
  the current `.vfs` suffix is deliberately storage-internal.
- Consider schema migration handling before changing `STORE_VERSION`.
- Do not use this as POSIX `fsync()` durability. It persists explicit snapshots
  only.

Verification performed for this handoff:

- `cd host && npm run build` succeeds. The build still emits the existing CJS
  `import.meta` warnings from unrelated files.
- `cd host && npm test -- --run` was attempted. In this worktree it reported
  250 passing tests, 138 skipped tests, 16 failing tests, and 1 failing suite.
  The observed failures were all missing local binary fixtures such as
  `kernel.wasm`, `programs/wasm64/hello64.wasm`,
  `programs/wasm32/fork-exec.wasm`, `programs/wasm32/ifhwaddr.wasm`, and
  `programs/wasm32/mmap_shared_test.wasm`. Fetch or provide binaries with the
  repository's binary setup flow before using that result as a product signal.

After that works, add a background checkpoint loop:

- mark the VFS dirty after mutating syscalls;
- debounce saves while the kernel is active;
- skip saves when another save is in progress;
- surface quota or persistence failures to the page;
- keep a downloadable export as the user-visible escape hatch.

## Crash and Consistency Model

The prototype does not promise POSIX durability for every write. It persists
named snapshots:

- if the latest manifest is valid, load it;
- if the latest manifest is corrupt, load the previous valid slot;
- if the active image file is missing, report no image;
- old image files are best-effort pruned after a successful commit.

`fsync()` on `MemoryFileSystem` remains a no-op. Application-level persistence
comes from the snapshot call, not from kernel writeback semantics.

## Why Not Mount OPFS as `/`

`OpfsFileSystem` is useful for direct persistence under selected paths, but it
does not yet provide full POSIX behavior for symlinks, hardlinks, permissions,
or ownership. The snapshot store keeps the already-working
`MemoryFileSystem` semantics and uses OPFS only as durable bytes.

Direct OPFS mounts still make sense for special cases such as `/persistent`,
large database files, or imported/exported user data.

## Next Layer: Journal and Chunking

Once whole-image save/load is proven, the likely next iteration is:

1. Append a compact operation journal or dirty-file journal beside the latest
   snapshot.
2. Replay the journal into memory after loading the last compacted image.
3. Periodically compact by writing a new full image and truncating old journal
   segments.
4. Replace whole-image files with content-addressed chunks when full snapshots
   become too expensive.

The OPFS-only chunk layout can mirror the current snapshot layout:

```text
<project-id>/
  manifest-a.json
  manifest-b.json
  chunks/
    <sha256>
  journals/
    <generation>-<segment>.jsonl
```

The manifest would name the active root image/chunk tree plus the journal
segments required to reach the latest state.

## IndexedDB Future Work

IndexedDB is deliberately out of this prototype. It is still a good future
layer for:

- cross-browser fallback when OPFS is unavailable or unreliable;
- project lists, user metadata, snapshot labels, and migration state;
- transactional manifest commits for chunk roots and journal catalogs;
- a content-addressed chunk index keyed by hash;
- coordinating multiple storage backends from a single metadata plane.

The likely long-term design is OPFS for large byte storage and IndexedDB for
metadata/fallback. That should be added after the OPFS image path has real usage
data.
