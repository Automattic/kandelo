# Buffer JSON and view ownership

The existing byte installer now consumes one complete unchanged pinned
Buffer.toJSON/adjustOffset/subarray/slice source section. JSON uses actual
intrinsic typed length and indexed bytes, with type Buffer. Subarray creates
an actual FastBuffer view of the selected real backing allocation without
TypedArray species/constructor dispatch; slice intentionally calls its public
subarray method as pinned. Public buffer/byteOffset access and offset coercion
order remain exact; this is not an intrinsic-hardening rewrite of Node source.
Assignment-created descriptor flags are preserved by retiring old class methods
before installing the selected algorithms. Existing Buffer.Symbol.species
constructor owner was already present and is not duplicated.

Fourteen differential groups and unchanged test-buffer-slice.js/tojson.js
execute actual generated factories with native allocation/alignment/detach-key,
warning/brand dependencies explicitly supplied by node-buffer-pool.cjs.
Those native dependencies do not establish guest engine or four-host behavior.
Initial authored test-driver syntax failure and baseline mismatches remain in
the sealed handoff. No test assertion/source pin/ABI change is supplied.
Other Buffer overloads, codecs/transcode, constructor/pool/transfer/GC/realm,
concurrent/shared storage and actual identified guest validation remain open.
