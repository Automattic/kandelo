/**
 * run-fetch-in-kernel.ts — Demo of the host's `fetchInKernel` API.
 *
 * Spawns `programs/tiny-http-server.wasm` via `NodeKernelHost`, sends one
 * HTTP request through the new external interface (no real TCP — uses
 * `kernel_inject_connection` directly), and prints the response.
 *
 * Usage:
 *   npx tsx examples/run-fetch-in-kernel.ts [port]
 *
 * See docs/plans/2026-04-30-external-kernel-http-request-interface.md.
 */
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { resolveBinary } from "../host/src/binary-resolver";

async function main() {
  const port = Number(process.argv[2] ?? 8085);

  const programPath = resolveBinary("programs/tiny-http-server.wasm");
  const programBytes = readFileSync(programPath);
  const programArrayBuffer = programBytes.buffer.slice(
    programBytes.byteOffset,
    programBytes.byteOffset + programBytes.byteLength,
  );

  const host = new NodeKernelHost({
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });
  await host.init();

  const exit = host.spawn(programArrayBuffer, ["tiny-http-server", String(port)]);

  let response;
  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await host.fetchInKernel(
        port,
        {
          method: "GET",
          url: "/example?q=hello",
          headers: { Host: "kernel.local" },
          body: null,
        },
        { timeoutMs: 5000 },
      );
      break;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!response) throw new Error(`fetchInKernel never succeeded: ${lastError}`);

  console.log("--- response ---");
  console.log(`status=${response.status}`);
  for (const [k, v] of Object.entries(response.headers)) {
    console.log(`${k}: ${v}`);
  }
  console.log("---");
  console.log(new TextDecoder().decode(response.body));

  const code = await exit;
  console.log(`server exited with code ${code}`);

  await host.destroy();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
