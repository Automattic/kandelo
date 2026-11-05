# System-error data and numeric DNS error dependencies

V-008/V-035 and N-002/013 now have a shared partial error-data owner.
The exact Node/source/native pins and frozen audit remain unchanged.
This is not complete error delivery, DNS or values-family compatibility.

## Actual source owners

uv-platform-adapter.js supplies real per-binding error constants and fresh
Map instances from compiler-selected data. The native table expands the
unchanged pinned UV_ERRNO_MAP with the unchanged libuv errno header against
the actual compiler's errno definitions. POSIX values therefore come from
guest libc, while portable EAI/EOF/UNKNOWN and missing-errno values use the
target's actual libuv definitions. No host errno table or Linux identity is
substituted in the guest. The table is data; no libuv runtime or ABI exists
on this basis and process.versions.uv remains absent.

The private binding supplies getErrorMap, message data and UV_* constants.
Copied internal/errors uvErrmapGet and internal/util name/map/message
algorithms now consume that owner. Public util name/message validation is
unchanged pinned source. Numeric DNSException retains its number in errno,
including the target EAI_NODATA/EAI_NONAME to ENOTFOUND policy. UVException
uses the actual shared table rather than a missing binding or a small
bootstrap heuristic. Other direct bootstrap/native error mappings remain
independent gaps; this does not close V-035.

Public maps and their entry arrays are independent from each other and the
private cached map. Construction uses captured Map operations without
consulting mutable public collection methods/array iterators. The engine
bridge roots the result array, each row and strings during marshalling.
Patch 60 and its declared inputs stage/generate the table privately; no
kernel/host/syscall ABI changes occur.

## Evidence and preserved failure

The standalone native-host table is compiled with the declared compiler.
All 85 native map entries match pinned native Node, including numbers,
names and messages. This does not prove the wasm32 errno profile or the
uncompiled engine array bridge. Those need identified target artifacts.

Eleven public-util controls and two isolated numeric-error controls pass
on the exact native reference. They exercise actual candidate factories
over native error-data/engine boundaries. The controls cover all native
map entries, name/message validation, unknown ordinary error numbers,
fresh mutable maps, public-collection mutation resistance, numeric DNS
fields and UVException fields. Stack/GC/native marshalling and all four
guest hosts remain unvalidated. No new overall suite was run.

The first native compile failed because the generated macro excerpt lost
the upstream blank-line terminator after its final continuation. The old
generator/header/source hashes and compiler output are retained separately.
The generator separator was corrected; the unchanged full-table assertion
then passed. No upstream assertion or expected data was weakened.

## Remaining dependencies and target questions

Public DNS callback/promise lookup/lookupService now connect to actual
native address/name request owners. Complete callback-scope/loop/ref/GC/
realm/error behavior and the c-ares record/channel bridge remain open.
Their numeric errors must use this binding, not lose errno by coercing codes
to strings. The complete guest name-service interface and record marshalling remain
implementation work. Native provider identity and complete warning/fatal/
stack policy are still missing or unvalidated.

The pinned public message wrapper accepts negative safe integers, while
src/uv.cc GetErrMessage reads an Int32. Behavior outside Int32 needs a
retained native differential control before closing that edge; no target
change, fabricated result or accepted exclusion is made here. Locale,
platform-specific aliases, direct errno delivery, source stacks and error
constructor/descriptors still require their full owning-layer review and
later guest controls. A complete table does not mean every syscall exists.

The full product rebuild remains deferred. Source checks and the native
helper compile do not establish current Node/Chromium/Firefox/WebKit
conformance or readiness for overall suites.

Patch 61 now supplies partial real address/name native request owners and
shares the full pinned EAI mapping with the older Promise lookup bridge.
The exact native helper checks reverse-name/address/zone/constants/error
behavior. Pinned frontends are now connected in source; shared callback
scopes/metadata/CLI and guest compilation remain open; see the DNS dependency record. This source prerequisite does
not close the public request/provider/stack/lifecycle obligations above.
