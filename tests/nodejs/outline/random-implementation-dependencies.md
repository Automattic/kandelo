# Random generation source owners and remaining dependencies

The exact audited Node 26.13.0 target remains unchanged. This is partial
crypto implementation work, not closure of a public API or module family.

## Source candidate

`crypto-random-jobs-adapter.js` selects the pinned randomBytes, randomFill,
randomInt cache/refill and UUID v4/v7 algorithms. The existing pinned sync
validation remains. `random-operations.h` uses actual OpenSSL RAND_bytes_ex
and owned secure allocations; `native-random.cpp` stages real native worker
requests through the shared queue and copies completion bytes on the owning
JS thread. Shared destinations use atomic byte stores. `native-fs.cpp`
provides distinct RandomBytesJob resource identity over shared request
storage. Patch 72 and SpiderMonkey recipe 58 stage these native inputs;
the guest engine and its JSAPI bindings have not been compiled.

The provider error formatter now follows the full pinned OpenSSL library
prefix map, with source-generation checks against that map. This also
changes the shared digest owner; old digest evidence remains historical.

## OpenSSL threading prerequisite

The prior package disabled OpenSSL threading. A concurrent native control
crashed during OpenSSL algorithm initialization. Its configuration selects
no-op locks, unguarded once initialization and shared error storage in
threads_none.c. This is a Kandelo package defect, not an external engine
defect. Recipe 5 enables real OpenSSL threads with the SDK pthread flags.

Normal resolver builds completed for both wasm32 and wasm64. SDK probes
linked pthread and the actual rebuilt RAND/secure-allocation symbols for
both targets; they were not executed. The fresh native threaded control
passed 512 operations across eight threads with isolated error queues and
secure allocation provenance/retirement checks. Native success does not
establish guest libc, worker, entropy or OpenSSL runtime conformance.

## Bounded evidence

* Six focused algorithm scenarios passed using native Node entropy,
  RandomBytesJob, allocation and async-resource boundaries.
* Four unchanged upstream random files passed in candidate and native
  modes. Deprecated random aliases remain native in this harness and do
  not establish candidate alias support.
* Six affected synchronous-random controls passed after updating their
  fixture to inspect the new provider boundary.
* The earlier native no-thread pass, later SIGTRAP crash and crash report
  remain preserved. A passing single run did not establish thread safety.
* Initial source-selection and fixture failures remain recorded separately;
  repetitions are not additional API coverage.

Raw reports are under `.context/node26-random-controls-r3/`,
`.context/node26-random-upstream-r1/` and
`.context/node26-random-threaded/target-builds.json`. The native crash
report is `.context/node26-random-native/owner-failed-r2-crash.ips`.
No combined current-candidate four-host conformance follows from these
controls. Earlier baseline results describe different artifacts.

## Remaining owning work

The current scratch/copy-back job does not retain the original backing
store across transfer. A native differential control shows that Node fills
the transferred destination and successfully calls back with the original,
now detached input. This source candidate instead rejects that detached
input at completion. A real backing-store lease is required; this is an
implementation gap, not an accepted engine limit. Resize, early visibility,
additional scratch-memory accounting and allocation failure need the same
ownership review.

Guest compilation, actual worker/entropy/error/loop/ref/cancellation/shutdown
behavior, precise AsyncWrap prototypes/descriptors/IDs, GC and cross-realm
ownership remain unvalidated or incomplete. Deprecated aliases, CLI/FIPS/
snapshot policies, fork-sensitive cache behavior, complete crypto namespace
metadata and the target's newer OpenSSL features remain open. Threaded
dependency outputs must reach the engine through a later normal dependency
rebuild; building the libraries alone does not update the running product.

Domain was inspected but remains unexposed: fatal-exception recovery,
domain entry trampolines and weak-reference ownership still need real
owners. Continue independent audited work before broadening this slice's
test campaign. Overall suites and the full product rebuild remain deferred.
