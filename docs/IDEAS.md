# Ideas

## 1. On-demand coreutils in browser via lazy-loading filesystem

When running the kernel in the browser, make coreutils (and other binaries) available for use but only download each one on-demand. Consider a special filesystem type for this — e.g. a `LazyFetchFS` that resolves reads to wasm binaries by fetching them from a URL when first accessed, caching in memory after the first load.

This would avoid downloading all coreutils upfront (which adds latency and bandwidth) while still making them available as if they were installed.

## 2. Shareable computers as URL boot descriptors

See [`plans/2026-05-11-shareable-computer-url-design.md`](plans/2026-05-11-shareable-computer-url-design.md).

The promising direction is to share the computer topology rather than
trying to fit every byte into the URL: signed base images, signed
software packages, mount configuration, requested runtime settings, boot
command, and optional compressed overlays when user changes are small
enough to inline.
