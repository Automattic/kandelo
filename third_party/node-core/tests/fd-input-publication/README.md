# Native fd input byte publication

control.cjs exercises the actual normally generated fd factory with explicit
native Node stream/pipe/TTY/Promise dependencies. run.py uses real OS pipes and
raw PTYs; native controls wrap the real handle.onread and call the original
onStreamRead against actual streamBaseState fields, never a fabricated handle
or written counter. Candidate transport boundaries deliver actual native
Readable bytes. Their bind bridge is registration only; guest provider/frame,
GC, fatal, cancellation and liveness conformance are not claimed.

Three paths are covered: ordinary fd Promise; the retained captured-input
Promise compatibility branch; and captured TTY callback. Current production
openInput selects the callback path; the Promise compatibility branch remains
real code but is not described as the normal current TTY route. public-from,
valueOf and iterator getters are poisoned after factories/owners initialize.
Native/candidate bytes and private allocation/offset/count retention are
observed separately from public API conformance. The existing baseline's six
correct-byte cases make extra private copies; only its three valueOf cases
are actual fatal/nonpass outcomes. None is a passing compatibility exclusion.

Use exact NODE26_REFERENCE plus FD_PUBLISH_REPO/FD_PUBLISH_EVIDENCE and invoke
run.py in the declared development shell. No global setup or native compilation
is needed. The sealed producer also retains two genuine short-read/nonzero
window subjects and four prior fd controls, with separate scopes.
