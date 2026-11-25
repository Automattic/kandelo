This is the typed Wasm emitter for the Node-owned libffi target backend. It
builds with the original fork instrumenter/C boundary in one Rust static
artifact, sharing its Rust dependency/allocator closure. No new external
library, interpreter, subprocess or host interface is introduced.

The emitter covers Node's scalar types and arbitrary argument combinations,
including three doubles and shapes outside the old static dispatch families.
Its C entry always passes generated modules through the original side transform.
The normal guest loader must still admit those outputs. Call adapters have a
fixed bridge and retain no target/cif; typed callbacks retain a live native
closure address. A reservation module keeps the callback address stable before
the signature is known, using ordinary guest table operations when installed.

This library alone does not implement upstream libffi preparation, signature
caching, loader/fd ownership or closure retirement. Those C target-backend owners
and guest thread/fork/permission/resource qualification remain required. Node's
JS conversion/fatal callback/termination policy stays in original Node source.
Current guest Rust panic=abort/OOM limitations remain explicit. Successful
compilation or host code-generator tests do not establish working Node FFI.
