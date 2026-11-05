# Buffer codec source slice and remaining owners

This implementation-phase record follows the immutable values audit. It
addresses V-014 and parts of V-016/V-017/V-030/V-031. It does not close those
findings or the values family. The target stays Node 26.13.0 at
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

## Implemented source

`third_party/node-core/buffer-codecs-adapter.js` owns UTF-8, ASCII/Latin-1,
UTF-16LE, hex, base64 and base64url over intrinsic-branded byte spans. UTF-8
encoding replaces unpaired surrogates and capped writes stop before a
partial character. Decoding consumes maximal valid prefixes of malformed
UTF-8 and retains a BOM. UTF-16 preserves raw code units and ignores an odd
trailing byte on decode. ASCII encode takes the low byte; decode masks its
high bit. Hex stops at the first invalid pair and ignores an odd nibble.
Base64 accepts both alphabets, skips invalid characters and stops at padding.
Legacy hex/base64 UTF-16 input uses the pinned nbytes uint8 table indexing.

Pinned public wrappers supply encoding aliases, argument/range normalization,
fromString/createFromString, byteLength/stringLength, alloc/fill/write,
toString/toLocaleString and bidirectional search, plus private prototype
slice/write wrappers and isLatin1. The byte adapter delegates string
conversion to this owner. The real unpooled allocator exports its private
createUnsafeBuffer to alloc; fill encodes actual bytes without consulting
mutable public allocator methods. The public createFromString retains its
own target call to Buffer.allocUnsafeSlow.

The private search owner handles numeric and encoded needles, empty inputs,
relative offsets, exclusive ends and UTF-16 unit alignment, including the
different string/buffer offset rounding in the target native source. Fill
uses encoded or raw view patterns and snapshots overlapping bytes before
repetition. Slices copy shared bytes before string construction; they do not
consult user-controlled backing-store/offset properties or species. Native
private binding error text remains distinct from public JS validation text.
Public assignment descriptors and toLocaleString alias identity are restored.

The bundle selects exact hash-checked sections from the retained lib/buffer.js
and lib/internal/buffer.js. Native reference files under upstream/buffer-codecs
are specifications, not compiled V8 support. Protocol encoding tags come from
their pinned src/node.h enum. The engine supplies its actual buffer/string
limits. No kernel/host wire interface changes occur.

## Evidence and its limits

The final focused run `.context/node26-buffer-codecs-controls-r4.log` passes
23 controls: nine new codec controls, eight existing byte controls and six
HTTP header controls. They load actual candidate source and the exact
SHA-verified Node reference. These are JS controls over real fixed
ArrayBuffers at the allocation boundary, not guest native allocation.
The codec controls compare all 65,536 two-byte UTF-8 inputs and selected
malformed three/four-byte prefixes, aliases, malformed hex/base64, capped
writes, bounds, raw views, lengths, fill, search, descriptors, private error
paths and public allocator replacement. The exhaustive two-byte comparison
is not exhaustive Unicode/input/concurrency coverage.

Three unchanged upstream public files (ASCII, write and two-byte-string
UTF-8 write) run against candidate and native reference. The final report
is `.context/node26-buffer-codecs-upstream-r3/report.json`; its six process
outcomes, source identities, logs and explicit native boundaries are retained.
Native assert/common, engine and all non-Buffer internal bindings remain
native; unrelated buffer-module exports in the preload remain native too.
No unchanged assertion is patched or suppressed. These files do not exercise
the real allocation pool even where their comments describe that pool.

Earlier controls and inputs remain historical. The second focused run
recorded 21 passes and one failure: its new allocator-isolation control
incorrectly expected the invalid hex pattern `éab` to succeed. The corrected
control compares both valid and invalid pattern outcomes with native Node;
the failure and exact inputs remain under node26-buffer-codecs-r2-source.
Source review subsequently corrected native private error text and expanded
the focused control; earlier passing runs do not validate those later bytes.

## Remaining implementation and validation dependencies

* Actual shared pool layout, alignment and mark-untransferable ownership are
  missing. fromStringFast deliberately uses createFromString's unpooled path;
  this is an implementation deviation, not a platform exclusion or full
  pinned pool implementation. Array-like allocation ordering stays open.
* The callable/deprecated Buffer constructor, species/subclass and exact
  slice/subarray construction, allocUnsafe alignment and CLI zero-fill policy
  retain their existing gaps. Zeroed unsafe bytes are not themselves a
  violation. The native malloc/alignment owner remains uncompiled.
* Detached, resizable/out-of-bounds, immutable, cross-realm and concurrently
  shared backing stores need API-specific engine/lifetime evidence. Private
  DataView detached/OOB getters and native size_t/int64 limit coercions are
  unresolved. They must not become passing unsupported classifications.
* Invalid non-number search-end inputs reach native CHECK preconditions in
  the target; complete validation/termination policy is unresolved. The
  portable search's numeric coercion is not proof of parity there.
* Complete transcode, resolveObjectURL, transfer and other buffer exports
  remain separate owners. TextEncoder/TextDecoder, StringDecoder, stream/FS/
  HTTP consumers, branding/diagnostics and inherited operations still need
  their original audit obligations reconciled after implementation.
* The combined engine/bootstrap artifact has not been rebuilt or run on Node,
  Chromium, Firefox or WebKit. No current four-host conformance follows from
  this slice, and no family is complete.

Move to independent filesystem/loader/stream/process findings before a deeper
Buffer test campaign. After the breadth pass, run unchanged applicable public
Buffer, encoding, consumer, transfer, allocation and engine/lifecycle coverage
with native controls on identified artifacts, preserving every nonpass.
