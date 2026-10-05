/**
 * Run Quickshell with a config under wlcompositor in one NodeKernelHost
 * (research: compare a sink-plan build against the installed binary):
 *   npx tsx tools/fork-sink-research/real/run-qs.ts <quickshell.wasm> <shell.qml>
 * Env: SEQ_EXEC="guest-path=host-wasm,..." exec mappings.
 * Quickshell has only Wayland platform plugins, so it needs a compositor
 * even for a config without windows. Prints guest output; exits with
 * Quickshell's status.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const [program, config] = process.argv.slice(2);
const load = (p: string) => {
  const b = readFileSync(resolve(p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const execPrograms: Record<string, string> = {};
for (const kv of (process.env.SEQ_EXEC ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  execPrograms[k] = resolve(v);
}
const compositor = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
if (!compositor) throw new Error("wlcompositor.wasm not built");
let out = "";
const host = new NodeKernelHost({
  maxWorkers: 8,
  execPrograms,
  onStdout: (_p, d) => { const s = new TextDecoder().decode(d); out += s; process.stdout.write(s); },
  onStderr: (_p, d) => process.stderr.write(d),
});
await host.init();
host.setInputCanvasDims(1920, 1080);
let code = 1;
try {
  void host.spawn(load(compositor), ["wlcompositor"], { env: ["WLC_LAYOUT=dwindle"] });
  const deadline = Date.now() + 20_000;
  while (!out.includes("COMPOSITOR_UP")) {
    if (Date.now() > deadline) throw new Error("compositor did not come up");
    await new Promise((r) => setTimeout(r, 50));
  }
  code = await Promise.race([
    host.spawn(load(program), ["quickshell", "-p", config], {
      env: ["HOME=/tmp", "PATH=/opt/gx:/usr/bin:/bin", "XDG_RUNTIME_DIR=/tmp", "XKB_CONFIG_ROOT=/tmp"],
      cwd: "/tmp",
      stdin: new Uint8Array(0),
    }),
    new Promise<number>((_, rej) => setTimeout(() => rej(new Error("quickshell timed out")), 180_000)),
  ]);
  console.error(`[run-qs] quickshell -> ${code}`);
} finally {
  await host.destroy().catch(() => {});
}
process.exit(code);
