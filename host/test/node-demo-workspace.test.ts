import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NODE_WORKSPACE_PROFILE_PATH,
  stageSpiderMonkeyNpmRuntime,
} from "../../images/vfs/lib/init/spidermonkey-npm-runtime";
import { ensureDirRecursive, writeVfsFile } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { runCentralizedProgram } from "./centralized-test-helper";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL_WASM = join(REPO_ROOT, "local-binaries/programs/wasm32/dash.wasm");
const STARTER_PACKAGE = '{\n  "name": "demo",\n  "version": "0.0.1"\n}\n';
const NPM_PATCH_INPUTS = [
  "/usr/local/lib/npm/lib/utils/display.js",
  "/usr/local/lib/npm/lib/commands/token.js",
  "/usr/local/lib/npm/node_modules/cacache/lib/entry-index.js",
  "/usr/local/lib/npm/node_modules/cacache/lib/verify.js",
] as const;

describe("Node demo workspace", () => {
  it("initializes the starter package inside the mounted canonical maker home", async () => {
    const rootfs = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    for (const path of NPM_PATCH_INPUTS) {
      ensureDirRecursive(rootfs, path.slice(0, path.lastIndexOf("/")));
      writeVfsFile(rootfs, path, "", 0o644);
    }
    ensureDirRecursive(rootfs, "/home/maker");
    stageSpiderMonkeyNpmRuntime(rootfs);

    const home = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    home.chown("/", 1000, 1000);
    const io = new VirtualPlatformIO(
      [
        { mountPoint: "/home/maker", backend: home },
        { mountPoint: "/", backend: rootfs },
      ],
      new NodeTimeProvider(),
    );

    const result = await runCentralizedProgram({
      programPath: SHELL_WASM,
      argv: ["sh", NODE_WORKSPACE_PROFILE_PATH],
      uid: 1000,
      gid: 1000,
      env: [
        "HOME=/home/maker",
        "USER=maker",
        "LOGNAME=maker",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
      io,
      onKernelReady: (kernel, pid) => kernel.setCwd(pid, "/home/maker"),
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(readVfsText(home, "/package.json")).toBe(STARTER_PACKAGE);
    expect(home.stat("/package.json")).toMatchObject({ uid: 1000, gid: 1000 });
    expect(() => rootfs.stat("/home/maker/package.json")).toThrow();
    expect(() => rootfs.stat("/work")).toThrow();
  }, 30_000);
});

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    const length = fs.read(fd, bytes, null, bytes.length);
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    fs.close(fd);
  }
}
