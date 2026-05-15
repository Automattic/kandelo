# DOOM browser demo assets (intentionally empty)

The DOOM browser demo (`examples/browser/pages/doom/`) fetches the
shareware `doom1.wad` (id Software, freely redistributable) at page
load from a Linux-distro mirror, verifies the SHA-256, and caches the
bytes via the Cache API. Nothing in this directory is loaded by the
demo — see `examples/browser/pages/doom/main.ts`.

Drop a custom `doom1.wad` here only if you're patching the demo to
bypass the runtime fetch.
