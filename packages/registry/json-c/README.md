# json-c

The package builds upstream json-c 0.19 as a static library through its CMake
build and the Kandelo SDK. Sway uses it for IPC JSON messages.

The release carries `patches/0001-free-containers-outside-assert.patch`.
Upstream's iterative `json_object_put()` performs its final container-freeing
call inside `assert()`. With `NDEBUG`, that call disappears, retaining the
container and its owned storage. The patch always evaluates the call and keeps
the invariant assertion. It changes no JSON ownership or public API contract.
Remove it when the packaged upstream release includes the correction.

A native release reproduction using the unmodified 0.19 source retains 200 JSON
objects after 100 releases of a root object containing a nonempty array. The
patched implementation retains zero. This reproduction does not run Kandelo.
To check a staged source tree with the package patch applied:

```sh
scripts/dev-shell.sh bash packages/registry/json-c/tests/check-release-free.sh \
  /absolute/path/to/staged-json-c /absolute/path/to/private-test-work
```

The test counts allocations from the real `json_object.c` translation unit and
calls the public `json_object_put()` API. It builds with `NDEBUG`; JSON output
or user-data callbacks alone would not prove that container storage was freed.
