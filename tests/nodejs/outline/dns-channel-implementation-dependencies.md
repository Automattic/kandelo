# DNS Resolver, native event completion and record values

This partial N-001–005/013 implementation consumes the actual c-ares backend.
It preserves the exact audited Node26.13.0 pin and original audit. No family
or individual API is complete and no new platform exclusion is accepted.

## Actual implementation and ownership

Full unchanged pinned dns, internal/dns/utils, callback_resolver and promises
modules now share real ChannelWrap/QueryReqWrap dependencies. Instance/default
resolver configuration, callback/promise validation, TTL results, record types,
reverse, cancellation, error constants and the lazy promises descriptor have
actual source owners. Lookup remains the OS name service, distinct from raw
DNS records and host synthetic fetch/TLS routing addresses.

native-dns-records.cpp owns actual native channels, provider identities and
rooted requests. The c-ares event thread publishes independently copied native
packets into the shared native-work completion queue. BeginExternal and
FinishExternal register/count actual producer work without occupying a pool
worker or touching JavaScript from the network thread. Shutdown interrupts
producers without holding the completion lock, waits for terminal publication,
and silently retires requests before releasing roots. Pending query work roots
both request and channel. Idle channels do not count as active loop work.

Wire activity is retired atomically at native publication, matching the target
server-replacement rule; request async identity lasts through the owning realm
callback/microtask scope. Channel/query async providers are DNSCHANNEL and
QUERYWRAP. Finalizers queue destroy identities and native channel destruction
joins the actual c-ares event owner. Typed server tuples preserve real address/
port configuration; local-address changes act on the actual channel. Reverse
copies borrowed host aliases before c-ares returns. A/AAAA/ANY/TXT/CAA/MX/NS/
CNAME/SRV/PTR/NAPTR/SOA/TLSA decoding uses the portable record owner.

The JSAPI materializer creates actual sparse arrays, Latin-1 strings, ordinary
objects and independent ArrayBuffers. Dictionary fields are own data properties;
CAA tags use ordinary property assignment, including setters and exceptions.
Completion enters the request realm, preserves callback argument counts and
uses the shared native callback scope. The pinned error-name function and
pending-server error constant are generated unchanged from cares_wrap.h.

The normal engine recipe declares node-cares@26.13.0 and checks its compiled
source/target provenance before private-sysroot linking. process.versions.ares
comes from linked ares_version(), not a preset or claim of full public support.
Patch82 only registers private functions; it changes no kernel/host wire ABI.

## Evidence and limits

.context/node26-dns-channel-controls-r1/report.json has 26 passing scenarios:
22 controlled record responses compared through callback and promise APIs,
reverse, validation/server configuration, cancellation/pending server changes,
and default-resolver/exposure/descriptor checks. The actual candidate factories
execute against native Node channel/request/VM/OS dependencies. This does not
execute guest JSAPI or prove four-host conformance. Object/error comparison
scope excludes stacks and unselected metadata.

.context/node26-dns-channel-native-r1/report.json has 22 passing independent
portable c-ares decoder comparisons with pinned native Node. A separate native
callback control checks typed server/local-address ownership, a distinct event
thread, reverse, cancellation, destruction and values retained after close.
Its initial expected IPv4 literal did not match the existing packet fixture;
the failure and original helper/input/binary are retained. The expected literal
was corrected to the packet's 203.0.113.77; runtime code was unchanged.
Four existing DNS lookup/observer controls pass against native dependencies.

Initial source checks failed Mozilla include ordering in two newly staged
headers. Header ordering was corrected; checker bytes/expectations are unchanged.
The failed log and original inputs remain in .context. Final source checks
verify full pinned module bytes, generated bundle syntax, declared dependency,
patch82 exact forward/reverse, unchanged audit/pin and upstream include style.
No overall suite or full product rebuild has run. Targeted compilation is
recorded separately from guest behavior when its result is available.

## Remaining owners and later validation

* Compile/execute the identified guest bridge, validate rooted native work,
  cancellation/destruction and idle/pending exit on all four hosts. Historical
  Firefox exit-fixture timeout remains unresolved for this candidate.
* Complete target EnsureServers fallback-refresh policy after connection
  refusal, configuration reload and permission-mode integration. Native
  defaults cannot establish guest /etc/resolv.conf, hosts/services or egress.
* Audit exact inherited/private receiver/constructor/descriptor/reset behavior,
  provider frames and phase/ref policy. Reverse invalid input initializes then
  retires its actual request resource; that ordering still needs guest evidence.
* Verify OOM/GC/cross-realm/shutdown/reentrant setters/callback exceptions and
  mixed native pool/event work. Source ownership and compilation are separate
  from runtime ordering/lifetime proof.
* Complete guest lookup multiple-result/IPv6/name-source behavior. Internet UDP
  egress still reports EHOSTUNREACH on unsupported routes; local/session UDP
  has separate actual routes. Browser fetch routing is not raw DNS support.
* Reconcile individual original observations and later unchanged DNS/Resolver/
  record/cancel/TCP-fallback/exit assertions, preserving every nonpass and exact
  artifact/host/flag identity. Keep overall suites and full rebuild deferred.

Move next to independent audited owners rather than growing a DNS-only test
campaign. This source slice is not complete Node core compatibility.

The normal targeted wasm32 engine72 build subsequently succeeded in
320.1 seconds with all 618 frozen selected source identities unchanged.
The actual Node-vendored c-ares dependency compiled through the normal SDK
resolver recipe with real executable feature checks. Unchanged Mozilla
checks, optimization and fork instrumentation passed. Reports, executable
copies, dependency provenance/archive are retained in
.context/node26-engine-r72-accepted. No guest/four-host runtime validation,
overall suite or full product rebuild occurred. Compilation does not close
configuration, permission, identity, ordering or resource-lifecycle gaps.

The subsequent port/adapter integration pass found that engine72's new DNS
C++ functions were not forwarded by the production JS adapter. Compilation
and prior direct-native frontend controls did not prove that missing step.
The actual adapter control retains its dnsVersion failure and now passes the
same26 scenarios after forwarding all eight channel/query/configuration/version
bindings. See port-packets-implementation-dependencies.md. No prior scoped
result is promoted into guest conformance.

## Scoped IPv6 byte-address followup

Pinned cares_wrap uses uv_inet_pton for local source addresses, server tuples
and reverse input; its IPv6 parser removes `%zone` before parsing bytes. The
former raw c-ares parser rejected that suffix. In local-source configuration
that status was ignored after a separate JS isIP check, so accepted input
could fail to change the actual channel. The JS check also rejected empty or
arbitrary zone suffixes that native Node accepts for setLocalAddress.

A bounded shared DNS ParseAddress now implements the pinned fixed-buffer zone
rule and feeds the actual c-ares setters, server tuple conversion and reverse
request decoder. Local-family admission uses the same IPv6 prefix rule.
Zones are not fabricated interface indices or DNS answers. The public
setServers validation stays unchanged; getServers exposes the actual parsed
channel addresses/ports, which do not preserve ignored zone text.

Forty-four focused native configuration/component checks match selected public
callback/promise validation and server results against the exact Node26.13.0
reference, with production-header parser and actual c-ares channel operations.
They do not execute production guest JSAPI, reverse-query dispatch, async
resource metadata or four hosts. EnsureServers fallback/configuration reload,
permissions, lifecycle/receiver/CCW, maxTimeout limits, default/worker state and
actual transport/conformance remain open. Constructor/descriptor/error exports
and promisify are already sourced from pinned public modules; their presence
is not a new claim of complete runtime support.
