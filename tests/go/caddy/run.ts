import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../host/src/node-kernel-host.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <caddy.wasm> <kernel.wasm>");
}

const programBytes = readFileSync(programPath);
const image = KandeloImageFs.create();
image.setImageCapacity(programBytes.byteLength + 8 * 1024 * 1024);
for (const directory of ["/bin", "/tmp", "/var", "/var/www", "/var/www/html"]) {
  image.mkdir(directory, 0o755);
}
image.createFileWithOwner("/bin/caddy", 0o755, 0, 0, new Uint8Array(programBytes));
image.createFileWithOwner("/var/www/html/index.html", 0o644, 0, 0,
  new TextEncoder().encode("Kandelo Caddy static response\n"));

let stderr = "";
const diagnostics: unknown[] = [];
const host = new NodeKernelHost({
  rootfsImage: new Uint8Array(await image.saveImage()),
  onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  onHostDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
});
let serverPid = 0;
try {
  const kernelBytes = readFileSync(kernelPath);
  await host.init(kernelBytes.buffer.slice(
    kernelBytes.byteOffset,
    kernelBytes.byteOffset + kernelBytes.byteLength,
  ) as ArrayBuffer);
  const { pid, exit } = await host.spawnFromVfs("/bin/caddy", [
    "/bin/caddy", "file-server", "--root", "/var/www/html", "--listen", ":8080", "--no-compress",
  ], { env: ["HOME=/tmp", "TMPDIR=/tmp"] });
  serverPid = pid;
  let serverExit: number | undefined;
  exit.then((code) => { serverExit = code; }).catch(() => {});
  let response: Awaited<ReturnType<typeof host.fetchInKernel>> | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (serverExit !== undefined) throw new Error(`Caddy exited before readiness: ${serverExit}\n${stderr}`);
    try {
      response = await host.fetchInKernel(8080, {
        method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null,
      }, { timeoutMs: 10_000 });
      break;
    } catch (error) {
      if (!String(error).includes("No in-kernel listener")) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
  if (!response) throw new Error(`Caddy did not listen on 8080\n${stderr}`);
  const body = new TextDecoder().decode(response.body);
  const passed = response.status === 200 && body === "Kandelo Caddy static response\n" &&
    diagnostics.length === 0 && !stderr.includes("panic");
  console.log(JSON.stringify({ passed, status: response.status, body, stderr, diagnostics }));
  if (!passed) process.exitCode = 1;
} finally {
  if (serverPid !== 0) await host.signalProcess(serverPid, 15).catch(() => {});
  await host.destroy();
}
