# Packages

Kandelo software package definitions live here. Packages are secondary to the
kernel, but this tree keeps the CI and shipped software story organized.

- `registry/<name>/package.toml` describes one buildable package, its source,
  license, dependencies, build script, and outputs.
- `registry/<name>/build-*.sh` builds the package for Kandelo.
- `registry/<name>/demo/` contains package-owned launchers, service configs,
  sample assets, and local demo helpers.
- `registry/<name>/test/` contains package-owned tests and fixtures. A package
  PR should be able to trigger these paths without treating the change as a
  host/runtime change.
- `sets/*.toml` names product or CI scenarios that should be kept buildable as
  a group. These are advisory manifests today; automation can consume them
  once the package-set schema is wired into `tools/xtask`.

Shared host/kernel test artifact inventories live under
[`../tests/test-artifacts/`](../tests/test-artifacts/), not in the package
registry.

Package-system tests that validate registry tooling rather than a specific
package live in [`../tests/package-system/`](../tests/package-system/). Root
[`../examples/`](../examples/) is reserved for small kernel and SDK examples.
