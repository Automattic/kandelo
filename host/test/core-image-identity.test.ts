import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";

for (const name of ["web-stack-vfs", "wordpress-family-vfs"]) {
  it(`${name} preserves maker's login and sudo access`, async () => {
    let transcript = "";
    let notify = () => {};
    const host = new NodeKernelHost({
      rootfsImage: readFileSync(resolveBinary(`programs/wasm32/${name}.vfs.zst`)),
      onPtyOutput: (_pid, bytes) => { transcript += new TextDecoder().decode(bytes); notify(); },
    });
    const waitFor = (pattern: RegExp) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${pattern}: ${transcript}`)), 60_000);
      notify = () => { if (pattern.test(transcript)) { clearTimeout(timer); resolve(); } };
      notify();
    });
    try {
      const bytes = readFileSync(resolveBinary("kernel.wasm"));
      await host.init(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const login = await host.spawnFromVfs("/bin/login", ["login", "-p", "-f", "maker"], {
        pty: true, env: ["TERM=xterm-256color"],
      });
      await waitFor(/kandelo\$ /);
      transcript = "";
      host.ptyWrite(login.pid, new TextEncoder().encode(
        "printf 'kandelo\\n' | sudo -S -p '' /bin/bash -c 'test \"$UID\" = 0 && printf \"CORE_SUDO_%s\\n\" ROOT_OK'; printf 'CORE_STATUS_%s\\n' \"$?\"\n",
      ));
      await waitFor(/CORE_STATUS_\d+/);
      expect(transcript).toContain("CORE_SUDO_ROOT_OK");
      expect(transcript).toContain("CORE_STATUS_0");
      host.ptyWrite(login.pid, new TextEncoder().encode("exit\n"));
      expect(await login.exit).toBe(0);
    } finally { await host.destroy(); }
  }, 180_000);
}
