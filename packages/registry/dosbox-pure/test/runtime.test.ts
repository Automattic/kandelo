import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { dosSmokeImage } from "./fixtures";

const env = ["HOME=/home/player", "XDG_DATA_HOME=/home/player/data"];

describe("DOSBox Pure interpreter", () => {
  let kernelBytes: ArrayBuffer;
  let directoryImage: Uint8Array;
  let zipImage: Uint8Array;
  // Artifact resolution may compile its receipt checker on a fresh checkout.
  // Prepare those artifacts before measuring a guest operation's timeout.
  beforeAll(async () => {
    kernelBytes = Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer;
    directoryImage = await dosSmokeImage();
    zipImage = await dosSmokeImage(true);
  }, 600_000);

  it("runs real DOS code, reads a key, writes a file and releases devices for another launch", async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const host = new NodeKernelHost({
      rootfsImage: directoryImage,
      onStderr: (_pid, bytes) => stderr.push(new TextDecoder().decode(bytes)),
      onStdout: (_pid, bytes) => stdout.push(new TextDecoder().decode(bytes)),
    });
    await host.init(kernelBytes);
    try {
      for (let run = 0; run < 2; ++run) {
        const directory = run === 0 ? "/games" : "/games2";
        const child = await host.spawnFromVfs("/usr/bin/dosbox-pure", ["dosbox-pure", `${directory}/dosbox.conf`],
          { env, uid: 1000, gid: 1000 });
        await expect.poll(async () => Array.from(await host.readFileFromVfs(`${directory}/READY.TXT`) ?? []),
          { timeout: 30_000 }).toEqual([1]);
        host.injectInputEvent(0, 1, 30, 1); // KEY_A down
        host.injectInputEvent(0, 0, 0, 0);
        await expect.poll(async () => Array.from(await host.readFileFromVfs(`${directory}/RESULT.TXT`) ?? []),
          { timeout: 30_000 }).toEqual([0x61]);
        host.injectInputEvent(0, 1, 30, 0);
        host.injectInputEvent(0, 0, 0, 0);
        expect(await host.signalProcess(child.pid, 15)).toBe(true);
        expect(await child.exit).toBe(0);
      }
      expect(stderr.join("")).toContain("running x86 interpreter");
      expect(stderr.join("")).not.toContain("unavailable");
    } catch (error) {
      console.error({ stderr: stderr.join(""), stdout: stdout.join("") });
      throw error;
    } finally { await host.destroy(); }
  }, 90_000);

  it("loads a ZIP and flushes DOS writes to a separate per-user save overlay", async () => {
    const host = new NodeKernelHost({ rootfsImage: zipImage });
    await host.init(kernelBytes);
    try {
      const original = await host.readFileFromVfs("/games/game.zip");
      const child = await host.spawnFromVfs("/usr/bin/dosbox-pure",
        ["dosbox-pure", "/games/game.zip", "--frames", "180"], { env, uid: 1000, gid: 1000 });
      expect(await child.exit).toBe(0);
      const save = await host.readFileFromVfs("/home/player/data/dosbox-pure/saves/game.pure.zip");
      expect(save).not.toBeNull();
      const entries = unzipSync(save!);
      expect(Array.from(entries["RESULT.TXT"] ?? [])).toEqual([0x61]);
      expect(await host.readFileFromVfs("/games/game.zip")).toEqual(original);
    } finally { await host.destroy(); }
  }, 60_000);
});
