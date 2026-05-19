# Tests

External and generated conformance test trees live here.

- `libc/` contains the musl libc-test submodule, Kandelo overlays, and build
  outputs.
- `packages/` contains package integration harnesses and fixtures that exercise
  kernel behavior through real ported software.
- `posix/` contains the Open POSIX test suite.
- `sortix/` contains the Sortix os-test submodule and build outputs.
- `results/` stores local test-run metadata.

Test runner scripts stay in `scripts/` so CI and local workflows have stable
entry points.
