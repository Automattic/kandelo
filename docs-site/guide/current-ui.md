# Current Kandelo UI

::: warning API stability
The Kandelo UI and every browser-facing boot URL shape documented here are experimental. They are useful today, but they are not a long-term compatibility promise.
:::

The public Kandelo UI is available at:

```text
https://automattic.github.io/kandelo/
```

It boots prebuilt machines in the browser using `kernel.wasm`, package artifacts, and VFS images. The first screen lets users boot a preset, paste a Kandelo URL, or bring a VFS image.

## Requirements

Kandelo needs a secure context (HTTPS, or a trustworthy local address such as
`127.0.0.1`) and cross-origin isolation to expose `SharedArrayBuffer`:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The GitHub Pages deployment uses a service worker to add the required isolation headers. If the page reports that `SharedArrayBuffer` is unavailable, clear site data and reload. A stale service worker can keep old behavior alive.

## Local Development

From a Kandelo checkout:

```bash
./run.sh browser
```

Open:

```text
http://127.0.0.1:5401/
```

`./run.sh browser` builds or reuses the supported local graph and points Vite
at its validated source-only projection. Prefer it to launching Vite directly,
which omits that build and selection step.

## Gallery Presets

The current UI ships local gallery presets such as:

- Bare shell
- Node.js
- nginx
- nginx + PHP
- WordPress SQLite
- WordPress MariaDB
- fbDOOM
- TyrQuake
- Freeciv
- LÖVE games

When a user launches a preset, the UI selects a VFS image, boots the kernel, starts the configured process, and presents the relevant surfaces:

- terminal
- web preview for HTTP demos
- syslog and process internals
- VFS browser
- framebuffer, mouse, keyboard, and audio for demos that expose those devices

The base shell also has PHP CLI and Composer. Each command downloads its
deferred executable or archive on first use. Composer enables its required
PHP extensions for its own invocation; ordinary `php` keeps its usual
configuration, and these shell commands do not install PHP-FPM.

## Direct VFS Links

The UI can boot a direct VFS image URL without a gallery manifest:

```text
https://automattic.github.io/kandelo/?vfs=https://example.com/images/site.vfs.zst
```

Accepted image URL schemes are `http` and `https`. The image should be a `.vfs` or `.vfs.zst` file produced by Kandelo's VFS tooling.

The host serving the image must allow the browser to fetch it from a cross-origin-isolated page. Use CORS or compatible cross-origin resource policy headers.

## Script-Carrying Share Links

The dock's Share button turns the current machine into a link that also runs a shell script when opened. Type a script into the dialog's editor and copy the URL; the script travels in the URL's `#k1=` fragment as a size-capped, checksum-verified payload.

When someone opens the link, the machine boots, the script's full contents are printed in the terminal, and it then runs in the initial shell — bash on images that ship it. The script file is left in place at `/run/kandelo/inputs/script/kandelo-link.sh`, writable, so the visitor can inspect, edit, and re-run it. Opening the Share dialog on a machine booted from such a link pre-fills the editor with the inherited script, so a received link can be tweaked and re-shared.

Scripts run without a confirmation prompt because every machine in the current UI is ephemeral: closing the tab discards everything, so a link can affect only its own session. A malformed or oversized link fragment fails with a visible error instead of booting. Launching a different machine from the gallery drops the fragment, so a script never follows you to another machine.

## External Software

The demo app exposes only repository-defined gallery entries. It does not
request third-party software manifests. To launch an externally published
image, use a [direct VFS link](#direct-vfs-links).

## Network Behavior

Browser Kandelo supports local loopback sockets, virtual machine-to-machine
networks inside one browser session, and WebRTC network sessions between
computers. Internet egress uses fetch/TLS bridges, exposed to guests as a
TCP-only link; external UDP fails with `EHOSTUNREACH`. Browser sandboxing
still prevents raw TCP/UDP sockets to arbitrary internet endpoints. The
service worker HTTP bridge lets browser requests reach guest web servers.

### Network Sessions

Open the dock's network panel on a running computer and create a session.
Its invite link names the machine image and profile and opens the recipient's
panel; the recipient clicks **Join** to connect. The host forwards IPv4 UDP
and TCP between members. Leaving or booting another machine ends that
computer's participation; when the host leaves, the session ends for everyone.
Invite links do not carry the startup-script fragment from a Share link.

Doom's **LAN game** dock menu can host a private game or join one in the
session. Its waiting room shows joined players; the host can press Space
to start early or Esc to quit. Quake's multiplayer menus can discover session
peers. Freeciv's **Multiplayer** dock menu can host a server or join the
session host; it uses a direct connection because multicast discovery does
not reach peer machines. See [Freeciv multiplayer](https://github.com/Automattic/kandelo/blob/main/docs/freeciv.md#multiplayer).
These are LAN links, not arbitrary internet UDP access. The default connection setup
uses STUN without a TURN relay, so some network layouts cannot connect.
Current guest-session validation covers Chromium; Firefox/WebKit guest
behavior and general internet paths between computers remain unverified.

Network sessions need a signalling server as well as the browser app. The
development server runs the PHP piplet. A standalone production build includes
`signalling/piplet.php`, requiring 64-bit PHP 8.3+ and a writable directory;
static-only hosting needs a separately hosted endpoint selected at build time
with `./run.sh build-browser --signalling-url URL`. The optional combined
Spacefast package uses its database-backed `/signalling` Function instead,
leaving the portable PHP build available for other hosts. Both clients must
have access if that Space is private. See the
[network-session reference](https://github.com/Automattic/kandelo/blob/main/docs/browser-support.md#purpose-checked-browser-peer-connections)
for connection settings, deployment, and validation limits.

### Cross-Origin HTTP Requests

The browser app defaults cross-origin fetches to:

```text
https://wordpress-playground-cors-proxy.net/?
```

For local development:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

The URL selects the transport endpoint; it does not define a second capability
profile. Kandelo currently relays only `Accept`, `Content-Type`,
`git-protocol`, `Range`, `wp_blog`, and `wp_install` at configured proxy
boundaries, and repeats `Range` as `X-Cors-Proxy-Range`, because WP Cloud,
which hosts the default proxy, strips `Range` before it reaches the proxy.
Anonymous bodyless GETs may omit other fields with a diagnostic. Requests that
would lose credentials, a body, or state-changing semantics fail before proxy
dispatch. Direct browser requests and Node.js-host networking are unchanged.

The optional Spacefast proxy also requires a quota-session credential. The
current app obtains it through the proxy's PHP session Function and stores it
on the app's origin, without needing third-party cookies. Deploy the app,
proxy, and session endpoint together and reload existing tabs after upgrading
that protocol. The ordinary Playground proxy does not use this handshake.
See [Spacefast deployment and limits](https://github.com/Automattic/kandelo/blob/main/apps/spacefast-cors-proxy/README.md#combined-kandelo-site).
