# Captured TTY output publication rollback

The ordinary borrowed-stdio output factory acquires a genuine captured TTY
OutputHandle before constructing its shared Writable. If option evaluation,
Writable validation, binding or a later public setter throws, that acquisition
must be retired rather than abandoned until an eventual GC. The output adapter
now exposes close through the existing tty-output-close native owner. The fd
factory catches only construction/publication failures, attempts that genuine
retirement once, and rethrows the original value even if cleanup also fails.
Successful construction and the existing stdio dummyDestroy policy are
unchanged. Rollback never closes the borrowed public fd or a replacement
installed at that number. It also does not reverse the verified OFD
initialization contract already performed by OutputHandle::Open.

This is a consumed partial lifecycle prerequisite, not public tty constructor
activation. Public ReadStream/WriteStream remain gated. Socket kind/adoption,
StreamBase WriteWrap original-allocation queues/encoding/partial completion,
shutdown/error/cancel, native constructor birth/init ordering and full guest
async close/ref semantics remain open. Outer bootstrap bindOutput failures are
also separate from this inner fd-factory publication transaction. A native
close-root allocation failure can still prevent immediate retirement; the
original construction error remains primary and existing GC/shutdown owns
that fallback. No no-op close, fake kind, successful shutdown or metadata was
introduced.

Focused controls compile the current actual OutputHandle header once into a
small native NAPI component and run exact source-backed fd/terminal factories
on real PTYs, with native Node26 Writable/errors/VM as explicit dependencies.
Six groups cover option getter, real Writable validation, public fd setter,
public-fd replacement, cleanup exception priority and successful write/destroy.
The retained baseline is1pass/5nonpasses; the candidate is6pass. The native
component closes directly; it does not exercise SpiderMonkey queued-close
callbacks or prove guest/four-host behavior. No new guest C++ is compiled,
no overall suites or engine/product builds run, and old fallback/nonpasses
remain unchanged. New source follows existing actual read-side rollback
ownership rather than importing an inert public tty frontend.
