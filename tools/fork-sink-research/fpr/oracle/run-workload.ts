/**
 * Fork-stack oracle workload runner (research). Runs one program under
 * NodeKernelHost with /bin tools mapped explicitly, so no image or resolver
 * state is involved:
 *   npx tsx tools/fork-path-research/oracle/run-workload.ts <program.wasm> <name> [args...]
 * Env: ORACLE_EXEC="path=wasm,..." extra exec mappings; TIMEOUT (ms).
 * The fork stacks themselves are recorded by the KANDELO_FORK_STACK_LOG host
 * hook (tools/fork-path-research/oracle-fork-stack-log.patch).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";

const root = resolve(import.meta.dirname, "../../../..");
const bin = (p: string) => resolve(root, "local-binaries/source-only-v1/programs/wasm32", p);
const load = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const [program, name, ...args] = process.argv.slice(2);
const execPrograms: Record<string, string> = {
  "/bin/sh": bin("dash.wasm"),
  "/bin/dash": bin("dash.wasm"),
};
const coreutils = "cat wc sort echo ls printf head tail tr uname true false sleep env mkdir rm cp mv touch date seq yes tee cut uniq basename dirname pwd id test expr".split(" ");
for (const n of coreutils) {
  execPrograms[`/bin/${n}`] = bin("coreutils.wasm");
  execPrograms[`/usr/bin/${n}`] = bin("coreutils.wasm");
}
for (const n of ["grep", "sed"]) {
  execPrograms[`/bin/${n}`] = bin(`${n}.wasm`);
  execPrograms[`/usr/bin/${n}`] = bin(`${n}.wasm`);
}
for (const kv of (process.env.ORACLE_EXEC ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  execPrograms[k] = resolve(v);
}
let out = "";
const host = new NodeKernelHost({
  maxWorkers: 8,
  execPrograms,
  onStdout: (_p, d) => { out += Buffer.from(d).toString(); process.stdout.write(d); },
  onStderr: (_p, d) => process.stderr.write(d),
});
await host.init();
const timeout = Number(process.env.TIMEOUT ?? 120000);
let code = 1;
try {
  code = await Promise.race([
    host.spawn(load(resolve(program)), [name, ...args], {
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", "TERM=dumb", ...(process.env.ORACLE_ENV ?? "").split(",").filter(Boolean)],
      cwd: "/tmp",
      stdin: new Uint8Array(0),
    }),
    new Promise<number>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout)),
  ]);
} finally {
  await host.destroy().catch(() => {});
}
console.error(`[run-workload] exit ${code}`);
process.exit(code);
