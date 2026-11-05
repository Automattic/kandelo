# Native analysis regression expectations

Captured from the validated native source at `dc1f807eea` (before removing
Walrus), by running the adapted fixtures against an isolated copy of that
source. Each file names a test; section headers identify the variant and first 12
hexadecimal digits of the input SHA-256. Values are readable Rust debug output: original
function/byte coordinates, selected sets, reference liveness, facts reports,
scalar layouts and wire descriptors.

The tests only compare these files; they cannot update them. Review a changed
expectation against its WAT fixture and ABI/runtime behavior before replacing
it. Engine execution fixtures remain separate from these structural checks.
