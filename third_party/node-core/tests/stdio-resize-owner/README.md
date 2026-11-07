# Focused stdio resize and publication controls

The private run-controls.py receipt creates actual PTYs and supplies RESTORE_FD,
REPORT_FD and STDIO_RESIZE_DIR. Use the pinned26.13.0 native reference with
--no-warnings --expose-internals. Native mode observes real process stdout/stderr;
before/after modes execute the actual selected bootstrap consumer and source-
backed terminal/fd/process-signal factories. Genuine internal/test/binding
SignalWrap is an explicit native fixture dependency, not production delegation.

The existing exact OutputHandle addon/header are reused; no compiler is needed.
Actual ioctl changes and process.kill(SIGWINCH) drive resize. Captured descriptor
reuse and publication errors are real operations, never process.emit simulations.
The only authored failure is a throwing real newListener/prototype setter.
Original thrown identity and real extra-owner retirement are asserted.

Initial missing-report and wrong process.binding signal_wrap setup errors remain
nonpasses. The corrected internal binding route leaves production unchanged.
The uncaughtException handler reports unexpected harness errors as failures; it
is not evidence for guest fatal/callback exception behavior. Native shared libuv
signal behavior does not establish Kandelo's actual sigaction/self-pipe owner,
EBUSY sharing, queued close, GC/realm/Worker or any four-host conformance.
