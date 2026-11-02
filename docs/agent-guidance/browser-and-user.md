# Browser And User Contract

The browser UI is a consumer and presentation layer for the platform. It
should expose the real state of a Kandelo machine, not synthesize success or
implement alternate runtime behavior.

`web-libs/kandelo-session` owns reusable browser-facing contracts:
`KernelHost`, boot descriptors, snapshots, demo configuration parsing, gallery
metadata, and sharing behavior. App-specific React wiring and page fixtures
belong under `apps/browser-demos`.

The main thread must never own a VFS `SharedArrayBuffer` — live or staging.
The kernel worker owns the live filesystem (`kernelOwnedFs`), and boot-time
image composition runs in a disposable worker
(`apps/browser-demos/pages/kandelo/kernel-host/image-composer.ts`) whose
staging buffer dies with its realm. `Worker.terminate()` is the only mechanism
that reclaims a shared buffer deterministically on WebKit — a buffer the
persistent main thread merely dropped is released only if a garbage collection
happens to run, and reserved shared memory creates almost no heap pressure to
trigger one, so main-thread VFS buffers accumulate across machine boots until
Safari throws `Out of memory` (#863). Treat any new main-thread
`SharedArrayBuffer` or long-lived image buffer in a boot path as a defect:
compose in a worker and hand the main thread plain, transferable bytes (an
image composed with `KandeloImageFs` lives in that module's memory, which is
why the composer runs in a worker). A GC nudge
(`settleWebKitReclaim` in `apps/browser-demos/lib/kernel-owned-boot.ts`, still
used by the benchmark page's main-thread build path) is best-effort with a
deadline and does not count as reclamation.

`KernelHost` is a compatibility surface. UI surfaces should consume machine
state through that contract: status, boot descriptor, dmesg, process events,
PTY, VFS reads, proc/memory inspection, syscall trace, framebuffer, web
preview, presentation preferences, demo guide, and snapshots. Avoid reaching
around it unless the behavior is truly app-local.

Agent tools must use that same surface. Run guest commands and file writes
as the configured guest account, collect output from owned command families,
and keep agent commands separate from the user's interactive input. A signal
being sent is not proof that a job finished: require authoritative process
exit, exact worker detachment, and process-record cleanup. Refresh image tools
from notifications emitted by the filesystem owner; a host-side file cache
cannot know what a guest changed. See `docs/webmcp.md` for the tool contract.

Use the same precedence rules for initial tool loading, a full refresh, and
a single-file update. Choose the definition that owns a name before parsing
it. A malformed user override must remain disabled rather than unexpectedly
restoring a different shipped command; removal can restore the fallback.

Distinguish guest account permissions from browser origin authority. Guest
web pages run on a separate preview origin, served by its own service worker
through the owning tab's `PreviewBridgeHost` (`apps/browser-demos/lib/preview/`,
`apps/browser-demos/preview-origin/`). Never serve guest bytes from the app's
origin, never add a same-origin fallback when a deployment has no preview
origin (fail with the explicit error), and keep the preview frame sandboxed
without top navigation. Treat every message from the preview origin as
untrusted: guest pages share that origin, can script the relay frame and
forge its messages, and are not isolated from each other. The preview
worker must not route by URL alone: it refuses a request it attributes to
one machine's page for another machine's address, and its broadcasts name
a machine only by a hash of its name; keep both when changing the worker.
Keep the guest's cookie jar in the owning tab, never in a service worker
or persistent storage. Changes to the preview path must keep
`apps/browser-demos/test/preview-isolation.spec.ts` and
`preview-service-worker.spec.ts` passing on all three engines; see
`docs/browser-support.md`, "Guest web previews run on their own origin".
The preview origin's own files (its service worker, relay page and
relay script) live in `apps/browser-demos/preview-origin/`; the app-side
bridge, relay client, cookie jar and name commitment live in
`apps/browser-demos/lib/preview/`. A deployment without a preview origin
has no web previews; that is the documented failure, not a gap to fill
with same-origin serving. A deployment may put its preview origin on the
app's site or on another site (`docs/browser-support.md`, "Choosing a
preview origin"); keep both working. When the browser denies the preview
origin storage, the pane must say so from the relay's real failure (the
`SecurityError` from registering the preview worker), never from the user
agent; `apps/browser-demos/test/preview-storage-blocked.spec.ts` covers it
on both layouts.

Credential request fields (`Authorization`, `ChatGPT-Account-ID`) leave
a browser machine through Kandelo's proxy and relay path only for a
process holding a kernel-recorded per-process credential grant
(`Process::credential_grant`; see `docs/architecture.md`, "Credential
grants"). Nothing else lets those fields through: no site-wide approval,
no remembered allow, no per-program or per-package permission. The grant
governs header fields, not data: a token stored in a guest file (Codex's
`~/.codex/auth.json`) or carried in a request body (device-code sign-in,
token refresh) is ordinary data that any process of the same guest user
can read and send, granted or not. Never describe the grant as
protecting a token from other guest processes, a malicious image, or a
binary placed at a declared path; `docs/browser-support.md`, "What a
credential grant does not protect", is the authoritative list. Keep
these invariants:

- Never add a credential field (`Authorization`, `ChatGPT-Account-ID`,
  `Cookie`, `Proxy-Authorization`, ...) to Kandelo's proxy profile; the
  profile parser refuses one, and only the grant path relays a
  credential. A CORS proxy or relay may accept a credential field only
  because Kandelo's kernel worker and service worker refuse every
  credential without a verified grant; do not add credential fields to a
  proxy's allow-list or forwarding for any other caller or path.
- Never allow-list `X-Kandelo-Credential-Grant` in any CORS proxy's
  preflight or forward it. The service worker removes the tag after
  verifying it, so a request that still carries it skipped that gate and
  must fail visibly at the proxy.
- Never strip an ungranted credential and send the request anyway;
  refuse it before dispatch.
- The Node host has no CORS proxy and no service-worker gate: programs
  open real sockets, so the prompt and grant exist there for host parity
  only, and every Node question says so (`enforcement: "none"`; the
  browser's say `"proxy-gate"`). That is a documented host boundary; do
  not describe Node as gating credentials.
- A request is attributed to its writer only on a connection whose
  engine negotiated TLS 1.2, whose record framing the attribution
  follows; any other or unknown version means no request on that
  connection is granted. Keep that fail-closed check if the engine
  changes.

The service worker's credential gate is a second gate behind the kernel
worker's, not a replacement for it. Keep it accepting tags only from the
kernel worker's entry script (whose URL the build injects), keep its
answers in memory only, never let the grant tag leave the browser, and
never serve a CORS proxy's answer as anything but `fetch()` data. Do not
describe it as protecting against code the app's origin runs: that code
can start its own kernel worker. The app's origin is trusted because guest
previews do not run on it. Its names mirror host constants; the parity
test in `host/test/browser-cors-proxy-service-worker-parity.test.ts` and
`apps/browser-demos/test/credential-gate.spec.ts` on all three engines
cover it (see `docs/browser-support.md`, "Per-process credential
grants").

The development credential relay (`apps/browser-demos/vite/credential-relay.ts`)
has no permission of its own: the per-process grant is its only
permission. Keep the service worker gating requests to it like requests
to the proxy, keep it carrying a credential only with the opt-in and
refusing a request that still carries a tag, and do not add back an
approval page, session or site-wide consent.
`host/test/credential-relay.test.ts` and
`apps/browser-demos/test/credential-relay.spec.ts` (all three engines)
cover it.

The credential prompt belongs to the app, behind
`KernelHost.setCredentialRequestHandler`. Keep it in Kandelo's own UI,
never in terminal output; keep deny the default (no handler, Escape, a
withdrawn question, a replaced handler, a detached kernel); keep Allow,
and the choices that answer for more than one question, disarmed for the
input delay after every question appears, queued ones included, so input
aimed elsewhere cannot answer it; never add a "remember" choice that
allows or any persistent grant state (the one remembered choice, "Don't
allow, and stop asking for this machine", only denies and lives in
memory until the machine goes away); keep a flood of questions bounded
(the kernel worker's per-machine cap, "Deny all waiting" for a burst,
and "stop asking" as the only choice that ends an endless launch loop)
so a guest cannot keep the user from the terminal; keep the program path and
the image's provenance visible, because a declared program is
identified only by its path; and keep the intermediary each credentialed
request passes through (`CredentialRequest.transport`: the CORS proxy or
development relay by origin and path, "cannot be sent" with no proxy,
"directly" on Node) and the fact that its operator can read the
credentials in the dialog's main body, never only under Details. When the program's file changed after boot
(`programChangedSinceBoot`), say so prominently and never credit the
file to the image. The image source the app passes
(`credentialImageSource`) must be where the bytes were actually fetched
from, never something the image says about itself.
`apps/browser-demos/test/credential-request-dialog.spec.ts` covers it on
all three engines.

Boot descriptors and shared URLs are untrusted input. They need explicit
versioning, size caps, mount limits, path validation, allowed source kinds, and
loud failures for malformed or oversized payloads. Do not relax validation to
make a broken link load.

Browser persistence and sharing are part of the platform contract, not
presentation details. When state lives in IndexedDB, localStorage, service
worker cache, a remote artifact, or a share URL, make the actual guarantees
explicit: whether it is durable or clearable, private to this browser/profile
or intentionally shareable, bounded by URL/storage limits, and tied to a
trusted origin or content hash. Do not present ephemeral, user-local,
remote-fetched, or URL-encoded state as if it were a durable, private,
verified platform image.

VFS images are product artifacts and system state. They should contain the
runtime files, symlinks, configs, service definitions, metadata, and assets
needed by a demo. If a demo needs presentation preferences, default surface
order, an auto-command, guide data, or image-declared assets, put that in
`/etc/kandelo/demo.json` via the VFS image builder rather than hardcoding
package-specific fallbacks in the app loader.

Absence of demo metadata is valid. The app should use generic defaults, not
package-name conditionals. If metadata for an existing package-backed image
changes, bump the relevant package/build revision so the image is rebuilt
through the normal package path.

A deployment update must not break the first reload of an open tab (see
`docs/browser-support.md`, "Deployment updates"). Keep VFS groups at their
content address (`vfs-groups/sha256-<manifest digest>/`), never a fixed
path whose bytes change between builds; keep the build-id check that makes
a page wait for its own build's service worker before boot starts any
worker; keep its automatic reload to one per (page build, worker build)
pair; and do not add another `registration.update()` call to a page that
the navigation already updates. `apps/browser-demos/test/deployment-update.spec.ts`
(real production builds, run with `KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT`)
covers a changed group and an app-only change on all three engines.

User-visible failures should reveal real platform failures. Missing binaries,
failed VFS image fetches, ABI mismatches, service startup failures, worker
crashes, service-worker failures, and blocked processes should surface as
explicit errors, logs, statuses, or diagnostics. Do not convert them into
silent loading states or optimistic UI.

Browser demos should boot software through the platform: VFS image,
dinit/service tree where appropriate, kernel loopback TCP, service-worker
bridge, PTY, framebuffer, audio, input devices, and normal process lifecycle.
Demo pages may provide controls and presentation, but should not implement
substitutes for package scripts, runtime files, process supervision,
networking, devices, or terminal behavior.
