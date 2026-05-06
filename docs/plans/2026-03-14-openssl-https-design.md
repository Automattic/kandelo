# OpenSSL & HTTPS Support — Design

## Goal

Enable HTTPS in C programs targeting Kandelo by compiling OpenSSL to Wasm and providing a reference TLS-intercepting browser backend.

## Architecture

This work lives in `examples/libs/openssl/` — it is not core kernel/SDK infrastructure. The kernel stays TLS-unaware; it provides raw POSIX sockets, and TLS is the application's and integrator's concern.

**Node.js:** OpenSSL compiled to Wasm performs TLS handshakes over raw TCP sockets provided by TcpNetworkBackend. No kernel or backend changes needed.

**Browser:** A TLS-intercepting fetch backend (adapted from WordPress Playground's TLS 1.2 implementation) acts as a MITM between the Wasm OpenSSL client and the browser's native `fetch()`. The kernel provides the socket primitives; the backend is an integration choice made by the developer.

## Deliverables

### 1. OpenSSL Build Script (`examples/libs/openssl/build.sh`)

Downloads a pinned OpenSSL 3.x LTS release and builds static libraries using the SDK:

```
perl Configure linux-generic32 \
  no-asm no-threads no-dso no-shared no-async \
  no-engine no-afalgeng \
  -DHAVE_FORK=0 \
  --prefix="$INSTALL_DIR" \
  CC=wasm32posix-cc AR=wasm32posix-ar RANLIB=wasm32posix-ranlib
```

After Configure, patch the generated Makefile to remove cross-compile guards (same approach as WordPress Playground). Build only the needed targets:

```
make -j$(nproc) build_generated libssl.a libcrypto.a
make install_sw
```

Output: `include/openssl/*.h` and `lib/libssl.a` + `lib/libcrypto.a`.

Usage:
```
wasm32posix-cc -I openssl-install/include app.c \
  -L openssl-install/lib -lssl -lcrypto -o app.wasm
```

Any SDK bugs uncovered during this process get fixed in the SDK proper.

### 2. TLS-Intercepting Fetch Backend (`examples/libs/openssl/tls-fetch-backend.ts`)

A `NetworkIO` implementation for browser environments that handles both HTTP and HTTPS:

**Port 80 (HTTP):** Same behavior as the existing FetchNetworkBackend — parse raw HTTP from send buffer, route through `fetch()`.

**Port 443 (HTTPS):**

1. `getaddrinfo(hostname)` returns synthetic IP, stores hostname-to-IP mapping.
2. `connect(handle, addr, 443)` looks up hostname, initializes per-connection TLS MITM state.
3. On first `send()`, receives TLS ClientHello from Wasm OpenSSL.
4. Backend acts as TLS 1.2 server: generates a certificate for the target hostname on-the-fly, signed by a bundled MITM CA.
5. Completes TLS handshake over send/recv exchanges.
6. After handshake: `send()` receives TLS Application Data records, decrypts to plaintext HTTP request, issues `fetch()` with `https://` URL (browser handles real TLS to the origin server).
7. Wraps HTTP response in TLS Application Data records for `recv()`.

**TLS implementation:** Adapted from WordPress Playground's purpose-built TLS 1.2 library (`packages/php-wasm/web/src/lib/tls/`). GPL-2.0-or-later licensed, proven in production, minimal footprint.

**MITM CA trust:** The example includes a CA certificate. Integrators populate `/etc/ssl/certs/` in the VFS so Wasm OpenSSL trusts it. The example documents both VFS pre-population and explicit `SSL_CTX_load_verify_locations()`.

### 3. Tests (`examples/libs/openssl/test/`)

**Build verification:** OpenSSL compiles and links. A minimal C program calls `SSL_CTX_new()` / `SSL_CTX_free()` to verify the library works.

**Node.js end-to-end:** A C test program does an HTTPS GET (e.g., `https://example.com`). Links OpenSSL, creates SSL context, connects raw TCP socket, performs TLS handshake, sends HTTP request, reads response. Runs with TcpNetworkBackend over real TCP.

**Browser backend end-to-end:** Same C test program run with the TLS-intercepting fetch backend in a Node.js test harness (the Playground TLS library works in Node.js). Verifies: MITM CA is trusted, handshake completes, HTTP request is intercepted, response returns through `fetch()`. Mock/proxy the `fetch()` call to avoid network dependencies in CI.

Test program: `examples/libs/openssl/test/https_get.c`.

## Dependencies and Risks

**WordPress Playground TLS 1.2 library** — Purpose-built for this use case, battle-tested, minimal. We vendor or reference the relevant files. GPL-2.0-or-later licensed.

**OpenSSL build fragility** — The `linux-generic32` + Makefile patching approach is a hack that works (proven by WordPress Playground) but may break across OpenSSL versions. Pinning to a specific version and documenting patches mitigates this.

**Cipher suite compatibility** — Playground's TLS 1.2 supports specific cipher suites. Must verify OpenSSL 3.x can negotiate a compatible one.

**TLS 1.3** — Playground's implementation is TLS 1.2 only. If Wasm OpenSSL defaults to TLS 1.3, the MITM handshake fails. The example configures `SSL_CTX_set_max_proto_version(ctx, TLS1_2_VERSION)` or documents this constraint. TLS 1.3 support is future work.

**SDK gaps** — Expected. OpenSSL's build will surface SDK issues (missing flags, CC wrapper edge cases). Fixes improve the SDK for all users.

## Future Work (not in scope)

- **Kernel networking compliance** — `setsockopt`/`getsockopt` forwarding, `shutdown` forwarding to backend, non-blocking + `poll`/`select` for network handles. Valid POSIX compliance work, tracked separately.
- **TLS 1.3 browser interception** — Requires extending or replacing the TLS 1.2 implementation.
- **Additional library examples** — zlib, libcurl, etc. following the same `examples/libs/` pattern.
