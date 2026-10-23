# CHROMIUM-TEXTDECODER-REJECTS-SHARED-VIEWS

Status: suspected. No standalone reproduction exists in the repository and
none was run for this entry. Not filed.

## Defect

The Encoding Standard declares `TextDecoder.decode(optional
AllowSharedBufferSource input, ...)` (checked against
https://encoding.spec.whatwg.org/#interface-textdecoder on 2026-10-22),
so a view over a `SharedArrayBuffer` is a valid argument. Code comments in
the host say that Chrome throws a `TypeError` for such a view, and one
comment says Firefox does too. The Firefox claim rests on that single
comment (`host/src/worker-main.ts`, the dlopen name decode). No one has
re-run any of these claims for this entry, and the comments give no
browser versions.

## Why Kandelo is affected

Guest linear memory is a shared `WebAssembly.Memory`, so every string the
host reads out of a process (a path, a dlopen name, a shader source, a
debug string) is a view over a `SharedArrayBuffer`.

## Workaround and its cost

Each site copies the bytes into an ordinary `ArrayBuffer` (`slice()` or
`Uint8Array.set`) before `decode()`. The cost is one small copy per string.
The tagged sites are in `host/src/kernel-worker.ts`, `host/src/worker-main.ts`
and `host/src/webgl/bridge.ts`; find them with
`git grep -n "RUNTIME-WORKAROUND: CHROMIUM-TEXTDECODER-REJECTS-SHARED-VIEWS"`.
Other host code may also copy before decoding without a comment that says why.

## Evidence

Only the code comments at the tagged sites. No versions, no reduction.

## Why this is not a Kandelo defect

Not yet established. Still unknown: which Chromium and Firefox versions
throw, whether the engine reports a spec deviation or a documented
limitation, and whether the failure needs a shared view specifically or
also a growable one. A standalone page that calls
`new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(4)))` on
each engine would decide it. If every engine accepts it, the comments are
stale and the copies are only defensive.

## Draft upstream report

Not ready. Once the page above throws on a released engine: title
"TextDecoder.decode() rejects SharedArrayBuffer-backed views, contrary to
AllowSharedBufferSource", steps (the one-line page), expected (decoded
string), actual (TypeError), versions.

## Removal criteria

A released Chromium (and Firefox, if it is confirmed there) accepts shared
views. Then remove the copies whose only reason is this defect, and retire
the entry. Two sites keep their copy even then, because it also guards
against another hazard: `host/src/worker-main.ts` (the dlopen name read,
where compilation may grow or detach memory) and `host/src/webgl/bridge.ts`
(the shader source read, where the copy also protects against
SharedArrayBuffer grow races). Their tag comments say so; when retiring,
reword those two comments and remove the tag rather than the copy. Check
the other sites for the same second reason before deleting them.
