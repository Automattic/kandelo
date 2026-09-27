/**
 * The WordPress images' first-boot secrets service
 * (`images/vfs/scripts/wordpress-first-boot.ts`).
 *
 * The images are byte-reproducible, so they cannot carry WordPress's keys and
 * salts; each machine writes its own on first boot. The contract:
 *
 * - two first boots of the same image produce different secrets;
 * - a later boot of the same machine (its filesystem kept) keeps them;
 * - the file is readable by PHP-FPM's `nobody` workers and writable by no one
 *   but root.
 *
 * The script runs here exactly as dinit runs it (`/bin/bash <script>`), on the
 * canonical shell rootfs with the script installed the way the image builders
 * install it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import {
  WORDPRESS_SECRETS_SCRIPT,
  populateWordPressFirstBootSecrets,
} from "../../images/vfs/scripts/wordpress-first-boot";
import {
  WORDPRESS_SECRETS_PATH,
  WORDPRESS_SECRET_NAMES,
} from "../../apps/browser-demos/lib/init/wordpress-runtime-config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rootfsPath = join(repoRoot, "host/wasm/rootfs.vfs");
const haveRootfs = existsSync(rootfsPath);

async function imageWithService(): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(rootfsPath)), {
    maxDecompressedBytes: 1024 * 1024 * 1024,
  });
  populateWordPressFirstBootSecrets(fs);
  return fs.saveImage();
}

interface Machine {
  host: NodeKernelHost;
  run(argv: string[]): Promise<string>;
  runService(): Promise<string>;
  secrets(): Promise<string>;
}

async function boot(image: Uint8Array): Promise<Machine> {
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: image,
    onStdout: (_pid, data) => { output += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { output += new TextDecoder().decode(data); },
  });
  await host.init();
  const machine: Machine = {
    host,
    async run(argv) {
      output = "";
      const { exit } = await host.spawnFromVfs(argv[0], argv, {
        env: ["PATH=/usr/sbin:/usr/bin:/sbin:/bin"],
        cwd: "/",
      });
      expect(await exit, output).toBe(0);
      return output;
    },
    runService() {
      return machine.run(["/bin/bash", WORDPRESS_SECRETS_SCRIPT]);
    },
    async secrets() {
      const bytes = await host.readFileFromVfs(WORDPRESS_SECRETS_PATH);
      expect(bytes).not.toBeNull();
      return new TextDecoder().decode(bytes!);
    },
  };
  return machine;
}

function keyValues(file: string): string[] {
  return WORDPRESS_SECRET_NAMES.map((name) => {
    const match = new RegExp(`define\\('${name}', '([A-Za-z0-9_-]{64})'\\);`).exec(file);
    expect(match, `${name} in:\n${file}`).not.toBeNull();
    return match![1];
  });
}

describe.skipIf(!haveRootfs)("WordPress first-boot secrets", () => {
  it("gives each machine its own secrets and keeps them on its later boots", async () => {
    const image = await imageWithService();

    const first = await boot(image);
    const second = await boot(image);
    try {
      // Until the service runs, the file is the image's placeholder, which
      // stops WordPress instead of letting it run without keys.
      expect(await first.secrets()).toContain("throw new RuntimeException");
      expect(await first.runService()).toContain("generated this machine's secrets");
      expect(await second.runService()).toContain("generated this machine's secrets");
      const a = keyValues(await first.secrets());
      const b = keyValues(await second.secrets());
      // Eight distinct keys per machine, none shared between machines.
      expect(new Set(a).size).toBe(8);
      for (const value of a) expect(b).not.toContain(value);

      // A later boot of the same machine keeps what it generated.
      const before = await first.secrets();
      expect(await first.runService()).toContain("keeping this machine's secrets");
      expect(await first.secrets()).toBe(before);

      // Root writes it; PHP-FPM's nobody workers (gid 65534) may only read.
      const mode = await first.run([
        "/bin/sh",
        "-c",
        `stat -c '%a %u %g' ${WORDPRESS_SECRETS_PATH}`,
      ]);
      expect(mode.trim()).toBe("640 0 65534");
    } finally {
      await first.host.destroy();
      await second.host.destroy();
    }
  }, 180_000);
});
