# Examples

C programs demonstrating Kandelo capabilities. Each can be compiled with the SDK and run on the TypeScript host.

## Building and Running

```bash
# Compile any example
wasm32posix-cc examples/hello.c -o hello.wasm

# Run it
npx tsx examples/run-example.ts hello
```

See [docs/sdk-guide.md](../docs/sdk-guide.md) for full SDK documentation.

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
| [mmap_file_test.c](mmap_file_test.c) | Memory-mapped file I/O |
| [test-pthread.c](test-pthread.c) | Thread creation via clone() |
| [sysv_ipc_test.c](sysv_ipc_test.c) | SysV IPC (message queues, semaphores) |

### Browser Demos

The `browser/` directory contains interactive demos running real software in the browser via Vite:

```bash
cd examples/browser
npm install
npx vite --port 5198
```

| Demo | URL path | Software |
|------|----------|----------|
| Simple Programs | `/` | C example programs |
| Shell | `/pages/shell/` | dash + GNU coreutils |
| Python | `/pages/python/` | CPython 3.13 REPL |
| PHP CLI | `/pages/php/` | PHP 8.4 scripts |
| nginx | `/pages/nginx/` | Static file serving |
| nginx + PHP-FPM | `/pages/nginx-php/` | FastCGI integration |
| MariaDB | `/pages/mariadb/` | SQL database (5 threads) |
| Redis | `/pages/redis/` | In-memory store (3 threads) |
| WordPress | `/pages/wordpress/` | nginx + PHP-FPM + SQLite |
| LAMP | `/pages/lamp/` | MariaDB + nginx + PHP-FPM + WordPress |

Live at: [Kandelo browser demos](https://brandonpayton.github.io/wasm-posix-kernel/)

See [docs/porting-guide.md](../docs/porting-guide.md) for how to create new demos.

### Ported Software

Build scripts for real-world software are in `libs/`:

| Software | Build script | Binary output |
|----------|-------------|---------------|
| dash 0.5.12 | `libs/dash/build-dash.sh` | `libs/dash/bin/dash.wasm` |
| GNU coreutils 9.6 | `libs/coreutils/build-coreutils.sh` | `libs/coreutils/bin/coreutils.wasm` |
| GNU grep 3.11 | `libs/grep/build-grep.sh` | `libs/grep/bin/grep.wasm` |
| GNU sed 4.9 | `libs/sed/build-sed.sh` | `libs/sed/bin/sed.wasm` |
| PHP 8.4 | `libs/php/build-php.sh` | `libs/php/bin/php.wasm`, `php-fpm.wasm` |
| MariaDB 10.5 | `libs/mariadb/build-mariadb.sh` | `libs/mariadb/bin/mariadbd.wasm` |
| Redis 7.2 | `libs/redis/build-redis.sh` | `libs/redis/bin/redis-server.wasm` |
| CPython 3.13 | `libs/cpython/build-cpython.sh` | `libs/cpython/bin/python.wasm` |
| nginx 1.27 | via `examples/nginx/` | `examples/nginx/bin/nginx.wasm` |
| SQLite | `libs/sqlite/build-sqlite.sh` | (library, linked into PHP) |
| zlib | `libs/zlib/build-zlib.sh` | (library, linked into PHP) |
| libxml2 | `libs/libxml2/build-libxml2.sh` | (library, linked into PHP) |
| OpenSSL | `libs/openssl/build-openssl.sh` | (library, linked into PHP) |

## Pre-compiled Binaries

Most examples include pre-compiled `.wasm` files so you can run them without the SDK installed.
