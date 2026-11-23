# Maintaining the Node port

The current consolidation and develop reconciliation are unbuilt and untested,
at the user's request. Earlier first-iteration results remain attached to their
original artifacts. The complete 19-family port and B6 catalog/roadmap review
remain unfinished. See [current scope](README.md#current-scope).

## Source ownership

| Package | Responsibility |
| --- | --- |
| `node-core-source` | Pinned upstream Node archive; no checked-in source tree or generated inventory. |
| `spidermonkey-core` | Pinned Mozilla archive, complete `base-patches/` then `patches/`, static engine and matching headers. |
| `spidermonkey-node/bridge` | Internal source preparation, V8-shaped interfaces over real SpiderMonkey values, roots and callbacks, and complete native source adaptations. This is part of the Node recipe. |
| `spidermonkey-node` | Original Node configure/GYP, full registration lists, Environment, startup, loaders and native policy. Builds the internal bridge once, then default and experimental executables as two outputs of this recipe. |
| `node` | Existing package ID forwarding the already-built executable; no second compile. |
| `node-browser-bundle` | Normal installed executable/symlink, unchanged bundled npm and lazy archive. |
| `node-native-lifetime-tests` | Unshipped native lifetime companion; no production fallback. |
| Shared libc/kernel/host packages | General guest OS behavior, process/thread/resource retirement and host parity. |

The standalone SpiderMonkey shell retains develop's implementation. The rejected
Node frontend, its probes and its private dependencies are preserved in local
recovery snapshots rather than retained in the production source tree.

The internal bridge's `contracts.json` assigns roles and protecting consumer contracts to
its actual staged files. The inventory tool records production patch and source
identities; generated release receipts belong outside maintained source.
An inventory or source compilation does not certify every method in a file.

For the reviewed cleanup designs, Node and reused upstream algorithms must use
the maintained bridge abstraction. SpiderMonkey object hooks, concrete engine
types and engine-specific lifetime operations belong in the bridge implementation,
not direct calls from Node policy code. Generic engine hooks must remain free of
Node-specific policy. This is the required design boundary, not a claim that every
current adaptation has already been brought into alignment.

## Reduced private-data and job boundary

Context metadata lives in a global application slot, so GC-sensitive native
lookups need no property resolution, allocation or user JavaScript. Private
object entries live in an engine-owner weak map; their bags may refer back to
the object without rooting an otherwise unreachable cycle. Proxy identity stays
separate from its target. Template-private entries are installed separately
from public properties. Native fields and Node cleanup retain their owners.

The bridge owns the continuation value and captures/restores it through the
original job host-data API. A small generic engine option retains host data for
optimized reactions. Retire its native roots before destroying the JSContext;
never run a second Environment shutdown from a GC finalizer.

Both profiles continue to disable Inspector and expose no SpiderMonkey
Debugger. `Promise::MarkAsSilent` therefore has no debugger action in this
profile; it must never mark a rejection handled. Inspector activation must
restore debugger-silence semantics alongside its debugging adapter.

Serializer buffer-growth/version-error adaptations are explicit in
`bridge/native-source-patches/0010-native-value-wire-safety.patch`. Preparation
still selects portable parts of the complete original unit and validates the
raw source and reversible patch. Source extraction or receipt generation is
not runtime qualification.

This review revision has not been built or tested. The existing dynamic-import
extension remains: ordinary engine completion cannot directly preserve
cross-compartment namespaces, Node-owned evaluation and attribute validation.
The proposed namespace API alone is insufficient. Any replacement needs a
complete review; earlier shipping results refer to earlier artifact identities.

Reconsider removing `0029-kandelo-node-dynamic-import.patch` on engine upgrades
if supported SpiderMonkey interfaces can preserve these contracts with less
maintained code. A replacement must preserve cross-context results, Node's
control over evaluation, import-attribute validation, promise/error behavior
and callback lifetimes without rewriting Node's JavaScript or relying on
engine internals through undocumented casts. Retaining the extension for this
cleanup does not make it a permanent requirement. Review the source boundary
and qualify affected imports on all four hosts before replacing it.

## Temporary native versions of Wasm helpers

Here, native means a guest C/Rust library loaded through normal `dlopen`. The
library still targets Kandelo's Wasm machine format; it replaces the helper's use
of WebAssembly execution inside guest Node. General guest Wasm remains later work.

| Helper | Maintained boundary | Migration back |
| --- | --- | --- |
| Amaro 1.1.11 | Preserve its complete upstream lazy JavaScript wrapper; `node-amaro` replaces the Wasm glue with a private native Rust backend. Node's availability check recognizes the native capability. | Qualify original Wasm imports, memory, exceptions and cleanup. Restore the upstream backend/check and retire the private library/ABI after default CJS/ESM TypeScript and lifetime acceptance on all four hosts. |
| Undici llhttp 9.3.1 | Isolated upstream C parser and real buffer/callback/cleanup glue, selected by one explicit JavaScript parser-factory change. Remaining Fetch code stays upstream. Node HTTP uses its own pinned llhttp 9.4.3. | Qualify original Wasm callbacks, memory growth/views, interruption and cleanup. Restore the original factory and retire the native binding after the same HTTP/HTTPS/body/redirect/stream/cancel/error/lifetime acceptance on all four hosts. |

Record any additional native helper's exact archive identity, source boundary,
dependency/lifetime owner, protecting tests and removal steps. These adaptations
do not establish general guest Wasm support. Shared platform fixes retain their
own owners when a helper is retired. Dependency consolidation is a later review.

## Engine patch follow-up

Track the retained engine patches through the
[platform-omission review](../spidermonkey-core/README.md#future-work-platform-omissions).
Each patch carries its own plain-language rationale. Provisional retention is
not proof that every hunk belongs permanently in SpiderMonkey.

## Review all retained port patches

Every added or modified patch file in this port carries a plain-language
justification and a source-review judgment. For the two existing Rust SDK patch
files, the judgment covers only this PR's changes, not their older hunks.
`Supported` means a concrete consumer and source contract justify the adaptation;
it does not prove minimality or runtime correctness. `Mixed` means the behavior
is needed but some placement or additional purpose is weakly justified. `Weak`
means the current patch's necessity or ownership is not adequately established.

- [ ] Extend the engine's platform-omission review to every retained Node,
  reused-native-source, libuv, Amaro, libffi, tracing and Rust SDK patch. Trace
  consumers and shared platform alternatives, and discuss every weak or mixed
  justification before adopting a cleanup. Correct OS/SDK omissions at their
  owner; keep Node policy in Node or its maintained bridge. Retain required
  behavior and review exact artifacts on all four hosts when validation is
  separately authorized.

This source review neither qualifies current artifacts nor authorizes removals,
behavior changes or a reduced compatibility scope. The complete 19-family port,
full conformance work and B6 review remain required.

- [ ] Design and qualify actual shared-GC value transfer as a separate capability
  follow-up. Cleaning up `SharedValueConveyor` move/destruction methods does not
  provide that support. Preserve its ownership interface for a future backend;
  the current bridge has no payload producer. A maintainable implementation is
  not yet established: review shared identity and mutation, worker concurrency,
  cross-runtime references and cycles, in-flight message roots, and collection
  when either worker exits. Do not substitute ordinary cloning or pass raw GC
  pointers between independent SpiderMonkey runtimes. Retaining this gap in the
  roadmap is not approval to exclude it from the complete compatibility review.

## Upgrade procedure

1. Preserve the current source, exact artifact identities, test inventories and
   failure logs. Identify the person responsible for the upgrade.
2. Authenticate upstream archives and compare Node startup, loaders, Environment,
   registration lists, parser diagnostics, contextification, GC and dependencies.
3. Apply both complete engine patch directories in their build order. Apply the
   Node and native-source chains to fresh upstream files. Review every conflict;
   reject failures, fuzz and offsets. Preserve upstream algorithms and structure.
4. Review each changed bridge operation alongside its Node callers. Generate
   metadata from the verified archive in the build directory. Keep ownership of
   Node policy with Node; do not add another loader, timer queue or process owner.
5. Build normal default and feature profiles through the declared dev shell and
   package pipeline. Preserve registration lists and collect complete related
   compiler/linker failures before changing inputs and retesting.
6. Bind acceptance to the resulting executable, providers, kernel, host and image.
   Keep Node, Chromium, Firefox and WebKit separate. Preserve distinct CLI,
   path/filesystem/timers, CJS and ESM gates, plus VM/REPL, JS/TS, npm, Fetch,
   lifetime and applicable memory tests. Keep finite budgets and failure counts;
   do not retry unchanged commands or widen deadlines.
7. Record failures, unrun cases, capabilities and limits explicitly. Source counts
   and builds do not establish module conformance. A shipping checkpoint requires
   the applicable tests on those exact artifacts; B6 is not full-port completion.

Preserve the agreed snapshot, addon, report, Inspector and general guest-Wasm
follow-ups. Meaningful changes to approved behavior, ownership, capabilities or
acceptance require explicit review; routine work inside those contracts does not.
