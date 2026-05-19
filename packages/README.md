# Packages

Kandelo software package definitions live here. Packages are secondary to the
kernel, but this tree keeps the CI and shipped software story organized.

- `registry/<name>/package.toml` describes one buildable package, its source,
  license, dependencies, build script, and outputs.
- `registry/<name>/build-*.sh` builds the package for Kandelo.
- `registry/<name>/demo/` contains package-owned launchers, service configs,
  sample assets, and local demo helpers.
- `registry/kernel-test-programs/` describes the small wasm programs used by
  host/kernel smoke tests; the source files themselves live in `../programs/`
  and `../examples/`.
- `sets/*.toml` names product or CI scenarios that should be kept buildable as
  a group. These are advisory manifests today; automation can consume them
  once the package-set schema is wired into `tools/xtask`.

Package test harnesses and fixtures live in [`../tests/packages/`](../tests/packages/)
because they primarily validate kernel behavior against real ported software.
Root [`../examples/`](../examples/) is reserved for small kernel and SDK
examples.
