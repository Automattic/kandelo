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
  it("restores the image-owned Node environment after login", async () => {
    const rootfs = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    for (const path of NPM_PATCH_INPUTS) {
      ensureDirRecursive(rootfs, path.slice(0, path.lastIndexOf("/")));
      writeVfsFile(rootfs, path, "", 0o644);
    }
    ensureDirRecursive(rootfs, "/home/maker");
    stageSpiderMonkeyNpmRuntime(rootfs);

    const result = await runCentralizedProgram({
      programPath: SHELL_WASM,
      argv: [
        "sh",
        "-c",
        `. "$1"
printf '%s\\n' \
  "PS1=$PS1" \
  "npm_config_cache=$npm_config_cache" \
  "npm_config_registry=$npm_config_registry" \
  "npm_config_fund=$npm_config_fund" \
  "npm_config_audit=$npm_config_audit" \
  "npm_config_progress=$npm_config_progress" \
  "npm_config_update_notifier=$npm_config_update_notifier" \
  "NPM_CONFIG_FUND=$NPM_CONFIG_FUND" \
  "NPM_CONFIG_AUDIT=$NPM_CONFIG_AUDIT" \
  "NPM_CONFIG_PROGRESS=$NPM_CONFIG_PROGRESS" \
  "NPM_CONFIG_UPDATE_NOTIFIER=$NPM_CONFIG_UPDATE_NOTIFIER"`,
        "sh",
        NODE_WORKSPACE_PROFILE_PATH,
      ],
      uid: 1000,
      gid: 1000,
      env: [
        "HOME=/home/maker",
        "USER=maker",
        "LOGNAME=maker",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
      io: new VirtualPlatformIO(
        [{ mountPoint: "/", backend: rootfs }],
        new NodeTimeProvider(),
      ),
      onKernelReady: (kernel, pid) => kernel.setCwd(pid, "/home/maker"),
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("PS1=spidermonkey-node$ ");
    expect(result.stdout).toContain("npm_config_cache=/tmp/.npm-cache");
    expect(result.stdout).toContain(
      "npm_config_registry=https://registry.npmjs.org/",
    );
    for (const name of [
      "npm_config_fund",
      "npm_config_audit",
      "npm_config_progress",
      "npm_config_update_notifier",
      "NPM_CONFIG_FUND",
      "NPM_CONFIG_AUDIT",
      "NPM_CONFIG_PROGRESS",
      "NPM_CONFIG_UPDATE_NOTIFIER",
    ]) {
      expect(result.stdout).toContain(`${name}=false`);
    }
  }, 30_000);

  // `/home/maker` IS NOT A HOST MOUNT ANY MORE, and this test used to say it
  // was. It mounted a second `MemoryFileSystem` there and read the starter
  // package back out of that backend. The kernel took `/home/maker` as an
  // in-kernel tmpfs scratch mount in Phase 5 increment 1a (`e4cc807f2a`,
  // alongside `/tmp`, `/var/tmp`, `/var/log`, `/var/run`, `/root`, `/srv`,
  // `/dev/shm`), so the host mount is shadowed: the guest's write lands in the
  // kernel and no host backend ever sees it.
  //
  // Measured rather than reasoned. With the old mounts in place the shell
  // traced `cd /home/maker`, `[ ! -e package.json ]` TRUE, `printf ... >
  // package.json`, and exited 0 -- and afterwards `test -e package.json`
  // answered YES from inside the guest while BOTH host backends answered
  // ENOENT. The bytes were never lost; the test was looking in a place the
  // platform had stopped using.
  //
  // So the assertions move to where the file now lives. What the profile owes
  // is observable to its own guest, which is the only observer that was ever
  // entitled to it.
  it("initializes the starter package in the kernel-owned maker home", async () => {
    const rootfs = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    for (const path of NPM_PATCH_INPUTS) {
      ensureDirRecursive(rootfs, path.slice(0, path.lastIndexOf("/")));
      writeVfsFile(rootfs, path, "", 0o644);
    }
    ensureDirRecursive(rootfs, "/home/maker");
    stageSpiderMonkeyNpmRuntime(rootfs);

    const result = await runCentralizedProgram({
      programPath: SHELL_WASM,
      // No `cat` in this image, so the read-back is shell builtins only.
      argv: [
        "sh",
        "-c",
        `. "$1"
printf '%s\n' "exists=$([ -e package.json ] && echo yes || echo no)"
printf '%s\n' "cwd=$(pwd)"
printf '%s\n' "--begin--"
while IFS= read -r line; do printf '%s\n' "$line"; done < package.json
printf '%s\n' "--end--"`,
        "sh",
        NODE_WORKSPACE_PROFILE_PATH,
      ],
      uid: 1000,
      gid: 1000,
      env: [
        "HOME=/home/maker",
        "USER=maker",
        "LOGNAME=maker",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
      io: new VirtualPlatformIO(
        [{ mountPoint: "/", backend: rootfs }],
        new NodeTimeProvider(),
      ),
      onKernelReady: (kernel, pid) => kernel.setCwd(pid, "/home/maker"),
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("cwd=/home/maker");
    expect(result.stdout).toContain("exists=yes");
    // The exact starter package, read back by the guest that wrote it.
    expect(
      result.stdout.slice(
        result.stdout.indexOf("--begin--\n") + "--begin--\n".length,
        result.stdout.indexOf("--end--"),
      ),
    ).toBe(STARTER_PACKAGE);

    // And the host `/` backend never sees it, which is the invariant that
    // replaced "it is in the home mount": the kernel owns the scratch prefix,
    // so nothing leaks down into the image the machine booted from.
    expect(() => rootfs.stat("/home/maker/package.json")).toThrow();
    expect(() => rootfs.stat("/work")).toThrow();
  }, 30_000);
});
