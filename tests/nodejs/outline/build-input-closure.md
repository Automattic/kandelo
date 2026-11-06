# Shared Node core build inputs

Source132 shares native string-byte primitives across JWK and hash/HMAC/cipher
updates. Original strings/encodings now reach native owned conversion;public
Buffer allocation cannot supply private native input.31root groups(including
96boundary cases inside one new group) and12package checks pass;the standalone
codec compiles to Wasm through the SDK. Private24,736byte/12,308affected-JWK/
226material results were identity-verified,not rerun. Actual native JSAPI and
combined117–132engine remain uncompiled;all19families partial. Overall suites/
full product rebuild stay deferred. See [private native bytes](private-byte-implementation-dependencies.md).


Source131 fixes receiver victim-root insertion with genuine own properties,
so inherited indexed setters cannot leak/drop roots or reenter before commit.
The NAPI packet fixture now mirrors production own-element definitions.
Original17matched public groups,2existing failure groups,4native/7candidate
prototype groups and12package checks pass;old receiver and old fixture fail
the new assertions as expected. Production JSAPI/combined117–131engine remains
uncompiled;all19families partial. Overall suites/full rebuild stay deferred.
See [indexed receiver ownership](worker-locks-prototype-fix.md).


Source130 removes public Buffer allocation/JavaScript callbacks from native
JWK byte ownership,preserves OOM/control failures,and roots material across
reentrant getters and foreign-handle realm access.20root key checks(including
one new callback-forbidding group) and12package checks pass. Source-identical
private evidence contains12,308codec and226material passes;those were verified
by source/dependency/binary identities,not rerun. Four unchanged files retain
6passes/2consumer nonpasses. Combined117–130engine/JSAPI remains uncompiled;
all19families partial. Overall suites/full product rebuild remain deferred.
See [JWK review fixes](jwk-review-fixes.md).


Source129 adds a real shared worker-lock manager,receiver-local waiting and
released Promises,transactional grant/steal delivery and fair native-provider
dispatch.17public groups match exact native26;2fixture failure groups,
38affected controls and12package checks pass. One unchanged upstream
lock-diagnostics file passes both dependency-fixture modes. Portable owners
also compile through the actual SDK. These are scoped source/native controls;
production JSAPI/guest/four-host behavior is unvalidated. Lazy native-data
properties,global Navigator routing and earlier compatibility gaps remain open.
All19families remain partial;overall suites/full rebuild remain deferred.
See [lock integration and limits](worker-locks-integration.md).


Source128 selects the copy owner’s reflink header by actual availability.
Targeted engine127failed on an absent linux/fs.h selected by the existing
package macro;it also recorded an unresolved SDK calltypes-plugin crash.
Both failures remain saved. The corrected header compiles through the actual
SDK in normal and legacy-macro control modes.20zero-directory controls and
12package checks pass;the43-case portable matrix retains1errno mismatch.
Accepted engine116remains stale;source117–128is uncompiled as a full engine.
All19families remain partial;overall suites/full product rebuild stay deferred.
See [copy ownership](copy-file-implementation-dependencies.md).


Source127 routes filesystem copyFile sync/callback/promise wrappers through a
bounded descriptor owner and the existing real FSReq queue. Actual O_EXCL,
inode checks before truncation,metadata/cleanup and S_IFDIR rejection replace
the whole-buffer copy.35frontend and12package checks pass;two unchanged
upstream files pass in both native-dependency modes. The portable owner passes
20zero-directory controls;its43-case matrix retains1directory errno mismatch.
Guest117–127source is uncompiled;accepted116is stale. All19families remain
partial;overall suites/full rebuild remain deferred. See
[copy ownership and open differences](copy-file-implementation-dependencies.md).


Source126 adds four complete RSA/EC key references. Current guard:621inputs;
12package-contract controls pass. Source closure is not runtime conformance.

Source125 adds two complete AsyncHook/internal registry references under the
declared async directory. Current guard:617inputs;12package-contract checks pass.
This source coverage does not establish implementation or runtime conformance.

Source124 adds one complete pinned ELU reference under the declared performance
directory. The current source guard covers615 inputs;12 fresh package-contract
checks pass. This is source coverage,not runtime conformance.

At source120, the engine recipe added309 core inputs: 308 existing
source/reference/license files and the new input guard. The earlier static
inventory identified 305 files; a conservative scan also found the domain,
network-IP and TLS identity adapters. That checkpoint guarded601
files, including already-declared production owners and references. Source121
adds the warning owner/references; that checkpoint guarded606 files. Source122 adds path/glob references and
owners; the current guard covers614 files. Source123 changes the existing key
material/dispatch/adapter inputs without adding new source owners;614 remain
guarded, with a fresh source check and12 passing package-contract controls.

`third_party/node-core/check-build-inputs.py` checks root production files,
recursive manifest file paths, literal Python generator paths, the native
unity fragment list and literal engine build-script paths. Declared resolver
directory inputs cover their real subtrees; an arbitrary string prefix does
not. Missing files and paths escaping the repository fail. Root production
owners are conservatively included even when a computed name prevents a
literal-read scan from finding their consumption.

The normal engine build runs this guard and `build.py --check` before staging
engine source. Changed adapters and verification references participate in
cache identity; a changed adapter with a stale checked-in bundle fails the
freshness check. The build does not regenerate checkout inputs. The guard
itself is declared so guard changes also invalidate the package cache.

The runtime recipe revision remains120: this slice changes declarations and
source preflight, not runtime output bytes. The content-addressed key changes
with those declared inputs and the build script. No published archive,
production index, durable generation, target pin or ABI was changed.

## Evidence and limits

`.context/node26-core-inputs-r4/report.json` records identities and source-only
commands. All 601 selected files are covered; bundle freshness and shell
syntax checks pass. Twelve package-contract checks pass, including actual
negative fixtures for omitted owners/references, missing unity fragments,
literal generator/shell inputs, traversal, directory matching and a stale
bundle. The stale-bundle check runs the real generator in an isolated copy
and verifies that rejection does not rewrite its bundle.

The initial missing-input inventory and failed Vitest invocation using the
wrong root-level executable path are retained. Corrected checks use the
existing host-local Vitest installation and exact pinned native Node26
reference through the declared development shell. No packages were installed.

This is not a dynamic read trace, a complete transitive SDK/toolchain closure
proof or evidence that earlier runtime failures came from stale artifacts.
New computed subdirectory reads or new build mechanisms still require review
and appropriate declarations. No source input guard establishes API support.

Source117–120 remains uncompiled; accepted engine116 is not current. The
prior terminal controls retain their original source/native boundary scope.
Cipher, SQLite, Error and compression nonpasses remain open. All19 families
remain partial. No new guest cases, overall suites or product rebuild ran.
