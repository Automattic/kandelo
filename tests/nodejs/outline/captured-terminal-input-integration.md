# Captured terminal input and request lifetime

Source191 integrates the sealed input prerequisite over190, preserving newer
FFI teardown, spawn publication, sys/crypto and unrelated source. The target,
source/native-reference pin and ABI55 are unchanged. This does not implement
public TTY constructors or close any family/finding.

## Actual consuming path

Supported slave-terminal stdin now captures the actual device through the
existing verified reopen/identity/dup2 owner. Only the isolated open-file
description becomes nonblocking. Its mode lease references the same terminal.
Replacing or mutating the public fd cannot redirect later reads or close the
replacement when the owned input retires. Unsupported master/unreopenable paths
retain the existing fallback and their explicit ownership/backpressure gaps.

The actual fd-read reactor stores the opaque terminal lease, its real root and
the exact Promise. Ref/cancel match that lease/request, not a public fd number.
Close stops admission, unlinks/cancels the request, then releases its descriptor.
Completion unlinks before Promise hooks and returns without retaining a raw
list-next pointer across reentry. Promise creation rechecks live lease state.
Native OS dispatch publishes the read Promise directly, avoiding a later result
packet allocation after a request has linked. Stream construction/publication
failure closes the actual lease and preserves the original exception.

The consumed curated OS method now forwards the full argument tuple, including
false/null read controls. Only that part of the forwarding capsule is integrated;
fsEvent forwarding remains pending the actual notification export. No absent
capability or TTYWRAP identity is advertised. Public tty classes remain generic
stream subclasses; proper StreamBase/TTY handle admission and lifecycle are
still prerequisites for the actual callable Socket-derived classes.

## Current focused verification

The existing native canonical-mode descriptor executable consumes byte-identical
current portable header/control sources and passes14actual PTY ownership checks.
Two extracted actual-curated-OS forwarding groups preserve owner/Promise/value
identity against an explicit recording boundary. Nine source owner checks cover
routing, exact request matching, direct publication, reentry/close ordering,
unchanged raw-mode algorithm and prior spawn/FFI integration preservation.
These source/portable controls do not compile or run production JSAPI.

Normal generation and844-file input closure, complete bootstrap syntax, zero-fuzz
engine patch0139 replay and unchanged Mozilla checking pass. Eighteen scoped
existing Vitest checks pass:14package-source and4fd-stream native-boundary cases.
No new compilation or matched actor experiments ran at root. Accounting adds
5previous successful input helper compiles and2previous diagnostic compiles;
one diagnostic helper was never loaded/executed. Accepted173 is stale for191.
No engine/kernel/product build, overall suite or guest/four-host validation ran.

Current evidence: `.context/node26-tty191-source-r1/report.json`,
`focused-results.json` and `.context/node26-tty191-affected-r1.json`.
Immutable input, matched diagnostic and forwarding capsules keep their original
seals. Root preflight initially rejected changed bootstrap context without
applying source; the narrow current integration preserves that log.

## Mode-restoration evidence stays separate

The original three raw-to-normal controls still fail; final R3 aborts SIGABRT
before its close assertion. Source, executable and original stderr are retained.
No mode algorithm, assertion, platform identity, mask or candidate-only flush/read
is changed. The independent canonical descriptor pass is not raw-mode proof.

Later existing diagnostics match I/O and readiness setup among actual Node,
portable InputHandle and a direct-libc branch within a shared addon. All22full
attribute phase comparisons agree and93resource/I/O checks succeed. Without a
persistent fixture watcher, all three retain PENDIN immediately after normal;
with the same real kqueue watcher, all three restore initial words; the same
later poll clears the bit for all three. Nine literal comparisons still fail
and remain recorded separately. Diagnostic process exit0 means collection and
matched checks completed, not passing those false restoration verdicts. The
second libc-only compiled helper was never executed and is not evidence.

This does not establish an outside-runtime defect or an accepted platform
exclusion. The old mismatched control setup does not justify a production mode
fix. Actual guest termios/readiness and public TTY behavior remain unvalidated.

## Remaining work

Public callable TTY classes and real shared StreamBase/TTYWRAP admission, exact
Socket hierarchy/options/descriptors, SIGWINCH, master/unreopenable/backpressure,
concurrent close/fork, allocation pressure/late initialization, Promise hooks,
security wrappers/realms/GC/fatal/context/Worker teardown and all four identified
hosts remain open. Original mode and earlier output failures are not passes.
Full product rebuild and overall suites remain deferred. Nested guest Wasm
execution backend remains in scope for the final phase.
