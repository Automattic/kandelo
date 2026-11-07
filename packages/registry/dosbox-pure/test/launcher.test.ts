import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive } from "../../../../images/vfs/scripts/vfs-image-helpers";
import { dosSmokeCom } from "./fixtures";

const env = ["HOME=/home/player", "PATH=/usr/bin:/bin"];
const text = new TextDecoder();

describe("dos-play in Kandelo", () => {
  let kernel: ArrayBuffer;
  let goodImage: Uint8Array;
  let corruptImage: Uint8Array;
  beforeAll(async () => {
    kernel = Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer;
    const archive = zipSync({ "release/SMOKE.COM": dosSmokeCom(false), "release/LICENSE": new TextEncoder().encode("fixture notice") });
    const digest = createHash("sha256").update(archive).digest("hex");
    const make = async (sha: string) => {
      const fs = KandeloImageFs.create();
      fs.setImageCapacity(64 * 1024 * 1024);
      for (const dir of ["/bin", "/usr/bin", "/usr/share/dos-play", "/fixtures", "/home/player", "/tmp"])
        ensureDirRecursive(fs, dir);
      fs.chown("/home/player", 1000, 1000);
      fs.chmod("/tmp", 0o1777);
      const install = (path: string, artifact: string) => fs.writeFile(path, readFileSync(resolveBinary(artifact)), 0o755);
      install("/bin/bash", "programs/bash.wasm");
      fs.symlink("/bin/bash", "/bin/sh");
      install("/bin/coreutils", "programs/coreutils.wasm");
      for (const name of ["cat", "mkdir", "mv", "rm", "cp", "wc", "cut", "sha256sum"])
        fs.symlink("/bin/coreutils", `/bin/${name}`);
      for (const name of ["grep", "curl", "unzip"])
        install(`/usr/bin/${name}`, `programs/${name}.wasm`);
      install("/usr/bin/dosbox-pure", "programs/dosbox-pure/dosbox-pure.wasm");
      install("/usr/bin/dos-play", "programs/dosbox-pure/bin/dos-play");
      fs.writeFile("/usr/share/dos-play/games.tsv", new TextEncoder().encode(
        `smoke\t${archive.length}\t${sha}\tfile:///fixtures/game.zip\tzip\trelease\tSMOKE.COM\tDOS smoke fixture\tCC0-1.0\n`), 0o644);
      fs.writeFile("/fixtures/game.zip", archive, 0o644);
      return fs.saveImage();
    };
    goodImage = await make(digest);
    corruptImage = await make("0".repeat(64));
  }, 600_000);

  async function boot(image: Uint8Array) {
    let log = "";
    const host = new NodeKernelHost({ rootfsImage: image,
      onStderr: (_pid, data) => { log += text.decode(data); },
      onStdout: (_pid, data) => { log += text.decode(data); },
    });
    await host.init(kernel);
    const run = async (...args: string[]) => {
      const child = await host.spawnFromVfs("/usr/bin/dos-play", ["dos-play", ...args], { env, uid: 1000, gid: 1000 });
      return child.exit;
    };
    return { host, run, log: () => log };
  }

  it("downloads, verifies and unpacks a game, preserves its notice, then launches from cache", async () => {
    const { host, run, log } = await boot(goodImage);
    const game = "/home/player/.local/share/dos-play/smoke";
    try {
      expect(await run("--list"), log()).toBe(0);
      expect(log()).toContain("DOS smoke fixture");
      expect(await run("smoke", "--frames", "120"), log()).toBe(0);
      expect(Array.from(await host.readFileFromVfs(`${game}/RESULT.TXT`) ?? [])).toEqual([0x61]);
      expect(text.decode((await host.readFileFromVfs(`${game}/LICENSE`))!)).toBe("fixture notice");
      // Removing the source proves the second launch uses the installed game.
      const remove = await host.spawnFromVfs("/bin/rm", ["rm", "/fixtures/game.zip"], { env });
      expect(await remove.exit).toBe(0);
      expect(await run("smoke", "--frames", "60"), log()).toBe(0);
      expect(log().match(/Downloading DOS smoke fixture/g)).toHaveLength(1);
      expect(log().match(/running x86 interpreter/g)).toHaveLength(2);
    } finally { await host.destroy(); }
  }, 120_000);

  it("rejects changed bytes before extracting or launching and removes the incomplete download", async () => {
    const { host, run, log } = await boot(corruptImage);
    try {
      expect(await run("smoke"), log()).toBe(1);
      expect(log()).toContain("SHA-256 mismatch");
      expect(log()).not.toContain("running x86 interpreter");
      expect(await host.readFileFromVfs("/home/player/.local/share/dos-play/smoke/SMOKE.COM")).toBeNull();
      expect(await host.readFileFromVfs("/home/player/.local/share/dos-play/.smoke.lock/download")).toBeNull();
    } finally { await host.destroy(); }
  }, 90_000);
});
