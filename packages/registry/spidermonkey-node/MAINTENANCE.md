# Maintaining the Node port

The current simplification and develop reconciliation are unbuilt and untested,
at the user's request. Earlier first-iteration results remain attached to their
original artifacts. The complete 19-family port and B6 catalog/roadmap review
remain unfinished. See [current scope](README.md#current-scope).

## Source ownership

| Package | Responsibility |
| --- | --- |
| `node-core-source` | Pinned upstream Node archive; no checked-in source tree or generated inventory. |
| `spidermonkey-core` | Pinned Mozilla archive, complete `base-patches/` then `patches/`, static engine and matching headers. |
| `spidermonkey-node-bridge` | Production `src/`, source preparation tools and complete portable native source adaptations. Preserve V8-shaped interfaces with real SpiderMonkey values, realms, roots and callbacks. |
| `spidermonkey-node` | Original Node configure/GYP, full registration lists, Environment, startup, loaders and native policy. Builds the default executable once. |
| `node` | Existing package ID forwarding the already-built executable; no second compile. |
| `spidermonkey-node-features` | Separate upstream experimental QUIC/DTLS build profile; compilation does not establish feature conformance. |
| `node-browser-bundle` | Normal installed executable/symlink, unchanged bundled npm and lazy archive. |
| `node-native-lifetime-tests` | Unshipped native lifetime companion; no production fallback. |
| Shared libc/kernel/host packages | General guest OS behavior, process/thread/resource retirement and host parity. |

The standalone SpiderMonkey shell retains develop's implementation. The rejected
Node frontend, its probes and its private dependencies are preserved in local
recovery snapshots rather than retained in the production source tree.

The bridge's `contracts.json` assigns roles and protecting consumer contracts to
its actual staged files. The inventory tool records production patch and source
identities; generated release receipts belong outside maintained source.
An inventory or source compilation does not certify every method in a file.

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
