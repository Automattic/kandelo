# Upstream builtin compiler foundation

`builtin-compiler.cpp` supplies separate native compilation paths for complete
upstream function bodies and real source-text module records. It consumes the
immutable registry in `third_party/nodejs/native/`. It neither evaluates code
nor implements an alternative module cache, bootstrap policy or public API.

The caller must enter the correct realm and immediately root the returned
function/module. Function bodies use upstream's exact admitted parameter list,
an empty environment chain, an anonymous function and the original diagnostic
origin. SpiderMonkey140 inserts one newline before the function body; options
start its synthetic wrapper at zero so the original body starts at line one.
Source-text modules have no wrapper and start at line one. Both paths pass the
complete UTF8 buffer and explicit byte length to the actual engine compiler.
Errors propagate; no substitute function/module is returned on failure.

Origins, kind names and argument vectors are static admitted metadata. The
helper introduces no std::string/vector allocations into the engine entrypath.
The metadata build tool reuses original Node C++ classification instead of
replicating source-kind policy in Python or JavaScript.

The normal Mozilla package now compiles and links these translation units.
Privileged JS-shell controls execute all three complete original context
initializers, then the complete original `internal/bootstrap/realm` body.
The normal Node entrypath still uses the existing compatibility bootstrap.

`per-context.cpp` privately owns the runtime symbol inventory, per-global
primordials, context exports and the realm-library owner. `realm.cpp` publishes
that owner before any original JavaScript executes and records terminal
initialization failure without replacing it on retry. Its native builtins
binding invokes the immutable compiler and retains the actual loader closures
registered by upstream JavaScript. The original `BuiltinModule` owns the only
module cache, exposure policy and builtin facade path. Native records and
function slots trace their owners; no host Node builtin supplies guest behavior.

The process object has its own mutable prototype and native empty-instance
constructor. A runtime-owned live Int32Array supplies the original exit-info
fields to every realm process through the canonical hidden key. Exit dispatch
is not connected yet. The initial process object reads guest `uname`, `getpid` and `getppid` through
libc and kernel syscalls. Its process methods/configuration remain partial.
The native config binding reports actual engine/build policy, uses the guest
engine locale and leaves unimplemented FIPS semantics explicit. The eager
realm binding closure and config are admitted; util also exposes the original
exit-info field indices. Native principal-node invocation uses protected
process/loader/primordials slots, preserves the actual failure, and makes a
failed environment terminal. Completing that body alone will not mark full
Realm bootstrap complete. Unsupported native bindings and missing
metadata/cache/source-text operations raise explicit implementation errors.
A compilation-event diagnostic list does not stand in for native cache usage.

See `tests/nodejs/upstream/realm-library-contracts.md` and its engine receipt
for the current boundary. Realm-library readiness is distinct from principal
bootstrap completion: `internal/bootstrap/node`, web/thread/ownership switches,
process environment and user CJS/ESM entrypaths still need their real native
backends and lifecycle. No full-product, successor-ABI, browser, fork or overall
suite claim follows from these focused controls. Do not wire placeholder
bindings merely to advance bootstrap.

`timers.cpp` owns the actual environment timer deadline, reference state,
shared info arrays and traced callbacks. Its opt-in shell-loop path uses guest
CLOCK_MONOTONIC and actual engine checkpoints, bypassing public compatibility
timer hooks. Native callback-scope/async/tick/fatal recovery and complete Node
phase ordering remain separate unfinished contracts. This backend does not
implement JavaScript timer lists; those belong to unchanged internal/timers.
