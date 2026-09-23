import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { registerDemoShellProfile } from "../../images/vfs/scripts/shell-lazy-archives";
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
    registerDemoShellProfile(rootfs);

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

  it("does nothing for a non-maker HOME", async () => {
    const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    ensureDirRecursive(rootfs, "/root");
    registerDemoShellProfile(rootfs);

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
