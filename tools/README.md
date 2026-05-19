# Tools

Repository-local tooling lives here.

- `xtask/` is the Rust automation CLI for package resolution, archive staging,
  index generation, ABI dumps, and related release tasks.
- `mkrootfs/` is the Node.js CLI for building root filesystem images from a
  manifest and source tree.

General workflow entry points can remain under `scripts/`; reusable tools with
their own dependencies should live here.
