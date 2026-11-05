# Hard links and destination errors

Source revision 118 addresses the audited `fs.link`, `fs.linkSync` and
`fs.promises.link` gap (FS-006/016/017), without closing those broad findings
or the filesystem family. The exact audited Node 26.13.0 pin is unchanged.
The new guest source is uncompiled; accepted engine 116 is not current.

## Actual owners

The bundle selects the three complete public functions unchanged from the
already archive-verified pinned `lib/fs.js` and `internal/fs/promises.js`.
Their callback validation/order, file-URL/path validation, experimental VFS
handler dispatch, promise rejection and return shapes remain upstream code.
The existing metadata platform obtains the actual native binding; no file
copy, fabricated inode metadata or synchronous callback facade supplies links.

`path-metadata-operations.h` uses libc `link` and actual errno, with the
existing EINTR retry policy. `native-path-metadata.cpp` copies both pathnames
into native-owned storage. Sync dispatch retains both until the libc call
returns. Queued work retains and accounts for both until completion or
cancellation, with checked combined allocation sizes. It uses the existing
FSREQCALLBACK/FSREQPROMISE and native queue owners and their callback scope.

The shared `KandeloFsWork` completion owner now carries an optional error
destination independently from its source path. Both retain raw pathname
bytes until the shared UVException owner decodes them. Promise error creation
and callback completion receive both fields; single-path operations retain
an undefined destination. The public callback still receives only its error
(or null), rather than the private transport tuple.

The kernel already implements `sys_link` in
`crates/runtime-core/src/syscalls.rs`: source NOFOLLOW resolution, actual
inode aliases in tmpfs/rootfs, host delegation, namespace/permission checks,
exchange/FIFO registrations and cross-namespace EXDEV. No kernel/host wire,
syscall, ABI version or memory ceiling changes are made. The new virtual and
completion fields are private to the guest engine embedding and require its
next targeted compile, not an ABI restamp or a full product rebuild.

## Identified evidence

* `.context/node26-link-source-r2/report.json`: six pinned metadata reference
  files verified against the canonical archive, generated bundle/bootstrap
  checks, selected source identities and declared inputs. These are source
  checks, not guest-C++ compilation.
* `.context/node26-link-frontend-r2.json`: twelve controls pass: five new
  hard-link/shared-destination controls and seven affected metadata controls.
  Candidate public source and error conversion use explicit native Node
  filesystem/request boundaries. They cover inode sharing and lifetime after
  source unlink, sync validation and source/destination error fields,
  callback scope/arity and queued path copies, promises and the shared private
  completion tuple. They do not run the new guest C++.
* `.context/node26-hardlink-native-r3/report.json`: one final portable-owner
  program matches the exact native Node reference for real inode aliases,
  retained bytes/link counts, duplicate/missing/empty path errors, symlink
  behavior and a valid UTF8 byte pathname. Its output fields are not separate
  public-API test counts. Two helper compilations were performed; the final
  reference-only correction reused the second compiled owner unchanged.

Initial nonpasses remain preserved. Source check r1 caught an undeclared
changed `fs-truncate-adapter.js` input; the recipe now declares it.
 Frontend r1 has eleven passes/one failure:
the new fixture unconditionally read a symlink alias that macOS `link`
resolved to a regular file. It now compares actual link type and contents
against native Node without assuming a universal symlink policy. The kernel's
NOFOLLOW source branch is recorded separately and needs guest/platform
reconciliation; this slice does not declare it an accepted deviation.

Portable r1 retains failed setup for an invalid-byte filename: both C++ and
native Node encounter the development volume's rejection, with Node reporting
EILSEQ. The final ownership comparison uses a valid UTF8 byte pathname; this
does not establish invalid-byte creation support. Portable r2 retains a
link-count mismatch because the reference sampled after creating another
macOS alias while the owner sampled before. The reference measurement was
moved to the same operation boundary. No upstream test/assertion changed.

## Remaining obligations

* Compile the shared completion and two-path work owner through the normal
  targeted engine path, with source117's empty-input correction included.
* Exercise actual guest sync/callback/promise links, byte/URL paths, error
  descriptors/destinations, callback hooks, cancellation/close/shutdown,
  reentry, allocation/GC pressure and path mutation/lifetime on all four hosts.
* Reconcile inode ownership, symlink and permission semantics, EXDEV across
  actual guest namespaces and platform-specific source-link behavior.
* Use unchanged pinned upstream link and FS-error tests in the later
  applicable validation pass. Keep skipped/unsupported/timeouts/harness
  errors and historical native exception failures separate from passes.
* Continue independent audited family gaps. This slice does not implement
  statfs, watchers, cp/glob or other missing FS APIs, and establishes no
  whole-family, combined-candidate or four-host conformance.

No overall suite or full product rebuild ran for this slice.
