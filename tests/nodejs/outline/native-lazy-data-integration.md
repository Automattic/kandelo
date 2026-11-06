# Native lazy data-property prerequisite integration

Source143 composes the sealed engine prerequisite over current142TLS/ELD/VM
and140backing inputs. It reconstructs affected Mozilla sources through the
actual0100environment and0112backing patches before applying the new changes;
13engine files roundtrip exactly through0114. Current shell changes by one
native registration only. Sixteen whole Node reference files match the pinned
archive. This adds real source owners,not public API or runtime acceptance.

Pending properties are real native DATA shapes with their existing descriptor
attributes and a distinct bit in the existing property-flag byte. Their ordinary
slots own hidden traced cells containing native callback/data/computed value/
state. No ES accessor,proxy namespace,visible sentinel,global root map or outer
host object stands in for the property. The static native callback has code
lifetime; JS loader/data edges are traced. Calls enter the actual holder realm,
wrap results/exceptions back and retain the successful result before fallible
shape publication. Real shape/Watchtower invalidation retires old cache state.

Generic get/descriptor/define/set,NoGC/pure fallback,megamorphic cache,proxy
invariant,seal/freeze and bulk-slot consumers distinguish pending data from
plain slot values/accessors. Descriptor/define reload lookup after callbacks.
Own set materializes without loading; inherited set keeps receiver ownership.
Delete/has/keys do not load. Freeze clears the real writable bit without calling
the loader. Separate non-loading integrity observation follows the pinned
native before/after behavior without changing descriptor attributes.

Installation currently admits only absent own non-index/non-private keys on an
extensible PlainObject in the current compartment. Broader holder/global/class/
existing-property/key admission is an implementation gap,not an accepted engine
boundary. Recursive loading and callback mutation use explicit ownership policy;
the target's four fatal/reentry observations are preserved and do not prove the
candidate policy has parity. Exceptions/OOM/interruptions remain visible.

Root checks exact source/patch composition,input closure,current unity/header
staging and syntax of two new JSAPI test bodies. Fourteen package source checks
pass. These do not compile or run C++/JSAPI. Sealed17native target observations,
three native integrity cases and four fatal processes are reference evidence
only,not candidate passes. Existing/new assertions and audited pins are unchanged.

Remaining work includes actual C++/JSAPI/SDK callback compilation; moving/GC/CCW/
realm/OOM/interrupt/IC/JIT/proxy/retirement execution; wider installation and
mutation/reentry parity; public Worker/locks,Navigator/util/fs/Buffer/web/module
consumers; identified-artifact guest and four-host conformance. Worker consumer
and watcher proposals remain separate pending integration. No current engine,
package/kernel/product build or overall suite ran. A normal engine142preflight
selected9nodes but did not start a heavy build: four other worktrees were
observed building large packages and cacheGC safely skipped a locked cache.
Continue source work and recheck peers before the targeted current-candidate
build. Resource coordination is not a compatibility exclusion or blocked goal.

See [native-lazy-data.md](../../../third_party/node-core/native-lazy-data.md)
and [native-lazy-data-finding-progress.json](native-lazy-data-finding-progress.json).
