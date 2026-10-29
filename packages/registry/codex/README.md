# Codex port

This recipe builds OpenAI's Codex CLI 0.163.0 for Kandelo's full-`std`
Rust target. The upstream source archive and Cargo dependencies are pinned.
The SDK retains standard-library bitcode for the upstream release profile's
link-time optimization.
Packaging removes DWARF debug sections before fork instrumentation, retaining
the compiler metadata and function names that stage needs. The normal
post-instrumentation optimization removes function names from the final
artifact; named diagnostic builds require the instrumenter's `--keep-names`.
Rust build scripts use the SDK's target pkg-config wrapper. The locked
`lzma-sys` and `bzip2-sys` crates compile their bundled C sources, rather
than selecting native host libraries through pkg-config.
It uses the SDK's libc 0.2.186 fork and the locked `nix` versions; it does
not downgrade dependencies or change the target's identity to Linux.

The full CLI builds through the package resolver, fork instrumentation,
and ABI admission. `--help`, `--version`, and unauthenticated login status
have run on the Node host. A real Codex exec session has also completed a
model/tool round trip against a guest-local HTTP fixture: Codex executed a
shell command, returned its actual output, and processed the next model
response. In the canonical browser shell, Codex is a lazy program: the
first execution fetches it. `--help`, `--version`, and the interactive
terminal interface started with `codex --no-daemon` run in Chromium,
Firefox, and WebKit; the interface reaches upstream's sign-in screen and
accepts keyboard input. Authenticated account use remains unverified. The
shared runtime prepares compact pthread artifact metadata once per process
image, avoiding another full executable copy and hash in every thread.

Codex calls OpenSSL from several tokio worker threads. Kandelo's OpenSSL
package therefore keeps OpenSSL's pthread support; a `no-threads` build
replaced its locks with single-thread stubs, and the interactive interface
corrupted the heap while decoding keys concurrently. The OpenSSL package
test `test/threads.test.ts` covers that use.

## System defaults

The package installs `/etc/codex/config.toml` (`system-config.toml`), which
is upstream's system configuration layer. A user's `~/.codex/config.toml`,
profiles, and command-line options override it. It sets two defaults,
both because this build has no `codex-code-mode-host`, a JavaScript host
built on Rust bindings to native V8, which do not target Kandelo:

- `features.daemon_auto_start = false`. Upstream's shared background
  server installs a complete managed Codex package (`codex-package.json`,
  `codex-code-mode-host`, and a bundled `rg` under `codex-path/`), which
  this recipe does not produce. Without this default, plain `codex` reports
  upstream's error, "this CLI has no complete local package", and advises
  `--no-daemon`. The setting selects the same in-process server.
- `model = "gpt-5.5"`. In Codex 0.163.0's model catalog, the gpt-5.6 and
  gpt-6 models are `code_mode_only`: every tool call, including shell
  commands, runs as JavaScript in the code-mode host, and fails closed
  without it (`failed to spawn code-mode host`). gpt-5.5 uses Codex's
  direct tools, which run on Kandelo. The catalog labels it a legacy
  model and offers an upgrade to gpt-6-sol; accepting that upgrade, or
  selecting another model with `/model` or `-m`, makes tool calls fail
  with that error.

The package does not supply a substitute code-mode host, fake the managed
package files, or patch Codex's selection logic.

The SDK fixes apply to Rust programs generally: descriptor cloning uses
`F_DUPFD_CLOEXEC`, file locking selects the existing Unix `flock` backend,
and signal/pthread/semaphore structures match Kandelo’s installed C
headers. Lock ownership is released when the final descriptor for an open
file description closes. These fixes belong to the SDK/kernel, rather
than Codex dependency patches. See [Rust target support](../../../docs/rust-target.md).

## Portability patches

The patches add Kandelo to platform selectors in existing Rust backends:

| Crates | Platform contract |
| --- | --- |
| `getrandom`, `ring`, `errno`, `nix` | musl errno definitions and Kandelo's `getrandom` function |
| `mio` | epoll, eventfd, and Unix file descriptors |
| `tokio`, `tokio-util` | Unix threads, sockets, signals, and peer credentials on a Wasm target |
| `reqwest`, `opentelemetry-http` | socket-based HTTP and blocking requests rather than browser JavaScript imports |
| `chrono`, `time`, `age`, `opentelemetry`, `tracing-opentelemetry`, `jsonwebtoken` | Unix/system clocks rather than browser JavaScript clocks |
| `whoami` | Unix passwd, hostname, and uname APIs, with Kandelo reported as its own platform |
| `webbrowser` | Unix executable discovery and launch; no wasm-bindgen window imports |
| `dirs` | the existing Unix/XDG directory backend rather than browser-only directory discovery |
| `socket2` | musl message-header field types and TCP socket-option bindings |
| `parking_lot_core` | field assignment for the padded wasm32 musl time64 `timespec` |
| `rustix` | libc-backed epoll/eventfd, musl ioctl argument type, and exclusion of an unavailable non-Linux fallocate flag |
| `wayland-backend` | the existing epoll backend for Unix sockets |
| `backtrace` | the upstream unsupported backend, matching the SDK's documented Wasm stack-introspection boundary |

These selectors do not add kernel features. Unsupported operations retain
the platform's actual errors. Mio uses the generic Unix address path;
the SDK does not expose Rust's Linux-specific abstract-address extension.
Rustix's epoll and eventfd support calls libc directly; it does not select
the Linux raw-syscall backend. Kandelo's epoll record is 16 bytes on both
architectures, with eight-byte-aligned event data.

The Codex source patch enables its POSIX process hardening on Kandelo:
disable core dumps with `setrlimit` and remove loader-injection environment
variables. It also makes that Unix helper's failure exit code available
under the same `unix` condition as the helper itself. It does not bypass
hardening or pretend Kandelo implements Linux `prctl` or `ptrace`.
The core crate also uses a compiler recursion limit of 256, matching the
existing TUI limit, to compile nested async tool-handler layouts on wasm32.

## Platform gaps

Guest stack backtraces are unavailable: WebAssembly does not expose its
engine call frames to guest code. The standalone `backtrace` crate selects
its upstream unsupported backend, just as the SDK's standard-library
overlay does; it captures no frames or symbols. This does not introduce
libunwind stubs. See [Rust target boundaries](../../../docs/rust-target.md#documented-boundaries).

On this branch's base, `/proc/self/exe` reads as the process's `argv[0]`,
so `std::env::current_exe()` returns the relative path `codex` when the
shell finds Codex on `PATH`. Codex derives helper paths from it, which is
why the code-mode error names a bare `codex-code-mode-host` rather than
`/usr/bin/codex-code-mode-host`. `main` now reports the executed file
(commit 18d19a6891, "POSIX: Name the executable a process runs in
/proc/<pid>/exe").

Kandelo currently returns `ENOSYS` for inotify. The locked `notify` crate
selects its upstream `PollWatcher` on Kandelo, so filesystem monitoring
uses polling. Implementing kernel filesystem notifications and exposing
them through libc would allow an event-driven watcher without changing
Codex itself.

Upstream Codex selects its command-policy sandbox only on Linux, macOS,
or Windows. It has no Kandelo sandbox backend. Per-command filesystem
and network restrictions inside a Kandelo machine would need a platform
policy interface and a corresponding Codex backend; this port does not
claim those restrictions or select another OS's sandbox.

## Credential request declaration

The package also installs `/etc/kandelo/credential-requests.d/codex.json`
(`credential-requests.json`, mode 0644). It declares that `/usr/bin/codex`,
titled "Codex", sends account credentials to exactly three HTTPS origins,
`https://auth.openai.com`, `https://chatgpt.com`, and
`https://api.openai.com`, and that its launch waits for the user's answer
(`"launch": "wait"`). It is the declaration the platform's credential
prompt reads; a program that declares nothing is never offered
credentials. The path is the real file, not the `/bin/codex` symlink.

The declaration only names who may receive credentials. It does not grant
anything, and nothing in the platform reads it at runtime as of this
change. The shell image builder validates it with
`parseCredentialRequests` (`host/src/credential-requests.ts`), so a
malformed declaration fails the image build. The local credential relay's
origin list is configured separately and is not derived from this file.

## Networking boundaries

The browser host's existing TLS/fetch bridge transports HTTP(S), rather
than providing arbitrary external TCP or WebSocket forwarding. HTTP(S)
requests in the default browser app use its configured CORS relay. Account
traffic depends on that relay's behavior and trust model. TCP
keepalive options are represented by the kernel but do not currently send
keepalive probes. Neither behavior is changed or hidden by this package.
The default proxy profile is anonymous: it rejects credential fields such as
`Authorization` and rejects unsupported application headers on body-bearing
requests. Codex sends additional request headers, so browser model requests
are blocked by this transport contract even before account authentication.
For local development, the app now has a separate credential relay with an
explicit permission page on an isolated loopback origin. App and guest-preview
scripts cannot read or submit the approval form. It checks consent before receiving guest request
envelopes and forwards only to its configured OpenAI HTTPS origins. The user
must approve the local relay before signing in; approval can be revoked and
does not enable credential forwarding through the public anonymous proxy.
See [local relay permission](../../../docs/browser-support.md#local-credential-relay-permission).
Guest Codex integration and actual subscription use remain unverified.

To sign in from a local development server, open
`<app origin>/__kandelo_credential_relay` (for example
`http://127.0.0.1:5499/__kandelo_credential_relay`), review the disclosure,
and choose whether to allow it. Without approval, sign-in fails at the
relay's credential-free permission check and sends no request envelope.
Then run `codex login --device-auth` and complete the displayed URL and
code in a host browser; Codex finishes signing in on its own. Device-code
login must be enabled for the user's account or workspace. Codex's browser
sign-in redirects to `http://127.0.0.1:1455/auth/callback`, a port of the
user's computer that a browser machine cannot listen on, so it does not
complete in a browser machine.

Signing in does not copy host credentials. See
[OpenAI authentication](https://learn.chatgpt.com/docs/auth).
This recipe does not remove Codex headers or weaken the default proxy profile.
Opening a login URL uses the Unix browser launcher:
a guest browser executable or an explicit platform URL-opening interface is
needed to open it on the host; the Wasm process cannot call the host window.
