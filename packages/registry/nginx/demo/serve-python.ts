/**
 * serve-python.ts — Run the nginx + Python (wsgiref) Notes API service VFS
 * on the Node host.
 *
 * dinit starts the Python WSGI app first, then nginx through the dependency
 * graph baked into /etc/dinit.d. nginx serves the static app root and
 * reverse-proxies /api/ to the Python app on 127.0.0.1:8000.
 *
 * Usage:
 *   npx tsx packages/registry/nginx/demo/serve-python.ts [port]
 *
 * Then: curl http://localhost:8080/api/notes
 */

import {
  bootDinitServiceVfs,
  finishWhenDinitExits,
  installSignalHandlers,
  removeServiceLogfiles,
  rewriteNginxListenPort,
  SERVICE_DEMO_ENV,
  trackDinitExit,
  waitForHttp,
} from "../../service-vfs-demo";

async function main() {
  const port = parsePort(process.argv[2] ?? "8080");

  console.log("Booting nginx + Python Notes API VFS with dinit...");
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/nginx-python-vfs.vfs.zst",
      publicFile: "nginx-python-vfs.vfs.zst",
      buildHint: "./run.sh build nginx-python-vfs",
    },
    target: "nginx",
    maxWorkers: 12,
    maxPages: 4096,
    // WHY no PYTHONHOME/PYTHONDONTWRITEBYTECODE here: pid 1 is dinit, and
    // the notes-app service reads those from its own env-file inside the
    // image (/etc/dinit.d/env-python). Passing them to pid 1 as well was
    // left over from when the app was launched directly; dinit does not
    // forward its own environment to a service that names an env-file.
    env: [...SERVICE_DEMO_ENV],
    configure: (fs) => {
      rewriteNginxListenPort(fs, port);
      removeServiceLogfiles(fs, ["notes-app", "nginx"]);
    },
  });

  installSignalHandlers(host);
  const dinitExited = trackDinitExit(exitPromise);

  console.log(`Waiting for nginx + Python Notes API on http://localhost:${port}/...`);
  await waitForHttp(`http://localhost:${port}/api/health`, 180_000, dinitExited);

  console.log("\nnginx + Python Notes API running under dinit.");
  console.log(`  Static page: curl http://localhost:${port}/`);
  console.log(`  Health:      curl http://localhost:${port}/api/health`);
  console.log(`  Notes:       curl http://localhost:${port}/api/notes`);
  console.log("\nPress Ctrl+C to stop.");

  await finishWhenDinitExits(host, exitPromise);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
