/**
 * Run a sequence of commands of one program in ONE NodeKernelHost, so the
 * guest filesystem persists between them (research):
 *   npx tsx tools/fork-sink-research/real/run-seq.ts <program.wasm> <name> <cmds.json>
 * cmds.json: [["init","-q","/tmp/r"], ["-C","/tmp/r","commit",...], ...]
 * Env: SEQ_EXEC="guest-path=host-wasm,..." exec mappings; SEQ_ENV extra env.
 * Prints each command's exit status; exits non-zero if any command failed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";

const [program, name, cmdsPath] = process.argv.slice(2);
const cmds: string[][] = JSON.parse(readFileSync(cmdsPath, "utf8"));
const execPrograms: Record<string, string> = {};
for (const kv of (process.env.SEQ_EXEC ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  execPrograms[k] = resolve(v);
}
const bytes = (() => {
  const b = readFileSync(resolve(program));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
})();
const host = new NodeKernelHost({
  maxWorkers: 8,
  execPrograms,
  onStdout: (_p, d) => process.stdout.write(d),
  onStderr: (_p, d) => process.stderr.write(d),
});
await host.init();
let failed = 0;
try {
  for (const argv of cmds) {
    const code = await Promise.race([
      host.spawn(bytes, [name, ...argv], {
        env: ["HOME=/tmp", "PATH=/opt/gx:/usr/bin:/bin", "TMPDIR=/tmp", "TERM=dumb", "GIT_PAGER=cat", "PAGER=cat",
          ...(process.env.SEQ_ENV ?? "").split(",").filter(Boolean)],
        cwd: "/tmp",
        stdin: new Uint8Array(0),
      }),
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error("timeout: " + argv.join(" "))), 120000)),
    ]);
    console.error(`[run-seq] ${argv.join(" ")} -> ${code}`);
    if (code !== 0) failed++;
  }
} finally {
  await host.destroy().catch(() => {});
}
process.exit(failed ? 1 : 0);
