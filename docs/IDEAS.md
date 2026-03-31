# Ideas

## 1. On-demand coreutils in browser via lazy-loading filesystem

When running the kernel in the browser, make coreutils (and other binaries) available for use but only download each one on-demand. Consider a special filesystem type for this — e.g. a `LazyFetchFS` that resolves reads to wasm binaries by fetching them from a URL when first accessed, caching in memory after the first load.

This would avoid downloading all coreutils upfront (which adds latency and bandwidth) while still making them available as if they were installed.
