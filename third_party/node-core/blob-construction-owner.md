# Blob construction and slice conversion

The shared Blob byte owner consumes the existing pinned WebIDL sequence
converter before reading its options or copying BufferSources. This retains
iterator/string/error chronology, reads endings/type once, and snapshots real
bytes after all sequence conversion and option getters. Type string coercion
follows actual byte assembly. Dictionary/error and actual Buffer limits come
from existing owners. Blob.slice uses the same real long-long WebIDL converter
for start/end, preserves clamp/range/type order and slices its actual private
byte allocation without a public TypedArray species/subarray call.

The unchanged sourceConverter selection comes from pinned Node26.13.0
lib/internal/blob.js; its byte-copy/storage adaptation uses Kandelo's existing
WeakMap Blob records. No native-host Blob is used by production. Focused native
fixtures supply actual shared Node WebIDL/errors/brands/streams/encoding/clone
marking, so native-dependent matches do not establish guest conformance.

This does not complete Blob. Custom inspection remains missing (unchanged
upstream test-blob.js fails there after this slice); exotic Blob subclass
metadata and mutable native-style handle properties, full clone/transfer,
stream behavior, complete encodings, object URLs, GC/OOM/large allocation,
realm/worker/four-host and prototype-mutation behavior need further work or
identified-artifact validation. No remaining gap is an accepted exclusion.
