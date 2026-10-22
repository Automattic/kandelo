# Kandelo

Kandelo is an operating system kernel for WebAssembly (Wasm). It runs Unix
software — shells, editors, web servers, databases, and games — in a browser
or Node.js. Programs use POSIX, the standard Unix interfaces for files,
processes, pipes, signals, and sockets, to work together.

**[Try Kandelo in your browser](https://kandelo.dev/)** — pick a machine from
its gallery. Nothing to install.

Kandelo is experimental. POSIX conformance is the goal; some interfaces are
incomplete or limited by WebAssembly and browser security rules.

## What runs on it

| Examples | What you can do |
|----------|-----------------|
| WordPress, nginx, PHP, MariaDB, SQLite | Run web apps and databases |
| Python, Ruby, Perl | Run scripts and language interpreters |
| SpiderMonkey-based Node.js runtime | Run JavaScript with a Node.js-compatible API |
| Git, Vim, nano | Work with source code in a terminal |
| bash, dash, GNU coreutils | Use shells, pipes, and familiar command-line tools |
| Freeciv | Play with the native client and dedicated server |
| DOOM, Quake | Play games with graphics and audio |
| LÖVE | Run Lua games |

See [software examples and versions](packages/README.md) for more. These are
upstream projects compiled through Kandelo's SDK; package recipes include
portability patches where needed.

## Quick start

To build locally, you need **macOS or Linux**, **Git**, and
**[Nix](https://nixos.org/download/) with flakes enabled**. Nix supplies the
compilers, Node.js, and other build tools.

```bash
git clone https://github.com/Automattic/kandelo.git
cd kandelo
git submodule update --init libc/musl sdk/rust/libc-upstream
./run.sh setup
./run.sh browser
```

Open the URL printed by the server, normally <http://127.0.0.1:5401>.
The first setup downloads tools and builds the supported software from source.
Later runs reuse cached builds. Run `./run.sh setup` again after pulling changes.

The development server supplies the browser isolation settings Kandelo needs.
For custom hosting, see [Browser Support](docs/browser-support.md#directory-scoped-production-hosting).

To change Kandelo, run tests, or compile a C program, start with
[Contributing](CONTRIBUTING.md).

## How it works

```text
Programs (C, C++, Rust → Wasm)
    │ system calls through shared memory
    ▼
Kernel (Rust → Wasm, in a dedicated worker)
    │
    ▼
Host runtime (TypeScript → browser or Node.js APIs)
```

Each process runs in its own worker. One kernel manages the machine's
processes, files, and communication between programs. Programs link against
musl, a C library, and a small adapter that sends system calls to the kernel.
The host runtime starts workers and connects the kernel to network, display,
and other host APIs.

See the [architecture reference](docs/architecture.md) for the layers and
system-call flow, and [fork instrumentation](docs/fork-instrumentation.md)
for how Kandelo copies a running process.

## Capabilities and limits

Kandelo supports files and directories, processes and threads, pipes and
signals, sockets, terminals, and graphics/audio devices. Programs can share
one machine or communicate over virtual networks and browser WebRTC sessions.

Some system calls and flags are incomplete. WebAssembly also limits memory
protection, shared memory between processes, and asynchronous thread
cancellation. Browser internet traffic uses fetch/TLS bridges rather than
arbitrary raw TCP/UDP sockets.

See [POSIX status](docs/posix-status.md) for supported behavior and
[WebAssembly limitations](docs/wasm-limitations.md) for platform boundaries.
Browser APIs and file image formats can change: pin your Kandelo revision and
rebuild programs and images when the binary interface (ABI) changes. See
[API stability](docs-site/reference/api-stability.md).

## Learn more

| I want to… | Start here |
|------------|------------|
| Use the browser app | [User guide](https://automattic.github.io/kandelo/guide/) |
| Build, change, or test Kandelo | [Contributing](CONTRIBUTING.md) |
| Compile a program | [C/C++ SDK](docs/sdk-guide.md) · [Rust SDK](sdk/rust/README.md) |
| Port software | [Porting Guide](docs/porting-guide.md) |
| Host Kandelo | [Static hosting](docs/browser-support.md#directory-scoped-production-hosting) · [Optional Spacefast hosting](apps/spacefast-cors-proxy/README.md#combined-kandelo-site) |
| Understand the internals | [Architecture](docs/architecture.md) · [Repository layout](docs/repository-organization.md) |

## License

- **GPL-2.0-or-later** for the platform: kernel, host runtime, SDK, build
  scripts, and examples.
- **MIT** for the runtime glue and musl overlay linked into user programs.

Ported packages keep their upstream licenses. See [LICENSE](LICENSE) for the
full licensing model, including running your own proprietary programs.
