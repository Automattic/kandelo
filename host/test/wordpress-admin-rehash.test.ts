/**
 * The WordPress image re-salts the published demo admin password's hash on
 * each machine (`wordpressAdminRehashMuPlugin` in
 * `images/vfs/scripts/wordpress-first-boot.ts`).
 *
 * The image is byte-reproducible, so it carries one admin hash for every
 * machine. The contract:
 *
 * - two machines booted from the same image end up with different hashes
 *   after their first request, and the published password logs in to both;
 * - a later boot of the same machine (its filesystem kept) keeps its hash.
 *
 * Runs the real `wordpress` image on the Node host through its dinit service
 * tree, the path `packages/registry/wordpress/demo/serve.ts` uses.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { writeVfsBinary } from "../src/vfs/image-helpers";
import { configureWordPressRuntime } from "../../packages/registry/service-vfs-demo";
import {
  WORDPRESS_SECRETS_PATH,
} from "../../apps/browser-demos/lib/init/wordpress-runtime-config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const imagePath = join(
  repoRoot,
  "local-binaries/source-only-v1/programs/wasm32/wordpress.vfs.zst",
);
const DATABASE = "/var/www/html/wp-content/database/wordpress.db";
const ADMIN_HASH = /\$wp\$2y\$10\$[./A-Za-z0-9]{53}/;

interface MachineState {
  database: Uint8Array;
  secrets: Uint8Array;
}

/**
 * Boot one machine from the image (plus `persisted`, the files a kept
 * filesystem would carry), serve one request, log in, and return the admin
 * hash and the state a later boot of this machine would start from.
 */
async function bootMachine(
  port: number,
  persisted?: MachineState,
): Promise<{ hash: string; loggedIn: boolean; state: MachineState }> {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(imagePath)), {
    maxDecompressedBytes: 1024 * 1024 * 1024,
  });
  configureWordPressRuntime(fs, { port, freshSqliteDatabase: false, phpFpmWorkers: 1 });
  if (persisted) {
    writeVfsBinary(fs, DATABASE, persisted.database, 0o644);
    fs.chown(DATABASE, 65534, 65534);
    writeVfsBinary(fs, WORDPRESS_SECRETS_PATH, persisted.secrets, 0o640);
    fs.chown(WORDPRESS_SECRETS_PATH, 0, 65534);
  }
  const host = new NodeKernelHost({ maxWorkers: 12, maxPages: 4096, rootfsImage: await fs.saveImage() });
  try {
    await host.init();
    await host.spawnFromVfs(
      "/sbin/dinit",
      ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"],
      {
        env: ["HOME=/root", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"],
        cwd: "/",
      },
    );
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 240_000;
    for (;;) {
      const status = await fetch(`${base}/`, { signal: AbortSignal.timeout(60_000) })
        .then(async (r) => { await r.body?.cancel(); return r.status; })
        .catch(() => 0);
      if (status > 0 && status < 500) break;
      if (Date.now() > deadline) throw new Error("WordPress did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
    const login = await fetch(`${base}/wp-login.php`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "wordpress_test_cookie=WP%20Cookie%20check",
      },
      body: new URLSearchParams({ log: "admin", pwd: "password", testcookie: "1" }),
    });
    await login.body?.cancel();
    const loggedIn = (login.headers.getSetCookie?.() ?? [])
      .some((cookie) => cookie.startsWith("wordpress_logged_in_"));
    const database = await host.readFileFromVfs(DATABASE);
    const secrets = await host.readFileFromVfs(WORDPRESS_SECRETS_PATH);
    expect(database).not.toBeNull();
    expect(secrets).not.toBeNull();
    const hash = ADMIN_HASH.exec(new TextDecoder("latin1").decode(database!))?.[0];
    expect(hash).toBeDefined();
    return { hash: hash!, loggedIn, state: { database: database!, secrets: secrets! } };
  } finally {
    await host.destroy();
  }
}

function imageHash(): string {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(imagePath)), {
    maxDecompressedBytes: 1024 * 1024 * 1024,
  });
  const st = fs.stat(DATABASE);
  const fd = fs.open(DATABASE, 0, 0);
  const bytes = new Uint8Array(st.size);
  fs.read(fd, bytes, null, bytes.byteLength);
  fs.close(fd);
  return ADMIN_HASH.exec(new TextDecoder("latin1").decode(bytes))![0];
}

describe.skipIf(!existsSync(imagePath))("WordPress admin hash re-salting", () => {
  it("gives each machine its own hash of the demo password and keeps it on a later boot", async () => {
    const shipped = imageHash();
    const port = 39100 + (process.pid % 400);
    const first = await bootMachine(port);
    const second = await bootMachine(port + 1);

    expect(first.hash).not.toBe(shipped);
    expect(second.hash).not.toBe(shipped);
    expect(first.hash).not.toBe(second.hash);
    // The published password still logs in (WordPress verified it).
    expect(first.loggedIn).toBe(true);
    expect(second.loggedIn).toBe(true);

    const later = await bootMachine(port + 2, first.state);
    expect(later.hash).toBe(first.hash);
    expect(later.loggedIn).toBe(true);
  }, 600_000);
});
