# Unfinished cached-module getter admission

cached() is the sole actual getExportsForCircularRequire caller and already
reads module.loaded to admit unfinished records. The private ESM adaptation
must inspect only the existing private format and must not reread that public
property. A second read can execute getters or throw after a valid admission.
The same explicit pending-ESM status failure remains an implementation gap.

loaded-getter-control.cjs accepts mode/native-or-candidate, scenario,
actual repo root and an existing private fixture directory containing
`target.cjs` with `module.exports={ready:1}`. Warm the actual relative cache
with the same createRequire parent, then observe accessor count, original
throws and exports-getter chronology. Candidate modes use the real generated
Module/cache/loader owner with explicit native VM/filesystem/URL/brand/warning
fixture dependencies. They are not guest conformance or ESM implementation.

The sealed correction evidence retains original double-read failures, checks
five native/candidate groups and separately checks the private pending-format
error owner. There are no assertion/selector/upstream-source changes, ABI/pin
changes or new native registrations. Guest proxy/realm/warning/ESM/four-host
validation and broader loading gaps remain open.
