# Borrowed stdin terminal modes and window queries

Source120 implements the borrowed-stdio mode/window prerequisites for T-007
and T-008. It does not implement the public Socket/TTY constructors or close
these findings. The exact audited Node26.13.0 pin and audit remain unchanged.

`terminal-operations.h` owns a real CLOEXEC dup of the input descriptor,
validates it through tcgetattr, and uses actual termios/ioctl operations.
Entering raw from normal snapshots the actual attributes. The pinned UNIX
RAW/RAW_VT and binary IO policies use symbolic target headers; successful
changes alone update native mode state. NORMAL restores the saved handle
attributes with TCSADRAIN. The process-wide first-owner reset policy follows
the pinned libuv source; close restores that owner's original state with
TCSANOW and closes only the owned lease, never the borrowed caller fd.
No O_NONBLOCK changes, guessed layout, fabricated attributes or fixed window
sizes implement this route.

`native-terminal.cpp` supplies an opaque GC-owned mode lease and actual
window query through the existing OS packet binding. Native async state
tracks leases without rooting JS objects; context shutdown closes them before
detach, and later finalizers unlink/release retained native state safely.
Close is idempotent. Descriptor ownership survives reuse of the caller's
number. This mode lease is not advertised as a native TTY/Socket I/O handle.

`terminal-platform-adapter.js` uses the complete pinned setRawMode method,
with one explicit adaptation from its optional handle call to the private
stdio lease. It retains true/false/raw/io policy, errors/events, return and
isRaw/rawMode updates. A real fd-stream retirement hook owns cleanup; a
user-emitted public close notification does not release the native resource.
The SpiderMonkey window route now reaches actual TIOCGWINSZ. Public TTY
constructors, descriptor reopen/type/flag/async identity and signal/resize
ownership remain separate gaps; the generic stdio stream is not a full TTY.

## Scoped evidence

* `.context/node26-terminal-source-r3/report.json`: four complete pinned
  reference files are archive-verified; selected identities, bundle/bootstrap
  generation/syntax and declared changed inputs pass. The first expanded
  source check caught an undeclared changed fd-stream adapter; it is now
  declared. This is not a guest C++ compile.
* `.context/node26-terminal-native-r1/report.json`: one compiled portable
  owner/reference comparison over a controlled development-host PTY matches
  exact native Node. A probe reads actual tcgetattr/ioctl state through
  raw/IO/normal/raw/close, verifies the borrowed fd survives and a closed
  lease rejects changes. Six snapshots are operations, not six API cases.
  This is neither the new JSAPI nor guest kernel/context-shutdown evidence.
* `.context/node26-terminal-frontend-r2/report.json`: five comparisons pass
  over the candidate pinned method/error owner and actual fd retirement
  source, with explicit native Node TTY/stream/handle dependencies. They cover
  modes, validation, genuine closed-handle errno, optional-handle behavior
  after close/borrowing and actual PTY state after a manually emitted close.
  Initial four positive controls are retained separately; they did not cover
  the subsequently reviewed notification/retirement distinction.
* `.context/node26-terminal-affected-r1.json`: four affected stream controls
  pass over candidate stream/transport source and real native pipe/file I/O.
  None of this executes the uncompiled guest terminal binding.

No new upstream terminal files, overall suites or full product rebuild ran.
One portable helper compilation ran; no guest engine/package/library build
ran. Source117–120 remain uncompiled and accepted116 is not current. Prior
cipher/SQLite/Error/compression nonpasses remain unresolved.

## Dependencies still open

The current kernel accepts TCSADRAIN but sys_tcsetattr does not wait for output
to drain. The new owner requests the correct action; it does not conceal that
kernel implementation gap or declare it a browser/platform limitation.

Implement actual signal subscriptions/delivery and SIGWINCH refresh/resize
lifecycle; the old no-op adapter remains an implementation gap. Implement
public tty constructors with actual I/O handle ownership, class inheritance,
reopen/flags/read/ref/close and async-resource policy. A copied mode algorithm
and a dup lease do not supply them. Reconcile receivers/private-handle
replacement, environments/colors, input/output lineage and complete errors,
reflection, worker/fork/quit/signal/GC/OOM/cancellation semantics.

The next warranted targeted compile must include this source and the pending
117–119 changes. Later unchanged tty/readline/stdin/resize coverage and exact
native controls must validate identified artifacts on all four hosts. Every
nonpass and incomplete API/family remains separate from passing conformance.

A separate static source-input inventory found 305 remaining verification
file dependencies absent from the engine recipe. It covers manifest paths
and literal build.py reads, not a full dynamic SDK/toolchain closure. Save and
fix that shared package-input contract next; it is not evidence that earlier
runtime failures were caused by stale artifacts.
