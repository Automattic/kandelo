#!/usr/bin/env node --experimental-strip-types

import {
  bootDinitServiceVfs,
  configureWordPressRuntime,
  finishWhenDinitExits,
  installSignalHandlers,
  trackDinitExit,
  waitForHttp,
} from "../../service-vfs-demo";

const port = Number(process.argv[2] ?? "3000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("port must be an integer between 1 and 65535");
}

const { host, exitPromise } = await bootDinitServiceVfs({
  image: {
    relPath: "programs/wordpress.vfs.zst",
    publicFile: "wordpress.vfs.zst",
    buildHint: "./run.sh build wp-vfs",
  },
  imagePath: process.env.KANDELO_WORDPRESS_FRANKENPHP_IMAGE,
  target: "frankenphp-classic",
  maxWorkers: 12,
  maxPages: 4096,
  configure: (fs) => configureWordPressRuntime(fs, {
    port,
  }),
  env: [
    "HOME=/root",
    "TERM=xterm-256color",
    "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
    "WP_APP_PATH=/",
    "WP_PROTO=http",
    `FRANKENPHP_LISTEN=:${port}`,
  ],
});

installSignalHandlers(host);
const dinitExited = trackDinitExit(exitPromise);
await waitForHttp(`http://localhost:${port}/`, 180_000, dinitExited);

console.log(`WordPress on Kandelo FrankenPHP: http://localhost:${port}/`);
console.log(`Admin: http://localhost:${port}/wp-admin/`);
await finishWhenDinitExits(host, exitPromise);
