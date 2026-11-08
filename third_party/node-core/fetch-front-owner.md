# Actual Fetch forwarding and WebIDL boundary

The public `fetch` is an ordinary function declared as
`fetch(input, init = undefined)`, forwarding both formals to the existing
private async consumer. Its name, length one and constructibility come from
the actual function declaration, not reflected-property overrides. A narrow
strict factory supplies the returned function's strict code; the existing
global descriptor publication owner is unchanged. The receiver is ignored and extra arguments
are not forwarded, as in the target's public wrapper.

This distinction is necessary for the argument check. Pinned Node
`exposed-window-or-worker.js:80–85` forwards both input and init, and Undici
`index-fetch.js:35–36` likewise forwards both values to its inner fetch. Even a
public `fetch()` reaches that inner consumer with two arguments. Adding a new
argumentLengthCheck directly to the old public async function would produce
the wrong zero-argument failure. This slice claims no new public missing-arg
rejection. Undefined input still reaches actual Request conversion and its
rejected-Promise error behavior.

The private consumer calls the captured, actual Undici WebIDL
argumentLengthCheck with its genuine arguments object before Request
construction, matching `fetch/index.js:158–160`. The same WebIDL owner already
serves Request/Body conversion. No hand-built length/status object or duplicate
validator is used. Private async execution preserves the existing rejection
path for Request/input/options exceptions; the ordinary outer wrapper returns
that Promise directly. This does not implement the target's full lazy module,
withResolvers/catch/stack/controller lifecycle.

The earlier dataURL dispatch issue is already source-addressed: current source
constructs the captured Request, reads its private state/current URL, and routes
data before public Request url/headers/method or global URL construction. The
historical source265 observation and appended source266 correction must both be
retained. This slice does not reimplement that route or credit it as new work.
Pinned Undici itself reads public requestObject.signal, so this slice does not
invent a new private signal accessor or change signal getter policy.

SRI remains an explicit missing implementation, and original cancellation
crash/nonpasses and full Fetch error-metadata failures remain unresolved.
The HTTP Request-record transport correction is described below. Redirects,
filtering/content decoding, dispatcher/cache/CORS policy, async/internal Promise
and stack metadata, and
guest/four-host validation are not completed here. Source inspection and exact
patch replay only were performed: no new runtime controls, compilers, normal
generation, package or overall suites, or guest execution. Parent owns later
shared generation and identified-artifact validation.

The generated guest bootstrap strips ESM imports and is evaluated as a Script
without forceStrict; the adapter-prefix IIFE has no strict directive. Therefore
source-file ESM syntax is not sufficient strictness authority. The earlier
5f294d52 capsule incorrectly asserted that it was. Its original source/report
remain immutable. This successor uses a simple-parameter strict factory that
returns the named ordinary function with the real default-parameter signature.
Strictness is inherited lexically; no illegal strict directive appears in the
non-simple parameter body, and no caller/arguments descriptors are fabricated.
Only this wrapper scope becomes strict. The retained private async consumer and
other bootstrap scopes are unchanged. Full target error/stack behavior remains
unimplemented/unvalidated as documented above.


## HTTP transport consumes the actual Request record

After the captured pinned Request constructor and genuine getRequestState,
HTTP transport consumes that record's method, HeadersList and current URL.
Pinned Undici index.js dispatch likewise reads request.method,
request.headersList.entries and requestCurrentURL(request); it does not reread
public Request.url, Request.headers or Request.method. Those mutable getters
must not redirect or replace validated transport state. The second global URL
construction is removed; the admitted Request URL object remains the actual
parser/serialization authority. Response publication clones the actual Request
URL list, matching the target's internal response URL-list lineage instead of
reparsing a public string. This adds no duplicate URL parser or fake record.

The public Request.signal access is retained because pinned fetch explicitly
uses it. Existing URL-field accesses (protocol, port, hostname, pathname/search)
remain accesses to the genuine URL object; no broad capture/intrinsic policy is
invented. Constructor RequestInfo/RequestInit/WebIDL conversion remains unchanged.
The existing data-URL early dispatch, upload stream owner and cancellation/body
owner are not rewritten. This bounded source correction does not establish the
full target ordering of repeated signal getters, URL fields, abort admission,
scheme dispatch or response publication under reentry.

Partial WEB-003/WEB-005 source progress does not close Fetch. SRI, redirects,
CORS/cache/filtering/decompression, headers policy, full Fetch controller,
upload and stream/lock/cancel/error/EOF interactions, cause/socket metadata and
stack/realm/GC/four-host behavior remain incomplete or unvalidated. In particular,
the earlier full premature-close cause mismatch and later enqueue/desiredSize
publication question remain unresolved. Actual candidate transport is the
existing HTTP/IncomingMessage/Socket owner, not an outer-host fetch delegate.

The patch is contextual over the source272 Fetch section, verified identical
to the pending source273 Fetch section. Its whole bootstrap is an image for
review only; later composition must preserve newer stdio/parser/TLS changes.
No tests, probes, generation, compiler or build were run for this source slice.
