# Start Kandelo In Your Browser App

::: warning API stability
The high-level browser host API is in flux. The current Kandelo UI imports `BrowserKernel` from the source tree, and the package-level export surface is still being finalized. Treat the code below as a current integration pattern, not a stable SDK contract.
:::

Kandelo browser apps have four moving pieces:

1. a browser page for UI;
2. a dedicated kernel worker that owns `kernel.wasm`;
3. process workers for guest programs;
4. a VFS image that contains the filesystem and boot program.

The preferred boot path is kernel-owned VFS:

```ts
const kernel = new BrowserKernel({ kernelOwnedFs: true });
const { pid, exit } = await kernel.boot({
  vfsImage,
  argv: ["bash", "-l", "-i"],
  cwd: "/home/user",
  uid: 1000,
  gid: 1000,
  pty: true,
});
```

In this mode, the main thread never owns the filesystem. It passes the VFS image bytes to the kernel worker, and the worker restores the filesystem internally before starting the first process.

## Current Source-Checkout Import

Inside this repository, browser pages import the host wrapper through the Vite alias configured by `apps/browser-demos`:

```ts
import { BrowserKernel } from "@host/browser-kernel-host";
```

For an app outside this repository, expect the import path and asset-handling contract to change as the npm browser API is stabilized. Until then, the safest external integration is to pin a Kandelo commit and mirror the browser demo app's Vite setup.

## Minimal Boot Shape

The following is the shape of a simple app that boots a VFS image with a PTY. The exact import path is intentionally shown as a placeholder because the public package export is not final.

```ts
import { BrowserKernel } from "YOUR_PINNED_KANDELO_BROWSER_HOST";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const log = document.querySelector("#log")!;
const input = document.querySelector("input") as HTMLInputElement;

const vfsImage = new Uint8Array(
  await fetch("/images/shell.vfs.zst").then((r) => r.arrayBuffer()),
);

const kernel = new BrowserKernel({
  kernelOwnedFs: true,
  onStdout: (data) => {
    log.textContent += decoder.decode(data);
  },
  onStderr: (data) => {
    log.textContent += decoder.decode(data);
  },
});

const { pid, exit } = await kernel.boot({
  vfsImage,
  argv: ["bash", "-l", "-i"],
  cwd: "/home/user",
  env: [
    "HOME=/home/user",
    "USER=user",
    "LOGNAME=user",
    "TERM=xterm-256color",
    "LANG=en_US.UTF-8",
  ],
  uid: 1000,
  gid: 1000,
  pty: true,
});

kernel.onPtyOutput(pid, (data) => {
  log.textContent += decoder.decode(data);
});

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  kernel.ptyWrite(pid, encoder.encode(input.value + "\n"));
  input.value = "";
});

exit.then((code) => {
  log.textContent += `\nprocess exited with ${code}\n`;
});
```

## Hosting Requirements

Your app needs the same browser isolation that the Kandelo UI needs:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

When hosting on a platform that cannot set custom headers, use a service worker strategy like the Kandelo UI does. The worker also needs to serve or rewrite cross-origin assets so they are compatible with cross-origin isolation.

## Assets

A browser app normally needs:

- `kernel.wasm`
- a `.vfs` or `.vfs.zst` image
- any lazy file or lazy archive assets referenced by that image
- worker entry scripts emitted by the host runtime bundle
- optional UI libraries such as xterm.js for terminals

If the VFS image contains lazy files or lazy archives with relative URLs, pass the correct `lazyUrlBase` when booting:

```ts
await kernel.boot({
  vfsImage,
  lazyUrlBase: new URL("/assets/", location.href).href,
  argv: ["bash", "-l", "-i"],
});
```

## Service Worker HTTP Bridge

For server demos such as nginx or WordPress, browser fetches cannot connect to a real local TCP port. The Kandelo UI uses a service worker to intercept requests under an app prefix and forwards the raw HTTP request to the kernel worker. The kernel injects that request into the guest TCP listener.

Use this pattern when your guest software is an HTTP server:

1. register a service worker;
2. boot the VFS image with the server process or dinit service tree;
3. wait for the guest to bind the expected TCP port;
4. connect the service worker MessagePort to the kernel;
5. point an iframe or fetch call at the service-worker app prefix.

The implementation to study is:

```text
apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts
apps/browser-demos/public/service-worker.js
```

## Legacy Main-Thread VFS

Older demos restore `MemoryFileSystem` on the main thread and call `kernel.spawn(...)`. That path is still used by some browser labs, but new apps should prefer `kernelOwnedFs: true` and `kernel.boot({ vfsImage })`.
