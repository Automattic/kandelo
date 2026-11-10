# SpiderMonkey For Kandelo

This package is the first SpiderMonkey port target for Kandelo. It builds the
upstream SpiderMonkey JavaScript shell from Firefox ESR as `js.wasm`.

Current scope:

- standalone SpiderMonkey shell (`js -e 'print(1+1)'`)
- wasm32 POSIX cross-build through `wasm32posix-cc` / `wasm32posix-c++`
- ECMAScript `Intl` support through Mozilla's in-tree ICU/ICU4X
- JS shared memory and shell worker support
- JIT disabled and C++ exceptions enabled
- normal Kandelo fork instrumentation after the final `wasm-opt` pass
- JS `worker_threads` support through clone/pthreads

Not yet provided or validated:

- a complete Node-compatible embedding
- execution of the complete unchanged upstream Node core library
- npm / Express / Claude Code validation
- JS-facing nested WebAssembly compilation, which currently requires a
  SpiderMonkey wasm JIT backend while this package builds with JIT disabled

The upstream-first Node runtime remains work in progress on top of this engine.

Build:

```bash
bash packages/registry/spidermonkey/build-spidermonkey.sh
```

Resolver build:

```bash
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run -p xtask --target "$HOST_TRIPLE" -- build-deps resolve spidermonkey
```

## Upstream Node compiler foundation (source candidate)

The upstream-first restart imports unchanged Node core JavaScript under
`third_party/nodejs/`. The recipe now stages the immutable registry and native
compiler consumer into the actual Mozilla shell source list. It builds the
logical wrapper metadata with original Node C++ code and verifies source hashes
before generating the private include. The new host `clang++` input is declared.

This wiring has not been built as a guest package. The existing compatibility
bootstrap remains active; no upstream Node bootstrap, complete module support
or four-host startup is claimed. No full product rebuild or ABI change is part
of this source change. See `docs/nodejs-upstream-runtime.md` and the per-family
implementation ledger for the remaining state, binding and engine work.
