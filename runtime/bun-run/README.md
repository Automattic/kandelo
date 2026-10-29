# bun-run.js

`bun-run.js` is the Kandelo bootstrap that runs a Bun-compiled standalone
executable on `spidermonkey-node`. It shells out to `bun-extract --prepare
<binary> <cache-root>` to extract (or reuse a cached extraction of) the
executable's embedded module graph, installs a thin `globalThis.Bun` shim and
`globalThis.__breq` module-require helper that the extracted app expects at
runtime, rewrites `process.argv` to the app's own view (`[node, entry,
...appArgs]`), and then natively `import()`s the cached `.mjs` entry point in
the current process. It is invoked as `node /usr/lib/kandelo/bun-run.js
<bun-executable> [app args...]` and exits non-zero with a `bun-run: ...`
message on stderr if extraction fails, the input isn't a recognizable Bun
executable, or the app's entry module fails to load.

The `bun-run` registry package builds the launcher and extractor and declares
the bootstrap as a runtime file. The shell's lazy `node.zip` includes all
three alongside `/usr/bin/node`. Invoke the launcher explicitly:

```sh
bun-run /path/to/standalone-executable --help
```

After successful extraction, the Bun shim reports the standalone bundle origin
with `isStandaloneExecutable: true` and exposes the extracted entry as `Bun.main`.
This preserves bundled resource selection; the host still executes JavaScript
on SpiderMonkey, and `process.arch` remains the actual guest architecture.
`Bun.unsafe` is an empty namespace: JavaScriptCore-specific controls such as
`setJITPolicy` are absent, so optional feature detection can skip them. The
runner does not expose a fake JIT control on SpiderMonkey.

The launcher uses a private directory at `/tmp/kandelo-bun-run-<effective-uid>`.
It rejects symlinks, foreign ownership, and group/other permissions there. The
extractor serializes cache publication with a POSIX file lock and publishes its
completion manifest only after successful writes. The cache lives on tmpfs and
does not survive a machine reboot. Direct JavaScript-bootstrap invocation uses
a fresh private temporary directory instead.

For npm distributions that publish Bun executables in architecture-labelled
packages, select the payload explicitly using npm's documented `--cpu` and
`--libc` options. This selects download data without changing `process.arch`:

```sh
npm install --cpu=x64 --libc=glibc @anthropic-ai/claude-code-linux-x64@2.1.300
bun-run ./node_modules/@anthropic-ai/claude-code-linux-x64/claude --version
```

Installation must fit the machine's filesystem memory budget. The development
browser relay's 100 MiB response cap rejects this version's 119,473,462-byte
tarball with HTTP 413. The default browser proxy profile enables anonymous
direct CORS fallback for that response. npm then downloads the unchanged
registry URL directly and verifies its integrity; the explicit npm payload
install and cold version/help calls pass in Chromium, Firefox, and WebKit.
Profiles without that fallback still need downloads within their relay cap.
Splitting a download into bounded ranges requires checking the integrity
of the complete archive; it does not increase available filesystem memory.
Retaining compressed archives and npm cache entries during extraction can
exhaust that budget. A failed install or a truncated executable is not a
usable Bun payload. See `docs/browser-support.md`, "Package compatibility and
lifecycle scripts", for these boundaries.

This route bypasses the upstream wrapper's architecture selection by installing
the payload package directly. `npm install @anthropic-ai/claude-code` still
selects for the actual wasm32 guest and leaves an unsupported-platform
placeholder. Native machine code and native addons inside a payload are not
executed by this runner. Full application compatibility also depends on the
Node and Bun APIs the extracted JavaScript uses.
