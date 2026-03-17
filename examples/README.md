# Examples

C programs demonstrating wasm-posix-kernel capabilities. Each can be compiled with the SDK and run on the TypeScript host.

## Building and Running

```bash
# Compile any example
wasm32posix-cc examples/hello.c -o hello.wasm

# Run it
cd host
node --experimental-strip-types src/run.ts ../hello.wasm
```

## Programs

### Basics

| Example | Description |
|---------|-------------|
| [hello.c](hello.c) | Hello world — minimal printf test |
| [malloc.c](malloc.c) | Dynamic memory allocation via brk/mmap |
| [strings.c](strings.c) | String operations (string.h, ctype.h) |
| [math.c](math.c) | Number formatting and basic math |
| [snprintf.c](snprintf.c) | String formatting without I/O |
| [fprintf.c](fprintf.c) | Writing to stdout and stderr |

### Filesystem

| Example | Description |
|---------|-------------|
| [files.c](files.c) | File I/O — open, read, write, seek, stat |
| [dirs.c](dirs.c) | Directory operations — mkdir, readdir, rmdir |
| [flock_test.c](flock_test.c) | Advisory file locking via flock() |

### System

| Example | Description |
|---------|-------------|
| [environ.c](environ.c) | Process info and environment variables |
| [putenv_test.c](putenv_test.c) | setenv/getenv/putenv/unsetenv |
| [getaddrinfo_test.c](getaddrinfo_test.c) | DNS resolution via getaddrinfo() |

### Browser Demo

The `browser/` directory contains an interactive demo that runs examples in the browser using Vite:

```bash
cd examples/browser
npm install
npm run dev
```

Requires `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` headers (Vite config handles this automatically).

### Library Integrations

The `libs/` directory contains build scripts for compiling larger C libraries to Wasm:

| Library | Directory | Status |
|---------|-----------|--------|
| PHP | [libs/php/](libs/php/) | Build script + integration tests |
| SQLite | [libs/sqlite/](libs/sqlite/) | Build script |
| libxml2 | [libs/libxml2/](libs/libxml2/) | Build script |
| OpenSSL | [libs/openssl/](libs/openssl/) | Build script (TLS support in progress) |
| zlib | [libs/zlib/](libs/zlib/) | Build script |

## Pre-compiled Binaries

Most examples include pre-compiled `.wasm` files so you can run them without the SDK installed. The debug/trace files (`fp128*`, `strtod_debug*`, `div_trace*`, `mul_*`) are development artifacts for testing numeric precision.
