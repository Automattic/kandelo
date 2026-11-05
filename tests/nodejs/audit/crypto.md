# Crypto source review

State: **source review complete with implementation gaps**. Real entropy and digest paths exist alongside missing
algorithms and public semantic gaps. No cryptographic probe/test ran.

Bootstrap:3963–4118 owns the public facade. Native digest/HMAC contexts
at reviewed js.cpp:398–580 call OpenSSL and release native contexts on
digest/finalization. Entropy opens /dev/urandom, reads actual guest bytes
and closes the fd. Kernel sys_read dispatches Urandom to host_getrandom
(`syscalls.rs`:6181; wasm_api.rs:852); `host/src/kernel.ts`:2206–2229
is the final host implementation. This entire chain matters.

| ID | Requirement | Source finding |
|---|---|---|
| C-001 | Ciphers, asymmetric/symmetric keys, sign/verify and certificate APIs | createCipheriv/createDecipheriv/createPrivateKey/createPublicKey/generateKeyPairSync/sign/verify throw; X509Certificate constructor throws. Other keygen, KDF, key exchange, KeyObject/CryptoKey and algorithm-control APIs are missing |
| C-002 | getRandomValues integer TypedArray branding and quota errors | Accepts objects having buffer/byteLength, including wrong brands. Generic Error replaces target quota DOMException. Need detached/shared/cross-realm/offset semantics |
| C-003 | Entropy must remain cryptographically strong or fail truthfully | Host kernel.ts:2222 falls back to Math.random if host crypto.getRandomValues is absent. Normal modern host path uses Web Crypto, but this explicit fallback invalidates an unconditional CSPRNG claim for all allowed environments |
| C-004 | randomFill/randomBytes/randomInt validation, callback semantics and limits | randomFill async is missing; fillSync performs weak input/offset validation; randomInt has no callback overload; randomBytes work is synchronous before queued callback. C-014 traces whole large reads to a single over-quota host call; byte/element-unit and native async gaps remain |
| C-005 | Hash/Hmac full public stream/prototype/encoding behavior | Returned objects only provide update/digest, not Node Hash/Hmac Transform instances; update ignores inputEncoding, copy/options/stream APIs absent. getHashes returns a fixed four-name list, and native resolver also only recognizes selected names |
| C-006 | timingSafeEqual accepts target byte views with native timing guarantees | Converts arbitrary inputs through Buffer.from and loops in JavaScript. Source contains no constant-time backend contract; equal output on sample inputs cannot establish the required timing property |
| C-007 | WebCrypto and public crypto.webcrypto/subtle identity | Fallback global has only getRandomValues/randomUUID; no SubtleCrypto/CryptoKey algorithm implementation or complete public module alias. Brand predicates also always return false in core adapter |
| C-008 | Exact backend and algorithm availability | Kandelo OpenSSL package 3.3.2 differs from reference 3.5.9. Backend/provider/format/capability differences and missing public routes are reviewed in crypto-contracts.md; linking OpenSSL is not Node conformance |

For C-003, image-build deterministic entropy is separately explicit in
wasm_api.rs:853–856. It is build-image state, not a suitable normal runtime
randomness source. No evidence reviewed here says the normal user guest
is in that mode. Do not conflate it with the host's missing-WebCrypto
fallback. The completed trace now records C-014: whole large Urandom reads use
reserved scratch and reach one host Web Crypto call, exceeding its
65,536-byte quota. This is source diagnosis, not new runtime evidence.

All four hosts use the guest facade. Actual host Web Crypto presence and
entropy-call limits affect the final path. Native Node host crypto objects
are not automatically guest CryptoKey implementations. Missing bindings
and current algorithm coverage are implementation gaps, not a concrete
non-V8 impossibility.

Later unchanged crypto/WebCrypto tests and native controls need known
vectors, malformed formats, Unicode/encoding, brands, detachment, KDF/key
sizes/options, async errors/cancellation/lifetime and unavailable-provider
statuses. Security properties require actual backend guarantees, beyond
happy-path output comparisons. Current-candidate runtime conformance is
pending on every host.

The [complete contract review](crypto-contracts.md) adds C-009 native
allocation/finalizer/secret ownership questions, C-010 native string NUL
truncation and public digest semantics, C-011 namespace/metadata gaps,
C-012 typed-array fill units, C-013 random range/UUID/callback contracts,
C-014 the host quota path, C-015 complete missing public algorithm and key
routes, and C-016 exact target prose/source questions.

`crypto-requirements.json` reconciles all 476 original crypto obligations
(187 sections and 289 descriptors) and all 178 scoped Web Crypto sections,
plus returned/inherited/dictionary/native-owner requirements. The future
catalog contains 530 source files including helpers and WPT sources, not
530 executed cases. The broader web family remains incomplete. Target
questions and later native/host/lifetime controls are explicit; no fix,
runtime probe, test or build ran.
