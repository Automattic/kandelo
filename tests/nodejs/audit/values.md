# Values-family source review

Review state: **broad source review complete with gaps**. The completed
[values contracts](values-contracts.md) reconcile the earlier observations
below with final assignments, inherited methods and native owners. No
implementation sign-off or runtime execution is implied. Final cross-family
audit reconciliation remains separate from this family review.

## Source ownership

| Public surface | Final source route | Audit state |
|---|---|---|
| assert / assert/strict | Bootstrap 2801–2810 → `_createNodeCore` → pinned assert/comparison algorithms with custom bindings and AssertionError | Source reviewed; error/diff/diagnostic/binding gaps V-029 |
| buffer | Bootstrap 1151–1374 plus numeric/unpooled installers at 2818–2820 and Blob assignment at 6836 | Source reviewed; public and inherited semantics/native allocation/policy gaps V-030–032 |
| constants | Public registry points directly to fs.constants at 5804 | Source review complete with aggregate/identity/descriptor and conditional-definition gaps |
| path, path/posix, path/win32 | `_createNodePathPlatform` at 1637; registry aliases 6011–6012 | Source reviewed; real lexical/glob owners, process dependency and runtime questions retained |
| punycode | Registry object 5805–5808 | Source review complete with missing/stub APIs, descriptors and deprecation findings; runtime pending |
| querystring | Bootstrap 3490–3529 | Source review complete with options, coercion, decoding, hook, callable/descriptor and error findings; runtime pending |
| string_decoder | Bootstrap 2898–3015 | Source review complete with conversion/coercion/receiver/state-view/size-error gaps |
| url | Bootstrap 3288–3484 → shared WHATWG implementation; custom legacy/path helpers | Source reviewed; actual WHATWG state/list/WebIDL owners and partial Node wrappers V-036 |
| util / util/types | Bootstrap 2603–2792 plus later shared-helper/event getters; brand adapter and inspection adapter | Source reviewed; missing owners, public deprecate miswiring, brands/inspection/error questions V-033–035 |
| sys | No registry entry or later assignment found in bootstrap public module registration | Source review complete: missing util alias/load warning, util behavior remains separate |

## Concrete source findings

| ID | APIs / requirements | Observed source and implication | Source references | Shared dependencies |
|---|---|---|---|---|
| V-001 | querystring.parse/decode: dictionary, duplicates and special property names | Uses `{}` and `key in result`, so inherited keys such as constructor/toString participate as existing values; Node starts with a null-prototype dictionary | Bootstrap 3491–3511; Node source `lib/querystring.js`, parse | Captured intrinsics, exact dictionary semantics |
| V-002 | querystring.parse: plus, malformed encoding, custom decoder, maxKeys and separators | Direct decodeURIComponent throws on malformed escapes; '+' is not converted to space; fourth options parameter is absent; value starts at idx+1 even for multi-character eq | Bootstrap 3491–3511; Node source `lib/querystring.js`, parse / qsUnescape | Byte encodings and tolerant percent decoder |
| V-003 | querystring.stringify/encode, escape/unescape and unescapeBuffer | Values use encodeURIComponent coercion directly instead of Node primitive conversion; custom encoder options absent; unescape has no malformed-input fallback; unescapeBuffer absent | Bootstrap 3514–3529; Node source `lib/querystring.js`, stringifyPrimitive / stringify / qsUnescape / exports | Buffer byte semantics and exact primitive coercion |
| V-004 | punycode toASCII/toUnicode and encode/decode/ucs2/version | Both present functions return input unchanged; remaining public exports absent | Bootstrap 5805–5808; Node source `lib/punycode.js`, exports and Bootstring implementation | Unicode/code-point algorithms and deprecation policy |
| V-005 | url.domainToASCII/domainToUnicode | toASCII is String(d), without domain validation or IDNA conversion; public domainToUnicode is absent despite a separate shared private helper used by formatting | Bootstrap 3385, 3484; Node source `lib/internal/url.js` | Actual IDNA/WHATWG URL backend, error/coercion rules |
| V-006 | url.fileURLToPath / pathToFileURL options and fileURLToPathBuffer | Helpers accept one argument only; windows option is ignored and byte-preserving fileURLToPathBuffer is missing | Bootstrap 3435–3479; Node source `lib/internal/url.js` | Path policy, percent decoder, raw filename bytes |
| V-007 | url legacy parsing, formatting, resolving and urlToHttpOptions | Parser returns a plain object, ignores third slashesDenoteHost argument and uses last colon as port even for bracketed IPv6; legacy format always appends // after protocol. urlToHttpOptions and Url constructor absent | Bootstrap 3288–3430, 3476–3480; Node source `lib/url.js` | Legacy source algorithms, querystring and public object/descriptors |
| V-008 | util public helpers | convertProcessSignalToExitCode, debounce, throttle, diff, getSystemErrorMap/getSystemErrorMessage, setTraceSigInt, markPromiseAsHandled, MIMEType/MIMEParams, parseArgs, parseEnv and styleText are absent from final util assignments | Bootstrap 2758–2792, 2816–2829, 3232–3236; Node source `lib/util.js` and `doc/api/util.md` | Signals/errors, scheduler, parser/MIME libraries, promise metadata and terminal styles |
| V-009 | util.getSystemErrorName and internal UV errors | Public lookup uses a hand-written errno subset; shared UV getErrorMap throws ERR_NOT_IMPLEMENTED. Full Node system-error names/messages and dependent error formatting remain missing | Bootstrap 367–385, 2781–2792; `third_party/node-core/values-platform-adapter.js`:83 | Actual guest errno/UV-style translation and error constructors |
| V-010 | assert.AssertionError diagnostics, error validation and expression extraction | Pinned assertion algorithms use a custom simplified AssertionError and generic codeError formatter; error_source expression always undefined. Importing pinned assert does not supply Node's full diagnostics | `third_party/node-core/adapter.js`:112–157; Node source `lib/internal/assert/assertion_error.js` / `lib/internal/errors/error_source.js` | Stack/source locations, shared errors, diff and inspection |
| V-011 | util.types.isKeyObject/isCryptoKey/isExternal | These predicates always return false; real constructors/representations and brand integration are not implemented | `third_party/node-core/adapter.js`:39–57 | Actual crypto/FFI object ownership and engine brands |
| V-012 | buffer constants legacy module | node:constants aliases fs.constants; Node creates a separate frozen aggregation of OS dlopen/errno/priority/signals, fs and crypto constants | Bootstrap 5804; Node source `lib/constants.js`:33–41 | SDK/OS/crypto constants, object identity and descriptors |
| V-013 | Buffer.from(Buffer/TypedArray/DataView) ownership and conversion | Every ArrayBuffer view becomes a view over the same buffer and raw byte length. Node's Buffer/Uint8Array overload copies, and other inputs require their own conversion rules | Bootstrap 1178–1209; Node source `lib/buffer.js`, from / fromObject / fromArrayLike | Typed-array brands, copying, raw buffer sharing and cross-realm checks |
| V-014 | Buffer.from/toString/write/byteLength encodings | Outside hex/base64, from uses TextEncoder; toString uses UTF-8; write and byteLength ignore encoding. Hex parsing consumes pairs with parseInt rather than Node's valid-prefix rules | Bootstrap 1178–1209, 1242–1294; Node source `lib/buffer.js`, encodingOps | Full byte codec surface, malformed/truncated input and overload validation |
| V-015 | Buffer.concat/copy truncation and fill bounds | concat copies each full source with TypedArray.set before checking totalLength; copy likewise sets full source slice. Node truncates to available capacity instead of failing for an oversized write | Bootstrap 1212–1227, 1313–1319; Node source `lib/buffer.js`, concat / copy | Bounds, overlapping copies, validation and result lengths |
| V-016 | Buffer.alloc fill/encoding and allocUnsafe(size, alignment) | alloc honors only numeric or string fill, string fill always uses UTF-8; empty pattern and invalid fill are not Node validation. allocUnsafe ignores alignment and is the original Uint8Array allocation path | Bootstrap 1161–1176; `third_party/node-core/buffer-unpooled-adapter.js`; Node source `lib/buffer.js`, alloc / allocUnsafe | Allocation policy, fill pattern, native alignment and public limits |
| V-017 | Buffer callable/legacy constructor, pool, missing public methods/exports | Buffer remains a Uint8Array subclass with inherited construction, no callable legacy wrapper. stringLength, copyBytesFrom, swap16/32/64, parent/offset, poolSize, buffer.File, isLatin1, resolveObjectURL and transcode lack their public owners. Inherited lastIndexOf exists but lacks Buffer overloads | Bootstrap 1151–1374, 2818–2820, 6836; Node source `lib/buffer.js` and public docs | Allocation/encoding/Blob/File/object-URL scope and CLI policy |

V-017's inherited-method distinction is completed by V-030.
For example, inherited TypedArray.fill exists but does not implement all
Node Buffer.fill overloads. Numeric read/write and selected prototype
methods are installed later by the pinned numeric adapter; public swap
methods are not in that selected range and remain missing.

Likewise, initial util.promisify/deprecate/debuglog implementations are
overwritten with shared pinned helpers. Those final helpers, rather than
the earlier definitions, are the audit targets. Abort-related util getters
are installed later as well.

## Open source questions

The [query/codecs reconciliation](values-query-codecs.md) completes the
querystring and punycode source reviews with explicit negative findings,
aliases/descriptors/coercion/load effects and later evidence requirements.
The [StringDecoder review](string-decoder-contracts.md) now completes that
module source audit with gaps. The [legacy module review](values-legacy-modules.md)
completes constants/sys aggregation and alias contracts, including V-024–V-028.
The [completed values review](values-contracts.md) now covers path and the
remaining owners. The questions below are retained as native controls and
explicit policy/artifact questions, rather than unperformed broad source review.

- Validate API/overload/error/descriptor observations, including path glob policy,
  assertion instances, inspect options/custom hooks and cross-realm brands.
- Trace TextEncoder/TextDecoder, WHATWG URL, StringDecoder and all byte
  codecs against the pinned Node algorithms and concrete engine limits.
- Determine exact CLI zero-fill/pool behavior and ArrayBuffer ownership,
  shared/resizable/detached storage and transfer requirements.
- Reconcile deprecated sys/util/punycode behavior and load-time warnings with
  public import policy; deprecation does not exclude an API.
- Attach scoped existing evidence to each applicable row without treating
  a historical artifact's results as current-candidate conformance.

No engine/platform exclusion has been accepted for these gaps.

## Later validation candidates, not executed

Source-discovered unchanged upstream files include:

| Concern | Pinned source candidates |
|---|---|
| Query dictionary, decoding and options | `test/parallel/test-querystring.js`, `test-querystring-escape.js`, `test-querystring-multichar-separator.js`, `test-querystring-maxKeys-non-finite.js` |
| Punycode | `test/parallel/test-punycode.js` |
| Domain and path URLs | `test/parallel/test-url-domain-ascii-unicode.js`, `test-url-fileurltopath.js`, `test-url-pathtofileurl.js` |
| Legacy URL objects | `test/parallel/test-url-parse-format.js`, `test-url-format.js`, `test-url-parse-invalid-input.js` |
| Util examples | `test/parallel/test-util-callbackify.js`, `test-util-parse-env.js`, `test-util-styletext.js`, `test-util-isDeepStrictEqual.js` |
| Byte operations | `test/parallel/test-buffer-concat.js`; remaining Buffer cases still need full selection |
| Streaming decode | `test/parallel/test-string-decoder.js`, `test-string-decoder-end.js`, `test-string-decoder-fuzz.js`, `test-string-decoder-utf8-large.js` |

Bare test filenames in a row share its first `test/parallel/` prefix.
Native controls must establish expected values, errors, descriptors,
mutation effects, alias identities and asynchronous ordering for the exact
pin. These proposed comparisons have not been executed in this audit.
