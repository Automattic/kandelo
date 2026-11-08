# Actual HTTP client performance entry producer

The existing complete pinned timerify module is already consumed by the public
Performance and perf_hooks owners. It uses the real performanceNow clock,
actual Histogram ownership and PerformanceObserver queue; it is not replaced
or credited as new work here.

The actual ordinary HTTP ClientRequest now consumes the pinned startPerf and
stopPerf blocks from _http_client.js. Its installed _finish calls the actual
OutgoingMessage._finish first, preserving prefinish/user callback order, then
starts a HttpClient entry only when an actual http observer exists. The start
record retains the existing private request authority/proxy state from pinned
prepareHeaders, the actual method/path and the target getHeaders read. No
synthetic network metric, promise completion or native provider ID is created.

The actual final response-header callback stops the entry before response event
publication, using real statusCode/statusMessage/headers. Informational and
upgrade callbacks use their separate existing parser paths. Failed requests
with no final response do not manufacture successful entries. Response-body
completion is not substituted for final response headers. Clock errors and
public property/getHeaders exceptions remain real; the producer adds no catch,
suppression or fallback. The private statistics Symbol and observer queue keep
real request/detail objects alive only through their existing JS ownership.
The selected target stop block does not delete the record; this preserves the
target's retained record and observer-disconnect/reconnect behavior.

The shared observer supported-type selection now admits http because genuine
ordinary HTTP ClientRequest and the existing pinned ServerResponse producers
consume it. It does not advertise GC, HTTP2, net or QUIC producers. Public HTTP
Server activation and persistent connection lifecycle remain incomplete.
HTTPS currently follows the separate legacy makeHttpModule route without the
actual Agent request authority and is deliberately not given a fabricated
HttpClient URL or timing record by this slice. That remains an implementation
gap, not an accepted platform boundary. Native callback/resource/GC/realm/Worker
and four-host timing/lifecycle conformance is unvalidated.

This is partial observability O-008/O-009 source progress, with HTTP lifecycle
prerequisites still governed by the network/HTTP findings. No full performance,
PerformanceObserver, Server or crypto/other-family completion is claimed. The
full pinned target _finish also has independent diagnostic-channel/trace
producers; those are not implemented or credited by selecting just the timing
blocks. Existing metrics, GC hooks, uvMetricsInfo, Worker milestone ordering
and V8-start unset policy remain unchanged.

Zero tests, probes, compiler attempts, generation or builds were run. There is
no new runtime/API group evidence. These contextual source hunks must compose
over later bootstrap/curves/Fetch changes, and the parent must perform actual
normal generation in its coherent batch. Existing Agent-only fixtures need no
timing owner until they exercise the new timing-consuming paths; fixtures that
do so must supply the real observation owner rather than a no-op substitute.
