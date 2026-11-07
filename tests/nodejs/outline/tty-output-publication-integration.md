# Captured TTY output publication rollback

The borrowed-stdio output factory already acquired a genuine native OutputHandle
before options/Writable construction, but failures could abandon it until GC.
Its actual inner construction/bind/setter transaction now attempts existing
native captured-owner close and rethrows the exact original value. Close never
uses a borrowed public fd number or replacement. Success and stdio dummyDestroy
retain their real prior lifetime policy.

Six fresh native component groups pass on real PTYs, actual current generated
factories and the same compiled production OutputHandle. They cover option and
Writable validation, escaped fd setter, real public-fd replacement, error
priority after actual close, and successful write/destroy. Original baseline
five nonpasses per run remain. One successful native NAPI compile is counted
once; root reuses exact header/addon/binary identities. Native Writable/errors/
VM/NAPI/direct-close are explicit dependencies, not guest queued-close proof.

Independent source review finds no new verified blocker while retaining outer
bootstrap bind failure, close-root allocation fallback, native init-hook
escaped-owner rollback and all other lifecycle questions. Normal885input/core/
bootstrap/staging and14package checks pass. No new guest C++/kernel/engine/
product build, overall suite or ABI/pin change occurs.

This does not activate public TTY constructors or fabricate kind/shutdown/queue
support. Guest queued callback/ref/destroy/GC behavior, real Socket/TTY adoption,
WriteWrap byte/partial/EAGAIN/shutdown/cancel semantics and all four hosts remain
open. No API/family closes; unrelated work/remainder and target pins stay intact.
