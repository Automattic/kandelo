# Engine 271 build acceptance

The normal selected source-only resolver compiled, linked, optimized,
fork-instrumented and cached source 271 successfully. The producing source commit
is 3c52b3233e96d0b6bdefcdec07e1c74b9b0e8f89. The retained artifact SHA256 is
20821b997e81871c330e4c154a3700f2d7452f6412c2e6312ef4c164b70fd718,
52,865,511 bytes and mode 0755. Its actual build key and ABI55 custom section
were verified against the selected plan and normal cache receipt.

The original wrapper exited 1 only during artifact retention: it assumed the
normal binaries-dir alias could not be a symlink. The actual normal resolver
exited 0. The independent corrected verifier exited 0, accepted only the exact
normal cache target with identical bytes, size and mode, and ran no resolver or
compiler. Original failed terminal and manager records remain. This is one
retention harness error and zero engine build failures for this attempt.

One known engine package attempt is credited once: lower bound 378 becomes 379.
The selected nine-node plan is not nine compiler attempts. Four older unknown
dependency attributions are unchanged. The prior failed source 270 engine
attempt and source 271 source/check/TCP helper history remain untouched. The
previous source 263 accepted object is preserved verbatim in history, and source
239 runtime evidence remains historical. Later metadata-only commits do not
change the producing runtime source commit. See engine271-build-result.json for
exact evidence identities and separate numeric outcomes.

No guest startup, API test, Node/Chromium/Firefox/WebKit runtime or four-host
conformance ran. Compilation does not establish public API, GC, realm, OOM,
fatal, Worker or process lifecycle conformance. All 19 families remain partial;
central ledger 182 and 207 unlinked groups remain. Overall suites, full product
and successor ABI artifact builds stay deferred. Private environment descriptor,
legacy poll-interest and codec initialization error proposals are excluded.
