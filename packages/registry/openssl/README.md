# OpenSSL

OpenSSL's `libssl.a` and `libcrypto.a`, built for Kandelo through the SDK
(`build-openssl.sh`) for wasm32 and wasm64. Consumers include libcurl, curl,
git, wget, PHP, SpiderMonkey and cmake.

## No secure heap

OpenSSL is configured with `no-secure-memory`. Its secure heap
(`crypto/mem_sec.c`) keeps secrets in a separate `mmap` arena bracketed by
`PROT_NONE` guard pages, locked into memory and excluded from core dumps.
WebAssembly memory has no page protection (`docs/posix-status.md`, "No page
protection"), so Kandelo cannot provide those guards, and the arena code would
put `mprotect()` into every program that links `libcrypto.a`.

With the secure heap compiled out:

- `CRYPTO_secure_malloc_init()` returns 0 (the secure heap is unavailable) and
  `CRYPTO_secure_malloc_initialized()` returns 0.
- `OPENSSL_secure_malloc()` and the other `OPENSSL_secure_*` allocators use
  the ordinary heap, as on platforms without a secure heap.
  `OPENSSL_secure_clear_free()` still clears the memory before freeing it.

`include/openssl/configuration.h` defines `OPENSSL_NO_SECURE_MEMORY`, so
consumers can test for it. Within OpenSSL only its tests, which are not built
here, call `CRYPTO_secure_malloc_init()`; libssl and libcrypto use the secure
allocators only through the ordinary-heap fallback above.
