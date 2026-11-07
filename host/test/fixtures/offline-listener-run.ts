import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { NodeKernelHost } from "../../src/node-kernel-host";

// Occupy only an OS-assigned port owned by this fixture. Neither the baseline
// nor the fixed run can publish onto a user's or another agent's server.
const guard = createServer();
await new Promise<void>((resolve, reject) => {
  guard.once("error", reject);
  guard.listen(0, "127.0.0.1", resolve);
});
const port = (guard.address() as import("node:net").AddressInfo).port;
const bytes = new Uint8Array(readFileSync(new URL("./offline-listener.wasm", import.meta.url))).buffer;
const machines: NodeKernelHost[] = [];
const exits: Promise<number>[] = [];
const pids: number[] = [];
try {
  // Both guest listeners remain live at the readiness barrier, even though
  // a completely different machine (this Node process) owns the host port.
  for (let index = 0; index < 2; index++) {
    let ready!: () => void;
    const listening = new Promise<void>(resolve => { ready = resolve; });
    let output = "";
    const host = new NodeKernelHost({ offlineEgressLink: true,
      onStdout: (_pid, data) => {
        output += new TextDecoder().decode(data);
        if (output.includes("READY\n")) ready();
      },
    });
    machines.push(host);
    await host.init();
    const exit = host.spawn(bytes.slice(0), ["offline-listener", String(port)], {
      onStarted: pid => { pids[index] = pid; },
    });
    exits.push(exit);
    await Promise.race([listening, exit.then(code => { throw new Error(`exited before listen: ${code}`); })]);
  }
  machines.forEach((host, index) => host.setStdinData(pids[index], new Uint8Array([1])));
  const codes = await Promise.all(exits);
  if (codes.some(code => code !== 0)) throw new Error(`guest exits: ${codes}`);
  console.log(JSON.stringify({ listeners: 2, overlapping: true, guestPort: port, exits: codes }));
} finally {
  await Promise.all(machines.map(host => host.destroy()));
  await new Promise<void>(resolve => guard.close(() => resolve()));
}
