# Native version of Undici’s Wasm parser

Temporary native build of the complete llhttp 9.3.1 C sources in pinned Node
26.13.0’s Undici. It is isolated from Node HTTP’s llhttp 9.4.3. Compilation
namespaces original identifiers; parser algorithms and callback settings stay
unchanged. The sole public entrypoint exposes a versioned private C ABI.

Node loads this library lazily through ordinary guest dlopen. Its private owner
traces callback/realm/buffer edges with Node’s cppgc lifetime methods and releases
parser allocations before the Environment disappears. Library code remains
pinned through process/TLS retirement. No public addon execution is enabled.

Restore Undici’s original Wasm factory and retire this package/private binding
once guest Wasm passes the same real HTTP/HTTPS, body, redirect, stream, cancel,
error, GC and shutdown cases independently on all four hosts. See
`docs/nodejs-upstream-maintenance.md`. This draft is not runtime-qualified.
