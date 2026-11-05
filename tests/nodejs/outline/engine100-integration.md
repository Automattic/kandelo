# Targeted engine100 and source101 followup

The normal resolver builds wasm32 engine100 successfully with the pinned
Node26.13.0 ncrypto dependency and OpenSSL3.5.9. The declared `js.wasm`
output is 49,560,409 bytes, SHA256
`d514069f1d4b95dccf7cf3995456703b1eed775fbdb13f7a023b1cbd0b19edf9`.
The build receipt, selected prebuild source identities verified unchanged
after compilation, exact logs, source preimages and output are retained in
`.context/node26-engine-r100-accepted/`. This is selected engine evidence,
not a full immutable kernel/SDK/host source closure or four-host conformance.

This build compiles the previously uncompiled97 metadata,98 synchronous
filesystem,99 promise-write and100 native-key source. A subsequent JS-only
source101 comparison dependency correction remains uncompiled. Earlier
source-stage statements remain historical and are superseded only for
these compiled source bytes; their API/runtime obligations are not closed.

The first100 engine attempt failed on a wrong ncrypto helper name and a
netdb macro collision introduced by the custom shell include order. Both
were corrected; failed source and logs remain in
`.context/node26-engine-r100-failed-r1/`. Native key material, new public JS
wrappers and selected regressions have separate scoped evidence in
[key ownership](key-implementation-dependencies.md).

The guest integration runner launched zero cases: current artifact policy
rejects the retained old kernel. The attempt is recorded in
`.context/node26-engine-r100-controls-r1/report.json`. Its preparation
failure is an unresolved harness/artifact prerequisite; zero failures and
zero passes do not establish compatibility. An earlier import failure was
resolved by installing the existing locked host dependencies. No rejected
artifact was loaded directly, admitted, restamped or retagged.

The normal instrumenter log also retains its compiler-facts hash-mismatch
notice and use of its bounded native baseline. No validation bypass was
introduced. No full product image/kernel/host rebuild, overall suite, merge,
publication or deployment was performed. Later guest validation needs an
admitted identified kernel/image and the source101/102 comparison/HKDF followups; any full
product rebuild remains deferred and must be reported before proceeding.
