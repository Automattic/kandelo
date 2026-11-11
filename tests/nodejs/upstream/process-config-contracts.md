# Native process/configuration prerequisite

This work continues the unchanged Node.js 26.13.0 source at commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. It adds real native state needed
by the original principal-node body. It does not complete upstream startup.

## Process and exit-info ownership

Original `src/node_process_object.cc:CreateProcessObject` constructs an instance
of a native `process` class and then attaches process metadata. Its constructor
can also create an empty instance. Original `lib/internal/bootstrap/node.js`
sets the class prototype's parent to EventEmitter.prototype; this requires a
distinct mutable prototype, never Object.prototype. Without new, the original constructor returns its effective receiver, with
global substitution and primitive boxing. The new native constructor
honors actual new-target/prototype semantics, creates empty instances, and the
realm's initialized process retains its actual guest metadata.

Original `src/env.h:Environment::ExitInfoField` assigns kExiting=0, kExitCode=1
and kHasExitCode=2. `src/env-inl.h` uses a live AliasedInt32Array, owned once by
the Environment, not separately by each realm. The native runtime now owns one
real Int32Array and returns checked cross-compartment wrappers to every realm.
The canonical exit_info private symbol attaches this same storage to each
initialized process. Native util.constants exports the original three indices.
Normal constructor-created instances do not acquire process metadata or this
private state. Original upstream exitCode/_exiting accessors will operate on
these fields when principal bootstrap reaches them. Actual native exit dispatch
and full process lifetime behavior remain unfinished.

## Configuration

Original `src/node_config.cc` defines the binding and compile gates. The current
binding has per-realm identity and read-only data fields:

| Field | Actual source of value |
|---|---|
| isDebugBuild | Compiled engine DEBUG configuration |
| openSSLIsBoringSSL | Linked OpenSSL header's actual build macro |
| hasOpenSSL | Actual OpenSSL build header, linked by the normal package |
| hasIntl | Compiled JS_HAS_INTL_API; omitted when unavailable |
| hasInspector | False: no inspector backend is registered in this embedding |
| noBrowserGlobals | False: selected ordinary Node bootstrap policy includes web setup |
| bits | 8 * sizeof(intptr_t) in the guest compiler target |
| getDefaultLocale() | JS_GetDefaultLocale from this guest engine runtime, not host Intl |

The locale is the actual engine's BCP47 runtime locale, which can differ from
an embedding host or native V8 on another operating system. Public JavaScript
mutation of Intl does not supply it. The existing build uses complete Mozilla
Intl data, the original options parser and a standalone native tracing component.
Optional hasSmallICU/hasNodeOptions fields are absent. The original tracing
binding and engine intrinsics now support the actual hasTracing=true capability.
This is not permission to silently accept unsupported options when CLI integration is
implemented. Linking OpenSSL does not implement the full Node crypto binding.
The original fipsMode constant's integration semantics are not established;
access raises ERR_KANDELO_NOT_IMPLEMENTED rather than copying a reference flag.
Builtins config JSON and the broader native option registry remain missing.

## Principal-node call boundary

The native owner now compiles and calls the complete original
`internal/bootstrap/node` with process/require/internalBinding/primordials from
protected native slots. The mutable diagnostic exports container is not an
input. A separate NodeNotStarted/NodeRunning/NodeBodyDone/NodeFailed state
tracks this body. Publication precedes JavaScript; reentry/repeat rejects,
and a failure retains the original exception and makes the realm owner
terminal. Diagnostics retain the actual compilation-event IDs without exposing
partial loader/process objects. A previously captured diagnostic JS closure can
still return its original cached binding; guarded native compile/lookup entry
rejects after failure. No cache policy is rewritten to revoke an original JS
closure. Finishing this body will not mark web setup,
thread/ownership switches, process.env or full Realm bootstrap complete.

The current next eager binding is timers, followed by task_queue/async_wrap and
the wider original dependency closure. Missing bindings remain actual startup
failures. Dedicated controls check native state and terminal-failure behavior;
those passing controls must never be described as successful Node startup.
Full guest entrypaths, browser hosts, complete native differential, security,
OOM and finalization remain unverified.
