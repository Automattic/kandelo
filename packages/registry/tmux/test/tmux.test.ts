import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { TMUX_CONTROL_MARKERS, TMUX_CONTROL_SCRIPT } from "./contracts";
import { tmuxProgram, tmuxTerminfoFiles } from "./artifacts";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsBinary } from "../../../../host/src/vfs/image-helpers";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";

async function tmuxTestImage(): Promise<Uint8Array> {
  const image = KandeloImageFs.create();
  image.loadImage(new Uint8Array(readFileSync(resolveBinary("programs/rootfs.vfs.zst"))));
  for (const file of tmuxTerminfoFiles()) {
    ensureDirRecursive(image, dirname(file.path));
    writeVfsBinary(image, file.path, new Uint8Array(file.data), 0o644);
  }
  writeVfsBinary(image, "/usr/bin/tmux", new Uint8Array(readFileSync(tmuxProgram())));
  return image.saveImage();
}

describe("tmux on Kandelo", () => {
  it("runs pane shells, exchanges input, splits panes, resizes and creates windows", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/bash.wasm"),
      argv: ["bash", "--noprofile", "--norc", "-c", TMUX_CONTROL_SCRIPT],
      env: ["HOME=/tmp", "PATH=/usr/bin:/bin", "LC_ALL=C.UTF-8"],
      uid: 1000, gid: 1000, timeout: 90_000,
      rootfsImage: await tmuxTestImage(),
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const marker of TMUX_CONTROL_MARKERS) expect(result.stdout).toContain(marker);
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  }, 105_000);

  it("attaches a real terminal, preserves the session after detach, and reattaches", async () => {
    const output = new Map<number, string>();
    const diagnostics: unknown[] = [];
    const text = new TextDecoder();
    const host = new NodeKernelHost({
      rootfsImage: await tmuxTestImage(),
      onPtyOutput: (pid, data) => output.set(pid, (output.get(pid) ?? "") + text.decode(data)),
      onHostDiagnostic: value => diagnostics.push(value),
    });
    const env = ["TERM=vt100", "HOME=/tmp", "PATH=/usr/bin:/bin", "SHELL=/bin/sh", "LC_ALL=C.UTF-8"];
    const common = ["tmux", "-L", "attached-test", "-f", "/dev/null"];
    try {
      await host.init();
      const first = await host.spawnFromVfs("/usr/bin/tmux", [...common, "new-session", "-s", "attached"], {
        env, uid: 1000, gid: 1000, pty: true, ptyRows: 24, ptyCols: 80,
      });
      await expect.poll(() => output.get(first.pid) ?? "", { timeout: 30_000 }).toContain("attached");
      host.ptyWrite(first.pid, new TextEncoder().encode("printf 'TMUX_ATTACHED_READY\\n'\r"));
      await expect.poll(() => output.get(first.pid) ?? "", { timeout: 20_000 }).toContain("TMUX_ATTACHED_READY\r\n");
      host.ptyWrite(first.pid, new Uint8Array([2, 100]));
      expect(await first.exit).toBe(0);

      const second = await host.spawnFromVfs("/usr/bin/tmux", [...common, "attach-session", "-t", "attached"], {
        env, uid: 1000, gid: 1000, pty: true, ptyRows: 32, ptyCols: 100,
      });
      await expect.poll(() => output.get(second.pid) ?? "", { timeout: 20_000 }).toContain("TMUX_ATTACHED_READY");
      host.ptyWrite(second.pid, new TextEncoder().encode("printf 'TMUX_REATTACHED_READY\\n'\r"));
      await expect.poll(() => output.get(second.pid) ?? "", { timeout: 20_000 }).toContain("TMUX_REATTACHED_READY\r\n");
      host.ptyWrite(second.pid, new Uint8Array([2, 100]));
      expect(await second.exit).toBe(0);
      const stop = await host.spawnFromVfs("/usr/bin/tmux", [...common, "kill-server"], { env, uid: 1000, gid: 1000 });
      expect(await stop.exit).toBe(0);
      await expect.poll(async () => (await host.enumProcs()).filter(proc => proc.pid !== 1), { timeout: 10_000 }).toEqual([]);
      expect(diagnostics).toEqual([]);
    } finally {
      await host.destroy();
    }
  }, 105_000);
});
