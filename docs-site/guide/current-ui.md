# Current Kandelo UI

::: warning API stability
The Kandelo UI and every browser-facing boot URL shape documented here are experimental. They are useful today, but they are not a long-term compatibility promise.
:::

The public Kandelo UI is available at:

```text
https://automattic.github.io/kandelo/
```

It boots computers from filesystem images in the browser. Open **Library**
to create or reopen a computer, then use **Activities** to start installed
apps without rebooting it.

## Requirements

Kandelo needs a secure context (HTTPS, or a trustworthy local address such as
`127.0.0.1`) and cross-origin isolation to expose `SharedArrayBuffer`:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The static deployment uses a service worker to add the required isolation
headers. Reload if an old worker is still active. Clearing site data also
removes local computers; export important files before doing so.

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

## Computers and Activities

Choose **Library → New computer**, then an image: **Base Shell**, **Web Stack**,
or **WordPress**. Give it a name and choose temporary or saved storage.
Library reopens, renames, keeps, and deletes local computers. A computer's
`?computer=<UUID>` URL reopens its own filesystem on reload; it is not a
shareable copy of that filesystem.

Temporary computers also use browser disk storage. They become eligible for
cleanup after 24 hours without opening them. Keep one through Library to
retain it. Image-backed files persist; scratch mounts such as `/tmp` reset
on reboot. Browser storage is not a backup.

::: warning Experimental persistence
Saved computers from this release will not work in the next release.
Export important files before updating Kandelo. Transactional software
upgrades are not implemented yet.
:::

**Activities** starts installed programs on the running computer. Independent
apps can run together; an app that needs a display or managed website port
already in use stops the conflicting activity first. **Web** and **Graphics**
switch between the website preview and graphical display without restarting
their programs. Terminal, file browsing, and process information remain
available from the dock.

Web Stack includes nginx, PHP/Adminer, Python Notes, Ruby Todo, and a Redis
voting board. Games and tools such as Doom, Quake, Freeciv, and LÖVE are
activities on the base shell. See
[computer storage and retention](https://github.com/Automattic/kandelo/blob/main/docs/browser-support.md#computer-library-and-retention)
for the full storage behavior.

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

**More → Share setup…** creates a link with startup settings and an optional
shell script. It shares starting inputs, not the current filesystem or a
network invitation. The script travels in the URL's `#k1=` fragment as a
size-capped, checksum-verified payload.

When someone opens the link, the machine boots, the script's full contents are printed in the terminal, and it then runs in the initial shell — bash on images that ship it. The script file is left in place at `/run/kandelo/inputs/script/kandelo-link.sh`, writable, so the visitor can inspect, edit, and re-run it. Opening the Share dialog on a machine booted from such a link pre-fills the editor with the inherited script, so a received link can be tweaked and re-shared.

Scripts currently run without a confirmation step. A malformed or oversized
fragment fails with a visible error. Selecting a different computer drops
the fragment; it does not carry that script into the selected computer.

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

Open the dock's network panel to create an invitation. Choose an installed
activity, such as termchat or a multiplayer game, or share a plain network
room. Packages supply the activity's setup and join steps. The host forwards
IPv4 UDP and TCP between members. Leaving or replacing a hosted room
disconnects its members; their programs keep running. See
[package-declared sessions](https://github.com/Automattic/kandelo/blob/main/docs/package-sessions.md).

Doom, Quake and Freeciv offer game activities in the network panel. Doom's
waiting room shows joined players; the host can press Space to start early
or Esc to quit. Quake's own multiplayer menus can also discover session
peers. Freeciv's launcher uses a direct TCP connection to the session host
rather than depending on discovery. See [Freeciv multiplayer](https://github.com/Automattic/kandelo/blob/main/packages/registry/freeciv/README.md#multiplayer).
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
