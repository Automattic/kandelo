# Child process callback and Promise collection

The public exec/execFile functions consume complete unchanged pinned Node26.13.0
normalization, output collection, timeout/byte-limit, error and custom-promisify
algorithms over the existing real spawn owner. Output streams use their actual
setEncoding decoder; Buffer output retains bytes. Each output has its own limit,
Infinity disables it, and actual timeout/maxBuffer kill/error/close paths own
callback completion. The custom Promise carries the actual child, returns both
outputs and attaches them to original rejected errors, with pinned descriptors.
exec dynamically reads the actual public execFile member. Caller stdin remains
open until the caller or actual child terminal owner closes it, as pinned Node
does; collectors no longer destroy caller input by unconditionally calling end.

The normal generator verifies full retained child_process.js and exact complete
section hashes. There is no replacement spawn, fabricated child or completion
flag. Existing child wait/reap, pipe/read cancellation, error/exit/close and kill
resources remain the lower production dependencies.

Focused evidence is native-dependent:23semantic groups plus4unchanged upstream
files/native+candidate over genuine native Node spawn/stream/Buffer/error/timer
owners. Original5/23baseline matches, original stdin-write error and private
missing-input setup failures remain evidence, not allowances. This does not
validate guest launch/stdio/AbortSignal/signal delivery/timer callback/fatal/GC/
realm or all four hosts. Full child Process/IPC/fork/stdio kinds, spawn shell/
argv0/options/error and lifecycle findings remain open; CP-010 is a partial
owning source implementation, not a compatibility closure.
