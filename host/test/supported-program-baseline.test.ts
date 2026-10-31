import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { addIncompatibleForkFixture, addInitialLaunchFixtures } from "./fixtures/program-compatibility";

const directory = new URL("../../abi/program-fixtures/v55/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")) as {
  version: number;
  programAbi: number;
  programContractDigest: string;
  fixtures: { name: string; file: string; size: number; sha256: string }[];
};
const markers: Record<string, string> = {
  echo: "BASELINE_ECHO",
  "spawn-smoke": "spawned-ok\nOK",
  "fstatat-empty-path": "FSTATAT_EMPTY_PATH_PASS",
  "mmap-file": "file still: Hello from mmap file test!\nmsync ok\nPASS",
  pthread: "main: shared_value = 10 (expected 10)\nmain: retval = 42 (expected 42)\nPASS",
  "environment-lifecycle": "FORK_ENV_PASS\nEXEC_ENV_PASS\nEMPTY_ENV_PASS",
};

describe("supported program baseline: unchanged previously compiled programs", () => {
  let host: NodeKernelHost;
  let incompatibleFork: Uint8Array;
  beforeAll(async () => {
    expect(manifest.version).toBe(1);
    expect(manifest.programAbi).toBe(55);
    expect(manifest.programContractDigest).toBe("1358eca04a8d33fa5bcc27d1c672af2f6e7aaf466a398ad598d991347b1a4415");
    expect(manifest.fixtures.map(fixture => fixture.name).sort()).toEqual(Object.keys(markers).sort());
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.mkdir("/tmp", 0o777);
    for (const fixture of manifest.fixtures) {
      const bytes = readFileSync(new URL(fixture.file, directory));
      expect(bytes.byteLength).toBe(fixture.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
      image.writeFile(`/bin/${fixture.name}`, bytes, 0o755);
    }
    addInitialLaunchFixtures(image, readFileSync(new URL("echo.wasm", directory)));
    incompatibleFork = addIncompatibleForkFixture(image, readFileSync(new URL("environment-lifecycle.wasm", directory)));
    host = new NodeKernelHost({ rootfsImage: await image.saveImage() });
    await host.init(Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer);
  }, 60_000);
  afterAll(async () => { await host?.destroy(); });

  it("preserves incompatible user-built fork programs and explains the rebuild requirement", async () => {
    await expect(host.spawnFromVfs("/launch/incompatible-fork", ["incompatible-fork"], {
      uid: 1000, gid: 1000, ownedJob: { id: "incompatible-fork", timeoutMs: 30_000 },
    })).rejects.toThrow(/Rebuild user-built forking programs with the current Kandelo SDK/);
    expect(await host.readFileFromVfs("/launch/incompatible-fork")).toEqual(incompatibleFork);
  });

  it("launches retained initial paths with requested credentials, cwd and shebang argv", async () => {
    const options = { uid: 1000, gid: 1000, cwd: "/launch", ownedJob: { id: "initial-path", timeoutMs: 30_000 } };
    await expect(host.spawnFromVfs("./not-executable", ["refused"], options)).rejects.toThrow(/errno 13/);
    await expect(host.spawnFromVfs("./missing", ["missing"], options)).rejects.toThrow(/errno 2/);
    await expect(host.spawnFromVfs("./invalid", ["invalid"], options)).rejects.toThrow(/errno 8/);
    await expect(host.spawnFromVfs("./echo-no-read", ["echo", "x".repeat(65_537)], options)).rejects.toThrow(/errno 7/);
    for (const [path, marker] of [["./echo-no-read", "INITIAL_EXECUTE_ONLY"], ["./script", "INITIAL_SCRIPT ./script"]]) {
      const process = await host.spawnFromVfs(path, ["original-argv", marker], options);
      void process.exit.catch(() => {});
      let cursor = 0;
      let output = "";
      const deadline = Date.now() + 45_000;
      for (;;) {
        const result = await host.readOwnedJob("initial-path", cursor, 16384);
        if (result.expired) throw new Error("Initial launch output expired");
        output += result.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("");
        cursor = result.next;
        if (result.terminationObserved) {
          expect(result.status, output).toBe("completed");
          expect(result.exitCode, output).toBe(0);
          expect(output).toContain(marker);
          await host.releaseOwnedJob("initial-path");
          break;
        }
        if (Date.now() >= deadline) throw new Error("Initial launch did not retire");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }, 120_000);

  for (const fixture of manifest.fixtures) {
    it(`runs frozen ${fixture.name} bytes without rebuilding or restamping`, async () => {
      const id = `baseline-${fixture.name}`;
      const process = await host.spawnFromVfs(`/bin/${fixture.name}`, [fixture.name, ...(fixture.name === "echo" ? ["BASELINE_ECHO"] : [])], {
        env: ["INITIAL=parent", "REMOVE=before-fork"],
        ownedJob: { id, timeoutMs: 30_000 },
      });
      void process.exit.catch(() => {});
      let output = "";
      let cursor = 0;
      const deadline = Date.now() + 45_000;
      for (;;) {
        const result = await host.readOwnedJob(id, cursor, 16384);
        if (result.expired) throw new Error("Baseline fixture output expired");
        output += result.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("");
        cursor = result.next;
        if (result.terminationObserved) {
          expect(result.status, output).toBe("completed");
          expect(result.exitCode, output).toBe(0);
          expect(output).toContain(markers[fixture.name]);
          await host.releaseOwnedJob(id);
          return;
        }
        if (Date.now() >= deadline) throw new Error(`Baseline fixture did not retire: ${fixture.name}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }, 60_000);
  }
});
