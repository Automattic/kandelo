# Node package alias

This retains the existing `node` package ID by copying the already-built
`spidermonkey-node` executable. It does not configure or compile a second runtime.
The normal browser bundle installs one `spidermonkey-node` executable and a real
`node` symlink. See [the port](../spidermonkey-node/README.md) for source ownership,
build instructions and compatibility limits.
