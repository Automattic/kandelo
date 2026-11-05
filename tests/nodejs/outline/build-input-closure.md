# Shared Node core build inputs

At source120, the engine recipe added309 core inputs: 308 existing
source/reference/license files and the new input guard. The earlier static
inventory identified 305 files; a conservative scan also found the domain,
network-IP and TLS identity adapters. That checkpoint guarded601
files, including already-declared production owners and references. Source121
adds the warning owner/references; that checkpoint guarded606 files. Source122 adds path/glob references and
owners; the current guard covers614 files.

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
