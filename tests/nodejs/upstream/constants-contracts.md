# Native constant declarations

Revision 30 compiles the complete pinned `src/node_constants.cc` and
`src/node_constants.h` unchanged. A private C++ property builder maps their
initializer and property operations to actual rooted SpiderMonkey objects.
It supplies only this declaration interface; it does not implement V8 or
simulate Node resource handles. The actual original initializer registers
through this bridge and populates a per-realm cached binding.

The binding and all ten table containers have null prototypes. Primitive
entries retain native readonly, nonconfigurable, enumerable descriptors;
container properties retain their original mutability. This Kandelo build
exposes 425 numeric/string definitions. That number is metadata coverage,
not an operational support counter.

Compression metadata comes from all 171 original export declaration operands,
the original mode enum and limit declarations in complete verified node_zlib.cc.
The generator rejects executable policy or unreviewed grammar rather than
extracting compression functions. The guest compiler evaluates the declarations
against actual dependency headers. Complete pinned Brotli public headers supply
its API declarations; no Node Brotli backend is implied. The original trace
macro header supplies phase codes, without claiming tracing support.

The independent guest C probe caught two integration problems: the libzstd
package omitted its public error header, and Mozilla's bundled zlib header took
precedence over the declared target dependency. Libzstd revision 2 now installs
its original zstd_errors.h; its decoder archive bytes remain unchanged. The
Node constants preparation step explicitly stages the declared zlib/zconf and
zstd/error headers beside the native source and metadata. It leaves Mozilla's
own compression header selection alone. Future Node codec implementation still
needs actual codec symbol/version and operational validation.

Ten constants controls pass on each of Node, Chromium, Firefox and WebKit with
identical engine/kernel bytes. Forty-three values agree with the independent
Kandelo target-header probe on every host, together with four real filesystem
flag/errno effects. The same engine passes 208 prior Node cases. The selected
80 process drivers include nineteen expected fatal controls. Six shared native
reference controls pass separately; full snapshots record 348 equal values and
90 differences attributable to target OS/dependency headers and configuration.
Darwin errno, signal and file flags are not copied into Kandelo.

The original principal and stack-policy probes now reach missing `types` in
internal/util:73. Original NodeError construction still succeeds. Complete
upstream empty/simple output/errors/jobs/exit and CJS/ESM startup remain unproven.
Constants do not implement the corresponding OS, crypto, compression or trace
operations. Common async scopes, lifecycle/frame hooks and the full backend
catalog also remain incomplete.

Build failures, the independent header mismatch, initial read-only-root probe
failure and a native fixture spelling error are retained in
[constants-engine-check.json](constants-engine-check.json). The C probe uses
actual writable /tmp after the guest root correctly returned EROFS. Imported
Node/Brotli declarations follow Mozilla's existing foreign-source style policy;
our bridge remains checked and its own header/style failures were fixed.
Browser cleanup retains its macOS permission warning; existing Mozilla targeting
debt and the bounded native fork-instrumentation fallback remain open.

The partial machine-readable catalog is
[constants-contracts.json](constants-contracts.json), including 36 literal
consumers, ownership, sources, prerequisites and validation obligations.
Next implement genuine engine type predicates needed by the unchanged util
module, then continue the startup-required native closure. Complete the entire
backend graph and roadmap after startup and stop for user review before broader
implementation. Full products, successor-ABI campaigns and overall suites
remain deferred. These checks use empty guest filesystems, not product images.
