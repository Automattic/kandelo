# Pinned URL, file-path and HTTP-option conversion ownership

Source111 addresses portions of V-006/V-007/V-036 by replacing the handwritten
POSIX-only file-URL helpers and adding the missing byte conversion and HTTP
options helper. The exact Node26.13.0 target/source/native-reference pins and
frozen audit remain unchanged. These unchanged JS bytes are now compiled in accepted engine112. No new
URL-helper guest controls ran in that storage slice; the focused evidence
below remains native-dependency/source evidence, not four-host conformance.

## Reused algorithms and real dependencies

`third_party/node-core/url-path-platform-adapter.js` consumes unchanged
manifest-selected sections from the pinned `lib/internal/url.js` and
`lib/internal/data_url.js`. They implement:

- `fileURLToPath`: POSIX and Windows drive/UNC paths, host and encoded-separator
  validation, options access and string decoding.
- `fileURLToPathBuffer`: byte-preserving percent decoding, including arbitrary
  non-UTF8 bytes and literal malformed percent escapes where Node allows them.
- `pathToFileURL`: target path resolution, Windows/UNC options, trailing slash,
  validation and hostname handling.
- `urlToHttpOptions`: null-prototype output, enumerable string/symbol user
  properties, IPv6 brackets, authentication decoding and property-read order.

The exact private `isURL` predicate is also reused. It checks href/protocol and
the absence of legacy auth/path fields; it is not an intrinsic brand check.
The production namespace exports only the four public helpers, not this
private predicate. Public/global URL and URLSearchParams retain their shared
constructor identities.

Node's private URL constructor path modes normally enter native code. The
adapter ports only `src/node_url.cc`'s EncodePathChars primitive: its exact
15-entry ASCII table and Windows backslash rule. Generation verifies the
selected native source and derives the table. The real shared WHATWG parser
owns parsing, serialization and hostname/IDNA canonicalization. Results are
actual public URL instances with live searchParams, not shadow href objects.
Rejected hostname assignments are observed through an uncommitted parser
record and become the shared ERR_INVALID_URL with its actual input/base.

The helpers consume the real shared Buffer, path, error/validator/primordial
and domain owners and actual guest process.platform. They introduce no
host-Node forwarding, platform-identity change, native binding, kernel/host
ABI change or memory ceiling. The shared bootstrap moves domain initialization
before the URL helper factory and wires the four public methods explicitly.
The separate Claude/npm/Bun asset branch is byte-identical to its preimage.

## Frozen audit discrepancy

The V-036 sentence in `../audit/values-contracts.md` claiming that URIError for
bad file-URL bytes differs from Node is inconsistent with this pinned target.
Both pinned POSIX and Windows string conversion algorithms call
decodeURIComponent directly. Exact-native differential controls confirm
URIError for `%FF`, `%C0%AF` and malformed escapes. The unchanged upstream
byte-filename file also expects URIError for the string API.

The frozen audit is preserved. This mutable record resolves that sentence
against the actual pinned source and native behavior; it does not replace
URIError with a fabricated file error. The byte-returning API is distinct and
preserves permitted raw bytes. Exact URIError message/stack parity in the guest
engine remains unvalidated and belongs to the shared error work.

## Focused evidence and its limits

`.context/node26-url-path-source/report.json` records archive-verified hashes
for three full Node files and five selected sections, the encoding table,
generated-bundle freshness, combined-bootstrap generation/syntax, production
owner routing, unchanged target/audit and preserved Bun branch. The first two
checker attempts used incorrect source-marker expectations; their failed logs
are retained separately. They were tooling failures before runtime execution.

The final `.context/node26-url-path-frontend-r2.json` records15passing cases,
zero failures/skips:8new URL/path controls and7affected existing URL/exit
controls. The first15-case run is retained separately; the final run adds
stronger HTTP getter-order assertions within an existing case, not more cases.
Checks cover POSIX/Windows/UNC behavior, all128ASCII positions, surrogates,
shared URL identity/live state, validation, byte preservation, option/predicate
getter order, HTTP output/properties/getters and actual platform diagnostics.
Nested input comparisons are not separately counted APIs.

The fixture runs the generated candidate algorithms, vendored parser and
candidate shared path/errors/validators. Native process, inspection, globals
and default Buffer remain explicit dependency controls. The byte-returning
case supplies the actual candidate Buffer/codec owner with its controlled
allocator and checks its brand/prototype. It does not establish guest buffer
allocation, GC, transfer, filesystem or four-host conformance. The pre-existing
native environment helper is supplied explicitly for the affected controls;
no new helper compilation is counted here.

`.context/node26-url-path-upstream/report.json` retains four archive-verified,
unchanged upstream files in candidate/native modes:8executions,6pass/2skip.
`test-url-fileurltopath.js`, `test-url-pathtofileurl.js` and
`test-url-urltooptions.js` pass in both modes. `test-fileurltopathbuffer.js`
skips in both modes under its unchanged actual-macOS guard:
`Test unsupported on OSX`. The skip is not passing compatibility and is not
an accepted Kandelo API exclusion. Candidate preload redirects subject URL
methods and shared public/global constructors; native common, node:test,
filesystem and Buffer remain declared dependencies. Raw output and exact file
identities are retained. Six passes mean three distinct passing files.

## Remaining dependency order

1. Preserve raw Buffer filenames through public filesystem and loader argument
   validation, native marshalling, VFS/host backends and error paths. A
   byte-returning URL helper alone does not implement arbitrary-byte filenames.
2. Complete legacy URL parse/format/resolve/resolveObject/Url, public WHATWG
   wrapper errors/descriptors/coercions, complete IDNA behavior, Blob URL
   registry ownership/revocation and URLPattern. Existing private URL consumers
   need their own overload and brand/predicate reconciliation.
3. Complete HTTP request/Agent/server use of URL options and actual transport
   lifecycle; the helper alone does not establish HTTP integration.
4. Engine112now includes the unchanged source111bundle through the normal
   targeted path. Verify actual URL-helper behavior and identified artifacts
   on Node, Chromium, Firefox and WebKit; compilation is not that evidence.

The generic Error own-stack/prototype layout failure and all historical
nonpasses remain open. No finding/family is declared complete. Overall suites
and the full product rebuild remain deferred.
