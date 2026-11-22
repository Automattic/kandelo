# Native Amaro provider

This package builds the pinned Amaro 1.1.11/SWC source as a private guest
dynamic library. Its original whole JavaScript transform wrapper and Rust
`transform_sync`, `operate`, diagnostic and Serde conversion algorithms remain
the implementation. The private backend replaces generated Wasm imports with
operations on real values in the calling SpiderMonkey realm.

The converter source is the original locked serde-wasm-bindgen 0.6.5 archive,
declared as `node-amaro-serde-source`. Its source receipt records the import
adaptations. The native backend does not retain the original glue's static
string-handle cache: native handles belong to one synchronous rooted call.
No options schema, JSON conversion or alternate transformer is used by the
JS-value entry. The older JSON C entry remains a diagnostic interface.

Each synchronous transform borrows a C operation table and caller-owned rooted
handle arena. Nested calls install a separate Rust thread-local table and
restore the parent on return. A failed JavaScript operation returns through
C++ before Rust unwinds its private marker; the C export catches that marker.
The original engine exception/stack/stop remains in the caller's catcher.
Other Rust panics retain their actual payload until the library releases it.
No Rust panic may unwind through a C++ callback.

Node loads `/usr/lib/libnode-amaro.so` on the first actual transform, using
ordinary guest `dlopen`/`dlsym`. It retains the library's code through process
retirement so Rust TLS destructors and Worker callbacks cannot outlive it.
Individual Environment cleanup does not unload shared executable code. JS
roots and transform results retire at the end of each call. The library is
not an eager executable dependency and does not enable `.node` addons.

The new JS-value entry has compiled. Its Node consumer, lazy load, differential
semantics, exceptions and cleanup still require integrated qualification.
Earlier JSON-provider results do not qualify the new entry or default
TypeScript. Complete Node CLI acceptance on all four hosts remains required.
