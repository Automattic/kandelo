# Native Node lifetime companions

Unshipped diagnostic program for the selected Node26.13.0/SpiderMonkey153.7 ESR lifetime contracts. It is not added to a product image or default build set. It tests the actual native engine bridge and original Node embedding, Environment, cleanup and callback owners. It never uses the preserved compatibility frontend.

The recipe reuses the complete normal Node build and original registration lists/providers, then changes only its private `node_main.cc` to this test entrypoint. The original main is preserved in build scratch. The auxiliary normal output is not published as a production package or used as a new CLI-acceptance result. No production runtime source/flags or SDK claims change.

Invoke one case per guest process: `script-gc`, `interrupts`, `failure-state`, `sibling-cleanup`, or `diagnostic-ownership`. The program prints observations and a final PASS only after the original Environment and engine disposal complete. A failure aborts truthfully. Harnesses must retain actual output, status, process-generation retirement and timeout/nonpassing accounting on each host.

These controls cover the changed compiled-script/cycle, native interrupt, execution restriction, diagnostic and Environment disposal contracts. They do not prove full vm-context graph behavior, incremental/moving/OOM completeness, all native resource lifetimes, formal CLI acceptance, feature-module conformance or the complete port. No execution results are claimed here until built and run.

Revision 2 expands the same complete native companion with incremental and
shrinking GC, abandoned construction-lease rollback, injected engine OOM-state
preservation, nested/cross-realm no-JavaScript restrictions, and live sibling
JavaScript during asynchronous Environment cleanup. OOM-state injection is not
an allocation-failure or report-copy-OOM test. A separate handle-identity mode
checks original Node native/JS symbol identity and original module import.meta.
Fatal controls separately exercise the resident no-JavaScript logger before
Environment construction and after its disposal, plus the original engine OOM
reporter before Environment construction. Module metadata checks actual UTF-16
positions before and after stencil-cache decoding. No Node policy body is
instrumented or replaced. Results remain unqualified
until the corresponding installed cases finish.

The private entrypoint is now selected before the normal complete GYP build,
through a test-owned `make` wrapper restricted to that exact build directory
and target. All other make invocations forward unchanged. The normal recipe
prepares the complete diagnostic executable once; the installer validates its
prepared ABI and publishes only the declared diagnostic output. Production
recipes, entrypoints, registrations and binaries are unchanged.

The incremental stress compiles its validation program before GC, mutates an
existing native wrapper property while collection is actually active, and
queries the incremental flag at that point. It finishes a cycle only if the
mutator has not already completed it. Original failures remain retained.
