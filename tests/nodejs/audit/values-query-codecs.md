# Query string, Punycode and streaming decoding reconciliation

This is a source audit, with no new runtime execution. **querystring and
punycode have completed source reviews for their public reachable module
surfaces**, with the missing and incorrect behavior below. That does not
complete the values family or establish runtime conformance. StringDecoder
and path remain partial for the specifically recorded dependency questions.

## querystring: all seven exports

Target requirements: pinned `doc/api/querystring.md`:1–177,
`lib/querystring.js`:44–65,93–145,165–290,437–end and
`lib/internal/querystring.js`:38–112. Candidate owner: bootstrap:3490–3529,
registered without a later override in the shared builtin registry.

| Public API | Requirement and source conclusion |
|---|---|
| parse / decode | Same callable alias; null-prototype dictionary; string-only input (other values return empty dictionary); duplicate values; empty-entry versus empty-key distinction; multi-character/coerced separators; + decoding, tolerant malformed escapes, custom decoder/fallback and maxKeys. Candidate aliases are identical, but parse uses a plain object/inherited lookup, split, idx+1 and decodeURIComponent. It adds entries for bare empty segments, throws on truthy non-string input and malformed escapes, ignores maxKeys/custom decoders and fails multi-character equals. V-001/V-002 |
| stringify / encode | Same callable alias; object-only input, own keys/array values, Node primitive conversion (unsupported and nonfinite values become empty), separators, replaceable escape and custom encoder. Candidate aliases are identical but Object.keys(null/undefined) throws, string/function inputs can be serialized, object/nonfinite values are string-coerced, and mutable encoder/options are ignored. V-003/V-019 |
| escape | Percent encoding and Node error behavior, including the target's exact surrogate handling. Candidate delegates to encodeURIComponent. Normal scalar encoding has a real path; malformed/surrogate behavior and coded URIError differ. V-023 |
| unescape | Fast decodeURIComponent with tolerant byte/UTF-8 fallback on malformed escapes; replaceable public hook used by parse. Candidate only calls decodeURIComponent; malformed input throws and parse never consults its public hook. V-003/V-019 |
| unescapeBuffer | Byte-preserving permissive percent decoder, optional + to space, Buffer return. Missing export/implementation. It is exposed and directly exercised by unchanged upstream tests despite not having its own docs heading. V-003 |

`parse('&')` and an explicitly empty key such as `parse('=')` are distinct
requirements. The candidate treats both as empty-key entries. Keys such
as constructor/toString/__proto__ can interact with the inherited object
or its setter instead of becoming ordinary own dictionary entries.

V-019: public hook replacement is part of the documented contract.
`QueryString.escape` and `.unescape` are read by the target algorithms;
the candidate calls lexical encodeURIComponent/decodeURIComponent.
Replacing those exported functions therefore fails to affect its
stringify/parse. The candidate also looks up mutable global/object/array
methods where the target uses captured primordials; this is additional
observable dependency behavior, not a browser boundary.

V-020: alias identity does not establish descriptor/callable metadata.
Both module objects use ordinary writable/enumerable/configurable value
properties, but candidate parse/stringify have length 3 versus target 4;
unescape has length 1 versus target qsUnescape's 2. Target escape/unescape
function names are qsEscape/qsUnescape, versus escape/unescape. The absent
unescapeBuffer and its function/prototype descriptors remain missing.
The alias functions retain their originating function name and identity.
No module-owned symbol or asynchronous handle is created by this source.

V-023 is pinned by `test/parallel/test-querystring-escape.js`:19–33 and
internal/querystring.js:88–102. A trailing surrogate produces Node's
URIError with code ERR_INVALID_URI; raw encodeURIComponent does not add
that code. The exact target encoder also consumes the code unit following
a surrogate using its low ten bits; the upstream test deliberately pins
that legacy result for a surrogate followed by ordinary text. Substituting
a more conventional URI encoder is not compatible with that assertion.
This audit records the requirement without changing either implementation
or test.

There is no external I/O, native Unicode or host-specific operation in
the candidate querystring path. Its absent byte fallback would depend on
real Buffer/UTF-8 semantics. Source conclusions apply to all four hosts;
runtime results remain pending. There is no accepted engine/platform
boundary for these gaps.

## punycode: all eight named surfaces and load behavior

Target `lib/punycode.js`:1–14,431–455 exports version 2.1.0, ucs2 with
decode/encode, decode, encode, toASCII and toUnicode. Docs:1–160 specify
Bootstring conversion, Unicode code-point arrays/surrogate pairs and
domain/email label conversion. The actual candidate registry at
bootstrap:5805–5808 only contains identity toASCII/toUnicode methods.

| Public API | Requirement | Candidate conclusion |
|---|---|---|
| decode | Decode Bootstring ASCII payload to Unicode, with specified invalid-input/overflow behavior | Missing |
| encode | Encode Unicode code points to Bootstring ASCII | Missing |
| ucs2 / ucs2.decode / ucs2.encode | Public namespace; decode surrogate pairs into code points and reconstruct strings from code-point arrays | Namespace and both functions missing |
| toASCII | Convert non-ASCII domain labels, normalize recognized label separators, preserve email local-part handling | Returns argument unchanged; incorrect even for normal documented Unicode example |
| toUnicode | Decode xn-- labels to Unicode with domain/email handling | Returns argument unchanged |
| version | Exact bundled library version string | Missing; target 2.1.0 |

V-021: module load must apply DEP0040 application deprecation. Target
punycode checks internalBinding('util').isInsideNodeModules and emits a
DeprecationWarning for an applicable load. `src/node_util.cc`:331–362
examines the first relevant non-node stack frame; deprecations.md:931–958
classifies the exact release as application deprecation, not end-of-life.
The eager candidate object and generic builtin loader contain no such
punycode load effect or source-origin check. Missing warning activation
does not justify excluding the still-exported API.

The two candidate concise methods also differ from target function
declarations in constructability/prototype presence; the native descriptor
inventory records those target function prototypes. The other properties
and their descriptors are absent. There are no public module symbols or
asynchronous resources. Unicode and domain conversion belong to the
compatibility algorithm layer; a different private URL dependency already
containing Unicode code is not a connection to this public module.

All four hosts share this missing/stub surface. No engine/platform
boundary is accepted. Deprecation scheduling/output depends on the
separately incomplete process/warning and loader owners; the missing
module-specific effect is established independently.

## StringDecoder: real state, remaining semantic differences

Candidate bootstrap:2898–3015 has a WeakMap-owned state machine for UTF-8,
UTF-16LE, base64/base64url and direct ASCII/Latin-1/hex, with real pending
bytes, end flushing and reuse. Public StringDecoder, write and end exist.
The chunk-state logic follows the target native transitions at
`src/string_decoder.cc`:57–254; direct conversion uses different owners.

V-018: UTF-8 conversion constructs the mutable global TextDecoder on each
span, and hex/base64 uses public Buffer.from/toString. Target conversion
uses native StringBytes::Encode. User replacement of those globals or
methods can therefore affect candidate decoding without affecting the
target's native conversion path. Constructor Buffer.alloc and end's
this.write are also mutable in the target; those must not be falsely
reported as candidate-only deviations.

V-022: target write reads its internal state via an ordinary symbol
property; candidate requires WeakMap identity. A forwarding Proxy around
a target decoder can provide that symbol state, while the candidate
rejects the proxy as an invalid receiver. Native source accepts actual
ArrayBufferView bytes; candidate's intrinsic view helper is at 92–123.
Full detached/shared/out-of-bounds behavior and diagnostics remain open.

Undocumented legacy text/lastChar/lastNeed/lastTotal are retained as exposed
requirements. Target lastChar creates a fresh subarray view on each read;
candidate returns the same cached Buffer. Getters' enumerable/configurable
shape is supplied, but receiver/error/view identity semantics differ.
These legacy members are not silently counted as new documented APIs.

State is JS/Buffer-owned and synchronously released by reachability; no
fd/timer or external resource exists. Engine byte storage, Buffer codecs
and TextDecoder remain dependencies. The subsequent [complete source review](string-decoder-contracts.md)
reconciles these input/conversion/error/coercion requirements with concrete
gaps and explicit unexecuted controls. This paragraph records the earlier
checkpoint, not a current claim that the module source review is unfinished.

## path: dependency trace without a conformance claim

The path.js, internal constants and minimatch files match the exact
target source bytes. getLazy is an exact excerpt; glob matching is a
composition of unchanged helpers, not the filesystem traversal module.
build.py:106–125 injects private factories and explicit exports.
path-platform-adapter.js supplies SafeMap, isWindows/isMacOS, a frozen
empty object and lazy shared validateString/validateObject. Thus the
excerpt's closure variables really have owners; finding names absent
from the excerpt alone would be a false missing-dependency report.

Default export follows the guest POSIX platform. path.posix/path.win32
and node:path/posix/node:path/win32 point to the actual two objects, with
cross aliases and _makeLong retained. Explicit win32 algorithms remain
in scope even on this POSIX guest. POSIX toNamespacedPath is intentionally
an identity operation in the target, not a missing implementation.

resolve/relative use real guest cwd and Windows drive environment inputs
from process, with that owner's known environment gaps. Other lexical
methods have no filesystem access. matchesGlob uses the target matching
helpers/cache/minimatch and guest platform branch; it does not need fs
traversal. The completed values-contracts.md review covers Windows root/device/reserved-name
branches, matcher/helper dependency semantics and aliases/descriptors. Exact
receiver/callable metadata and process-state edge errors remain later native
controls, not evidence of runtime parity.

## Existing evidence and later controls

The completed baseline case ledgers include these modules, but failures
at common-helper initialization do not establish their assertions ran.
The linked historical records retain original status and artifact hashes.
No current-candidate conformance is established for any reviewed API.

Later unchanged selections: test-querystring.js, test-querystring-escape,
test-querystring-multichar-separator, test-querystring-maxKeys-non-finite,
test-punycode, test-string-decoder, test-string-decoder-end/fuzz/utf8-large
and method-specific path tests, all in test/parallel at the exact pin.
Native controls should cover hook replacement, aliases/descriptors and
length/name, malformed percent/UTF input, empty/non-string inputs,
prototype-sensitive keys, Unicode/surrogate domains, load-origin warnings,
decoder receiver/state/view identity and mutated conversion helpers.
These controls are proposals only and were not executed.
