# Native realm library boundary

Pinned Node.js 26.13.0 source commit: `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.
The complete original `internal/bootstrap/realm` executes through privileged
JS-shell controls. This is the library-loader stage of upstream startup;
principal `internal/bootstrap/node`, process-state switches and user CJS/ESM
entrypaths are separate unfinished stages. The ordinary Node entrypath still
uses the existing compatibility bootstrap.

## Original consumers and implemented ownership

| Contract | Original consumer | Current native behavior |
|---|---|---|
| Realm call | `src/node_builtins.cc`, `src/builtin_info.h` | Complete immutable body, original four arguments and undefined receiver; actual protected primordials object, not the mutable diagnostic export container |
| `builtins.builtinIds` | `lib/internal/bootstrap/realm.js` | Fresh array of all 443 admitted immutable registry IDs, binding frozen |
| `builtins.compileFunction(id)` | Same original loader | Original C++ wrapper metadata and real engine compilation; original JavaScript controls module caching, cycles and loading flags |
| `builtins.setInternalLoaders(internalBinding, require)` | Same original loader | Two actual callable closures retained in traced native slots, exactly once |
| `module_wrap` | Original builtin ESM facade | Canonical per-context binding, genuine synthetic module records, evaluation and namespace; partial binding limits remain in `module-wrap-contracts.md` |
| `errors` | Original realm and `internal/errors` | Canonical native preparation/enhancer callbacks; complete original error module installs them; partial CallSite/fatal-route limits remain in `error-stack-contracts.md` |
| `util.privateSymbols` | Original `internal/errors` | Normal-prototype object with all 22 original private identities from the canonical runtime inventory |
| Initial process | Original realm loader | Native process object, actual guest uname platform/machine, getpid data property and getppid getter; original JS supplies binding functions and moduleLoadList |
| Linked native lookup | Original process._linkedBinding | Declared embedder-linked module registry is empty; genuine missing-module error and `ERR_INVALID_MODULE` |

Native realm state belongs to its canonical per-context owner, which publishes
it before executing any JavaScript. Functions retain it in engine-traced slots;
all outgoing process/loader/binding/primordials/diagnostic edges are traced.
Initialization has distinct Initializing, LibraryReady and terminal Failed
phases. Reentry/retry cannot replace the owner. An original JavaScript exception
propagates unchanged, and a failed initialization exposes no partial loaders.
There is no finalizer-owned root or alternate JavaScript module cache.

Original Node uses CHECK for the loader function arguments and DCHECK for
once-only registration (`src/node_builtins.cc:SetInternalLoaders`). This port
keeps the latter invariant as a release assertion too. The isolated fatal
control establishes this port's invariant, not native release-build equivalence.

The native compilation-event list is private diagnostic state and snapshots
copy it. It is not a compile-cache implementation or cache-usage report.
`builtins.config`, `builtinCategories`, `natives`, `getCacheUsage`,
`hasCachedBuiltins` and `importBuiltinSourceTextModule` explicitly raise
`ERR_KANDELO_NOT_IMPLEMENTED`. Unsupported native binding names also raise that
error, with the actual name. No feature configuration or native-reference
platform identity is copied to pass bootstrap.

## Evidence and remaining startup closure

`realm-library-engine-check.json` identifies the package, kernel, source inputs,
native reference, controls, failure history and retained evidence. Sixteen guest
controls cover the original loader/cache/self-require and moduleLoadList,
private symbols, actual guest PID, original assert/error bodies, exposure
policy and real builtin ESM facade, failure/reentry, realm separation and GC.
The native reference has 12 separate controls on the pinned executable. Native
Node is already bootstrapped; it is not a guest startup reference. Native
`internal/bootstrap/realm` is intentionally inaccessible through ordinary
`require`, even with `--expose-internals`; the native fixture instead obtains
an actual BuiltinModule instance through the original modules helper.

A separate diagnostic compiles and invokes the complete original
`internal/bootstrap/node` with the actual existing process and loader. It stops
at its first eager native request, `internalBinding('config')`, at source line
68. The separate original typed-error construction returns correctly for the
selected ERR_INVALID_ARG_TYPE case. Calling the original stack-limit policy
also executes complete startup_snapshot/validators/util bodies, then stops at
the missing `constants` binding. These missing backends are retained gaps,
not successful startup tests. It does
not mark principal bootstrap complete or install a user entrypath. Native
process configuration, distinct mutable process prototype, exit-info state,
Buffer, timers/task queues/async context and the wider eager closure remain
unfinished. The full graph inventory and dependency-ordered roadmap are also
incomplete. No browser, full-product, successor-ABI or overall-suite validation
is established here.
