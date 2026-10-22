# Packages

This directory contains build recipes for software that runs on Kandelo.

## Software examples

These are upstream projects compiled to WebAssembly through the Kandelo SDK.
Some packages carry portability patches or adapt to documented platform limits.
The table is a selection, not the full registry. Each package's `package.toml`
is the source of truth for its exact version.

| Software | Version | What it shows |
|----------|---------|---------------|
| nginx | 1.24 | Web server: static files, reverse proxy, FastCGI, multiple worker processes |
| PHP | 8.5 | Command line and PHP-FPM (the FastCGI process manager) |
| Composer | 2.10.3 | PHP dependency manager, loaded lazily in the base shell |
| WordPress | 7.0 | Full site on nginx + PHP-FPM, with SQLite or MariaDB |
| MariaDB | 10.5 | SQL database server with threads |
| Redis | 7.2 | In-memory data store with background threads |
| SQLite | 3.49 | Embedded SQL database |
| CPython | 3.13 | Python interpreter and standard library |
| Perl | 5.40 | Perl interpreter and core modules |
| Ruby | 4.0 | Ruby interpreter and standard library |
| SpiderMonkey | 140 ESR | Firefox's JavaScript engine, used to provide a Node.js-compatible runtime with `npm install` |
| Git | 2.47 | Version control |
| Vim | 9.1 | Text editor with a full terminal UI |
| GNU nano | 8.0 | Text editor |
| ELinks | 0.20 | Text-mode web browser with HTTPS and page JavaScript via QuickJS-NG |
| dash, bash | 0.5.12, 5.2 | Shells with pipes, redirection, and job control |
| GNU coreutils | 9.6 | `ls`, `cat`, `sort`, `wc`, and the other core utilities |
| GNU grep, sed, gawk | 3.11, 4.9, 5.3 | Text processing |
| GNU findutils, diffutils | 4.10, 3.10 | `find`, `xargs`, `diff`, `cmp` |
| GNU make, m4 | 4.4, 1.4.19 | Build tools |
| curl, wget | 8.11, 1.25 | HTTP clients with TLS |
| GNU Netcat | 0.7.1 | TCP/UDP client and server |
| tar, gzip, bzip2, xz, zstd, zip, unzip | — | Archives and compression |
| less, bc, file | 668, 1.07, 5.45 | Pager, calculator, file-type detection |
| NetHack | 3.6.7 | Classic terminal game |
| fbDOOM | — | DOOM, drawn through the `/dev/fb0` framebuffer device |
| [Freeciv](../docs/freeciv.md) | 3.2.6 | Native SDL2 client and dedicated server; single player and TCP multiplayer through network sessions |
| TyrQuake | 0.71 | Quake (software renderer), drawn through `/dev/fb0` |
| [LÖVE](registry/love/README.md) | 11.5-kandelo-kms | Lua games with SDL2/GLES graphics and OSS audio; supported source controls and limits are documented with the package |
| espeak-ng | 1.52 | Speech synthesis, played through the `/dev/dsp` audio device |

The [registry](registry/) also includes SDL, Wayland/compositor, and Qt demos.
Node.js and browser hosts share the kernel and process runtime, with different
networking and display capabilities. See [Browser Support](../docs/browser-support.md)
for those limits and [Freeciv](../docs/freeciv.md) for its client/server guide.

## Package layout

- `registry/<name>/package.toml` describes one buildable package, its source,
  license, dependencies, build script, and outputs.
- `registry/<name>/build-*.sh` builds the package for Kandelo.
- `registry/<name>/demo/` contains package-owned launchers, service configs,
  sample assets, and local demo helpers.
- `registry/<name>/test/` contains package-owned tests and fixtures. A package
  PR should be able to trigger these paths without treating the change as a
  host/runtime change.
- `sets/local-supported.toml` selects the packages and browser products built
  by `./run.sh setup` and `./run.sh local-build`. It also records excluded
  packages and dormant products.

Shared host/kernel test artifact inventories live under
[`../tests/test-artifacts/`](../tests/test-artifacts/), not in the package
registry.

Package-system tests that validate registry tooling rather than a specific
package live in [`../tests/package-system/`](../tests/package-system/). Root
[`../examples/`](../examples/) is reserved for small kernel and SDK examples.

To build a package, run `./run.sh build <name>` from the repository root.
See the [Porting Guide](../docs/porting-guide.md) for adding software and
[Package Management](../docs/package-management.md) for recipes and caching.
