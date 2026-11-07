# Shared crypto errors: bounded owner handoff

This capsule depends on the exact immutable TLS credential seal
`72c14d16ff753a70804b27ae8132b582501246258e2f2d69112debba4c3a52a5`.
Patches are relative to those postimages; they do not reapply the credential
proposal or replace the current generated bundle. Both patch checks against
current root succeeded without modifying it.

The original S-009 problem was in a shared boundary. The native helper captured
remaining OpenSSL errors in the wrong order, forgot their primary numeric
identity, and produced a plain record. Frontends then created another Error
and assigned selected fields using strict JavaScript. That lost the first
remaining queue error's decoration, the subsequent explicit-primary decoration,
ordinary nonthrowing assignment refusal, setter order and original Error
identity. TLS, PKCS12, key, cipher, digest, X509 and KDF consumers shared the
same problem.

The new owned queue store reuses pinned Capture and Decorate algorithms and
verified Node error-code type admissions. C++ values capture and own all strings
before worker handoff; no engine pointer/context/value or provider-owned string
pointer crosses that seam. On the owning thread, the native helper creates a
real intrinsic Error, roots it, and assigns through actual [[Set]]. The array
contains own elements; inherited Array setters do not run. No setter exceptions
are replaced by a synthesized crypto error. Existing adapters forward the
original Error without inspecting its public code/name to recreate it.

Node's native error-code macros use Set(...).Check(), unlike Store's ordinary
Set(...).IsNothing(). A thrown inherited code setter is fatal in that macro
path. Isolated subprocess controls establish actual SIGABRT for both reference
and candidate; ordinary Store throwing setters remain original propagated
exceptions. This is an exact fatal-policy distinction, not an upstream-defect
claim. Nonthrowing false assignment remains nonfatal in both modes.

Pinned references are whole unchanged files in upstream/crypto-errors plus
section hashes. Capture/Decorate/ToUpper are translated only at the engine API
boundary; the queue/store wrapper models ToException and ThrowCryptoError's
primary/secondary sequence. Legacy shared error fields remain for internal
portable owners; frontend transport is a genuine Error, not a record. KDF
provider failures capture their complete queue, as pinned Capture+Insert does.

Source and runtime evidence are separate. Native controls compile real portable
OpenSSL/ncrypto owners and a test-only N-API error adapter. They execute the
exact native Node26.13.0 artifact. The N-API adapter covers the actual Error,
TypeError and RangeError kinds exercised here; it is not evidence for its
unused SyntaxError/URIError branches. Production JSAPI supports those intrinsic
types but remains uncompiled. The unchanged Mozilla style checker, declared
input closure, header staging and bootstrap syntax are source checks only.

Actual guest OpenSSL3.5.9 identity is taken from the accepted173 dependency
receipt/log copied with the TLS seal verified. The native executable exports
OpenSSL3.5.9 too, but it is a different artifact/configuration. This capsule
neither resolves a new guest dependency nor compiles/executes its libraries.

Remaining implementation/validation questions:

- Current candidate guest JSAPI compilation, all security-wrapper/realm/GC
  execution, four-host runtime evidence, exception termination and cancellation.
- Exact async-hooks callback execution context during error-property setters.
  Native CryptoJob::AfterThreadPoolWork converts errors before MakeCallback;
  Kandelo also prepares KDF results before entering its completion callback
  scope. That source correspondence is insufficient for full async context
  conformance. WebCrypto's separate InternalCallbackScope is outside this slice.
- Unrelated crypto validation/comparison and TLS certificate-verification error
  helpers still have their own policies; this bounded work does not audit or
  rewrite all errors. Digest-specific message accuracy and every call site's
  choice of error number/fallback require later per-API reconciliation.
- V8/SpiderMonkey stack formatting, C++ unwind timing visible through reentrant
  user setters, and provider configuration differences are not closed here.
- OpenSSL opaque allocations and runtime_error/string/vector allocator capacity
  are not newly charged to a guest memory ledger and are not claimed as RSS.
- Existing portable fixtures outside this capsule that still manufacture legacy
  records must migrate to real errors before they can validate the new adapter
  contract. Their assertions must remain unchanged unless a separately reviewed
  contract expectation is actually obsolete.

No accepted engine/platform exclusions, pin changes, ABI changes, overall
suites, engine/library/kernel/product builds, commits, pushes or root edits.


## Current parent integration

Source185 composes36actual shared-error source leaves plus the separate exact
sync-random bootstrap hunk over184, regenerating the combined bundle and
preserving FFI/Response/loader/WASI/Domain/TLS owners. Five actual production
inputs are added; the normal native embedding stages/sorts the real shared
header. No target/library pin, program/kernel-host ABI or engine registration
patch changes. Source presence remains separate from guest runtime conformance.

Fresh parent controls use the exact final native TLS/PKCS12/shared-queue artifacts
identified in report.json and verify raw header/addon source identities before
reuse.57TLS credential groups,5native context/handshake groups,47PKCS12 groups,
55ordinary property/owning-realm/GC groups and5real queue/worker groups pass.
Ten sync-random controls consume the exact current crypto IIFE/curated forwarder,
pinned sync/WebIDL algorithms and actual native Error component, preserving
original Error identity/descriptors/setter counts. Their failure admission is
controlled; it does not induce a genuine entropy/provider failure.

The existing isolated native/candidate checked-code setter SIGABRT evidence is
reused, not rerun or counted as ordinary Store semantics.14package checks and
normal current bundle/bootstrap/unity/declared-input/unchanged-style checks pass.
Seven prior tiny native compiler attempts are accounted for, including the
preserved unused fixture helper failure. Parent performs0new compiler commands.
No new guest artifact, library/engine/kernel/product build, overall suite or
full rebuild ran. Accepted173predates current185; no finding/family closes.

Parent's initial PKCS12 fixture omitted PKCS12_CONTROL_REPORT and stopped at
path.dirname(undefined). The original script/commands/logs remain under
.context/node26-errors185-missing-report-env-r1. The corrected setup supplies
root-owned report/variant output paths; assertions are unchanged and sealed
evidence is not written into. Source generation and earlier native fixture
compiler nonpasses remain immutable. The sync follow-up itself has0compiles.

Full per-API error/message/validation and async setter-context semantics remain
open, along with actual guest JSAPI/realm/security/GC/cancellation/allocation and
all-four-host evidence. Full crypto/WebCrypto/STORE/keygen/signatures/exchange and
TLS/SecureContext/protocol gaps remain real implementation work. Nested guest
Wasm execution stays in scope, scheduled after independent core-module work.
