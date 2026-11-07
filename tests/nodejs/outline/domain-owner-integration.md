# Public Domain owner and MakeCallback seam

This slice reuses complete unchanged Node26.13.0 lib/domain.js over Kandelo's
actual EventEmitter, AsyncHook/task and process fatal owners. The builtin loads
lazily so its process.domain property, EventEmitter patches, async hook and native
trampoline registration happen when domain is actually requested. The existing
URL domain-name helper adapter is separate and unchanged.

The public source owns stack/active/process.domain, explicit/implicit members,
receiver/argument/return behavior, bind/intercept, emitted/thrown/intercepted error
decoration, nested handlers and fatal stack unwinding. The exact previously pinned
WeakReference helper supplies real engine WeakRef with refcounted strong callback
lifetime, not a permanent strong domain map. Existing native/process fatal paths
are used; no catch converts thrown or unhandled errors into successful callbacks.

The shared async private useDomainTrampoline seam registers actual native rooted
callback and predicate functions. The predicate reads real before/after hook
counts and actual executionAsyncResource use, matching MakeCallback's activation
condition. A MakeCallback invocation method on the existing native callback scope
consults the authoritative entering ID; only ID0 uses that registered trampoline.
Ordinary nonzero callbacks retain their existing actual hook owner. Filesystem
callback completion and both stat-watcher callbacks use this seam. Internal
zero-ID scopes such as histogram direct resolver completion remain direct calls;
they are not MakeCallback and must not acquire invented domain behavior.

Registration is explicitly forwarded through the curated production adapter and
separately exported in the engine. Root fields live until terminal context
shutdown. Errors from hooks, callback/trampoline/gate/getters or domain handlers
remain actual errors in the owning fatal path. Domain.run/bind intentionally do
not gain convenience try/catch/finally cleanup that would hide pending failure.

## Evidence and limitations

Twelve selected unchanged upstream cases pass through both the exact native26
and complete candidate Domain source over actual native Node dependencies (24
processes, declared case flags retained). This is native/source component evidence,
not runtime proof of Kandelo's EventEmitter/Promise/native bridges. Four additional
groups use the actual candidate Domain/AsyncHook/task/unchanged fatal algorithms
and production forwarding over the sealed actual portable native execution owner
through N-API roots. Explicit host EventEmitter/timer, resource/destroy metadata
and registration dependencies remain. They verify handled-domain after ordering,
emitter error routing, throwing handler failure and unhandled false/exit policy;
they do not run the production C++ fatal exit boundary, GC, jobs or Promise hooks.

No production JSAPI/native trampoline, engine/kernel/product build, full suite or
identified guest/four-host run occurred. Legacy zero-ID addon MakeCallback and
other not-yet-routed native consumers, native hook activation/Promise-registration
context, foreign-VM/denied-wrapper/GC weak lifetime, OOM/fatal/reentry/teardown and
Worker behavior remain unvalidated or dependent on existing audited gaps. Public
abort/report/auxiliary-capture/REPL interactions and incomplete resource providers
remain separate prerequisites; copied source is not conformance closure.

The initial private bundling failure caught a filename collision with the URL
helper and was corrected by restoring that file and using domain-owner-adapter.js.
A first upstream runner attempt stopped at its explicit stale-bundle preflight;
no case ran against that stale candidate. Both failures and Nix fetch waits remain
recorded. Target/source/native pins, original upstream assertions and prior
fs.watch/TTY/PKCS12/compression capsules are unchanged.


## Current parent integration

Source178 composes the sealed owner additively with174VM/175SQLite/176HTTP/
177Server. The normal0132engine registration patch has an exact zero-fuzz
roundtrip from the real174postimage. The distinct URL helper, original fatal
handler and unrelated async algorithms remain unchanged. Normal recipe inputs
now declare both actual new runtime leaves; the private failed closure is not
reclassified as a pass.

Fresh root checks use current combined source. The same12whole unchanged
upstream files with their original flags pass in native and source-component
processes (24executions). Four actual candidate Async/fatal groups over the
identified existing portable native owner pass. Fourteen package checks and
normal source/bootstrap/unity/unchanged Mozilla style checks pass. No new
compiler command, engine/kernel/product build, guest run or overall suite ran.
Accepted173is stale for current178. No API, family or four-host closure is
claimed; all limitations and earlier failed preparation remain recorded.
