# CommonJS Module record and require owners

This source slice addresses parts of L-005/L-006/L-008/L-026/L-027. It does
not close those findings or the loading family. The audited Node 26.13.0
target and its immutable audit remain unchanged.

## Implementation and owning boundaries

module-record-platform-adapter.js selects target constructor, parent/accessor,
require-function, createRequire, lookup/global/node_modules path, load,
extension-selection and JSON algorithms. Private native parent/URL/format/
export fields use actual WeakMap owners instead of observable stand-in JS
Symbols. The manifest documents and hashes the original selections; build.py
checks every specific private-field transformation. Constructor shape and
parent descriptor/storage are compared against the exact native reference.

The ordinary CJS and JSON paths create real Module instances, retain actual
parent/children links, share public cache/extension tables and remove both
cache and failed-parent links when compilation/execution fails. Cache reuse
updates the requiring parent's children without changing the first parent.
Module._load, module.require, extension handlers and the live _pathCache
affect actual loading rather than detached helper results. Prototype load
dispatches the longest registered suffix and records actual completion.

Pinned createRequire validates genuine URLs and absolute filename contexts,
including directory URLs/paths. The require factory exposes actual main,
cache/extensions, resolve options and lookup paths. Global paths derive from
the process prefix and genuine safe HOME/NODE_PATH queries; changing the
introspection clone does not silently mutate the private path list. Resolution
uses current parent.paths/options and real file/extension candidates, preserving
the requested trailing-directory distinction. Ordinary and node:-prefixed
builtins retain their distinct public-cache behavior. Missing-module stacks
come from the actual first-parent graph.

SafeGetEnvironment extends the existing native environment owner with actual
uid/gid admission and musl's secure_getenv/startup secure state. The mutex
protects copying from this bridge's environment mutations. Patch 65 selects
the action; recipe revision 47 binds the source change. No compiler, host,
syscall or kernel wire ABI is renamed or emulated. The JSAPI engine bridge
remains uncompiled. Native helper controls do not validate privileged guest
startup, auxiliary-vector/credential transitions or arbitrary native environ
mutation outside this bridge's mutex.

Module.parent uses the retained pending-deprecation wrapper and real safe
startup NODE_PENDING_DEPRECATION state. Full CLI option/config/worker warning
activation, origin/stack policy and preloading remain incomplete. isPreloading
currently describes the ordinary non-preload path; its accessor does not
establish support for --require preloads.

The separate Bun asset-dispatch block is retained verbatim. Its plain asset
records and legacy cache alias remain outside this Node CJS/JSON slice. No
Claude/npm/Bun package shim is changed or counted as Node compatibility.
Shared-loader consumer regression on rebuilt artifacts remains necessary.

## Scoped evidence

Focused controls run the actual record factories and bootstrap loader over
native Node VM/URL/filesystem/environment/brand boundaries. They compare
constructor/private storage, URL validation, graphs, failed-child cleanup,
real extension dispatch, compiler receiver/return, public overrides, lookup
options and missing/builtin errors. The existing entry/JSON/main tests and
process-state controls remain. These are neither guest native-loader tests
nor conformance evidence for Chromium/Firefox/WebKit.

Three unchanged upstream files cover createRequire, multibyte contexts and
_nodeModulePaths. Only the public Module namespace is replaced; the test
module, assert/common, compiler/filesystem/URL/environment boundaries stay
native. Their actual JSON fixtures and source identities remain pinned.
The ordinary native process-state helper also exercises the new safe getter;
this is not a privilege-transition or musl/guest bridge test.

Earlier failures remain preserved. The first entry run had four failures/
six passes because the isolated fixture had not initialized the real debug
logger. The first expanded run had three failures/eighteen passes: a missing
CHAR_DOT dependency, a cache assertion using noncanonical /tmp instead of
the actual realpath, and a test comparing a CJS fs object with an ESM
namespace. The source dependency and controls are corrected; no upstream
assertion or platform identity changes. Current logs/source identities and
historical inputs are recorded separately in implementation-state.json.

## Remaining source and validation work

* Package exports/imports/conditions/self-reference/maps, package JSON errors/
  cache/main warnings and full directory-main custom extension resolution
  remain legacy or missing. CJS lookup progress does not close L-003/L-004.
* Module.wrap/wrapper overrides, circular-export warnings, parser-based format
  detection, TS stripping, hooks, source maps/compile cache, native addons,
  preloads/CLI and exact diagnostics/inherited/internal symbol behavior remain
  incomplete. Public _compile supports the ordinary CJS path; explicit ESM/
  TypeScript source compilation fails instead of loading unrelated disk data.
  Invalid internal binding argument/termination policy remains unresolved.
* ESM URL/JSON/namespace identity, builtin synchronization, native status,
  static async-graph and cycle admission remain owning engine/loader gaps.
  An unfinished ESM record explicitly fails pending-status admission; it is
  never treated as successful empty CJS exports. This is not a completed
  ERR_REQUIRE_CYCLE_MODULE or require(esm) implementation. Existing lexical
  native registry keys remain until their real URL/realpath owner is fixed.
* Experimental Node VFS resolution roots are not implemented. Ordinary guest
  filesystem mounts still use the guest namespace; they are distinct from
  Node's experimental reserved VFS registration. Registered handler resolution
  fails visibly rather than advertising a fabricated root.
* Safe environment activation, global prefix metadata, realms, native compiler/
  dynamic imports, filesystem failures, GC/lifecycle and every host need
  identified-artifact evidence. Shared URL/path/encoding dependencies retain
  their own audit gaps. No family or current four-host conformance closes.

Continue independent stream/process/other audited owners before a larger
loader campaign. After the breadth pass, reconcile all original module/package/
language/returned-object obligations, then run unchanged applicable coverage
and native controls with full durable per-host outcome accounting.
