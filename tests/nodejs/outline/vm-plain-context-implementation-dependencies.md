# Ordinary VM globals and runtime security-callback ownership

This source slice follows the uncontextified-global part of E-004/008/009
and the E-006/014 realm/security prerequisites. The full ordinary sandbox
exotic-object implementation remains open. No family/API finding closes.
The immutable Node26.13.0 source/native-reference pins are unchanged.

## Actual implementation

The unchanged public vm.js algorithms now accept their DONT_CONTEXTIFY
symbol through the actual platform dispatch. The private bridge passes null
and noContextify=true to the engine, which creates a fresh compartment/zone
and a real ordinary global using JS::DefaultGlobalClassOps. There is no
sandbox allocation, copying, proxy brand or host realm substitution in this
mode. Standard classes and inherited shared-memory/Atomics policy belong to
that new guest realm. The actual global wrapper is the returned context and
the WeakMap context key; run/globalThis/createContext/isContext identities
therefore share the same real engine object. Contextified ordinary sandboxes
retain their separate existing owner and incomplete forwarding semantics.

Compile/run/compileFunction still enter the actual stored realm and use
existing rooted Stencil/function/exception owners. Object descriptors,
mutation/deletion and freezing in plain mode use ordinary engine operations,
not a synthetic JS mirror. Context names/origins, cache/import/timeout/
microtask/full metadata and complete realm/exception behavior remain gaps.

The previous process-global security-callback struct/install boolean is
removed. ShellContext now owns its installed callback record and previous
callback pointer. Installation compares the actual runtime callback pointer
and retains prior subsumes/code-conversion policy. The CSP checker applies
each plain or sandbox realm's code-generation mask, then delegates allowed
requests to the previous CSP checker. Repeated installation does not wrap
itself. Shutdown restores the previous callbacks if this owner remains
installed, before ShellContext storage/context private data are retired.
This source fix does not claim all worker/race/shutdown paths are validated.
Policy slots and sandbox ownership are initialized before the new-global
observer hook publishes the realm. No outside engine defect or new accepted
platform exclusion is claimed.

Patch85 changes the real engine shell js.cpp/jsshell.h owners. Recipe78
stages it and the changed JS bundle. It also includes the preceding HTTP
recipe77 source; engine76 is the last accepted artifact until this targeted
build succeeds. No new syscall/host import/wire ABI, memory ceiling or
full product rebuild is introduced.

## Bounded evidence

Eight frontend controls pass over explicit native Node VM contexts, scripts,
functions and process/error dependencies. They cover existing validation/
identity and actual DONT_CONTEXTIFY global identity/mutation/freeze/isolation,
new-context dispatch, compileFunction and string code-generation restrictions.
Two are new scenarios; repeated cases do not increase API coverage. The
unsupported-deadline/cache/microtask/import guard remains a gap guard.
These controls do not execute Kandelo's native class or CSP installation.

The complete unchanged test-vm-context-dont-contextify.js is retained and
compared with its pinned source archive. Native mode passes. Candidate mode
uses actual frontend source over the explicit native realm backend and fails
at its final dynamic-import callback/loader requirement, which remains
unimplemented. Its assertion/platform/skip policy is unchanged. Earlier
assertions executing before that failure are not a passing file or a closed
API. Logs/statuses/identities are retained in
.context/node26-vm-plain-upstream/report.json. No assertion was removed to
turn this known nonpass into success.

## Remaining work and later validation

* Real live sandbox exotic property/descriptor/getter/setter/inheritance/
  symbol/global identity semantics; the current copy-on-resolve owner is an
  implementation gap, not an accepted engine boundary.
* VM import referrer/loader/module/TLA/graph ownership and full callback/
  sentinel/flag/error phases; the unchanged complete-file nonpass remains.
* Owned deadlines/SIGINT/per-context microtasks, persistent code caches,
  names/origins/source offsets/displayErrors and actual memory/profiling APIs.
* Guest ordinary-global/freeze/cross-realm/error/GC/OOM and callback chaining,
  independent-worker runtime installation/retirement and external policy
  replacement controls over identified artifacts on every host.
* Complete observation reconciliation and ordinary stamped consumer/ABI
  validation before full conformance claims. Targeted Default build-deps
  artifacts lack ABI-contract stamps; no manual retagging is permitted.

Move next to independent worker/testing/native-integration owners before a
larger VM-only campaign. Overall suites and the full product rebuild remain
deferred; a compiled package alone is not four-host runtime conformance.

The normal targeted engine78 build succeeded in 221.4 seconds.
All 634 frozen selected source identities matched. Unchanged upstream
style/macroassembler/opcode checks, optimization and fork instrumentation
passed. .context/node26-engine-r78-accepted retains executable/log/dependency
identities. Guest report .context/node26-vm-plain-guest-r1/report.json records
{"pass": 2, "fail": 0, "timeout": 0, "harness-error": 0}. These are Node-host guest checks of the
actual compiled owner; independent worker policy installation/retirement and
four-host/full-API conformance remain unvalidated. Default build-deps artifacts
warn about missing ABI-contract stamps; ordinary stamped SourceOnly consumer
validation remains pending. No manual retagging, full rebuild or overall suite.
