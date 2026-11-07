# Promise timers and actual shared insertion ownership

Source227 consumes complete unchanged pinned timers/promises with actual shared
Timeout/Immediate/insertion and cancellation owners. Timeout construction creates
its real async owner without scheduling; classic and Promise callers insert once.
Insertion passes duration separately from the actual monotonic origin, truncating
before native scheduling. Lazy access to the real resistant EventTarget symbol
avoids bootstrap cycles. Target getter/error order, abort-listener retirement in
Promise reactions, interval state and Scheduler behavior remain pinned algorithms.

Eighteen fresh native-dependent groups, four unchanged upstream files on both
subjects and two real unref-only process exits pass. Native handles/ref/clock/
Promise/EventTarget/VM and AsyncResource/ALS remain explicit fixture dependencies,
not guest provider/loop/frame/GC/fatal/Worker proof. Baseline11/18matches remain.
Original r1delay-as-origin defect is preserved and reproduced by the added actual
deadline group (17/18); its real insertion seam was fixed. Corrected-source fixture
missing genuine primordial factory caused separate nonpasses and was fixed in
fixture arguments only. All41original direct runtime attempts remain recorded.

Independent source review verifies1501members and actual existing scheduler
signature/clock/construction/listener/lazy-owner routes with no new P1/P2. Root
narrow zero-fuzz composition preserves226child collector and generator exactly;
no old whole bootstrap/build.py/bundle replaces current source. Three new runtime
inputs are declared. Normal889guarded inputs/bootstrap/staging and14focused package
checks pass. No compiler, engine/kernel/product build, ABI/target change or overall
suite occurs. All19families remain partial and no finding closes. Current combined
guest/four-host conformance is unestablished; targeted engine evidence remains due.
