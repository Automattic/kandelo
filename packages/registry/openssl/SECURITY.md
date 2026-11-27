# OpenSSL security limitations on Kandelo

## Secure allocations use the ordinary heap

The wasm32 and wasm64 libraries are configured with `no-secure-memory`.
Upstream OpenSSL can keep selected secrets in a separate arena surrounded by
inaccessible guard pages. Kandelo cannot enforce those page permissions within
guest WebAssembly linear memory.
See the [build configuration](build-openssl.sh) and
[Kandelo's memory protection limits](../../../docs/posix-status.md).

`OPENSSL_secure_malloc()` uses the ordinary heap. Callers lose the separate
arena and its memory-locking and dump-exclusion protections.
`OPENSSL_secure_clear_free()` still clears the supplied bytes before release.

The installed `openssl/configuration.h` defines `OPENSSL_NO_SECURE_MEMORY`.
At runtime, `CRYPTO_secure_malloc_init()` and
`CRYPTO_secure_malloc_initialized()` both return zero. Applications that
require guarded storage should check availability before handling secrets
and stop if initialization fails. Restoring the secure heap requires a target
that enforces guard pages.
