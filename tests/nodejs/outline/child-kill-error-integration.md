# ChildProcess.kill public error integration

Source168 integrates the one-hunk public error correction over167DNS and all
166native-root/backing fixes. Numeric zero, default/unknown/lowercase signal
conversion and actual native kill delegation were already present and remain
unchanged. Frozen CP-001 describes historical source; this slice does not
claim to introduce those earlier conversion fixes or close the full finding.

Actual native errno now goes through unchanged pinned ErrnoException and the
real compiler-selected UV map. Previously the frontend mutated the native
exception, retaining an engine strerror message and hardcoded classifications.
ESRCH returns false; EINVAL/ENOSYS throw; other native errors emit synchronously.
Failure preserves killed; success alone sets it. Constants remain compiler-
owned, without substituting native Darwin numbers for guest musl values.

The checked-in control preserves all35judges and actual-child assertions;
only its repo-root location changes. Current generated values/error owners
and actual bootstrap spawn/kill source run with explicit native status and
two owned real host-child boundaries.35judges and both child comparisons
match;14package checks pass. Zero leaves the child alive, lowercase SIGTERM
terminates it and owners kill/reap in finally. Host children are control
fixtures, never guest execution. No new compilation or overall suite ran.

Original10before mismatches, initial33case history and mistaken --live filename
harness error remain preserved. Complete ChildProcess prototypes/receiver/
descriptors/inherited/Symbol, IPC/fork/extra stdio/normalization/abort/timeout/
maxBuffer, native GC and exceptional wait lifecycle remain open. Actual guest
EPERM/ESRCH/EINVAL/ENOSYS under real credentials/process state and all four
hosts require identified-artifact evidence and applicable unchanged upstream
kill/spawn-error/platform cases. See [finding ledger](child-kill-error-finding-progress.json).
