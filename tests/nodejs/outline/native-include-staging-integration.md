# Native include and vendor staging integration

Source173 repairs the normal style failure from the actual171production
engine build. That earlier attempt compiled and linked, then failed its
unchanged Mozilla style gate with75added diagnostics at74unique locations.
The original terminal failure remains preserved; no artifact was accepted.

The generated unity and staged owner headers now use canonical include paths
and the actual pinned Mozilla include sorter. Five patched engine files gain
include ordering changes only. Directory-copy excerpts receive .h/-inl.h
names. Histogram declarations and inline definitions have explicit consumers.
Exact imported HDR and libuv bytes move to the real source-root third-party
boundary; owned stat-poll port headers stay under checked shell paths.
Actual moz.build source/include paths consume those locations. No checker,
expected output, ignore list, assertion or imported algorithm is changed.

Current normal staging, generated bootstrap syntax, full unchanged Mozilla
checker and788declared source inputs pass.14existing package contract checks
pass. Current172PKCS12raw owners are byte-identical. The private sealed slice
also preserves97source/provenance checks and five successful tiny native
compiler invocations; its unchanged histogram comparator matches403rows and
27import controls. Root reuses that identified component evidence without
claiming fresh runtime execution. Existing preparation failures are retained.

No normal production engine build has yet accepted173. Genuine vendor source
relocation still needs normal configure/compile/link acceptance; source style
and native component checks cannot prove it. Guest JSAPI/GC/realm/thread and
Node/Chromium/Firefox/WebKit conformance remain unestablished. Overall suites
and full product rebuilds remain deferred.

See [scoped ledger](native-include-staging-finding-progress.json),
[actual171result](engine171-build-result.json) and
[finding navigation](finding-ledger.md).
