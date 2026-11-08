# Shared captured TTY I/O

Source 246 has actual shared captured TTY IO and source-reviewed close/retirement phase corrections. Current root generated JS passed two real native Node TTY/WRITEWRAP component subjects, each matching 1026 PTY bytes; corrected portable IOHandle passed two groups. configureWrite remains validation-only. New guest native code, public constructors and four-host conformance remain uncompiled/unvalidated.

- Compile and validate actual shared TTY native JSAPI, seven engine routes, actual GC/realm/coercion/callback/fatal/Worker/fork behavior on identified artifacts across all four hosts.
- Implement genuine public callable tty.ReadStream/WriteStream and typed net.Socket admission, native init-before-fd-open and transactional adoption. Current real stdio owners do not complete public classes.
- Implement mixed/string/input-kind writes, output-kind reads, genuine nonblocking write readiness, shutdown and complete StreamBase/AsyncWrap request ownership.
- Support valid pipe/master/unreopenable fd admissions through real ownership; existing rejections remain implementation gaps, not engine/platform exclusions.
- Reconcile unchanged restoration/comparator observations and every original nonpass without weakening assertions, hiding errors or claiming a Darwin/guest exclusion.
- Current native Node backend controls and portable host PTYs do not establish new guest C++ or four-host conformance. Overall suites and full product rebuild remain deferred.
