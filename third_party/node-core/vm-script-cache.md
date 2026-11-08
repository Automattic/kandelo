# VM Script encoding and build identity foundation

This is a partial source implementation of `engine.md` E-008. It does not
complete Script caching, VM modules, heap measurement or four-host conformance.

The public Script owner retains its actual SpiderMonkey Stencil, original
source string and compilation metadata. `createCachedData()` and the legacy
`produceCachedData` option encode that trusted Stencil into a fresh actual
Buffer. The encoding merges real recorded lazy-function compilations. An
instantiated ScriptSource shares the native stencil reference; the cache
owner does not retain the executed context/global solely for later encoding.
The current negative-offset and parsing-context obligations remain open.

The output is explicitly a Kandelo identity envelope plus SpiderMonkey XDR,
not V8 cached data. That engine-specific format proposal is not a compatibility
exclusion or a finding closure. A buffer produced here cannot currently be
restored through public `cachedData`: that path keeps its honest
`ERR_NOT_IMPLEMENTED` failure. The raw native compile entry also rejects
non-undefined cache input. There is no new production DecodeStencil call.

XDR is a trusted compiled-data representation. A recomputable corruption hash
and build-ID check do not validate hostile stencils. The selected engine reads
raw scope records before scope-kind-dependent operations. Public arbitrary
Buffer admission requires a genuine safe engine validator/admission owner;
byte identity allowlists, process-local Buffer recognition, an embedded
constant MAC, or manufactured `cachedDataRejected` results are not substitutes.
This is an embedding implementation prerequisite, not an upstream defect
claim or accepted platform limit. Mozilla's trusted-profile threat model is
corroborated by [bug 2065343](https://bugzilla.mozilla.org/show_bug.cgi?id=2065343#c6).
The automated assessment in that issue is not runtime evidence for Kandelo.

The separate blocked proposal is evidence only and must not be integrated.
A later decoder must preserve real errors/OOM, validate every representation
and index before use, own copied input through decoding, and rebind current
filename/line/column metadata. Native Node accepts changed metadata; rejecting
those inputs is an implementation gap. Source-mismatch behavior also differs
between warm and fresh native compilation-cache conditions and remains
recorded rather than generalized into a source-hash rule. compileFunction
cache support is a separate obligation.

## Actual build identity

The generic resolver exports its exact `cache_key_sha` as
`WASM_POSIX_DEP_BUILD_KEY_SHA256`, reserves the name against dependency-variable
collisions, and documents the build-script contract. The engine recipe turns
that immutable key into its generated `KANDELO_ENGINE_BUILD_ID`; the existing
ShellBuildId callback uses it and SpiderMonkey adds its pointer/endian suffix.
It never uses the upstream shell's constant `JS-shell` for this foundation.

A direct manual recipe invocation without a resolver identity uses a fresh
cryptographically random build-instance nonce. This is explicitly a manual
build identity, not a reproducible resolver key. An environment with resolver
`WASM_POSIX_DEP_NAME` but no exact key fails closed, requiring a matching
resolver, rather than silently pretending to be a manual build.

The xtask change is shared build-tool source and must be reviewed separately
from a leaf runtime change. Existing `GLOBAL_PACKAGE_TOOLCHAIN_INPUTS` does
not list `build_deps.rs`; this patch does not broaden that list or alter
unrelated package keys. SpiderMonkey's changed declared generator/header and
recipe inputs invalidate its normal key and downstream consumers. A future
integration must rebuild/use the matching xtask, inspect the actual affected
normal plan and preserve the full-product rebuild deferral. No toolchain,
package or product rebuild was performed for this source capsule.

## Publication and validation boundaries

Actual compiled identity is installed before observable metadata setters.
Pinned Node's surrounding TryCatchScope stops later ordinary metadata writes
and retains the usable Script after a throwing setter. This policy is mirrored
only in that assignment block; native compilation/cache-creation failures
remain outside it. Public Buffer identity and invalid-receiver errors use real
existing owners and pinned controls.

The final C++/JSAPI and Rust handoff are uncompiled. A tiny native control
compiled the actual portable envelope header; generator controls executed the
actual Python generator. Final JS encoding controls use an explicit pinned
native Node Script/cache/realm/import backend, so they cannot validate the new
SpiderMonkey Stencil owner, raw pointer lifetime, build-ID handoff or guest
behavior. Earlier decoder-proposal frontend/upstream results have that same
backend boundary and are not final public decoding evidence. All original
setup failures, disproved expectations and source-composition nonpasses remain
in the capsule. No finding is closed.
