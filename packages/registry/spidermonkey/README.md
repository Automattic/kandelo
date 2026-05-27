# SpiderMonkey For Kandelo

This package is the first SpiderMonkey port target for Kandelo. It builds the
upstream SpiderMonkey JavaScript shell from Firefox ESR as `js.wasm`.

Current scope:

- standalone SpiderMonkey shell (`js -e 'print(1+1)'`)
- wasm32 POSIX cross-build through `wasm32posix-cc` / `wasm32posix-c++`
- ECMAScript `Intl` support through Mozilla's in-tree ICU/ICU4X
- JS shared memory and shell worker support
- JIT disabled and C++ exceptions enabled
- no fork instrumentation: SpiderMonkey's C++ control flow is too large for
  the current fork-stack rewrite in Chromium workers; JS worker_threads use
  clone/pthreads and still work

Out of scope for this package:

- a complete Node-compatible embedding
- vendored npm-scale Node builtin modules
- npm / Express / Claude Code validation
- JS-facing nested WebAssembly compilation, which currently requires a
  SpiderMonkey wasm JIT backend while this package builds with JIT disabled

Those live on top of this engine port after the shell is green.

Build:

```bash
bash packages/registry/spidermonkey/build-spidermonkey.sh
```

Resolver build:

```bash
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run -p xtask --target "$HOST_TRIPLE" -- build-deps resolve spidermonkey
```
