# Filesystem removal implementation dependencies

FS-012 and FS-014 remain partial. The source candidate now has real removal
owners, not a completed filesystem family or validated guest API. Target
Node 26.13.0, its exact source/native pins and the frozen audit are unchanged.
No overall suite, target package/engine compilation or full rebuild ran.

## Source implementation

The public sync, callback and promise rm wrappers and their option validators
are exact checked sections from lib/fs.js, internal/fs/promises.js and
internal/fs/utils.js. Full unchanged internal/fs/rimraf.js owns async traversal,
parallel child completion, races, ENOENT handling and retry/backoff. Public
validation/order, default spreading, false/undefined distinctions, force,
recursive, URL/Uint8Array paths and VFS return paths therefore have actual
algorithm owners. Force suppresses missing paths, not permission failures.

removal-operations.h owns actual std::filesystem symlink_status/remove/remove_all
for the synchronous backend, as the pinned Node native source does. It keeps
the POSIX retryable error set, number of attempts, whole-second sleep conversion,
last failed-attempt delay and specific/unknown error mapping. Existing symlinks
are removed rather than traversed as directory children. This uses the normal
existing guest libc++/libc/kernel namespace and credentials, not host paths or
C remove(). Native std::filesystem behavior still requires a target build.
The maxRetries uint32 input crosses the target's native signed-int32 boundary.
The candidate makes two's-complement delay multiplication explicit to avoid
undefined signed overflow; exact extreme-option overflow behavior remains an
unresolved target-fidelity question, not a proven compatibility guarantee.

The raw directory scanner owns a real opendir/readdir/closedir resource. It
copies bytes before readdir advances, excludes dot entries, sorts raw names
like libuv scandir and preserves syscall failures. Exceptions unwind the DIR
owner. The JSAPI work object copies the input path before submission, roots
its actual FSReqCallback and Buffer prototype, and carries only native memory
on the worker. On the owning realm, before callback scope entry, it allocates
independent ArrayBuffers/views for the names and retains them in the real
request's result slot. Queue cancellation/shutdown/retirement use the existing
shared native FS owner. Completed native payload is accounted before JS
allocation and retired with the work owner. Queued cancellation does not undo
an already running operation. This JSAPI source remains uncompiled.

Patch 70 includes/registers both native operations after the existing FS
owners. Recipe 56 declares/copies inputs. The Node/browser host adapters all
select this same guest implementation. There is no new host import, syscall,
wire structure, kernel semantic change or ABI bump in this slice.

## Evidence and limits

Twelve focused source controls pass: seven removal scenarios and five affected
directory controls. Eight additional scenarios select the compiled native
portable helper for synchronous deletion and a real raw scanner comparison.
The seven repeated frontend scenarios are not seven new API coverage claims.
Native Node provides the engine, request/metadata/async directory operations,
timer/byte/path/UV/error dependencies at explicit fixture boundaries.
Transient asynchronous unlink failures exercise real scheduled retries; this
is controlled fault injection in a fixture, not fabricated runtime behavior.
Synchronous retry timing and transient native filesystem failures were not
runtime-validated. Raw invalid-byte filename creation on the APFS control host
was already unsupported in the prior directory evidence; this run adds no
claim that guest raw filenames have been validated.

Three unchanged upstream files pass once as candidate and once as native:
test-fs-rm.js, test-fs-rmSync-special-char.js and its additional-error file.
The candidate selects public removal algorithms and the compiled portable
sync owner through an explicit helper transport. Other filesystem APIs,
engine/requests/assert/common and OS remain native controls. The full rm file
also directly exercises native internal/fs/utils; those direct internal checks
are native, not candidate evidence. Standard host-conditioned permission
assertions remain unchanged. No platform identity or assertion was changed.
These are three file outcomes per mode, not a public API conformance count.

The first focused run passed 11 controls and failed its retry assertion because
the fixture installed directory wrappers after its fault injection, overwriting
the injected unlink. The fixture now installs its scoped injection last. The
same retry assertions pass; original raw failure and exact input/helper copies
remain retained. This was a fixture defect, not a diagnosed outside-runtime
failure. No failure is reclassified as passing history.

## Remaining owning work

* The current rimraf dependency object routes readdir to the actual private
  raw scanner because the public readdir owner still ignores buffer encoding.
  Matching the target's public fs.readdir replacement/monkeypatch interaction
  is an implementation gap. Supply the full public readdir/Dirent/Dir owner
  and use that same owner in rimraf; do not accept this dependency isolation
  as a permanent platform exclusion. Other FS methods retain their real
  public source owners/native request path where already installed.
* Public readdir/Dirent/opendir/Dir recursive, encoding/type/raw-path and
  descriptor-relative lifecycle are still incomplete. A private raw scanner
  does not close their audited public APIs.
* Sync native error property ordering/descriptors, extreme options, mutation
  races, exact diagnostics/stack and target-specific libc++ behavior need
  reconciliation. Native source and happy-path controls are insufficient.
* Full VFS provider activation/handler semantics and Permission Model policies,
  guest mounts/credentials/resource limits, allocation failure, GC/realm,
  callback/rejection/fatal/worker/shutdown integration remain open. Existing
  shared callback scopes are source candidates, not completed phase evidence.
* Build identified guest backend/engine artifacts within user authorization,
  then validate unchanged rm/readdir/permission/race/exit coverage across Node,
  Chromium, Firefox and WebKit. No current four-host conformance is established.

Continue independent audited families before a larger filesystem test campaign.
No finding, API or family is marked complete by this source checkpoint.
