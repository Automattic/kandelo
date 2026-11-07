# Reusable native roots and backing-store compiler corrections

The normal selected source165engine build failed after490.6seconds. All frozen
inputs remained unchanged. Eight declared dependency packages were reused;
only the engine package was built. The kernel/rootfs/app/product graph and
overall suites were not run. Two actual compiler errors and the full exact
log/meta/result/source identities are retained in
[the build result](engine165-build-result.json). No artifact was accepted.

Source166 corrects these owning declarations/accesses:

- KandeloBackingTransfers.h now includes real jstypes.h and declares
  TrackMetadata with the same extern JS_PUBLIC_API as KandeloBackingStore.h.
  Only Store.h owns the default argument. This preserves signature, calling
  convention and metadata capability behavior without a RootingAPI dependency.
- Retained structured cloning obtains maximum length from the public resizable
  subclass getter, or current byteLength for a fixed buffer. This is exactly
  the original protected base helper's branch semantics. Allocation capability,
  transfer publication-before-detach and read-side reconstruction are retained;
  no private accessor is exposed or capacity synthesized.

A bounded source review also found five erroneous reusable-root clears across
three native owners. PersistentRooted::reset clears its value AND unregisters
it. Assignment requires initialized registration and does not register anew.
A null assignment clears the value while preserving the reusable root entry.
The original pinned RootingAPI.h is retained with exact SHA256
304d6a49b43d17b9dcc182915e32f4c33595ae8a93fceb58f42edbd1459f98a5.

| Owner | Concrete path | Correction |
| --- | --- | --- |
| UDP | Normal bound public close stops receive, clearing active, then native close reassigns it | Clear reusable idle value with nullptr |
| Signal | Failed public process subscription calls start then close; stop/restart and stale pending retirement can reuse the same root | Clear three reusable values with nullptr |
| StatWatcher | A start failure before work publication leaves the same captured owner open | Clear failed-start value with nullptr |

The StatWatcher scope is specific: ordinary failed fs.watchFile does not
publish the watcher and a normal retry creates a fresh owner. A public async
init hook can retain the real native owner before failure; later start/close
is then reachable. The UDP/Signal paths are ordinary public lifecycle paths.
Source establishes a debug initialization assertion and release untraced-owner
risk; no actual guest abort, use-after-free or GC success was demonstrated.
Terminal closed/detached teardown resets and unique_ptr-root resets are intact.

Current source/input/unity/replay checks and14package checks pass; these are
not native execution or conformance.166has not been compiled. Later validation
must use real guest JSAPI/GC: bound datagram close/receive-stop/queued sends,
failed signal installation/stop/restart/pending records, captured failed-start
StatWatcher reuse, and fixed/resizable retained transfer read/abort/GC paths.
All four hosts require identified-artifact evidence. No family is complete.
