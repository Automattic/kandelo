# Tools

Repository-local tooling lives here.

- `xtask/` is the Rust automation CLI for package resolution, archive staging,
  index generation, ABI dumps, and related release tasks.
- `mkrootfs/` is the Node.js CLI for building root filesystem images from a
  manifest and source tree.
- `common-memory-prototype/` is a trusted standalone Wasm experiment for
  process-private and shared virtual mappings in one common memory, with
  cross-worker correctness checks and diagnostic translation-cost benchmarks.
  See the [mechanism measurements](../docs/measurements/2026-11-10-common-memory-prototype.md)
  and [individual/combined optimization results](../docs/measurements/2026-11-10-common-memory-optimizations.md).
  It does not change the shipping runtime or implement Kandelo fork.
- `common-memory-program/` extends that experiment to checked whole-program
  rewriting, ordinary Kandelo fork, and real PHP-FPM shared OPcache in an
  isolated opt-in host profile. See its [README](common-memory-program/README.md)
  and [PHP-FPM mechanism report](../docs/measurements/2026-11-10-common-memory-php-fpm.md).

General workflow entry points can remain under `scripts/`; reusable tools with
their own dependencies should live here.
