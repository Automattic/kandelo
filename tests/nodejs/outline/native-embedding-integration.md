# Native embedding integration

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).
Sync whole-file ownership: [source98 scope](file-sync-implementation-dependencies.md).
Promise write/append ownership: [source99 scope](file-promises-implementation-dependencies.md).

This shared build prerequisite cuts across the partial implementation
families. It does not close any public API finding.

The normal wasm32 package build at recipe 60 found six actual JSAPI C++
errors. Rooted string handles and the supported cross-realm value wrapper
addressed those errors in recipe 61. That retry compiled and linked the
C++ changes, then failed the unchanged Mozilla include checker. Neither
failed attempt produced an accepted engine package. Their reports and
logs remain under `.context/node26-engine-r60-failed` and
`.context/node26-engine-r61-failed`.

Recipe 62 declares `generate-native-embedding.py`. It assembles the twenty
existing shell-private native fragments in dependency order into one unity
source, rather than depending on scattered `.cpp` includes. Function and
class bodies remain byte-identical after relocating literal includes and
the explicit SQLite session feature preamble. Conditional fragment
includes are rejected for review rather than lifted across feature gates.
Four shell helper declarations decouple native consumers from their later
definition positions. Portable header aliases are translated to canonical
Mozilla paths only in the private staging tree. Owned header preambles are
ordered; pinned upstream algorithms and checker expectations are unchanged.
Patch 74 changes the shell integration and four engine include groups.

Source evidence:

* `.context/node26-native-integration-checks/report.json`: exact twenty-body
  correspondence, declared inputs, target/audit identity checks, bundle
  generation check, shell syntax, and patch application/reversal with zero
  fuzz. This is source evidence, not guest conformance.
* `.context/node26-engine-style-check-r3.log`: the original Mozilla checker
  passes on the private prepared source tree. Its bytes match the pinned
  Mozilla source archive. Earlier failed preparation/check logs are retained.
* `.context/node26-native-integration-main-fetch.log`: origin/main fetched
  again; the branch remained fifty commits ahead and zero behind at this
  checkpoint. Unrelated dirty work was preserved.

An accepted package build, native resource/GC/realm/lifecycle behavior and
four-host guest validation are separate gates. Overall suites and the full
product rebuild remain deferred. Existing focused native controls do not
become guest passes when this build integration succeeds.

The normal revision 62 build then exposed an implicit prerequisite in the
generated SQLite constants header: it had relied on sqlite-store.h being
included first. Its own generator now includes sqlite3.h directly. The
revision 62 failed log/report and exact verified-frozen source identities
remain in `.context/node26-engine-r62-failed`. Revision 63 includes this
header dependency and the separate bounded async source fixes. The
unchanged checker still passes; package acceptance remains a separate gate.

## Accepted targeted package

The normal resolver build of revision 63 succeeded (job
`node26-core-engine-r63-1104-135202-6609`, exit zero, 215 seconds).
Mozilla's unchanged include, macroassembler and opcode checks passed;
Wasm optimization and fork instrumentation completed. The resulting
js.wasm/node.wasm are byte-identical, 47,771,809 bytes, SHA-256
`7340bf6ac00fdacc0fc74aab79d59f7b9760c535af46bfc9c1caf636e4d04a1e`.
The log, both executable copies, frozen source input identities and report
are retained in `.context/node26-engine-r63-accepted`. All 505 selected
source identities matched after the build. This is an accepted targeted
wasm32 engine artifact, not a full product image or guest runtime result.

Earlier "uncompiled" statements in historical dependency-slice records
describe those earlier checkpoints. This package now compiles the current
shared native bridge; GC/realm/resource/worker behavior and four-host
execution remain unvalidated. No full SDK/toolchain/dependency closure is
claimed by retaining this executable. Overall suites and the full product
rebuild remain deferred; the breadth-first implementation pass is unfinished.

Revision 64 subsequently compiled and linked the real typed directory scan
and readdir work owners. Its normal targeted wasm32 build passed the same
unchanged upstream checks, optimization and fork instrumentation. The
identified executable/report are in `.context/node26-engine-r64-accepted`;
see the readdir dependency record for the source/evidence scope. This does
not add guest execution or four-host conformance evidence.

Revision 65 subsequently compiled the incremental Hash/Hmac context owners,
exact native encoding parser and pinned public/stream classes. Its normal
wasm32 resolver build succeeded in 223.4 seconds; unchanged upstream checks,
optimization and fork instrumentation passed. Both retained executables are
47,838,056 bytes, SHA-256
`80dbb6085fa800a3f45e04403cc3f520058c4fa84b0babfbde229fa9e413b6b4`.
All 538 frozen source identities matched at build completion. The report and
artifacts are in `.context/node26-engine-r65-accepted`; the incremental-crypto
dependency record keeps real key/provider/GC/realm/backing-store and four-host
requirements open. No guest execution or full product rebuild occurred.

Revisions 66 and 67 compiled the persistent Dir cursor/resource/work and public
queue/iteration/disposal owners. Revision67 adds the interrupted-batch retry
reproduced by a retained native fault control. Its normal wasm32 build passed
unchanged upstream checks, optimization and fork instrumentation in 240.2
seconds. Both executables are 47,867,830 bytes, SHA-256
`07ca8793960ac38506d8bc89f1315efeb1c4e7645f8625a2952fcbf194efdf23`.
All 554 frozen source identities matched; identified reports and binaries for
both builds remain retained. No guest execution or four-host conformance is
claimed. See dir-implementation-dependencies.md for resource/GC/ref/permission/
VFS/realm/OOM and public lifecycle requirements that remain open.

Revision 68 subsequently succeeded through the normal targeted wasm32
resolver build in 227.0 seconds. All 578 frozen selected inputs
matched. Unchanged upstream checks, optimization and fork instrumentation
passed. Both executable copies have 48,032,973 bytes and SHA-256
`47697096864eea483587644b7d54f01865600ff0b6a79e5c9f706fa2ab815ab9`. The retained report/artifacts are
in .context/node26-engine-r68-accepted. Revision68 integrates the actual package parser/cache owner. 
No guest API/four-host execution or full product rebuild is established.

Revision 69 subsequently succeeded through the normal targeted wasm32
resolver build in 225.1 seconds. All 588 frozen selected inputs
matched. Unchanged upstream checks, optimization and fork instrumentation
passed. Both executable copies have 48,039,614 bytes and SHA-256
`50fa90b3349d9935e927d086bf1280174d26dfa44050c5182e462a7f9716d920`. The retained report/artifacts are
in .context/node26-engine-r69-accepted. Revision69 integrates live TLS metadata and actual verification results. 
No guest API/four-host execution or full product rebuild is established.

Revision70 subsequently succeeded through the normal targeted wasm32
resolver build in 244.5 seconds. All 596 frozen selected source
identities matched. Unchanged upstream checks, optimization and fork
instrumentation passed. Both executable copies have 48,049,967 bytes,
SHA-256 `8d06bafbe5274aad7ef160f0c31f422869d2f8e11e9787d4fcaa2496bd353a4c`.
.context/node26-engine-r70-accepted retains logs/artifacts/identities. This
compiles the public Buffer/pool, native zero-fill and permanent engine
ArrayBuffer restriction owners; it does not establish guest API/four-host
behavior. No full product rebuild occurred.

Revision71 subsequently succeeded through the normal targeted wasm32
resolver build in 193.3 seconds. All 612 frozen selected source
identities matched. Unchanged upstream checks, optimization and fork
instrumentation passed. Both executable copies have 48,138,366 bytes,
SHA-256 `1ef32c69dc79e8795285f23456b39efaff81ff744b371b2c6036856e6c51013e`.
.context/node26-engine-r71-accepted retains logs/artifacts/identities. This
compiles the public Buffer/pool, native zero-fill and permanent engine
ArrayBuffer restriction owners; it does not establish guest API/four-host
behavior. No full product rebuild occurred.

Revision72 succeeded through the normal targeted wasm32 resolver build in
320.1 seconds. All 618 frozen selected source identities matched.
Unchanged upstream checks, optimization and fork instrumentation passed.
Both executable copies have 48,439,632 bytes, SHA-256
`4ad8d26aa208aed216222e74a87e896a7c8cd4b16f322ff92cd0070e399f6808`.
.context/node26-engine-r72-accepted retains logs/artifacts and the actual
SDK-built c-ares dependency receipt/archive. The first attempt failed before
compilation because its existing make declaration lacked version_constraint;
its log/input snapshot is retained. This compiles actual channel/query/record/
external-work binding source, not guest API/four-host behavior. No full
product rebuild or overall suite occurred.

Revision75 compiled actual owned engine message packets, native close
acknowledgement and the production DNS/message adapter links through the
normal targeted wasm32 build in 195.2 seconds. All
621 frozen selected source identities matched; unchanged
Mozilla checks, optimization and fork instrumentation passed. Both executable
copies have 48,445,081 bytes, SHA-256
`540ad1d05828e229948f6f8366a95348b7809eb5899a6bca6c6ab2bdce930ea4`.
.context/node26-engine-r75-accepted retains logs/artifacts and reused c-ares
provenance. This is compilation, not full guest/four-host conformance. No
overall suite or full product rebuild ran.

Revision76 compiled pinned process-usage algorithms and the actual nominal
engine GC-budget read through the normal targeted wasm32 package build in
240.0 seconds. All 626 frozen selected source identities matched.
Unchanged Mozilla checks, optimization and fork instrumentation passed. Both
executable copies have 48,450,858 bytes, SHA-256
`cbe8f517e6adf76938a505f7cc5d91083c3c1f8602fda917a931468cbcdbc491`.
.context/node26-engine-r76-accepted retains exact artifacts/logs/dependency
provenance. Numeric guest process/heap/report/space owners remain missing;
no overall suite/full product rebuild or four-host completion is established.

Engine78 compiled ordinary VM globals/per-runtime security callbacks and
preceding HTTP77 JS through the normal targeted wasm32 resolver in
221.4 seconds; all 634 frozen selected inputs matched.
Unchanged upstream checks, optimization and fork instrumentation passed. Both
executables have 48,473,623 bytes, SHA-256 `93183f9d39f108fb5a2c1ae8b19c622a059cd267a3eb3f5bc228c8228d5d54e1`.
Accepted artifacts/logs/reused dependency provenance are in
.context/node26-engine-r78-accepted. Narrow Node-host VM guest outcomes remain
separate from complete VM/HTTP/worker/ABI/four-host conformance.


Engine83 compiles real Worker context/bootstrap/data/packet/endpoint/stop/join/
ref ownership, with patches86–88. All 641 frozen inputs match. Build time
200.1 seconds; 48,507,564 executable bytes, SHA-256
`a3679d830e4784e2af934c04c25c68a508ce5931ff321eb98b00b9c2dd1e52e7`. Exact accepted artifacts/logs/reused
c-ares receipt and source copies are in .context/node26-engine-r83-accepted.
Six identified Node-host guest cases pass; earlier79 compiler and80/81/82 guest
startup failures remain retained. No complete Worker/options/ABI/four-host
conformance follows. Subsequent recipe84 testing source remains uncompiled.

Engine88 native SQLite/control/session/virtual-property and idle/CLI integration
accepted in 247.7 seconds with 652 frozen selected inputs.
Executable bytes 48,737,580, SHA256
`c96179526eb5a206e8ea9295f9d460583d7c4ac9008eb5992404da3d7a8ed2fa`. Exact artifacts/source/logs and real
SQLite/c-ares dependency receipts: .context/node26-engine-r88-accepted.
Engine85 style failure and engine86 guest activation/exit nonpasses remain
retained. Narrow current Node-host outcomes are separate from full API/ABI/
four-host conformance; no overall suite/full product rebuild.
