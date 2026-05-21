# SpiderMonkey For Kandelo

This package is the first SpiderMonkey port target for Kandelo. It builds the
upstream SpiderMonkey JavaScript shell from Firefox ESR as `js.wasm`.

Current scope:

- standalone SpiderMonkey shell (`js -e 'print(1+1)'`)
- wasm32 POSIX cross-build through `wasm32posix-cc` / `wasm32posix-c++`
- ECMAScript `Intl` support through Mozilla's in-tree ICU/ICU4X
- JS shared memory and shell worker support
- JIT disabled, C++ exceptions enabled, fork instrumentation applied after
  optimization

Out of scope for this package:

- the Node-compatible embedding
- vendored Node builtin modules
- npm / Express / Claude Code validation

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
