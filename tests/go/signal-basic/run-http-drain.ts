import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../host/src/node-kernel-host.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";
import { verifyHttpSignalDrain } from "./http-drain.ts";
import { verifySignalRestart } from "./restart.ts";
import { verifySignalGC } from "./signal-gc.ts";

const [programPath, kernelPath, mode = "http-drain"] = process.argv.slice(2);
if (!programPath || !kernelPath) throw new Error("usage: run-http-drain.ts <signal.wasm> <kernel.wasm>");
if (!["http-drain", "restart", "signal-gc"].includes(mode)) throw new Error("unknown probe mode");
const image = KandeloImageFs.create();
image.setImageCapacity(16 * 1024 * 1024);
image.mkdir("/bin", 0o755);
image.createFileWithOwner("/bin/go-signal", 0o755, 0, 0, readFileSync(programPath));
let onOutput = (_bytes: Uint8Array) => {};
let stderr = "";
const diagnostics: unknown[] = [];
const host = new NodeKernelHost({
  rootfsImage: await image.saveImage(),
  onStdout: (_pid, bytes) => onOutput(bytes),
  onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
  onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
});
try {
  await host.init(Uint8Array.from(readFileSync(kernelPath)).buffer);
  const verify = mode === "signal-gc" ? verifySignalGC : mode === "restart" ? verifySignalRestart : verifyHttpSignalDrain;
  const result = await verify(host, async onStdout => {
    onOutput = onStdout;
    return host.spawnFromVfs("/bin/go-signal", ["go-signal", mode], {
      onStarted: mode === "signal-gc" ? () => {} : undefined,
    });
  });
  console.log(JSON.stringify({ ...result, stderr, diagnostics }));
  if (stderr !== "" || diagnostics.length !== 0) process.exitCode = 1;
} catch (error) {
  throw new Error(`${String(error)}\nstderr=${stderr}\ndiagnostics=${JSON.stringify(diagnostics)}`);
} finally { await host.destroy(); }
