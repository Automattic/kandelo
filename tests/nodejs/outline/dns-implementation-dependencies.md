# DNS and hostname lookup owner dependencies

N-001–005/013 remain partial. This slice supplies real native foundations,
not a completed public dns/Resolver surface. Exact Node/source/native pins
and the frozen audit/nonpasses remain unchanged. No overall suite or full
product/engine rebuild is authorized or performed here.

## Distinct services and actual source paths

dns.lookup uses the guest OS name service. dns-lookup.h calls actual libc
getaddrinfo, copies returned addresses and frees the result with RAII.
Patches 59/61 move OS work onto the existing SlowIo pool. The current
public callback/promise frontends share actual address/name request owners;
workers hold native strings/results, and the owning realm creates results
and invokes oncomplete. A separate earlier private Promise lookup remains.
Queue shutdown joins running work before retiring roots and never calls
user callbacks while destroying the realm. Allocation/native exceptions
become visible completion failures. The pinned libuv error definitions
are retained as references; common getaddrinfo statuses retain real data.

The lower route remains musl-overlay lookup_name -> private four-byte
getaddrinfo syscall -> kernel/runtime-core -> configured NetworkIO. That
interface can return one IPv4 routing address, including a synthetic
address for fetch/TLS routing. It cannot carry DNS RRsets, TTLs or arbitrary
record structures. This work does not reinterpret those addresses as DNS.
N-003's IPv6/multiple-result/OS name-source deficiencies remain open.

The former public resolve method returned fixed loopback success. It now
throws ERR_METHOD_NOT_IMPLEMENTED until the record bridge is installed.
That honest failure is a missing implementation, not passing compatibility
or an accepted exclusion. Resolver/record/reverse APIs remain missing. The lookup and lookupService
callback/promise frontends are now connected to real request primitives;
that source wiring does not establish guest behavior or remaining DNS APIs.

## Real record backend and normal package recipe

node-cares@26.13.0 selects unchanged c-ares 1.34.9 from the target archive.
The component's 386 input files are verified; wasm32/64 plans check exact
pins and normal resolver source/work/output layout without compiling.
The future target build uses the worktree SDK, truthful Kandelo identity,
actual executable feature-link checks and disjoint installation roots.
Native host configuration is not reused as target capability data.

dns-resolver.h owns an actual persistent c-ares channel, configuration,
poll-driven event thread, native query packets, cancellation and close.
Timeout/tries/max-timeout/cache/flags follow the selected target options;
the real library performs DNS packet generation, transport and parsing.
Callbacks copy borrowed DNS records before returning. Completed records
remain independently owned after channel teardown. Configuration and
query status are actual c-ares results, not canned answers.

This backend is not exposed as a public JS Resolver yet. It is not linked
into the guest engine prematurely, and its presence does not advertise
process.versions.ares or any passing public DNS capability.

## Evidence and limits

The native-host control compiles pinned c-ares and both headers, executes
actual loopback UDP DNS queries for answer.test/silent.test, and compares
the A address/TTL with native Node using the same configured test server.
It verifies source-address/server configuration, cancellation, destruction,
copied-record lifetime and native OS lookup from a worker. This is a real
controlled DNS server, not a candidate-side fabricated answer. It does not
test guest sockets/poll/thread behavior, engine Promise/root integration,
public record marshalling, four-host conformance or internet egress.

The SQLite builder also rejected its normal node-source-under-work layout.
An unchanged historical builder reproduces the rejection on both targets.
The corrected guard allows source staging beneath work while rejecting
build-inside-source and overlapping output roots. Current SQLite/c-ares
plans pass for both targets; those plans invoke no compiler/configure.

## Remaining implementation order

The shared numeric-error prerequisite now has a compiler-selected table,
pinned name/map/message algorithms and real UV_* constants; see the system
error dependency record. Native data/field controls do not compile the DNS
bridge or close provider/lifecycle/record work below.

1. Add opaque per-context Resolver/request owners, real ChannelWrap/
   QueryReqWrap integration and completed-packet dispatch on the owning
   JS loop. Close/join all channel threads before context roots retire.
   Propagate ref/cancel/error/GC state and actual async provider identity.
2. Install unchanged callback/promise Resolver/source algorithms with
   real validators, native constants and configuration. Integrate the portable record decoder into actual JS values and complete
   TTL/binary/text/alias/ANY/reverse/error contracts;
   preserve default/instance resolver and cancellation ownership.
3. Complete actual callback-scope tick/microtask handoff, CLI/worker option
   activation, native request/prototype metadata and the guest name-service
   interface. Pinned lookup/lookupService callbacks/promises now use actual
   request owners, but source wiring does not establish provider/phase
   conformance.
4. Supply configured /etc/resolv.conf/system/local-address behavior and
   transport capabilities. Default internet UDP egress currently reports
   EHOSTUNREACH; local/session datagrams have real separate paths. Node's
   TCP backend and browser fetch routing are not automatic raw DNS egress.
   These configured restrictions do not justify excluding public DNS.
5. Build the exact target backend/engine only within the existing rebuild
   constraints, then run unchanged upstream DNS/Resolver/record/cancel/
   TCP-fallback/exit tests and native controls on all four hosts. Keep
   every failure/skip/unsupported/timeout/harness result and artifact pin.

## Native name-service request source checkpoint

Patch 61 stages native request objects for both getaddrinfo and getnameinfo.
The objects have actual foreground-finalized native state, an owning async
lifetime, captured trigger/frame and distinct GETADDRINFOREQWRAP and
GETNAMEINFOREQWRAP providers. Initialization happens at dispatch, after the
public frontend would have assigned its callback/hostname fields. A dispatch
is marked before entering init hooks so reentrant hooks cannot submit it twice.
The shared SlowIo pool roots each request until owning-context completion;
workers carry only native input/output. Completion enters the request realm,
looks up oncomplete, supplies the target argument counts and restores async
context. Completion/failed handoff/shutdown/GC retire identity once; teardown
joins running jobs and never invokes user callbacks.

Address results retain OS order or stable family partitioning without
inventing/deduplicating answers. Empty success becomes EAI_NODATA. Reverse
lookup uses actual getnameinfo with NI_NAMEREQD, the target's one-byte string
conversion, numeric ports and the pinned POSIX named-zone policy. Constants
come from the compiler's netdb.h, not from the outer host or fixed musl values.
The shared EAI mapper uses the pinned UV definitions and captured system errno;
an unknown unmapped status remains UV_UNKNOWN and an invalid zero EAI_SYSTEM
errno becomes EIO, rather than a fabricated successful result or target abort.
These defensive native-embedding branches are not public platform exclusions.
The guest named-zone path is the existing musl-overlay if_nametoindex
(AF_INET datagram plus SIOCGIFINDEX) -> runtime-core netif lookup, not an
outer-host interface table. musl getnameinfo reads guest /etc/hosts and
/etc/services and falls back to its resolver/PTR path; the existing guest
configuration/UDP-egress constraints therefore still apply. Native-host
control results do not establish those guest data sources or routes.

The existing Promise lookup bridge also uses this shared mapper instead of
its smaller hardcoded table. Its old custom public frontend has now been replaced by the pinned
callback/promise lookup and lookupService algorithms. Raw UTS46 conversion,
shared defaults, literal nextTick policy, numeric errors, actual request
metadata and DNS observation have source owners. Complete AsyncWrap/private
metadata, shared native callback scopes, CLI/worker activation and built
guest behavior remain open. The old inert observer is removed; genuine
observation covers installed DNS producers only.
Resolver/channel/record/ref/cancel ownership and guest name-source/transport
limits from the previous sections remain open.

One focused standalone native-host control verifies actual reverse lookup,
IPv4/IPv6/port/zone conversion, numeric host/service behavior, error mapping
and named interface indices. Its loopback hostname/service and compiler
AI_* constants match the exact native Node reference. This evidence does
not compile the SpiderMonkey request bridge, test GC/hooks/realm failures,
connect the public frontend or establish guest/four-host conformance.
Source preflight checks the exact archived references, EAI mapping pairs,
patch application/reversal, declared recipe inputs and source generation.
No overall suite or full product/engine/target-package build ran.


## Pinned public lookup and observation source checkpoint

The current bootstrap selects dns-lookup-platform-adapter.js for callback
and promise lookup/lookupService. Complete unchanged pinned callback and
promise sections retain their different argument/overload validation,
null-byte checks, numeric errors, literal scheduling and multi-value
promisify descriptors. Full internal/dns/utils.js owns shared defaults,
allowed families/hints and result-order policy. Its Resolver classes are
not exposed until their native record/channel bridge exists. CLI and worker
option activation remain incomplete; no target flag is silently accepted.

UTS46 uses the actual vendored raw hostname converter, not a URL host
setter/parser. ASCII case mapping, invalid input and the pinned 16384-byte
limit are retained without interpreting ports, paths, credentials, percent
escapes or numeric-looking hosts as URL syntax. Nineteen focused conversion
cases match a separately compiled exact pinned Ada implementation; this
is not a full Unicode data/version audit or guest codec validation.

Actual native request state supplies async IDs/provider types during active
work and reports invalid/none after retirement. The public async provider
map selects the two IDs from pinned async_wrap.h. The returned inherited
AsyncWrap methods remain partial: asyncReset explicitly fails; invalid
receiver behavior, descriptors/constructor and full reset/frame semantics
still need their owning implementation and validation. No family closes.

The performance observer now has actual registration/counts, queued delivery,
entry/list objects and shared DNS start/stop producers, using pinned source.
The one reviewed adaptation advertises only installed DNS entry producers.
Other native target entry types remain explicit implementation gaps, not
accepted platform exclusions or filtered passing tests. mark/measure now
fail explicitly rather than reporting successful no-ops. See the separate
performance dependency record for origin, producer and public shape limits.

Four focused DNS frontend controls and 27 affected socket controls pass.
Three unchanged upstream lookup/reverse/validation files pass over candidate
algorithms and separately as native controls; their native request, common,
assert and OS dependencies are explicit. No guest engine bridge was built.
These counts are scoped controls, not public API compatibility denominators.

The first focused run passed three cases and failed one fixture assertion
that expected request retirement in an await continuation. Native Node's
MakeCallback drains microtasks before the ReqWrap destructor, so the wrapper
was still active. Its raw log and complete fixture/generated input copy are
retained. The corrected check observes retirement after the native callback
scope unwinds into the check phase and keeps the -1/NONE assertions.

This target observation also exposes a real shared implementation dependency:
JS_CallFunctionValue alone is not Node's native callback scope. The current
request cleanup occurs when Complete unwinds; guest nextTick/microtask
handoff before retirement must be implemented/validated in the shared
callback/scheduler owner. Native boundary controls cannot prove that phase
for SpiderMonkey. FS and other native producers share this prerequisite.
Full product rebuilds and overall suites remain deferred.


The initial shared callback-scope source now exists for DNS/FS/codecs,
including actual JS entry depth and outermost tick/job processing before
retirement. Its compiled policy matches native Node-API/libuv observations;
the JSAPI adapter remains uncompiled, with rejection/fatal/GC/realm/phase
obligations open. See callback-scope-implementation-dependencies.md. This
does not retroactively make the earlier native boundary tests guest evidence.

## Owned record decoder source checkpoint

The portable dns-records.h now consumes the same pinned c-ares legacy
reply parsers as Node's native record code for A/AAAA/CNAME/NS/PTR,
MX/TXT/SRV/NAPTR/CAA and single SOA. TLSA and ANY SOA consume validated
structured records. QueryResult::Decode preserves query failure status,
serializes its independently owned c-ares record and returns independently
owned values after channel destruction. No borrowed packet/name/binary
storage escapes the parser. Legacy parser allocations, hostent objects,
structured DNS records and serialized wire buffers have native RAII owners.
Allocation failure is not converted into an empty successful answer; the
future JS completion owner must propagate native exceptions correctly.

The native value model distinguishes Latin-1 strings, exact signed/unsigned
numeric fields, undefined, sparse holes, arrays, ordered own dictionary
fields, subsequent ordinary property assignments and binary ArrayBuffer
bytes. It is completion data, not an alternate public object model. Actual
JS values must be allocated on the owning realm. Ordinary assignments must
execute that realm's real setters and preserve exceptions. In particular,
CAA dynamic tags cannot be implemented as unconditional own data properties.

Exact target details verified against the pinned native executable include:

* A/AAAA TTL arrays and target address formatting; CNAME and alias handling.
* TXT chunk/record boundaries, embedded zero and Latin-1 0xff bytes.
* Ordered ANY categories, CNAME-or-A selection and original TLSA answer
  indices, including holes. TLSA data becomes an independent ArrayBuffer.
* SOA serial/minimum unsigned values and signed refresh/retry/expire fields.
* MX/SRV/CAA type fields even on specific queries; NAPTR/SOA own type fields
  with undefined values on specific queries. Undefined is not omission.
* CAA C-string truncation at zero, collisions with fixed fields, and the
  ordinary __proto__ string assignment behavior under a pristine prototype.
* Actual NXDOMAIN, empty-answer, server-failure and invalid-empty-TLSA status.

Twenty-two focused native differential scenarios use an owned real DNS peer
at 127.0.0.1 on an ephemeral UDP port. The portable helper performs actual
queries using the previously compiled, source/hash-verified pinned c-ares
archive. It closes the channel before decoding and drops record/query owners
before serializing values. Native Node performs its own actual queries to
the same peer. The comparison preserves undefined values, holes, objects and
ArrayBuffer identity/type rather than comparing lossy JSON alone. This is
not an unchanged upstream suite run or a public guest DNS capability pass.

The first launch failed before querying because the dev shell did not retain
an external helper-selection variable; selection now occurs inside the dev
shell. The first executed differential passed 20 scenarios and failed two
on omitted undefined type properties. Those candidate semantics were fixed;
all 22 subsequently passed. Original logs and exact failed-stage input/helper
copies remain retained. No failure is reclassified as passing history.

Remaining decoder questions include adversarial malformed/escaped/compressed
wire behavior, especially the structured ANY SOA path versus the target's
manual wire traversal, allocation failure and exact public reverse-query
normalization. Those are unresolved implementation/validation obligations,
not accepted engine boundaries. The successful-packet controls do not settle
full malformed-response/error or realm/prototype/GC/async behavior.

Public Resolver/QueryReqWrap integration, guest c-ares linking/configuration,
ref/cancel/shutdown/context lifetimes, real owning-loop dispatch, JSAPI value
materialization and all four-host conformance remain incomplete. The decoder
is not linked into the guest engine yet. No recipe revision, host import,
syscall or ABI contract changes; the generated JS bundle is unchanged.
Existing native controls for the earlier raw channel remain identified
historical evidence, not rerun or retroactively certified by this decoder.

## Subsequent public Resolver source integration

The full public callback/promise modules now consume native channel/request,
record materialization and external-completion queue owners. Earlier missing-
bridge statements above describe their recorded checkpoint. See
[dns-channel dependencies](dns-channel-implementation-dependencies.md) for
current source, explicit native-boundary evidence, retained failures and
remaining configuration/lifecycle/host requirements. No family is complete.
