# Persistent VFS image plan

The current fixed-overwrite overlay is an opt-in prototype, not general
persistent rootfs support. Keep the immutable base image and its append-only
journal separate: a failed update must never rewrite the only bootable base.
The browser owns OPFS byte transport; the Rust kernel owns filesystem
semantics. Node and browser must expose the same guest-visible behavior.

## Milestones

- [x] Bind a checksummed journal to an exact base-image digest and recover
  complete transactions after a crash.
- [x] Boot an opt-in browser computer from its saved image and journal, with
  a guest write surviving reload.
- [x] Define and test the durability contract. A successful write is visible
  immediately; `fsync`/`fdatasync` must make preceding writes durable or
  report failure. Document what a crash may lose without a successful sync,
  and how writeback errors are surfaced. Keep the disk capacity, resident
  cache budget, and OPFS quota as distinct limits.
- [ ] Install a decoded, composed image into OPFS incrementally. Verify its
  identity and digest before publishing a generation. An interrupted install
  must leave the previous bootable generation untouched. Do not allocate an
  image-sized JavaScript or Wasm buffer while installing.
- [ ] Boot through positioned reads of that OPFS image, with a bounded clean
  block cache. The page, composer, browser host protocol, and kernel worker
  must not materialize the whole image. Demonstrate a read-only image larger
  than the configured runtime-memory budget on Chromium, Firefox, and WebKit.
- [ ] Add bounded dirty blocks with read-your-writes, eviction, `fsync`, and
  shutdown behavior. A failed journal write or flush must not silently discard
  dirty data or acknowledge durability. Test recovery at each failure point
  on Node and browser.
- [ ] Bound journal recovery and index memory with checkpoint/compaction and
  a crash-safe generation handoff. A corrupt or incomplete new generation
  must fall back to the prior valid one, never silently reset the computer.
- [ ] Replay regular-file size, inode, and namespace changes with POSIX
  semantics, including create, truncate, unlink, and rename. Preserve
  existing protections for deferred, digest-declared, and set-ID content.
- [ ] Validate complete guest workflows and performance. Exercise >RAM
  images, quota exhaustion, tab contention, browser termination, corruption,
  and recovery; run applicable POSIX/conformance and Node/browser benchmark
  suites before claiming general support or a speedup.

The first >RAM acceptance target is deliberately read-only. It proves that
boot and image reads no longer require an image-sized allocation before
writeback or namespace mutations complicate the result. A large declared
capacity alone does not satisfy this target: the actual decoded image must
exceed the chosen runtime-memory budget.

## Current boundaries

The browser prototype now streams composed output into OPFS with one
acknowledged chunk in flight, verifies the stored bytes, and publishes only
from the boot that still owns the session, under one exclusive lock. The next
installation reclaims abandoned generation files. Reopening uses positioned OPFS
reads and a bounded clean cache; fixed overwrites use a bounded dirty cache.
Initial source fetch, zstd decode, and image-writer loading still materialize
the source image. Journal block locations and recovery work still grow with
the number of distinct changed blocks. Rust can stage a verified compacted
copy without changing the source, but the host cannot yet atomically hand off
between journal generations. Crash-safe live compaction and persistent
namespace mutations remain separate milestones, not implicit guarantees of
the current fixed-overwrite mode.
