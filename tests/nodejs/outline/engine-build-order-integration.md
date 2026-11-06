# Mozilla build-definition ordering correction

The normal targeted source149 engine build failed in Mozilla's build reader:
the NativeLazyDataProperty header preceded Modules in a sorted export list.
The SDK/libc and dependency refresh had run first; no current engine artifact
or guest conformance resulted. Frozen source identities were unchanged.

Source150 corrects three lists: the public header exports, the JSAPI test
sources and the shell histogram sources. Every member remains present. The
normal upstream validator and its assertions are unchanged. Applying the
exact Mozilla StrictOrderingOnAppendList to the actual before/after files
finds three failures before and accepts all 41 checked literal lists afterward.
Fourteen existing package-source checks also pass without skips. This check
does not stand in for the complete build reader, compilation or runtime tests.

Engine patch 0120 is additive over the identified source149 build definitions.
No runtime algorithm, native API, upstream assertion, target pin, kernel/host
ABI or SDK source changes. The prior build failure and the separate initial
preflight PATH failure remain preserved. The engine must be rebuilt through
the normal resolver; old artifacts are not restamped. All nineteen families,
current engine validation and four-host conformance remain incomplete.

Exact evidence: [engine-build-order-finding-progress.json](engine-build-order-finding-progress.json).
