import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { dosVgaExecutable } from "../../apps/browser-demos/test/support/dos-program";
import type { LazyDownloadEvent } from "../src/vfs/lazy-download-event";

const home = "/home/maker";
const environment = ["HOME=" + home, "USER=maker", "PATH=/usr/bin:/bin", "PYTHONHOME=/usr", "TMPDIR=/tmp"];

describe("DOS and content imports in the built Kandelo shell", () => {
  let kernel: ArrayBuffer;
  let image: Uint8Array;
  beforeAll(() => {
    const root = join(import.meta.dirname, "../..");
    vi.stubEnv("WASM_POSIX_RESOLUTION_POLICY", "source-only-v1");
    vi.stubEnv("WASM_POSIX_SOURCE_ONLY_BINARY_ROOT", join(root, "local-binaries/source-only-v1"));
    vi.stubEnv("WASM_POSIX_BINARY_RESOLVER_REPO_ROOT", root);
    kernel = Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer;
    image = new Uint8Array(readFileSync(resolveBinary("programs/shell.vfs.zst")));
  }, 600_000);
  afterAll(() => vi.unstubAllEnvs());

  it("keeps DOSBox lazy, lists the catalog without fetching the engine, and reuses the engine", async () => {
    const fs = KandeloImageFs.create();
    fs.loadImage(image);
    for (const path of ["/usr/bin/dosbox-pure", "/usr/bin/dos-play", "/usr/share/dos-play/games.tsv"])
      expect(fs.isPathDeferred(path), path).toBe(true);
    let stdout = "", stderr = "";
    const downloads: LazyDownloadEvent[] = [];
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => stdout += new TextDecoder().decode(bytes),
      onStderr: (_pid, bytes) => stderr += new TextDecoder().decode(bytes),
      onLazyDownload: event => downloads.push(event),
    });
    await host.init(kernel);
    const spawn = (path: string, args: string[]) => host.spawnFromVfs(path, args, { env: environment, uid: 1000, gid: 1000, cwd: home });
    const engineDownloads = () => downloads.filter(e => e.status === "complete" && /dosbox-pure(?:\.wasm|\/dosbox-pure\.wasm)/.test(e.url));
    try {
      expect(downloads).toEqual([]);
      const list = await spawn("/usr/bin/dos-play", ["dos-play", "--list"]);
      expect(await list.exit, stderr).toBe(0);
      for (const id of ["keen1", "dosdefender", "vitetris", "anarch"]) expect(stdout).toContain(id);
      expect(engineDownloads()).toHaveLength(0);
      const program = dosVgaExecutable();
      await host.writeFileToVfs(home + "/PLAY.BIN", program);
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = await spawn("/usr/bin/dos-play", ["dos-play", home + "/PLAY.BIN", "--frames", "5"]);
        expect(await child.exit, stderr).toBe(0);
        expect(engineDownloads()).toHaveLength(1);
        expect(await host.readFileFromVfs(home + "/PLAY.BIN")).toEqual(program);
        expect((await host.readDirFromVfs(home))?.filter(entry => /^K[0-9A-F]{7}\.EXE$/.test(entry.name))).toEqual([]);
      }
      expect(stderr).toContain("running x86 interpreter");
    } finally { await host.destroy(); }
  }, 180_000);

  it("runs ordinary Python subprocesses with pipes, status and exec errors", async () => {
    let stdout = "", stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => stdout += new TextDecoder().decode(bytes),
      onStderr: (_pid, bytes) => stderr += new TextDecoder().decode(bytes),
    });
    await host.init(kernel);
    try {
      const script = `import subprocess
r = subprocess.run(['/bin/sh', '-c', 'printf child-out; printf child-err >&2; exit 7'], capture_output=True, text=True)
assert (r.returncode, r.stdout, r.stderr) == (7, 'child-out', 'child-err'), r
try:
    subprocess.run(['/nonexistent-program'])
except FileNotFoundError:
    print('SUBPROCESS_OK')
else:
    raise AssertionError('exec error was lost')
`;
      const child = await host.spawnFromVfs("/usr/bin/python3", ["python3", "-c", script], {
        env: environment, uid: 1000, gid: 1000, cwd: home,
      });
      expect(await child.exit, stderr).toBe(0);
      expect(stdout).toContain("SUBPROCESS_OK");
    } finally { await host.destroy(); }
  }, 120_000);

  it("uses the installed guest Python, ZIP importer and actual detectors before launching DOSBox", async () => {
    let stdout = "", stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => stdout += new TextDecoder().decode(bytes),
      onStderr: (_pid, bytes) => stderr += new TextDecoder().decode(bytes),
    });
    await host.init(kernel);
    try {
      const notice = new TextEncoder().encode("Authored fixture notice.\n");
      await host.writeFileToVfs(home + "/bundle.zip", zipSync({ "game/PLAY.EXE": dosVgaExecutable(), "game/LICENSE.txt": notice }));
      const child = await host.spawnFromVfs("/usr/bin/game-play", ["game-play", home + "/bundle.zip"], {
        env: environment, uid: 1000, gid: 1000, cwd: home,
      });
      await Promise.race([
        expect.poll(() => stderr, { timeout: 180_000 }).toContain("running x86 interpreter"),
        child.exit.then(code => { throw new Error(`Importer exited before DOSBox started (${code}): ${stderr}`); }),
      ]);
      expect(stdout).toContain("Starting DOS:");
      const imports = home + "/.local/share/kandelo/game-imports";
      const entries = await host.readDirFromVfs(imports);
      const imported = entries?.find(entry => entry.name.startsWith("import-"));
      expect(imported).toBeDefined();
      expect(await host.readFileFromVfs(join(imports, imported!.name, "files/bundle.zip.unpacked/game/LICENSE.txt"))).toEqual(notice);
      expect(await host.signalProcess(child.pid, 15)).toBe(true);
      expect(await child.exit, stderr).toBe(0);
    } catch (error) {
      console.error({ stdout, stderr });
      throw error;
    } finally { await host.destroy(); }
  }, 240_000);
});
