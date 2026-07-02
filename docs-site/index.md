---
layout: home
hero:
  name: Kandelo
  text: A browser computer for real software
  tagline: Boot a VFS image and run shells, server software, command-line tools, and graphical experiments in a browser tab.
  actions:
    - theme: brand
      text: Open Kandelo
      link: https://automattic.github.io/kandelo/
    - theme: alt
      text: Use the Browser UI
      link: /guide/current-ui
    - theme: alt
      text: Build a Browser App
      link: /guide/browser-apps
features:
  - title: VFS images are the machine
    details: A VFS image carries the programs, files, configs, and metadata Kandelo needs to boot a browser machine quickly.
  - title: More than one process
    details: Kandelo can run shells, command-line tools, web servers, databases, and early framebuffer/audio demos as cooperating Wasm processes.
  - title: Bring your own software
    details: Build VFS images and publish them through direct links or package-source gallery manifests.
---

::: warning API stability
Kandelo's browser host, VFS image tooling, package-source workflow, and demo metadata are experimental. Public shapes can change at any time. Pin the Kandelo commit or package version you build against, and expect to update your integration as the project evolves.
:::

## What This Site Covers

Use these docs if you want to:

- boot and share machines in the current Kandelo browser UI;
- host a `.vfs` or `.vfs.zst` image and open it through Kandelo;
- build a custom browser app that starts Kandelo directly;
- create, inspect, modify, and publish VFS images;
- publish a gallery source that appears in the Kandelo UI.

## The Dream

The dream is still to "fold a computer into a URL": a link should be able to identify a VFS image, verify the software it references, choose a boot command, and carry small bits of user state. Serious systems will keep large artifacts as signed, cacheable downloads, but the URL should be enough to tell Kandelo what to boot.

For lower-level implementation details, keep using the repository docs:

- [Architecture](https://github.com/Automattic/kandelo/blob/main/docs/architecture.md)
- [Browser support](https://github.com/Automattic/kandelo/blob/main/docs/browser-support.md)
- [Porting guide](https://github.com/Automattic/kandelo/blob/main/docs/porting-guide.md)
- [Package sources](https://github.com/Automattic/kandelo/blob/main/docs/package-sources.md)
- [Package management](https://github.com/Automattic/kandelo/blob/main/docs/package-management.md)
