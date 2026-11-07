# Native signature callback-frame reference correction

This205slice changes only9native control/tooling paths. It changes no production
Kandelo runtime, engine/bundle/registry input, target/source/native pin or recipe
revision. The original40assertion file is byte-identical to its195seal and root
source. Original39/40with the old reference component remains a historical
nonpass; the corrected current control does not reclassify it.

Pinned CryptoJob calls AsyncWrap::MakeCallback with its actual captured context
frame. The old native component used public C++ AsyncResource::MakeCallback,
whose exact reference path replaced that frame with undefined. A sealed standalone
no-Kandelo native experiment compares public, explicit-frame and actual crypto
routes and records their difference. No formal upstream fault is attributed.

The corrected component captures genuine continuation storage immediately before
init, retains genuine AsyncResource IDs/resource/destroy and calls the exact
pinned private InternalMakeCallback overload with that frame. Only public V8/
async_context types cross the private entry; no Environment layout, fake frame/
ID, bound callback, skipped hook or production fallback is introduced. Native
executable/header/declaration hashes fail closed on a different reference.

## Focused evidence and limitations

Current original40groups pass, with3native/candidate lifecycle comparisons for
normal/init-mutated/before-and-callback-mutated frame behavior and restoration.
Current52streaming groups and2complete unchanged upstream files per subject exit0.
The sign-verify conditional OpenSSL CLI block remains skipped in both subjects;
that branch is not passing coverage. Verify-failure uses actual native TLS and
loopback. New production/private guest code is not executed by these controls.

Normal877input closure/staging/bootstrap syntax/unchanged Mozilla checker pass.
The14package checks are reused from the preceding205receiver checkpoint because
engine inputs are byte-unchanged. Exactly2previous successful helper compiler
attempts are integrated once, with exact native artifacts/dependency files/frozen
local snapshots. No new compile ran; full contemporaneous system-header hashes
were not retained by this sealed helper. Original1953attempts/2failures stay
separate. All sparse/env/replay errors and the first added-control destroy timeout
remain in raw logs; corrected tracking retains all assertions.

Production source already captures FsRequestFrame before init and installs it
before hooks in the shared callback owner. That trace justified no runtime fix,
and does not prove guest execution. Actual guest frame/root/GC/realm/fatal/OOM/
shutdown/Worker/queue behavior and identified-artifact four-host conformance
remain unvalidated. No finding/family closes. Fullproduct/overall suites remain
deferred, and nested guest Wasm remains in scope for the final phase.
