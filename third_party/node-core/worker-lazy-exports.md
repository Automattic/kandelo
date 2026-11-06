# Worker lazy native export consumer proposal

This source proposal consumes the separately sealed, uncompiled native lazy
DATA property prerequisite. It does not establish SpiderMonkey, guest or
four-host support, and it does not close R-015.

The complete pinned worker_threads.js native-lazy installation block installs
only `locks`. The existing real Worker/port/object-mark exports are assembled
first; installation then adds the pending native export. This preserves its
position after ordinary exports. No Lock/LockManager constructor is added to
worker_threads: those remain the actual private classes in unchanged pinned
internal/locks.js, with the actual private constructor tokens.

The bridge call is native.defineNativeLazyDataProperty(target,key,loader,id,7).
Mask7 means writable, enumerable and configurable. The target is the actual
Worker API PlainObject, satisfying the initial engine owner admission. There
is no ES accessor, Proxy, placeholder value or fallback when the native owner
is absent. Reads/own descriptors/define/integrity/assignment/deletion/receiver
semantics come from the actual engine prerequisite, not JavaScript emulation.

The loader and private module cache are created in the Worker's bootstrap
realm. The native owner enters the holder realm; its traced callback/data
record calls that loader. Foreign receivers do not choose another module or
shadow the holder on get. The callback resolves internal/locks through the
private module route, not mutable worker_threads.locks or a public require
cache. The same route is available to future correctly admitted consumers.

The module record owns exports, loaded and loading state like pinned
BuiltinModule.compileForInternalLoader. Circular internal import returns the
partial exports object. A failed initialization clears loading and retries;
only completed initialization sets loaded. The actual successful initialization
is appended to the captured moduleLoadList owner. This metadata is not proof
of property or manager conformance. A recording failure after loaded commits
retains the initialized exports on retry, as the pinned algorithm does.

The existing Worker owner now supplies a separate private captured threadId
view. Public worker_threads.threadId remains writable; changing it before first
locks read cannot change the actual Lock request client identity. Worker launch,
packets, scheduler, lock manager/provider rotation, request/callback/Promise
lifetime, native context cleanup and unref/wait behavior are unchanged.

All new state is ordinary realm-local traced JavaScript state. A pending
property's native record retains its loader; the platform owner retains its
module cache for the context lifetime. Public set/delete can retire that cell
without destroying the private module/singleton. Initialization errors propagate
unchanged; the sealed native owner handles its retry/ready/OOM state. No native
root registry, cross-thread JS reference or new external allocation is added.
Public-property recursive initialization remains an unresolved native/candidate
semantic question: the pinned target and V8 reference fixture abort bounded
processes; the uncompiled SM prerequisite uses a safe error/retirement policy.
Those observations are not an accepted exclusion or candidate runtime pass.

The focused controls execute the actual candidate JS consumer and actual
portable C++ LockManager with a test-only genuine V8 native lazy DATA owner.
This validates consumer wiring without an accessor/proxy/no-op fixture; it does
not compile or validate SpiderMonkey's owner, GC, realm wrappers or JSAPI.
Existing public/review Web Locks assertions remain unchanged; their setup now
requires NODE_LOCKS_LAZY_REFERENCE_BINDING naming that native reference fixture.

Navigator/global navigator and its CPU/locale/platform/brand/CLI providers are
not implemented here. Shell globals use a GlobalObject plus WindowProxy, which
the initial PlainObject owner deliberately does not admit. A future global
slice needs checked proxy/global forwarding and all global cache/descriptor/
integrity paths reviewed, not bypassed admission or a partial fake Navigator.

Other existing Worker gaps, including resourceLimits, postMessageToThread,
threadName and complete ordinary export ordering, remain unchanged. Prefix and
ordinary builtin aliases still use the existing builtin policy/cache routing.
No kernel/libc/SDK change or program/host ABI bump is proposed. Engine inputs,
recipe/source generation and artifact freshness must include both prerequisites
and this consumer before any public support claim.
