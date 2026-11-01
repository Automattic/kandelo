import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";

describe("packaged PHP-FPM configuration environment", () => {
  it("reads the host worker budget and a safe unset fallback without rewriting packaged configuration", async () => {
    let output = "";
    const append = (_pid: number, bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); };
    const host = new NodeKernelHost({ rootfsImage: new Uint8Array(readFileSync(resolveBinary("programs/wasm32/wordpress-family-vfs.vfs.zst"))),
      onStdout: append, onStderr: append });
    try {
      await host.init(Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer);
      const bytes = await host.readFileFromVfs("/etc/php-fpm.conf");
      if (bytes === null) throw new Error("WordPress source lacks PHP-FPM configuration");
      const source = new TextDecoder().decode(bytes).replace(/^pm.max_children\s*=.*$/m, "pm.max_children = ${KANDELO_PREFORK_SERVICE_PROCESSES:-1}");
      await host.writeFileToVfs("/etc/php-fpm-environment-test.conf", new TextEncoder().encode(source), 0o644);
      for (const count of [undefined, 1, 3]) {
        output = "";
        const process = await host.spawnFromVfs("/usr/sbin/php-fpm", ["php-fpm", "-tt", "-y", "/etc/php-fpm-environment-test.conf", "-c", "/dev/null"], {
          uid: 0, gid: 0, env: count === undefined ? [] : [`KANDELO_PREFORK_SERVICE_PROCESSES=${count}`],
        });
        expect(await process.exit, output).toBe(0);
        expect(output).toMatch(new RegExp(`pm\\.max_children\\s*=\\s*${count ?? 1}\\b`));
      }
    } finally { await host.destroy(); }
  }, 120_000);
});
