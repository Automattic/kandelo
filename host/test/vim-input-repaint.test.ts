import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";

describe("Vim input availability", () => {
  it("repaints open-line commands without another input byte", async () => {
    let output = "";
    let pid: number | undefined;
    const host = new NodeKernelHost({
      rootfsImage: "default",
      onPtyOutput: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
    });
    try {
      await host.init();
      const file = "/tmp/vim-input-repaint.txt";
      await host.writeFileToVfs(file, new TextEncoder().encode(
        "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[core]\n\tpager = cat\n" +
        "[user]\n\tname = Maker\n\temail = maker@wasm.local\n[init]\n\tdefaultBranch = main\n",
      ));
      const bytes = readFileSync(resolveBinary("programs/vim.wasm"));
      const exit = host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ["vim", "-N", "-u", "NONE", "-i", "NONE", "-n", "-R", file],
        { env: ["TERM=vt100", "HOME=/tmp"], pty: true,
          onStarted: value => { pid = value; } });
      await expect.poll(() => output, { timeout: 20_000 }).toContain("defaultBranch");
      const send = (text: string) => host.ptyWrite(pid!, new TextEncoder().encode(text));
      send("6G$");
      for (let round = 0; round < 8; round++) {
        output = "";
        send("o");
        await expect.poll(() => output, { timeout: round === 0 ? 3_000 : 1_000 })
          .toContain("-- INSERT --");
        send("\x1b");
        // Vim permits Escape to prefix a terminal key sequence for up to 1s.
        await new Promise(resolve => setTimeout(resolve, 1_100));
      }
      send(":q!\r");
      expect(await exit).toBe(0);
    } finally {
      host.destroy();
    }
  }, 45_000);
});
