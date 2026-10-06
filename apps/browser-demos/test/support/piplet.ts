import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real throwaway PHP server: never mutate the self-modifying repository piplet. */
export async function startPiplet(): Promise<{ url: string; close(): Promise<void> }> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
  const directory = mkdtempSync(join(tmpdir(), "kandelo-udp-piplet-"));
  const file = join(directory, "piplet.php");
  writeFileSync(file, readFileSync(new URL("../../../signalling/piplet.php", import.meta.url)));
  const server = spawn("php", ["-S", `127.0.0.1:${port}`, file], { stdio: "ignore" });
  let failure: Error | undefined;
  server.on("error", (error) => { failure = error; });
  const url = `http://127.0.0.1:${port}/`;
  const close = async () => {
    if (server.exitCode === null && !failure) {
      const finished = new Promise<void>((resolve) => server.once("exit", () => resolve()));
      server.kill("SIGTERM"); await finished;
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (failure) throw failure;
      if (server.exitCode !== null) throw new Error(`PHP server exited ${server.exitCode}`);
      try { if ((await fetch(`${url}?session=readiness-probe`)).status === 404) return { url, close }; }
      catch { /* Retry until this owned server is listening. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the signalling piplet did not start");
  } catch (error) { await close(); throw error; }
}
