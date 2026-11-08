import { afterAll, beforeAll, expect, it } from "vitest";
import { connect, createServer, type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

let fixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("./fixtures/offline-egress-listener.c", import.meta.url), [], { forkInstrument: true });
}, 120_000);
afterAll(() => fixture?.cleanup());

async function unusedHostPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function hostConnectionResult(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("host loopback connection did not complete"));
    });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("error", error => { socket.destroy(); resolve((error as NodeJS.ErrnoException).code ?? error.message); });
  });
}

for (const address of ["127.0.0.1", "127.0.0.2", "0.0.0.0", "10.0.2.15", "::1"]) {
  for (const mode of ["same", "fork"]) {
    it(`keeps an offline guest's ${address} listener private (${mode})`, async () => {
      const port = await unusedHostPort();
      let ready!: () => void;
      const listening = new Promise<void>(resolve => { ready = resolve; });
      let stdout = "", stderr = "";
      const diagnostics: unknown[] = [];
      const host = new NodeKernelHost({
        offlineEgressLink: true,
        onStdout: (_pid, bytes) => {
          stdout += new TextDecoder().decode(bytes);
          if (stdout.includes("GUEST LISTENING")) ready();
        },
        onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
        onHostDiagnostic: diagnostic => { diagnostics.push(diagnostic); },
      });
      try {
        const kernel = Uint8Array.from(readFileSync(resolveBinary("kernel.wasm")));
        await host.init(kernel.buffer);
        let pid!: number;
        const program = Uint8Array.from(readFileSync(fixture.programPath));
        const exit = host.spawn(program.buffer, ["offline-listener", String(port), address, mode], {
          onStarted: value => { pid = value; },
        });
        await Promise.race([listening, exit.then(code => {
          throw new Error(`guest exited before listen: ${code}; ${stdout}; ${stderr}`);
        })]);
        // A subsequent worker request completes after listen's queued native
        // callbacks, so this observes the live listener rather than startup.
        expect((await host.enumProcs()).some(process => process.pid === pid)).toBe(true);
        expect(await hostConnectionResult(port)).toBe("ECONNREFUSED");
        host.appendStdinData(pid, new Uint8Array([1]));
        expect(await exit, stdout + stderr).toBe(0);
        expect(stdout).toContain("GUEST LOOPBACK PASS");
        expect(stderr).toBe("");
        expect(diagnostics).toEqual([]);
      } finally {
        await host.destroy();
      }
    }, 30_000);
  }
}
