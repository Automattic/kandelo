# Production VM and backing API compilation corrections

The normal targeted source150 build passed Mozilla's build reader and reached
production C++ compilation. It failed on VM wrapper realm access, two
unqualified rooted-value arrays, a protected backing-size accessor and a
missing shared-buffer API declaration. Its frozen input hashes were unchanged.
The complete failed log and terminal result remain preserved; no engine
artifact, guest result or four-host conformance was accepted.

Source151 uses the declared GetObjectRealmOrNull API for actual checked native
module owners and qualifies JS::RootedValueArray. Engine patch0121 includes
the declared shared-buffer API and expresses the original maximum-capacity
check through the actual public resizable maximum/fixed byte-length readers.
This is equivalent to the pinned protected accessor, including resizable
buffers. It does not reduce the bound to the current logical byte length.
Realm guards, allocation identity, ownership and callback algorithms remain.

Pinned-header/source checks, exact patch replay, normal bundle freshness and
715 guarded input checks pass. Fourteen existing package-source tests pass
without skips. These are source checks, not a new production compile result.
The combined candidate still needs the normal targeted engine retry. Overall
suites and a full product rebuild remain deferred. All nineteen families,
individual API closure and current four-host conformance remain incomplete.

Private integration preflights separately composed the TCP/Agent foundation,
original allocation spans and actual callback recovery against source150.
Forty-one source/staging/syntax checks pass; missing new input declarations
were added only to that scratch candidate. ReadFile capacity also passes a
current-source preflight. Neither proposal is part of source151. X509,
synchronous CJS hooks, Body consumption, UDP and deferred Locks proposals
remain separately identified handoffs awaiting integration. These checks do
not promote their native/component evidence into guest conformance.

Exact source and failure evidence: [engine-api-finding-progress.json](engine-api-finding-progress.json).
