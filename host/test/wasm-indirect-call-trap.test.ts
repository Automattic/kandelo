import { beforeAll, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { SIGILL, signalExitStatus } from "../src/trap-signals";
import { indirectCallTrapImage } from "./support/indirect-call-trap-image";

let image: Uint8Array;
beforeAll(async () => {
  image = await indirectCallTrapImage();
}, 240_000);

it("records a terminal-only indirect call trap in guest dmesg", async () => {
  let log = "";
  const host = new NodeKernelHost({
    rootfsImage: image,
    onStdout: (_pid, bytes) => { log += new TextDecoder().decode(bytes); },
  });
  try {
    await host.init();
    const probe = "/bin/indirect-call-trap-test";
    const pipe = await host.spawnFromVfs(probe, [probe]);
    expect(await pipe.exit).toBe(0);
    const tty = await host.spawnFromVfs(probe, [probe], { pty: true });
    expect(await tty.exit).toBe(signalExitStatus(SIGILL));
    const unreachable = await host.spawnFromVfs(probe, [probe, "unreachable"]);
    expect(await unreachable.exit).toBe(signalExitStatus(SIGILL));

    const dmesg = await host.spawnFromVfs("/bin/dmesg", ["dmesg", "-r"]);
    expect(await dmesg.exit).toBe(0);
    expect(log).toMatch(RegExp(
      `process ${tty.pid} killed by signal 4 \\(SIGILL\\): Wasm indirect call trap \\((?:null table entry or )?signature mismatch\\)`,
    ));
    expect(log.split("Wasm indirect call trap")).toHaveLength(2);
    expect(log).toMatch(RegExp(`process ${unreachable.pid} killed by signal 4 \\(SIGILL\\)$`, "m"));
    const dmesgOnTty = await host.spawnFromVfs("/bin/dmesg", ["dmesg"], {
      pty: true, env: ["TERM=xterm"],
    });
    expect(await dmesgOnTty.exit).toBe(0);
  } finally {
    await host.destroy();
  }
}, 60_000);
