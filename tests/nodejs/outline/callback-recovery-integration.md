# Native execution ownership and exception recovery

Source checkpoint 149 gives native callbacks and JavaScript task scopes one
actual native execution-stack owner. Each record owns its prior context and
entering resource roots, IDs and native allocation claim. ID and resource
reads use this owner. The engine's default-trigger provider reads existing
state without creating an async environment. Clear epochs prevent late native
callback or engine-job cleanup from restoring a context already cleared by
uncaught recovery. Teardown releases roots while their context is still alive.

An outermost native callback failure invokes the owning guest process's
mutable _fatalException before request retirement. The standard handler uses
the unchanged pinned createOnGlobalUncaughtException algorithm. A recovered
failure drains the real after hooks, schedules a real Immediate and clears the
execution stack; it does not also perform successful-callback after/checkpoint
work. Nested synchronous failures propagate to their JavaScript caller, pop
their entering ID and restore context without after. This preserves catch and
finally behavior. Timer, tick and job failures recover at their event boundary
after the enclosing JavaScript stack unwinds.

Filesystem, CpDirJob, DNS, codecs, histogram and both StatWatcher callback paths
explicitly route actual errors through scope.Fail. The watcher paths previously
called successful Close even when JS::Call failed. Hook failure uses the real
guest process exit path. Native fatal dispatch distinguishes a strict false
handler result, a noncallable handler, a throwing handler and process.exit
inside the handler. Capture registration owns its real callback and report
flag. Promise rejection policy is not supplied by normal callback recovery.

The production adapter forwards all eight execution/process methods. Ordinary
bootstrap installs the process handler, and the normal recipe stages and
declares the owner and pinned references. Engine patch 0119 composes the shell
and JSContext hooks over source148. Root independently replayed all six existing
JSContext patches to exact expected preimages. Earlier locale, backing, copy,
watcher, TLS, Worker, lazy-property and VM source remains intact. Seven added
loop-guard lines received indentation corrections only. No target pin,
kernel/host ABI, platform identity or upstream assertion changes.

Focused root evidence:

- Four strict native helper compilations and six bounded control processes
  pass: actual portable stack/ledger/policy owners, zero-ID callback policy,
  normal/nested-throw/timer-entry policy modes, and eight generated-JS recovery
  groups over the actual portable owner through Node-API references.
- The component deliberately substitutes payload/Host/Node-API roots for
  SpiderMonkey roots and dispatch. Host events, timers and resource/destroy
  metadata are explicit dependencies. These are not production JSAPI proofs.
- Thirty-six affected checks pass without skips: twenty-two existing async
  frontend controls and fourteen package-source checks. Their test-only array
  execution bridge does not establish native execution-stack correctness.
- Five complete Node references and four Node-API headers match the audited
  archive. Normal source/input/unity staging and complete bootstrap syntax pass.

The existing sixteen exact native completion traces and sealed proposal
controls retain their original identities. The old Cp callbackThrow mismatch
is historical evidence, not a newly passing guest result. A native public C++
AsyncResource::MakeCallback control follows a different legacy path; its
exception swallowing is not substituted for FS/AsyncWrap completion semantics.

Remaining implementation gaps include the _fatalException getter-throw case
(native exits 0, current proposal reports the real getter exception and exits
7), reentrant fatal abort/inspector behavior, initial main IDs, Promise hook
activation/rejection modes, abort-on-uncaught CLI policy, diagnostic reports,
auxiliary REPL/domain users and fatal formatting. None is an accepted platform
exclusion. TCP reset/resource-alias reconciliation is a separate prepared
followup, and its provisional old After patch must not replace this owner.

All original failures remain preserved: stale bundle/input projections,
private-base/rebase mistakes, native-reference fixture compile failures and an
incorrect Node24 focused run before the exact Node26 rerun. One private focused
command accidentally invoked product baseline setup; it was stopped and reaped
during Rust tooling compilation before any test or accepted package, engine,
kernel or full product build. Its clean temporary checkout was removed after
identity/process checks, reclaiming about 1.37 GiB; logs remain. Root's initial
seal-parser schema error failed before source mutation and is also retained.

The combined SpiderMonkey C++/JSAPI/GC/realm/loop behavior and actual guest
callback recovery remain uncompiled and unvalidated. All four-host conformance
and per-API closure remain open; all nineteen families are partial. No overall
suite or full product rebuild ran for this integration.

Exact source, component and failure identities:
[callback-recovery-finding-progress.json](callback-recovery-finding-progress.json).
