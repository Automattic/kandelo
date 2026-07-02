# API Stability

Kandelo is still moving quickly. Assume browser-facing APIs can change at any time unless a future release explicitly marks them stable.

This applies to:

- `BrowserKernel` constructor and boot options;
- browser worker entry packaging;
- package export paths;
- VFS image metadata;
- `/etc/kandelo/demo.json`;
- gallery manifest fields;
- package-source workflow inputs;
- release index details;
- boot URL query parameters and share URL fragments.

## Integration Guidance

For production or long-lived demos:

- pin the Kandelo commit or npm package version;
- store the Kandelo ABI version used to build each image;
- rebuild VFS images after ABI or package-tooling changes;
- test boot in the browser UI after every Kandelo upgrade;
- treat direct source imports such as `@host/browser-kernel-host` as private-to-source-checkout usage;
- watch the repository docs and release notes before updating.

## What Is More Stable

These ideas are core to Kandelo, but individual APIs may still change:

- browser execution requires cross-origin isolation;
- the kernel runs in a dedicated worker;
- browser machines boot from VFS images;
- package-source repositories publish ABI-scoped artifacts;
- the browser gallery shows entries only when matching artifacts are available.

When in doubt, prefer direct VFS image links for simple sharing and package-source repositories for repeatable distribution.
