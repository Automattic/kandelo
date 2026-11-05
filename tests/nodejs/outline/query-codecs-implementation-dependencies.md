# Query-string and Unicode codec source owners

V-001/002/003/004/019/020/021/023 now have full retained querystring and
punycode algorithm owners and partial load-origin/warning integration.
No values-family finding or four-host conformance is closed. The exact
Node 26.13.0 pin and frozen audit remain unchanged.

## Implementation and shared dependencies

The queryCodecs manifest retains full unchanged lib/querystring.js,
internal/querystring.js and lib/punycode.js, plus the exact node_util.cc
origin reference. Whole-file hashes are verified during generation.
query-codecs-platform-adapter.js supplies the actual captured primordials,
Buffer and shared error owner. Private null-prototype factories claim a
cached module record before evaluation, retain actual exported identity and
retire failed evaluations. It does not substitute a URLSearchParams or
URI-component wrapper for the public query-string algorithms.

The public querystring owner now supplies all seven exports, true aliases,
callable metadata and descriptors. Null-prototype dictionaries, duplicate
keys, empty/non-string distinctions, multi-character/coerced separators,
maxKeys, plus decoding, tolerant malformed escapes and actual Buffer byte
fallback follow the pinned parser. Public escape/unescape replacement and
options callbacks are observed by the actual public module object. The
stringifier uses target primitive/array conversion and the exact legacy
surrogate encoding/error rules rather than a more conventional URI encoder.
The existing legacy URL consumer uses this same actual querystring object;
its full parse/format/resolve/path and IDNA contracts remain incomplete.

The identity-only public punycode object is removed. Its lazy registry getter
loads the full target module only on actual access, including its origin
check and DEP0040 warning call. Full Bootstring encode/decode, domain/email
labels/separators, UCS-2/code-point conversions, version and exact callable
objects come from retained source. One module cache preserves once-only load
behavior; a thrown origin/warning evaluation is not recorded as a successful
load and may be retried. Enumeration/availability alone does not evaluate it.
Private WHATWG/IDNA libraries remain separate owners; public punycode is not
silently substituted for modern domain policy.

The SpiderMonkey adapter uses its existing captured saveStack capability
for a bounded synchronous source-origin decision. It captures the private
bootstrap's actual engine source identity, ignores empty/node: sources and
that private source, then checks the first external source for the four
slash/backslash node_modules component forms from the target C++ reference.
It never parses mutable Error.stack, invents a caller, changes process.platform
or guesses from public module state. Missing saved frames explicitly throws.
The actual origin function is passed directly, avoiding an extra proxy frame.

This is shared guest adapter source across all four hosts; it is not a new
host import, syscall, native patch or wire ABI. Exact saved-frame visibility,
physical frame-limit behavior versus V8, async/native/ESM loader entry stacks,
realm/security/source identity and guest warning/CLI/worker delivery still
need identified-artifact validation. A Node native stack control does not
prove SpiderMonkey/V8 frame-depth parity. These are unresolved implementation/
integration questions, not accepted platform limits or external runtime bugs.

Recipe revision 54 binds changed bundle/bootstrap/prefix source. No package/
engine compilation or product rebuild is part of this slice.

## Focused and upstream evidence

Eight new codec/origin controls, nine affected Buffer-codec controls and
seven existing URL/exit controls pass (24 total). New query controls use the
actual candidate Buffer/codec/numeric/byte factories with a fixed regular
ArrayBuffer allocator. This exercises real candidate malformed-percent/UTF-8
fallback and bytes; it does not validate native allocation/pooling/transfer,
shared/resizable storage or guest engine behavior. Unicode outcomes and
errors, dictionaries/options/hooks/aliases/metadata, lazy warning/cache retry
and dependency suppression are compared against the exact native reference.

Origin controls cover bounded representative saved-frame chains and actual
native source stacks from compiled scripts with application, POSIX and
Windows dependency filenames. Native internal origin acts as an independent
comparison. Controlled saved-frame transport is explicit; guest saveStack,
bootstrap source capture and actual builtin load depth remain unvalidated.

Five unchanged upstream files pass in candidate/native modes: querystring,
escape, multi-character separator, non-finite maxKeys and punycode. The
Punycode file retains its --pending-deprecation flag. Only the CJS builtins
are selected; native Node supplies Buffer/engine/internal origin/warnings/
assert/common. These files therefore do not prove the guest Buffer, loader,
origin, warning process or four-host integration. Repeated runs are not
additional API coverage and no platform/test identity is spoofed.

The first upstream attempt retains four candidate passes, one candidate
failure and five native passes. Node's private test-binding import queued
its own setup warning; the Punycode file correctly rejected it as unexpected.
The final standard --import preload awaits setup ticks before main test
registration. Both the fixture warning and expected Punycode warning remain
visible in output. No warning is suppressed/filtered/replayed and no upstream
assertion is changed. The earlier 24-pass focused source stage before direct
origin routing/added native comparisons is historical, with exact copies.

## Remaining work and subsequent validation

Complete individual public API reconciliation, actual guest Buffer/error/
primordial/realm behavior and module/global/CJS/ESM cache/identity contracts.
Complete warning origin/stack/CLI/no-/throw-/trace-/pending-deprecation and
worker policies, actual moduleLoadList and compiler/native loader activation
metadata; these shared loader/process owners remain incomplete. Validate
punycode first-load origins and warning-once/retry behavior from application,
dependency, eval, native, CJS and ESM entry paths on each guest host.

Continue independent URL/encoding/util/native-integration and other audited
source gaps before expanding overall tests. Once the breadth pass and build
gates permit, run unchanged applicable upstream/WPT coverage over identified
guest artifacts on Node/Chromium/Firefox/WebKit and preserve every nonpass.
No exported algorithm, native control, skip or unsupported case counts as
complete public-core conformance.
