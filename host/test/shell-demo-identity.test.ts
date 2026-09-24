import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
// Register through the same entry point both image builders call, so this
// suite exercises the set the images actually ship rather than one helper
// inside it. Presence in a BUILT image is guarded separately, by
// tests/package-system/source-rootfs-shell-bridge.test.ts.
import { registerShellProfileScripts } from "../../images/vfs/scripts/shell-lazy-archives";
import { ensureDirRecursive } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { runCentralizedProgram } from "./centralized-test-helper";

// WHY try/catch, not a bare tryResolveBinary(): a resolver that has already
// staged dash in one provenance tier (e.g. an ad hoc `xtask build-deps
// resolve dash`) without also publishing it as an installed package throws
// rather than returning null — a genuinely ambiguous multi-tier state should
// fail loudly, not be silently treated as "missing" (see
// tryResolveBinarySetFromTiers in binary-resolver.ts). This suite only wants
// to know "is a usable dash.wasm available", so any failure means skip.
let SHELL_WASM: string | null;
try {
  SHELL_WASM = tryResolveBinary("programs/dash.wasm");
} catch {
  SHELL_WASM = null;
}
const PROFILE_SCRIPT_PATH = "/etc/profile.d/00-kandelo-shell.sh";

describe.skipIf(!SHELL_WASM)("Demo shell identity profile", () => {
  it("sets the maker interactive shell identity after login", async () => {
    const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    ensureDirRecursive(rootfs, "/home/maker");
    registerShellProfileScripts(rootfs);

    const result = await runCentralizedProgram({
      programPath: SHELL_WASM!,
      argv: [
        "sh",
        "-c",
        `. "$1"
printf '%s\\n' \
  "PS1=$PS1" \
  "HISTFILE=$HISTFILE" \
  "TMPDIR=$TMPDIR" \
  "LANG=$LANG" \
  "TERM=$TERM" \
  "SSL_CERT_FILE=$SSL_CERT_FILE" \
  "SSL_CERT_DIR=$SSL_CERT_DIR"`,
        "sh",
        PROFILE_SCRIPT_PATH,
      ],
      uid: 1000,
      gid: 1000,
      env: ["HOME=/home/maker", "USER=maker", "LOGNAME=maker"],
      io: new VirtualPlatformIO(
        [{ mountPoint: "/", backend: rootfs }],
        new NodeTimeProvider(),
      ),
      onKernelReady: (kernel, pid) => kernel.setCwd(pid, "/home/maker"),
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("PS1=kandelo$ ");
    expect(result.stdout).toContain("HISTFILE=/home/maker/.bash_history");
    expect(result.stdout).toContain("TMPDIR=/tmp");
    expect(result.stdout).toContain("LANG=en_US.UTF-8");
    expect(result.stdout).toContain("TERM=xterm-256color");
    expect(result.stdout).toContain(
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
    );
    expect(result.stdout).toContain("SSL_CERT_DIR=/etc/ssl/certs");
  });

  it("exports npm's image-wide settings from the node profile script", async () => {
    const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    ensureDirRecursive(rootfs, "/home/maker");
    registerShellProfileScripts(rootfs);

    const result = await runCentralizedProgram({
      programPath: SHELL_WASM!,
      argv: [
        "sh",
        "-c",
        `. "$1"
printf '%s\\n' \
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
        "/etc/profile.d/node.sh",
      ],
      uid: 1000,
      gid: 1000,
      env: ["HOME=/home/maker", "USER=maker", "LOGNAME=maker"],
      io: new VirtualPlatformIO(
        [{ mountPoint: "/", backend: rootfs }],
        new NodeTimeProvider(),
      ),
      onKernelReady: (kernel, pid) => kernel.setCwd(pid, "/home/maker"),
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
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
    // The shell image ships ONE /etc/profile.d for every machine it carries,
    // so nothing per-machine may live here: the node machine's name comes
    // from identity.title in its /etc/kandelo/demo.json, and a bare-shell
    // user must not find a seeded package.json in their home directory.
    const script = readVfsText(rootfs, "/etc/profile.d/node.sh");
    expect(script).not.toContain("PS1");
    expect(script).not.toContain("package.json");
    expect(() => rootfs.stat("/home/maker/package.json")).toThrow();
  });

  it("does nothing for a non-maker HOME", async () => {
    const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    ensureDirRecursive(rootfs, "/root");
    registerShellProfileScripts(rootfs);

    const result = await runCentralizedProgram({
      programPath: SHELL_WASM!,
      argv: [
        "sh",
        "-c",
        `. "$1"; printf 'PS1=%s\\n' "${"$"}{PS1:-unset}"`,
        "sh",
        PROFILE_SCRIPT_PATH,
      ],
      uid: 0,
      gid: 0,
      env: ["HOME=/root", "USER=root", "LOGNAME=root"],
      io: new VirtualPlatformIO(
        [{ mountPoint: "/", backend: rootfs }],
        new NodeTimeProvider(),
      ),
      onKernelReady: (kernel, pid) => kernel.setCwd(pid, "/root"),
      timeout: 20_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("PS1=unset");
  });
});

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const handle = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    const length = fs.read(handle, bytes, null, bytes.length);
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    fs.close(handle);
  }
}
