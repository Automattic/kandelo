# Upstream Node.js on SpiderMonkey

This port builds pinned Node.js 26.13.0 with SpiderMonkey 153.7 ESR through Node's
original configure/GYP build, startup, Environment, loaders and native policy.
The default runtime is installed as `/usr/bin/spidermonkey-node`;
`/usr/bin/node` is a relative symlink. Bundled npm remains upstream.

## Source and package ownership

`node-core-source` declares the upstream archive URL and SHA-256. The normal
resolver downloads/verifies it; recipes stage private copies below their work
roots. No upstream Node checkout or generated execution reports are vendored.

- `spidermonkey-core`: the standalone engine and reviewed engine patches.
- `bridge/`: this package's internal engine adapter, source preparation tools,
  source contracts and native lifetime interfaces.
- This package: Node's original build, target/engine patches, provider setup and
  the approved native Amaro/Undici bindings.
- `node-browser-bundle`: installed names, unchanged npm and lazy archive.
- `node-native-lifetime-tests`: maintained native GC/callback/cleanup controls.

Dependencies use the pinned isolated Node builds. See [maintenance](MAINTENANCE.md)
for source boundaries, dependency owners and upgrade procedure. Native Amaro and
Undici are temporary alternatives to their upstream Wasm helpers; migrate back
once general guest Wasm support has been designed and qualified.

## Build and test

Run through `scripts/dev-shell.sh`. A focused package/image build is:

```sh
./run.sh partial shell node-browser-bundle
```

The normal canonical build is `./run.sh local-build`. This recipe builds both
`node.wasm` (default) and `node-features.wasm`
(experimental QUIC/DTLS). The bridge is built once and shared by both internal
configurations. Normal packaging installs only the default executable; compiling
the experimental output does not establish feature conformance.

[Maintained npm regressions](../node-browser-bundle/test/README.md) run offline
and controlled-registry installation, lifecycle execution, CJS/ESM package use,
lockfiles, cache-only installation, executable links and process/thread/session
retirement separately on Node, Chromium, Firefox and WebKit. They also verify
both installed command names and the real symlink. Native lifetime controls are
owned by [node-native-lifetime-tests](../node-native-lifetime-tests/README.md).

## Current scope

The last qualified first iteration passed separate four-host CLI55, original
path/filesystem/timers11, CJS7, ESM9, VM18, controlled HTTP/HTTPS Fetch8, native
lifetime20, parser lifetime5, Worker retirement1 and npm10 cases per host.
Normal-app JS/default TypeScript, REPL/await, Fetch and npm checks passed on all
three browser engines. Exact artifacts and full receipts remain in the preserved
local shipping checkpoint; these are bounded results, not module conformance.

The current consolidation and develop reconciliation are unbuilt and untested,
at the user's request, for source review before further qualification. Prior
results are not results for this source update. Historical research, probes and
reports remain preserved locally. The older frontend is absent from the port.

All 19 core families remain required and unfinished. The B6 complete catalog and
roadmap review still gates later activation. RSS reporting currently reaches
ENOSYS. Inspector, native addons, diagnostic reports, startup heap snapshots and
general guest Wasm retain their agreed follow-up work. Public browser networking
uses Kandelo's existing Internet bridge; controlled guest TLS has separate
coverage. Native Safari and broad upstream core/POSIX suites remain unrun.
Existing saved computer filesystems are not automatically migrated.
