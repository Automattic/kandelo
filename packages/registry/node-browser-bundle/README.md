# SpiderMonkey Node runtime bundle

This package produces `spidermonkey-node.zip`, served through the package
resolver at `programs/wasm32/spidermonkey-node.zip`. The shell lazily mounts
its contents at `/usr/` on first use.

The archive contains the real `bin/spidermonkey-node` executable, a relative
`bin/node` symlink, the native Amaro and Undici helpers, and upstream npm.
The archive name identifies the engine; the `node` command preserves standard
shebangs and npm compatibility.

Build a focused image with `./run.sh partial shell node-browser-bundle`.
See [npm regressions](test/README.md) for the maintained package checks.
