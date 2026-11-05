# StringDecoder source audit

The public/retained legacy surface source review is complete with
implementation gaps. Runtime conformance is pending on all four hosts;
no test, probe, compilation or build was run. This completes neither
Buffer nor TextDecoder/Web APIs nor the values family.

## Owners and requirements

Pinned `lib/string_decoder.js`:24–170 implements construction,
write/end/text and lastChar/lastNeed/lastTotal through a seven-byte native
state buffer. `src/string_decoder.h`:34–54 and `string_decoder-inl.h`
define four incomplete bytes, missing/buffered counts and encoding field.
`src/string_decoder.cc`:57–252 implements incremental decoding and flush;
StringBytes::Encode in `src/string_bytes.cc`:568–765 supplies actual
UTF-8, UTF-16LE, ASCII/Latin1, hex and base64/base64url conversion.
`lib/internal/util.js`:258–316 supplies exact normalization.

Candidate `bootstrap.js`:2898–3015 has a real corresponding synchronous
state machine, owned by a WeakMap, with a four-byte Buffer and explicit
missing/buffered counts. Its byte input boundary is
_nodeBufferSourceBytes:92–123; conversion uses the global TextDecoder,
public Buffer.from/toString, direct code-unit assembly and public string
helpers. The shared guest implementation is used on every host.

| Public member | Required behavior and source disposition |
|---|---|
| StringDecoder(encoding) | Callable constructor, including .call(object), normalized encoding/default, ERR_UNKNOWN_ENCODING and ordinary encoding property. State is reinitialized on each call. Candidate handles ordinary supported strings but has the normalization/receiver differences below. Prototype and assigned methods have ordinary function metadata/descriptors; there is no EventEmitter/stream inheritance. |
| encoding | Ordinary own writable/enumerable/configurable property; changing it later does not change the already selected native encoding. Candidate similarly keeps a separate state encoding, but constructor-time accessors differ. |
| write(buf) | Strings are returned unchanged even before receiver validation. Other inputs require actual ArrayBufferView brands, including Buffer, typed arrays and DataView; raw AB/SAB and proxies over views are not accepted. Byte offset/length, detached/OOB empty spans, shared/resizable views and argument-before-receiver error order matter. Candidate obtains intrinsic view spans but uses mutable global brand/accessor machinery. |
| Incremental conversion | ASCII clears high bits; Latin1 preserves bytes; hex is lowercase. Base64/base64url buffer modulo-three bytes and flush with correct alphabet/padding. UTF-8 buffers tail lead/continuation sequences and interrupts missing sequences correctly; even invalid C0/C1 and overlong lead shapes can initially be buffered by the target, so they are not falsely flagged as candidate-only behavior. UTF-16LE buffers odd bytes/split high surrogates, preserves code units and ignores a single odd trailing byte on flush. Candidate's state-machine structure follows these native branches; imported helper behavior is still a real dependency. |
| end([buf]) | Omitted input skips write; provided input uses replaceable this.write, then flushes incomplete bytes and permits reuse. Do not demand a target-private immutable write function: both implementations deliberately dispatch through this.write. Candidate conversion/error/state-reset behavior still differs through its dependencies and receiver storage. |
| text(buf,offset) | Retained undocumented legacy member: reset missing/buffered state, then this.write(buf.slice(offset)). Public slice/write replacement and offset coercion remain observable in both target and candidate, rather than being rewritten to a new intrinsic-only contract. |
| lastChar | Enumerable/configurable getter with no setter; target returns a fresh four-byte Buffer subarray each time, sharing the real state storage. Candidate returns its same cached Buffer, a concrete identity mismatch. |
| lastNeed / lastTotal | Enumerable/configurable readonly accessors into actual state; total is missing plus buffered bytes. Candidate tracks corresponding counts but has WeakMap receiver behavior. No fd/timer/native work owner is allocated by these operations. |

Invalid-byte UTF-8 replacement is real in the candidate TextDecoder
state machine at bootstrap:166–283. Its valid-span fast path first checks
_bufferIsUtf8 and excludes shared spans, then calls adapter decodeUtf8.
The SpiderMonkey adapter captures its own encoder/decoder before the
polyfill; its fallback uses decodeURIComponent(escape(binary)) for valid
UTF-8 (`adapter.js`:35–37,178–187). It is not an unconditional raw Latin1
decode. Outer Node/browser TextDecoder objects are not automatically
available in the guest realm. Any retained native-decoder branch and BOM
behavior require explicitly identified initialization context later.

Shared views are not promised to be immutable snapshots: native
ArrayBufferViewContents (`util-inl.h`:600–612) can read live backing
storage. Source analysis of bounds/brand behavior is not a claim to have
executed detached/resizable/shared controls on SpiderMonkey or every host.

## Concrete remaining gaps

V-018 and V-022 from the earlier query/codecs report remain:
mutable conversion/global helpers differ from target's captured/native
paths; forwarding a receiver Proxy can expose the target symbol-owned
state, whereas the candidate WeakMap rejects it; lastChar view identity
differs. Target Buffer.alloc and end/text dispatch also remain mutable,
and are not incorrectly labeled candidate-only defects.

**V-027: normalization and constructor receiver access.** Target
normalizeEncoding dispatches on enc.length and may use captured
StringPrototypeToLowerCase with ordinary ToString coercion. An object
with length 4 and toString returning utf8 can reach that conversion.
The candidate instead demands a primitive string or successful intrinsic
String.prototype.valueOf, rejecting that object. It also calls mutable
name.toLowerCase. Target assigns this.encoding and reads it again for
validation/native selection; the candidate keeps its local name for
state initialization. Accessor-bearing .call receivers can therefore
change target selection or throw at a different stage. These are source
findings; no new demonstration was executed.

**V-028: string-limit/error contract.** Target MakeString checks UTF-8
span length and emits ERR_STRING_TOO_LONG, and StringBytes owns actual
conversion allocation/size errors. Candidate code has no equivalent
StringDecoder limit/error mapping and builds via TextDecoder, btoa,
String.fromCharCode/join and Buffer helpers. Patch 0048 exposes the real
SpiderMonkey JSString::MAX_LENGTH and TypedArray byte limit; copying V8
limits would misrepresent the guest. Different engine ceilings need
explicit documentation, while missing intentional error codes/state
handling remain implementation work. No maximum allocation was probed.

The target's symbol named kNativeDecoder is explicitly private native
storage, not a new documented public symbol API. Its observability and
receiver effects are retained in this audit; no fabricated matching
symbol is proposed. Public Symbol.dispose/asyncDispose/iteration APIs
are not present on StringDecoder in the target and are not invented.

## Proposed subsequent validation

Preserve unchanged test-string-decoder.js, -end, -fuzz, -utf8-large and
other pinned decoder cases with their actual common helpers, flags and
memory gates. The base case explicitly covers call-with-object, all
ArrayBufferView types, malformed input, retained state accessors, exact
coded errors and a memory-gated oversized UTF-8 span. Its memory skip
must stay nonpassing evidence; do not force an allocation during audit.

Later native controls should cover every byte split and flush/reuse,
invalid UTF-8 boundaries, raw UTF-16 code units and odd tails, all base64
remainders/alphabet/padding, aliases/encoding objects/accessors, strings
and receiver/argument error order, mutated helpers, Proxy receivers,
fresh/shared lastChar views and actual AB/SAB/resizable/detached storage.
Native and each guest host require their own artifact identities and
original outcomes. Existing historical common-helper failures do not
establish any of these assertions ran on current candidate revision 45.
