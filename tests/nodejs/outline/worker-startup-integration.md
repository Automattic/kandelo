# Worker startup option capture

Checkpoint 135 moves argv validation and string conversion to the pinned
constructor stage, before filename resolution and environment processing.
It retains the mapped value and selected eval branch instead of reading
getters again after user coercion can change the options. The existing native
bootstrap packet carries those values to the real worker startup path.

The startup prefix supplies `[worker eval]` for classic eval workers and uses
array-like append semantics. An Array species constructor can return a
non-iterable array-like result; spreading that result incorrectly rejects a
supported argv value. File workers retain their resolved filename. Existing
main-thread startup construction and native default-trigger, histogram,
lock and direct-clone forwarding are preserved.

## Focused evidence

Root controls compare 32 cases against exact native Node 26.13.0 and check two
main-startup vectors. Native reference workers send their actual argv/env and
finish before results are accepted. The candidate executes its real changed
constructor and startup prefix, intercepting native create before a guest
thread launches. This is source/dependency evidence, not candidate native-thread
or clone conformance. Getter/error ordering, sparse arrays, coercion effects,
invalid values, eval recapture and non-iterable species are covered.

Eleven affected port groups and 14 source/package checks pass. Seven complete
Node reference files match the pinned source archive. No native owner, engine
patch or binding changed, so no unchanged component was recompiled. Combined
source 117–135 has not successfully compiled as an engine, and no four-host
runtime acceptance is established. Overall suites and full rebuilds stay
deferred. Exact artifacts and identities are in the
[finding ledger](worker-startup-finding-progress.json).

The private handoff preserves six expected failures from the old constructor
and prefix. Their source/artifact identities were checked; they were not rerun
at the root. Fifteen native-only lazy-property/Navigator cases provide future
requirements. They are not candidate compatibility passes.

## Remaining owning-layer work

R-015 still needs real native lazy data properties with holder/creation-realm,
inherited receiver, descriptor, integrity-operation, GC, reentry and inline-cache
semantics. A public native getter is observable as an accessor and does not
supply that data-property behavior. Existing virtual stores also lack the
necessary integrity semantics. No manual descriptor or unsupported-case rename
was added to manufacture support.

Global Navigator still needs its branded properties, independent internal
locks singleton and genuine CPU/locale providers. No host alias or guessed
capability was installed. Other Worker options, modules, data URLs, TypeScript,
input types, environment sharing, stdio, executable argv[0], native lifecycle,
OOM/GC/realm handling and four-host behavior remain open. Prior lock query-order
and termination differences are retained. These are implementation obligations,
not accepted platform boundaries or evidence that the family is complete.

The audited target/source/native-reference pin, program/kernel/host ABI, wire
schema, platform identity, memory ceilings and accepted artifacts are unchanged.
