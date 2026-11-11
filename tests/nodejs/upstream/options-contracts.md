# Original native options and embedding bridge

Revision 32 compiles the complete pinned `node_options.cc`, `node_options.h`
and `node_options-inl.h` unchanged. Original declarations, aliases, implications,
field storage, validation, tokenization and serializers remain in that source.
The original mutex header uses real libuv mutex calls. Complete pinned ncrypto
and QUIC headers provide declarations/build guards, not a Node crypto backend.
The source stager verifies every byte and derives only the complete environment
setting enum from `node.h`; it extracts no function bodies or JavaScript.

A private namespace keeps the source's API names separate from other adapters.
Its marshalling layer uses actual SpiderMonkey strings, objects, arrays, Maps,
property operations, native functions and exceptions. Stable per-call cells own
real JS roots until publication; nested calls restore their actual frame owner.
There is no V8 heap, simulated resource handle or host Node guest backend.
Functions retain their realm and reject after its failure. The runtime owns actual
C++ option storage/shared pointers and serialization/configuration state. The
real original SafeMap prototype is retained in a protected realm slot, including
its native constructor/prototype assertions.

All seven native exports and both enum tables are supplied by the original
initializer. Six metadata queries throw ERR_OPTIONS_BEFORE_BOOTSTRAPPING until
the genuine node/web/thread/environment bootstrap and completion checks finish.
Completing only the node body does not open them. No test API forces completion.
The original `internal/options` module executes and keeps its lazy caches.
Post-bootstrap metadata values and complete facade equivalence remain unvalidated.

Real guest argv is captured before shell parsing. Native Node invocation inputs
are parsed before original realm.js using real guest secure_getenv and original
C++ parser functions. Privileged JS-shell controls can select explicit parser
inputs without declaring startup complete. Environment flags precede CLI flags;
profile replacement is once-only. Failed profiles remain terminal. Unimplemented
engine/config/security/file adoption fails explicitly. This is not the complete
process-global/config/dotenv/security/engine CLI pipeline or CLI acceptance.

Percentage memory selection reaches missing libuv information APIs. The private
adapter sets an explicit pending exception, and failed configuration cannot
serialize a value. Its zero return is failure transport only; existing kernel
sysinfo placeholder figures are not exposed as real memory accounting. No new
public libuv memory symbols or kernel/ABI behavior are supplied.

Fourteen binding/module/profile controls pass on Node, Chromium, Firefox and
WebKit with identical engine/kernel bytes, including argument coercion, NUL and
Unicode strings, exact errors, reentrant moving GC, realm/cache ownership and
bootstrap guards. Seven additional Node drivers preserve invalid input, terminal
parser failure and explicit memory/engine/env-file boundaries. Six shared controls
pass on the pinned native executable. The same engine passes 239 prior Node cases,
including nineteen expected fatal controls. Two additional method-registration
drivers preserve the source property assertion and an explicit unsupported
late-name inspection boundary. Browser drivers separately preserve
natural job exit, requested quit status and the original unhandled job error.

A separate 23-case guest probe compiles the complete same native source and
executes the original C++ parser/storage directly. All four hosts produce identical
observations. The pinned native reference agrees on 114 selected stored values,
ten errors and 152 common environment metadata entries. Fifteen native-only entries
belong to inspector/FFI build differences. Probe namespace names include raw entries
that the original public schema serializer filters, including a no-op snapshot flag;
namespace facade equivalence is not claimed. Native preload instrumentation changes
its require list and is explicitly excluded from value comparisons. A native literal
script-not-found error after `--`, forwarded engine flags and unsupported guest
memory selection remain recorded separately from successful operations.

Original principal and stack-policy probes now pass options and stop on missing
`string_decoder`; original typed NodeError construction still returns. Ordinary
public execution still uses the compatibility bootstrap. Empty/simple output,
errors, jobs, exit status and separate CJS/ESM startup acceptance remain incomplete.
The method helper follows original util.cc: it uses normal Set before naming
the function. An inherited setter can intercept assignment and run moving GC.
Throwing from that setter preserves the original fatal property check. If user
code resolves/redefines the function name during assignment, additional engine
tracking is required; this path fails explicitly rather than publishing incorrect
metadata. Default registration and setter interception without name inspection
are validated.

The partial catalog [options-contracts.json](options-contracts.json) records the
exports, literal consumers, signatures, phases, errors, ownership and prerequisites;
it is not the full lazy/conditional/worker/platform/exception graph.

The first preflight lacked its private sysroot directory; the next exposed a
missing declaration-vector constructor. The first engine compile caught an adapter
conversion; the next compiled/linked but failed include order. Own code was fixed
without weakening the checker. Initial patch context and an absent presumed mutex
inline header also remain recorded. Imported code follows the existing foreign
source style policy. Exact source/artifact identities and all attempts are in
[options-engine-check.json](options-engine-check.json). Existing browser cleanup
permission warnings, Mozilla target configuration debt and bounded fork fallback
remain open. Complete OOM/security/teardown/worker/multi-runtime/ShadowRealm and
post-bootstrap metadata behavior remain unproven.

Next implement real string_decoder/buffer/util startup prerequisites. After genuine
four-host startup, reconcile the full catalog and dependency-ordered roadmap and
stop for user review before broader work. Keep nested guest Wasm last unless startup
needs it. Full products, product images, successor-ABI builds and overall suites
remain deferred; these focused checks use empty guest filesystems.
