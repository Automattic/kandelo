/**
 * Real package acceptance through the dedicated Node kernel worker.
 * Graphics and peer multiplayer are verified separately in the browser.
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive } from "../../../../host/src/vfs/image-helpers";
import {
  registerDeclaredShellLazyArchive,
  SHELL_LAZY_ARCHIVE_SPECS,
} from "../../../../images/vfs/scripts/shell-lazy-archives";

const bundle = tryResolveBinary("programs/wasm32/freeciv-browser-bundle/freeciv.zip");
const encoder = new TextEncoder();
const env = [
  "HOME=/home/maker", "USER=maker", "LANG=C.UTF-8", "TERM=dumb",
  "ICU_DATA=/usr/share/icu", "FREECIV_DATA_PATH=/usr/share/freeciv",
];

async function boot() {
  const fs = KandeloImageFs.create();
  fs.setImageCapacity(16 * 1024 * 1024);
  for (const path of ["/tmp", "/etc", "/usr", "/home/maker"]) {
    ensureDirRecursive(fs, path);
  }
  const spec = SHELL_LAZY_ARCHIVE_SPECS.find((spec) => spec.id === "freeciv")!;
  const archive = registerDeclaredShellLazyArchive(fs, spec, () => bundle!);
  let output = "";
  const record = (_pid: number, bytes: Uint8Array) => {
    output += new TextDecoder().decode(bytes);
  };
  const host = new NodeKernelHost({
    rootfsImage: await fs.saveImage(),
    // The archive records its package-mirror path, which the lazy-asset
    // directory resolves to `<directory>assets/programs/wasm32/freeciv.zip`.
    rootfsLazyUrlBase: "https://freeciv.test/",
    rootfsLazyAssetDirectory: "https://freeciv.test/",
    rootfsLazyAssets: [{
      url: "https://freeciv.test/assets/programs/wasm32/freeciv.zip",
      bytes: archive.bytes,
      sha256: archive.integrity.sha256,
      size: archive.bytes.byteLength,
    }],
    onStdout: record,
    onStderr: record,
  });
  await host.init();
  return { host, output: () => output };
}

describe.skipIf(!bundle)("Freeciv package runtime", () => {
  it("runs both shipped executables from the lazy archive", async () => {
    const { host, output } = await boot();
    try {
      for (const name of ["client", "server"]) {
        const { exit } = await host.spawnFromVfs(
          `/usr/libexec/freeciv/${name}.wasm`,
          [`freeciv-${name}`, "--version"],
          { env, uid: 1000, gid: 1000, cwd: "/home/maker",
            ownedJob: { id: `freeciv-version-${name}`, timeoutMs: 30_000 } },
        );
        expect(await exit, output()).toBe(0);
      }
      expect(output().match(/3\.2\.6/g)?.length, output()).toBeGreaterThanOrEqual(2);
    } finally {
      await host.destroy();
    }
  }, 90_000);

  it("loads the ruleset, plays AI turns, saves, and reloads a real game", async () => {
    const { host, output } = await boot();
    const run = async (extra: string[], stdin: string) => {
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const { exit } = await host.spawnFromVfs(
        "/usr/libexec/freeciv/server.wasm",
        ["freeciv-server", "--Announce", "none", "--bind", "127.0.0.1", "--port", String(port),
          "--exit-on-end", "--saves", "/home/maker", ...extra],
        { env, uid: 1000, gid: 1000, cwd: "/home/maker",
          stdin: encoder.encode(stdin),
          ownedJob: { id: `freeciv-server-${extra.length}`, timeoutMs: 60_000 } },
      );
      expect(await exit, output()).toBe(0);
    };
    try {
      await run([], [
        "set minplayers 0", "set aifill 2", "set endturn 2", "set saveturns 1",
        "set timeout 1", "set firsttimeout 1",
        "set mapsize PLAYER", "set tilesperplayer 50", "start", "",
      ].join("\n"));
      const saves = (await host.readDirFromVfs("/home/maker")) ?? [];
      const saved = saves.find((entry) => /\.sav(?:\.[a-z0-9]+)?$/.test(entry.name));
      expect(saved, output()).toBeDefined();
      const path = `/home/maker/${saved!.name}`;
      const bytes = await host.readFileFromVfs(path);
      expect(bytes?.length, output()).toBeGreaterThan(100);
      const before = output().length;
      await run(["--file", path], "quit\n");
      expect(output().slice(before)).toMatch(/load|Load/);
      expect(output()).not.toMatch(/Failed to load|Cannot load|undefined symbol|RuntimeError: unreachable/);
    } finally {
      await host.destroy();
    }
  }, 150_000);
});
