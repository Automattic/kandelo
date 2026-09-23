# Browser And User Contract

The browser UI is a consumer and presentation layer for the platform. It
should expose the real state of a Kandelo machine, not synthesize success or
implement alternate runtime behavior.

`web-libs/kandelo-session` owns reusable browser-facing contracts:
`KernelHost`, boot descriptors, snapshots, demo configuration parsing, gallery
metadata, and sharing behavior. App-specific React wiring and page fixtures
belong under `apps/browser-demos`.

The main thread must never own a VFS `SharedArrayBuffer`. The kernel worker
owns the live filesystem, and `Worker.terminate()` is the only mechanism that
reclaims a shared buffer deterministically on WebKit — a buffer the persistent
main thread holds is released only if a garbage collection happens to run, and
reserved shared memory creates almost no heap pressure to trigger one. Every
main-thread VFS buffer therefore accumulates across machine boots until Safari
throws `Out of memory`. This has been fixed once already (#863 moved the live
filesystem into the worker) and regressed in spirit through a "transient"
main-thread build filesystem, so treat any new main-thread
`MemoryFileSystem`/`SharedArrayBuffer` in a boot path as a defect: compose
images in a worker and hand the main thread plain, transferable bytes. A
buffer that is merely dropped rather than worker-owned does not count as
fixed.

`KernelHost` is a compatibility surface. UI surfaces should consume machine
state through that contract: status, boot descriptor, dmesg, process events,
PTY, VFS reads, proc/memory inspection, syscall trace, framebuffer, web
preview, presentation preferences, demo guide, and snapshots. Avoid reaching
around it unless the behavior is truly app-local.

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
