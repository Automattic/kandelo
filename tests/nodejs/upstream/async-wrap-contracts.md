# Native async state and symbols

The unchanged `internal/async_hooks` module now executes through the actual
realm loader with a partial native `async_wrap` binding. The principal bootstrap
passes this dependency and stops on `constants` in `internal/util:62`, reached
through validators and timers. This is not successful Node startup.

The runtime owns live hook fields, async IDs, a growing ID stack, original JS
resource storage and private traced native resource storage. Constructor state
comes from the complete pinned native implementation: nine Uint32 hook fields,
four Float64 ID fields, a 32-double stack, check count one, async counter one
and default trigger minus one. It is not copied from an already bootstrapped
native process. Stack pushes/pops and clears operate on this actual storage;
original JS retains its own fast path and calls native growth when necessary.

All thirteen hook/ID constants and the provider enum are generated from complete,
hash-verified native declarations. The linked OpenSSL build yields 69 provider
names. These enum names do not establish implemented resource classes. The
canonical `symbols` binding publishes all 27 original ordinary symbols under
their native description keys, sharing identities with per-context initialization.
No private symbols are exposed through this binding.

Hook and trampoline registration retains the actual functions and owners.
Trampoline installation follows original `enableHooks()`/`disableHooks()` policy.
The existing Promise rejection callback now enters assigned async IDs with the
actual Promise resource and conditionally restores the previous context, including
after callback exceptions or a callback resetting the stack. This follows the
pinned native rejection callback; it does not supply general Promise lifecycle
hooks or before/after hook emission.

Requested Promise lifecycle hooks and GC destroy observers still fail explicitly.
Destroy-event queuing succeeds only when the actual destroy observer count is
zero, as in the native source; observer-enabled delivery fails explicitly. Complete
native callback scopes, continuation frames, resource factories, fatal exit/at-exit,
lifecycle/security/OOM/cancellation and ShadowRealm/prototype equivalence remain
unfinished. Selected corruption and malformed-input assertions stay fatal, with
recorded guest exit 132; full native Node exit-policy equivalence is not claimed.

Revision 29 passes twenty selected controls on each of Node, Chromium, Firefox
and WebKit using identical engine/kernel bytes, plus 188 prior controls on Node.
Nine shared controls also pass on the verified pinned native Node executable.
They exercise native and original-JS stack growth, live state, conversion,
resource identity, default-trigger restoration and actual Promise rejection
contexts. Thirteen constants and 69 provider values match separately. The 73
process drivers include nineteen expected fatal Node controls and preserve
original error exits and explicit missing behavior. This evidence does not
establish public `node:async_hooks` compatibility or successful startup.

The first engine passed 18 of 20 controls; inspector booleans were emitted as
integers and a test assumed eager trampoline registration. A subsequent build
failed because a temporary JSAPI value needed rooting. The first browser run
produced twenty passing guest observations but its copied harness still required
26 observations. These failures, their fixes, raw reports, both engine artifacts,
input identities and build logs are retained in
[async-wrap-engine-check.json](async-wrap-engine-check.json).
The browser cleanup log retains a macOS permission warning. Existing Mozilla
targeting debt and bounded native fork-instrumentation fallback remain open.

The machine-readable partial catalog is
[async-wrap-contracts.json](async-wrap-contracts.json). It lists literal consumers,
exports, signatures, ownership, scheduling, unsupported contracts and validation
obligations; it does not claim complete graph coverage. Next implement the actual
startup-required constants/native closure, then finish engine/context/callback
contracts required by the unchanged bootstrap. Preserve separate CJS and ESM
acceptance. After genuine four-host startup, complete the full backend catalog
and dependency-ordered roadmap, then stop for user review before broader work.
Full products, successor-ABI campaigns and overall suites remain deferred.
