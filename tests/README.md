# Tests

External and generated conformance test trees live here.

- `libc/` contains the musl libc-test submodule, Kandelo overlays, and build
  outputs.
- `package-system/` contains tests for package registry and binary-fetching
  automation.
- `posix/` contains the Open POSIX test suite.
- `sortix/` contains the Sortix os-test submodule and build outputs.
- `test-artifacts/` contains explicit ownership manifests for shared
  host/kernel test artifacts that are not packages.
- `results/` stores local test-run metadata.

Package-owned tests and fixtures live beside their packages under
`packages/registry/<name>/test/`. Test runner scripts stay in `scripts/` so CI
and local workflows have stable entry points.
