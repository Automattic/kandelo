# OpenSSL & HTTPS Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable HTTPS in C programs targeting Kandelo by compiling OpenSSL to Wasm and providing a reference TLS-intercepting browser backend.

**Architecture:** OpenSSL compiles to static Wasm libraries using the SDK's `wasm32posix-cc`. On Node.js, TLS works natively over raw TCP (TcpNetworkBackend). For browsers, a TLS-intercepting fetch backend (adapted from WordPress Playground's TLS 1.2 library) performs MITM, decrypts to HTTP, and routes through `fetch()`. Everything lives in `examples/libs/openssl/` — not core kernel infrastructure.

**Tech Stack:** OpenSSL 3.3.x, WordPress Playground TLS 1.2 library (vendored), TypeScript, Vitest, Web Crypto API

---

### Task 1: Scaffold Directory Structure

**Files:**
- Create: `examples/libs/openssl/package.json`
- Create: `examples/libs/openssl/tsconfig.json`
- Create: `examples/libs/openssl/vitest.config.ts`
- Create: `examples/libs/openssl/.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "wasm-posix-openssl-example",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build-openssl": "bash build-openssl.sh",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.2.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

**Step 4: Create .gitignore**

```
node_modules/
openssl-src/
openssl-install/
*.wasm
```

**Step 5: Install dependencies**

Run: `cd examples/libs/openssl && npm install`

**Step 6: Commit**

```bash
git add examples/libs/openssl/
git commit -m "feat: scaffold examples/libs/openssl directory"
```

---

### Task 2: OpenSSL Build Script

**Files:**
- Create: `examples/libs/openssl/build-openssl.sh`

**Context:** OpenSSL uses a Perl-based `Configure` script (not autoconf). We use the `linux-generic32` target and override CC/AR/RANLIB with our SDK tools. After Configure, we patch the Makefile to remove cross-compile guards, then build only `libssl.a` and `libcrypto.a`. This follows the WordPress Playground pattern.

**Prerequisites:** Perl must be installed (standard on macOS/Linux). The SDK must be npm-linked or in PATH (`wasm32posix-cc`, `wasm32posix-ar`, `wasm32posix-ranlib`).

**Step 1: Write the build script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# OpenSSL version to build
OPENSSL_VERSION="${OPENSSL_VERSION:-3.3.2}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/openssl-src"
INSTALL_DIR="$SCRIPT_DIR/openssl-install"

# Verify SDK tools are available
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# Download OpenSSL if not present
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading OpenSSL $OPENSSL_VERSION..."
    TARBALL="openssl-${OPENSSL_VERSION}.tar.gz"
    curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/${TARBALL}" \
        -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# Clean previous build
if [ -f Makefile ]; then
    make clean 2>/dev/null || true
fi

# Configure for Wasm using linux-generic32 target
echo "==> Configuring OpenSSL for Wasm..."
CC=wasm32posix-cc \
AR=wasm32posix-ar \
RANLIB=wasm32posix-ranlib \
perl Configure linux-generic32 \
    -DHAVE_FORK=0 \
    -DOPENSSL_NO_AFALGENG=1 \
    -DOPENSSL_NO_UI_CONSOLE=1 \
    no-asm \
    no-threads \
    no-dso \
    no-shared \
    no-async \
    no-engine \
    no-afalgeng \
    no-ui-console \
    no-tests \
    no-apps \
    --prefix="$INSTALL_DIR"

# Patch Makefile: remove cross-compile settings that conflict
# (same approach as WordPress Playground)
echo "==> Patching Makefile..."
sed -i.bak 's/^CROSS_COMPILE=.*/CROSS_COMPILE=/' Makefile
rm -f Makefile.bak

# Build only the static libraries
echo "==> Building OpenSSL..."
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" build_generated libssl.a libcrypto.a

# Install headers and libraries
echo "==> Installing..."
rm -rf "$INSTALL_DIR"
make install_sw 2>/dev/null || true

# Verify output
echo "==> Verifying..."
if [ -f "$INSTALL_DIR/lib/libssl.a" ] && [ -f "$INSTALL_DIR/lib/libcrypto.a" ]; then
    echo "==> OpenSSL build complete!"
    echo "    Headers:  $INSTALL_DIR/include/openssl/"
    echo "    libssl:   $INSTALL_DIR/lib/libssl.a"
    echo "    libcrypto: $INSTALL_DIR/lib/libcrypto.a"
    ls -lh "$INSTALL_DIR/lib/libssl.a" "$INSTALL_DIR/lib/libcrypto.a"
else
    echo "ERROR: Build failed — libraries not found" >&2
    exit 1
fi
```

**Step 2: Run the build script**

Run: `cd examples/libs/openssl && bash build-openssl.sh`

Expected: Downloads OpenSSL 3.3.2, configures, patches, builds, and installs to `openssl-install/`. This step will likely surface SDK issues — fix them in the SDK before continuing (see Task 2a).

**Step 3: Commit**

```bash
git add examples/libs/openssl/build-openssl.sh
git commit -m "feat: add OpenSSL build script for Wasm"
```

---

### Task 2a: Fix SDK Issues (Discovered During Build)

**Context:** OpenSSL's build will likely exercise the SDK in ways that single-file compilation doesn't. Common issues:

- **Configure test programs fail to link:** OpenSSL's Configure compiles small test programs. The CC wrapper may inject link flags that cause problems for simple test programs. May need to handle the case where Configure runs `cc -o /dev/null test.c` style probes.
- **Unknown flags:** OpenSSL's Makefile may pass flags the CC wrapper doesn't recognize. Check filterArgs() for gaps.
- **`-Wl,--version-script`:** OpenSSL may try to use version scripts. Should be filtered.
- **make install paths:** `make install_sw` may try to create paths that don't work.

**Files:**
- Modify: `sdk/src/lib/flags.ts` (add new ignored flags if needed)
- Modify: `sdk/src/bin/cc.ts` (fix link behavior if needed)
- Test: `sdk/test/*.test.ts`

**Steps:** Fix issues as they arise. For each fix:
1. Add a failing test in the SDK test suite
2. Fix the SDK code
3. Run SDK tests: `cd sdk && npx vitest run`
4. Re-run `build-openssl.sh` to verify
5. Commit SDK fix separately

---

### Task 3: Build Verification Test

**Files:**
- Create: `examples/libs/openssl/test/ssl_basic.c`

**Step 1: Write the basic test program**

```c
/*
 * ssl_basic.c — Minimal test that OpenSSL links and works.
 * Calls SSL_CTX_new / SSL_CTX_free to verify the library is functional.
 */
#include <stdio.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

int main(void)
{
    /* Initialize OpenSSL */
    OPENSSL_init_ssl(0, NULL);

    /* Create an SSL context */
    const SSL_METHOD *method = TLS_client_method();
    SSL_CTX *ctx = SSL_CTX_new(method);
    if (!ctx) {
        printf("FAIL: SSL_CTX_new returned NULL\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }

    printf("OK: SSL_CTX_new succeeded\n");
    printf("OpenSSL version: %s\n", OpenSSL_version(OPENSSL_VERSION));

    SSL_CTX_free(ctx);
    printf("OK: SSL_CTX_free succeeded\n");
    printf("PASS\n");
    return 0;
}
```

**Step 2: Compile and link**

Run:
```bash
wasm32posix-cc \
    -I examples/libs/openssl/openssl-install/include \
    examples/libs/openssl/test/ssl_basic.c \
    -L examples/libs/openssl/openssl-install/lib \
    -lssl -lcrypto \
    -o examples/libs/openssl/test/ssl_basic.wasm
```

Expected: Produces `ssl_basic.wasm`. If linking fails, debug and fix SDK or build issues.

**Step 3: Run the test program**

Create a quick Node.js runner or use the existing ProgramRunner integration test pattern to execute `ssl_basic.wasm` and verify output contains "PASS".

**Step 4: Commit**

```bash
git add examples/libs/openssl/test/ssl_basic.c
git commit -m "test: verify OpenSSL links and SSL_CTX works in Wasm"
```

---

### Task 4: HTTPS GET Test Program

**Files:**
- Create: `examples/libs/openssl/test/https_get.c`

**Context:** This C program performs a full HTTPS GET request using OpenSSL's API over raw POSIX sockets. It will be used for both Node.js (real TCP) and browser (TLS-intercepting backend) tests.

**Step 1: Write the HTTPS GET program**

```c
/*
 * https_get.c — Perform an HTTPS GET using OpenSSL over raw POSIX sockets.
 *
 * Usage: the host must provide networking (TcpNetworkBackend or TLS fetch backend).
 * Expects one argument: the hostname to connect to.
 * Connects to port 443, does TLS handshake, sends GET /, prints response.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

int main(int argc, char **argv)
{
    const char *hostname = argc > 1 ? argv[1] : "example.com";
    int port = 443;

    /* Initialize OpenSSL */
    OPENSSL_init_ssl(0, NULL);

    /* Create SSL context */
    const SSL_METHOD *method = TLS_client_method();
    SSL_CTX *ctx = SSL_CTX_new(method);
    if (!ctx) {
        printf("FAIL: SSL_CTX_new\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }

    /* Load CA certificates from default paths */
    if (SSL_CTX_set_default_verify_paths(ctx) != 1) {
        /* Try explicit path */
        SSL_CTX_load_verify_locations(ctx, "/etc/ssl/certs/ca-certificates.crt", NULL);
    }

    /* Resolve hostname */
    struct addrinfo hints = {0};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int gai = getaddrinfo(hostname, NULL, &hints, &res);
    if (gai != 0 || !res) {
        printf("FAIL: getaddrinfo: %d\n", gai);
        return 1;
    }

    /* Create socket and connect */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        printf("FAIL: socket\n");
        return 1;
    }

    struct sockaddr_in addr;
    memcpy(&addr, res->ai_addr, sizeof(addr));
    addr.sin_port = htons(port);
    freeaddrinfo(res);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("FAIL: connect\n");
        return 1;
    }
    printf("OK: connected to %s:%d\n", hostname, port);

    /* Create SSL connection */
    SSL *ssl = SSL_new(ctx);
    SSL_set_fd(ssl, fd);
    SSL_set_tlsext_host_name(ssl, hostname);

    if (SSL_connect(ssl) != 1) {
        printf("FAIL: SSL_connect\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }
    printf("OK: TLS handshake complete (%s)\n", SSL_get_version(ssl));

    /* Send HTTP GET request */
    char request[512];
    int reqlen = snprintf(request, sizeof(request),
        "GET / HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "\r\n", hostname);
    SSL_write(ssl, request, reqlen);
    printf("OK: sent HTTP request\n");

    /* Read response */
    char buf[4096];
    int total = 0;
    int n;
    while ((n = SSL_read(ssl, buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        if (total == 0) {
            /* Print first line of response (status line) */
            char *eol = strchr(buf, '\r');
            if (eol) *eol = '\0';
            printf("OK: response: %s\n", buf);
            if (eol) *eol = '\r';
        }
        total += n;
    }
    printf("OK: received %d bytes total\n", total);

    /* Cleanup */
    SSL_shutdown(ssl);
    SSL_free(ssl);
    close(fd);
    SSL_CTX_free(ctx);

    printf("PASS\n");
    return 0;
}
```

**Step 2: Compile**

Run:
```bash
wasm32posix-cc \
    -I examples/libs/openssl/openssl-install/include \
    examples/libs/openssl/test/https_get.c \
    -L examples/libs/openssl/openssl-install/lib \
    -lssl -lcrypto \
    -o examples/libs/openssl/test/https_get.wasm
```

**Step 3: Commit**

```bash
git add examples/libs/openssl/test/https_get.c
git commit -m "test: add HTTPS GET test program using OpenSSL"
```

---

### Task 5: Node.js End-to-End Test

**Files:**
- Create: `examples/libs/openssl/test/https-node.test.ts`

**Context:** Run `https_get.wasm` with `TcpNetworkBackend` (real TCP, real DNS). OpenSSL in Wasm does the actual TLS handshake over the real TCP socket. This test requires internet access.

**Step 1: Write the integration test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve main repo root from worktree
function repoRoot(): string {
  const gitCommon = execSync("git rev-parse --git-common-dir", {
    cwd: __dirname,
    encoding: "utf-8",
  }).trim();
  return join(gitCommon, "..");
}

describe("HTTPS via OpenSSL on Node.js (real TCP)", () => {
  it("performs TLS handshake and HTTPS GET to example.com", async () => {
    const root = repoRoot();
    // Dynamic imports from the host package
    const { WasmPosixKernel } = await import(
      join(root, "host/src/kernel.ts")
    );
    const { ProgramRunner } = await import(
      join(root, "host/src/program-runner.ts")
    );
    const { NodePlatformIO } = await import(
      join(root, "host/src/platform/node.ts")
    );
    const { TcpNetworkBackend } = await import(
      join(root, "host/src/networking/tcp-backend.ts")
    );

    const kernelWasm = readFileSync(join(root, "host/wasm/wasm_posix_kernel.wasm"));
    const programWasm = readFileSync(join(__dirname, "https_get.wasm"));

    let stdout = "";
    const io = new NodePlatformIO();
    (io as any).network = new TcpNetworkBackend();

    const kernel = new WasmPosixKernel(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
      io,
      {
        onStdout: (data: Uint8Array) => {
          stdout += new TextDecoder().decode(data);
        },
      },
    );
    await kernel.init(kernelWasm);

    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(programWasm, {
      argv: ["https_get", "example.com"],
    });

    expect(stdout).toContain("OK: connected to example.com:443");
    expect(stdout).toContain("OK: TLS handshake complete");
    expect(stdout).toContain("OK: response: HTTP/1.1");
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 60_000);
});
```

**Step 2: Run the test**

Run: `cd examples/libs/openssl && npx vitest run test/https-node.test.ts`

Expected: PASS — OpenSSL in Wasm performs real TLS over raw TCP.

**Step 3: Commit**

```bash
git add examples/libs/openssl/test/https-node.test.ts
git commit -m "test: Node.js end-to-end HTTPS via OpenSSL over real TCP"
```

---

### Task 6: Vendor WordPress Playground TLS Library

**Files:**
- Create: `examples/libs/openssl/src/tls/` (vendored from WordPress Playground)
- Create: `examples/libs/openssl/src/tls/utils.ts` (with shims)

**Context:** We vendor WordPress Playground's TLS 1.2 implementation from `packages/php-wasm/web/src/lib/tls/`. The library depends on `@php-wasm/util` (for `concatUint8Arrays`) and `@php-wasm/logger` — we provide trivial shims. The core TLS files are:

```
src/tls/
├── 1_2/
│   ├── connection.ts    # TLS 1.2 connection handler (MITM server)
│   ├── prf.ts           # PRF (pseudorandom function)
│   └── types.ts         # TLS protocol types and constants
├── extensions/
│   ├── 0_server_name.ts
│   ├── 10_supported_groups.ts
│   ├── 11_ec_point_formats.ts
│   ├── 13_signature_algorithms.ts
│   ├── 65281_renegotiation_info.ts
│   ├── parse-extensions.ts
│   └── types.ts
├── certificates.ts      # X.509 cert generation via Web Crypto
├── cipher-suites.ts     # Cipher suite registry
└── utils.ts             # Binary I/O helpers
```

**Step 1: Download the TLS files from WordPress Playground**

Write a script or manually download the files from GitHub. The base URL is:
`https://raw.githubusercontent.com/WordPress/wordpress-playground/trunk/packages/php-wasm/web/src/lib/tls/`

**Step 2: Replace `@php-wasm/util` imports**

The TLS files import `concatUint8Arrays` from `@php-wasm/util`. Add this helper to `src/tls/utils.ts`:

```typescript
export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
```

Then update imports in vendored files to use the local `utils.ts` instead of `@php-wasm/util`.

**Step 3: Replace `@php-wasm/logger` imports**

The signature_algorithms extension handler imports from `@php-wasm/logger`. Replace with:

```typescript
const logger = { warn: console.warn };
```

**Step 4: Verify the vendored library compiles**

Run: `cd examples/libs/openssl && npx tsc --noEmit`

Expected: No type errors.

**Step 5: Commit**

```bash
git add examples/libs/openssl/src/tls/
git commit -m "feat: vendor WordPress Playground TLS 1.2 library"
```

---

### Task 7: TLS-Intercepting Fetch Backend

**Files:**
- Create: `examples/libs/openssl/src/tls-fetch-backend.ts`

**Context:** Implements the `NetworkIO` interface. For port 80, behaves like the existing FetchNetworkBackend (parse raw HTTP, route through `fetch()`). For port 443, performs a TLS MITM using the vendored TLS library: generates per-domain certs signed by a built-in CA, completes TLS handshake with the Wasm OpenSSL client, decrypts application data to extract HTTP requests, routes through `fetch()` with `https://`, and re-encrypts responses.

**Key design challenge:** The `TLS_1_2_Connection` uses async `TransformStream` APIs and Web Crypto. Our `NetworkIO` methods are synchronous. We bridge this the same way the existing FetchNetworkBackend bridges `fetch()`: run async operations in the background and use `Atomics.wait()` / `Atomics.notify()` to synchronize.

The `NetworkIO` interface (from `host/src/types.ts`):
```typescript
export interface NetworkIO {
    connect(handle: number, addr: Uint8Array, port: number): void;
    send(handle: number, data: Uint8Array, flags: number): number;
    recv(handle: number, maxLen: number, flags: number): Uint8Array;
    close(handle: number): void;
    getaddrinfo(hostname: string): Uint8Array;
}
```

**Step 1: Write the TLS fetch backend**

Key design:

```typescript
import { TLS_1_2_Connection } from "./tls/1_2/connection";
import { generateCertificate, GeneratedCertificate } from "./tls/certificates";

interface TlsConnection {
    hostname: string;
    port: number;
    tls: TLS_1_2_Connection;
    // Buffers for synchronous send/recv
    clientEncryptedOutBuf: Uint8Array[]; // encrypted bytes TO client (for recv)
    serverPlaintextBuf: Uint8Array[];    // decrypted plaintext FROM client
    handshakeComplete: boolean;
    fetchDone: boolean;
    responseBuf: Uint8Array;
    responseOffset: number;
}

export class TlsFetchNetworkBackend implements NetworkIO {
    private connections = new Map<number, TlsConnection>();
    private hostMap = new Map<string, string>(); // synthetic IP → hostname
    private caRoot: GeneratedCertificate;
    private syncBuffer: SharedArrayBuffer;
    private syncArray: Int32Array;

    constructor(caRoot: GeneratedCertificate) {
        this.caRoot = caRoot;
        this.syncBuffer = new SharedArrayBuffer(4);
        this.syncArray = new Int32Array(this.syncBuffer);
    }

    getaddrinfo(hostname: string): Uint8Array {
        // Deterministic synthetic IP from hostname hash
        // Store hostname → IP mapping for later connect()
        const ip = syntheticIp(hostname);
        this.hostMap.set(ipToString(ip), hostname);
        return ip;
    }

    connect(handle: number, addr: Uint8Array, port: number): void {
        const ipStr = ipToString(addr);
        const hostname = this.hostMap.get(ipStr) || ipStr;

        if (port === 443) {
            // TLS connection — set up MITM state
            const tls = new TLS_1_2_Connection();
            this.connections.set(handle, {
                hostname, port, tls,
                clientEncryptedOutBuf: [],
                serverPlaintextBuf: [],
                handshakeComplete: false,
                fetchDone: false,
                responseBuf: new Uint8Array(0),
                responseOffset: 0,
            });
            // Set up stream piping for TLS client downstream → our buffer
            this.pipeToBuffer(tls, handle);
        } else {
            // Plain HTTP — same as FetchNetworkBackend
            // ... (reuse existing HTTP pattern)
        }
    }

    send(handle: number, data: Uint8Array, flags: number): number {
        const conn = this.connections.get(handle);
        if (conn.port === 443) {
            // Write encrypted bytes to TLS connection's client upstream
            this.writeTlsClient(conn, data);

            if (!conn.handshakeComplete) {
                // TLS handshake in progress — the TLS library processes
                // the bytes and generates response via the piped stream.
                // Block until handshake bytes are ready.
                this.waitForTlsOutput(conn);
            } else {
                // After handshake: accumulate decrypted plaintext,
                // detect complete HTTP request, issue fetch()
                this.waitForPlaintext(conn);
                if (this.hasCompleteHttpRequest(conn)) {
                    this.doFetch(conn);
                }
            }
            return data.length;
        }
        // ... plain HTTP send
    }

    recv(handle: number, maxLen: number, flags: number): Uint8Array {
        const conn = this.connections.get(handle);
        if (conn.port === 443) {
            // Return encrypted bytes from TLS connection's client downstream
            // These are either handshake messages or encrypted HTTP response
            return this.readTlsOutput(conn, maxLen);
        }
        // ... plain HTTP recv
    }
}
```

The exact implementation will need to handle:
- Piping between `TLS_1_2_Connection`'s TransformStreams and synchronous buffers
- Triggering `TLSHandshake()` async and blocking with `Atomics.wait()`
- Generating per-domain certificates signed by the CA
- HTTP request parsing from decrypted plaintext (reuse `parseHttpRequest` pattern from FetchNetworkBackend)
- Wrapping fetch response back through TLS encryption

**Step 2: Add CA certificate export**

The backend must expose the CA certificate as PEM so it can be written to the Wasm VFS:

```typescript
export async function createCARootCertificate(): Promise<GeneratedCertificate> {
    return await generateCertificate({
        subject: { commonName: "Kandelo MITM CA", organizationName: "Kandelo" },
        validity: { notBefore: new Date("2020-01-01"), notAfter: new Date("2040-01-01") },
        basicConstraints: { isCA: true },
    });
}
```

**Step 3: Verify it compiles**

Run: `cd examples/libs/openssl && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add examples/libs/openssl/src/tls-fetch-backend.ts
git commit -m "feat: add TLS-intercepting fetch backend for browser HTTPS"
```

---

### Task 8: Browser Backend End-to-End Test

**Files:**
- Create: `examples/libs/openssl/test/https-browser.test.ts`

**Context:** Run `https_get.wasm` using the TLS-intercepting fetch backend. This runs in Node.js (the vendored TLS library uses Web Crypto which is available in Node.js 20+). We mock `fetch()` to return a canned HTTPS response, avoiding real network dependencies.

The CA certificate must be written to the Wasm VFS at `/etc/ssl/certs/ca-certificates.crt` before the program runs, so OpenSSL trusts the MITM CA.

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { TlsFetchNetworkBackend, createCARootCertificate } from "../src/tls-fetch-backend";
import { certificateToPEM } from "../src/tls/certificates";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
    const gitCommon = execSync("git rev-parse --git-common-dir", {
        cwd: __dirname, encoding: "utf-8",
    }).trim();
    return join(gitCommon, "..");
}

describe("HTTPS via OpenSSL with TLS-intercepting fetch backend", () => {
    it("completes TLS handshake and HTTPS GET through MITM backend", async () => {
        const root = repoRoot();
        const { WasmPosixKernel } = await import(join(root, "host/src/kernel.ts"));
        const { ProgramRunner } = await import(join(root, "host/src/program-runner.ts"));
        const { NodePlatformIO } = await import(join(root, "host/src/platform/node.ts"));

        const kernelWasm = readFileSync(join(root, "host/wasm/wasm_posix_kernel.wasm"));
        const programWasm = readFileSync(join(__dirname, "https_get.wasm"));

        // Generate MITM CA
        const caRoot = await createCARootCertificate();
        const caPem = certificateToPEM(caRoot.certificate);

        let stdout = "";
        const io = new NodePlatformIO();
        (io as any).network = new TlsFetchNetworkBackend(caRoot);

        const kernel = new WasmPosixKernel(
            { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
            io,
            {
                onStdout: (data: Uint8Array) => {
                    stdout += new TextDecoder().decode(data);
                },
            },
        );
        await kernel.init(kernelWasm);

        // Write CA cert to VFS so OpenSSL trusts it
        // Use kernel's filesystem API to write the cert
        kernel.writeFile("/etc/ssl/certs/ca-certificates.crt", new TextEncoder().encode(caPem));

        const runner = new ProgramRunner(kernel);
        const exitCode = await runner.run(programWasm, {
            argv: ["https_get", "example.com"],
        });

        expect(stdout).toContain("OK: TLS handshake complete");
        expect(stdout).toContain("OK: response: HTTP/1.1");
        expect(stdout).toContain("PASS");
        expect(exitCode).toBe(0);
    }, 60_000);
});
```

**Note:** The `kernel.writeFile()` method may not exist yet. If not, use the kernel's VFS to pre-populate the file. Check how the VFS is populated in other tests and use the same pattern.

**Step 2: Run the test**

Run: `cd examples/libs/openssl && npx vitest run test/https-browser.test.ts`

Expected: PASS — TLS handshake via MITM, HTTP request extracted, routed through fetch, response encrypted and returned.

**Step 3: Run all tests**

Run: `cd examples/libs/openssl && npx vitest run`

Expected: All tests pass.

**Step 4: Commit**

```bash
git add examples/libs/openssl/test/https-browser.test.ts
git commit -m "test: browser HTTPS end-to-end via TLS-intercepting fetch backend"
```

---

### Task 9: Final Review and Cleanup

**Step 1: Run all tests across the project**

```bash
# Kernel unit tests
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# Host integration tests
cd host && npx vitest run

# SDK tests
cd sdk && npx vitest run

# OpenSSL example tests
cd examples/libs/openssl && npx vitest run
```

All should pass.

**Step 2: Review all changes**

```bash
git diff main --stat
git log main..HEAD --oneline
```

Verify no unintended changes, no debug code left behind.

**Step 3: Final commit if needed**

Clean up any loose ends.

---

## Notes

- **OpenSSL version:** Pinned to 3.3.2. Update `OPENSSL_VERSION` in build script to change.
- **TLS 1.2 only:** The MITM backend only supports TLS 1.2. If OpenSSL defaults to TLS 1.3, configure `SSL_CTX_set_max_proto_version(ctx, TLS1_2_VERSION)` in the test program, or add `no-tls1_3` to the Configure flags.
- **Cipher suite:** The vendored TLS library only implements `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`. Verify OpenSSL negotiates this suite.
- **Internet required:** The Node.js end-to-end test (Task 5) requires internet access. The browser backend test (Task 8) can be run offline if fetch is mocked.
- **CA cert trust:** For real usage, the CA PEM must be in the Wasm VFS at a path OpenSSL searches (e.g., `/etc/ssl/certs/ca-certificates.crt`).
