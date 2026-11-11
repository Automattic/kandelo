# Suspected resizable ArrayBuffer capacity loss

## Defect

SpiderMonkey 140.11.0esr's `ArrayBufferObject::ensureNonInline` appears to
allocate only `byteLength()` when moving inline storage out of its object.
Resizable buffers retain `maxByteLength()` and can subsequently grow without
reallocation. A later write can therefore exceed the replacement allocation.
This remains suspected until independently reproduced outside Kandelo.

## Why Kandelo is affected

The original Node string decoder borrows actual view storage while allocating
JavaScript strings. The embedding must stabilize and pin that storage so moving
GC cannot invalidate it. A small resizable input or state buffer follows the
engine's inline-to-heap path.

## Workaround and its cost

Patch 0040 allocates the full maximum capacity with the engine's zero-filling
allocator, copies the current bytes and keeps the existing engine ownership,
view notification and accounting. This preserves growth and shrinking semantics
and applies to all callers of the engine API. The original Node JavaScript and
native codec algorithms are unchanged. Memory use matches the original inline
buffer's maximum capacity; this introduces no new reservation policy.

## Evidence

The named revision-33 Kandelo engine traps in `__libc_free` through
`ArrayBufferObject::releaseData` after the decoder's resizable-buffer control.
The same artifact passes resizable allocation/resize/GC without decoding.
Retained diagnostics are under `.context/node-string-decoder/` in the Port Vila
workspace. The source review locates the copy's current-length allocation and
the resize operation's in-place writes. The pure shell case also traps in the
guest using only `ensureNonInline`, resize, writes and GC, without the Node
binding. The patched guest passes that case and all 22 decoder controls on Node,
Chromium, Firefox and WebKit, including maximum growth, zero-fill, shrink/regrow
and collection. These focused guest results are not complete engine conformance.

Mozilla's native macOS shell was downloaded from the official 140.11.0esr
release archive and verified against its official SHA512SUMS. Its `--version`
reports `JavaScript-C140.11.0`; binary SHA-256 and all output are retained in
`.context/node-string-decoder/native-spidermonkey-rab.json`. The first reduced
case completed without a crash. A separate size probe measured 152 bytes before
stabilization and 160 afterwards for a one-byte buffer with maximum length 64;
its grown bytes were zero. That probe is evidence to investigate, not an
independent self-judging reproduction of the guest trap. The classification
therefore remains suspected. No upstream report was filed.

## What is still unknown

Kandelo's allocator, embedding, target configuration or artifact preparation
could be responsible. Run the standalone `ensureNonInline` shell case against
an authenticated, unmodified Mozilla shell of the same version, then compare
the patched guest case, including zero-filled growth and finalization.

## Draft upstream report

Not ready to file. Reduce the capacity mismatch using the shell's
`ensureNonInline` testing API with no Kandelo code and retain source and binary
identities, verdict and runtime version. No report is authorized.

## Removal criteria

Remove the patch after the supported source version preserves maximum capacity
through non-inline stabilization and the standalone and guest controls pass
without the patch. Preserve the original Node decoder tests.
