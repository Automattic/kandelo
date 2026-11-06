# Rooted crypto byte-source ownership

This bounded source slice replaces the raw `js::IsBufferSource` calls beneath
synchronous crypto consumers with a checked, rooted `KandeloCryptoByteSource`.
It does not establish complete crypto or engine compatibility.

The selected internal SpiderMonkey140.11.0 overload takes `JSObject*`, checks
raw typed-array/DataView/ArrayBuffer/SAB classes and does not unwrap a CCW.
For unshared storage it may call `ensureNonInline`: that can materialize an
ArrayBuffer, allocate, collect or report a length-pinned error. The previous
crypto callers invoked that function inside AutoCheckCannotGC. This is an
integration error in Kandelo's usage, not a claim of a SpiderMonkey defect or
an observed compiler/runtime failure.

Admission now dynamically checked-unwraps using the caller's authority and
roots the actual storage. A denied wrapper retains an existing exception or
reports the engine's real access-denied error. Unrelated proxies are rejected
before realm entry. Native pointer access enters the actual storage realm,
then uses the public nonallocating no-GC view/ArrayBuffer/SAB accessors. Inline
bytes need not be moved or length-pinned for a synchronous consume. No pointer
escapes that consume, reaches JavaScript, or survives another input's realm/
security preparation. timingSafeEqual prepares both owners first and copies
one bounded range at a time; it never holds one JS pointer while preparing
the second. Native temporary allocation may throw; C++ unwinding restores the
no-GC/realm scopes before outer guards allocate or report JS errors. Shared
loads and stores preserve the existing relaxed atomic byte operations.

Digest, key/KDF byte-copy, native hash/cipher/HTTP parser delegates and sync
random filling inherit this path. Strings retain their existing rooted linear
string path. X509's separate narrow fix acquires its checked view directly and
continues to use the unchanged atomic copy helper; it must be composed before
removing the old helper when the older X509 source is present. SQLite's two
independent raw IsBufferSource uses remain separate source-audit questions.

Async random jobs require a different lifetime. They acquire the actual
root146 backing-allocation capability before async init, store it in the
request, then move it into native work. Raw AB/SAB inputs use a real view of
the same buffer for capability acquisition, never a copied JS snapshot.
Materialization/GC occurs only in this separate acquisition phase, with no
borrowed pointer live. Work writes its captured original span using relaxed
atomic stores; completion never redirects into a newly borrowed JS view or
turns detach into a synthetic invalid-state failure. ReleaseIo and existing
retirement/cancel/shutdown paths release the capability. Actual native scratch
is allocated before publication and accounted using its real vector capacity.
The current engine reserves RAB maximum capacity and resizes visible length
in place, but transfer/shrink/grow/GC/teardown behavior still needs validation
against an identified compiled candidate.

Twelve exact Node26.13.0 native VM/public-crypto reference groups establish
foreign view offsets, poisoned public byte properties, empty/detached/OOB and
shared ranges, and successful callback/original-allocation behavior when an
actual random init hook transfers a view/raw AB or grows RAB. Ordinary proxy
error formatting is preserved: Hash's JS type error can read constructor,
whereas native timing comparison rejects without that getter. These are
reference expectations, not execution of Kandelo's byte-source class, security
CCWs, backing bridge or work queue. The JSAPI source remains uncompiled and
no Node/Chromium/Firefox/WebKit candidate validation is claimed. Run the durable
reference control with an explicit pinned native executable and no setup:

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/path/to/pinned/node \
  bash third_party/node-core/tests/crypto-byte-source/run-reference.sh
```

Further validation must cover real allowed/denied CCWs, inline and length-pinned
storage, exact detached/OOB/zero/raw/shared/RAB/GSAB/native-work behavior,
failed acquisition/submission/init, cancellation, collection, shrink/transfer
races, resource/metadata parity and all four hosts. Public source exports and
native reference passes do not establish these candidate behaviors. Existing
crypto error/size/resource/module gaps remain separate.
