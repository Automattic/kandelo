# Go toolchain

The Kandelo shell mounts this package under `/usr`. The `go` command at
`/usr/bin/go` points into `/usr/lib/go`, which contains the matching
`compile`, `asm`, and `link` executables, standard-library build inputs for
`kandelo/wasm32`, and
assembler headers. The shell loads the archive when a program first opens
one of its files.

The host SDK installer and this package use the same
[upstream pin](build.toml) and [patch series](../../../sdk/go/patches/).
The native Go compiler in Kandelo's pinned development shell bootstraps
the patched compiler, which cross-builds the guest tools.

See the [guest quickstart](../../../docs/go.md#build-inside-kandelo) for
offline pure-Go builds. The package targets `kandelo/wasm32` and ships
the tools for `go build`. Automatic toolchain switching requires a
Go process-replacement implementation for Kandelo. Use `GOTOOLCHAIN=local`.

From the repository root, use `./run.sh partial shell go-toolchain` for a
development image or `./run.sh local-build` for the canonical shell.
