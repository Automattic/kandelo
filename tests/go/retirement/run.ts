import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../host/src/node-kernel-host.ts";
import type { DestroyProgressEvent } from "../../../host/src/browser-kernel-protocol.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) throw new Error("usage: run.ts <program.wasm> <kernel.wasm>");
const bytes = (path: string): ArrayBuffer => Uint8Array.from(readFileSync(path)).buffer;
const progress: DestroyProgressEvent[] = [];
const diagnostics: unknown[] = [];
let stdout = "";
let stderr = "";
let ready!: () => void;
const started = new Promise<void>(resolve => { ready = resolve; });
const host = new NodeKernelHost({
  onStdout: (_pid, bytes) => {
    stdout += new TextDecoder().decode(bytes);
    if (stdout.includes("GO RETIREMENT READY")) ready();
  },
  onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
  onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
});
host.subscribeDestroyProgress(event => progress.push(event));
try {
  await host.init(bytes(kernelPath));
  const exit = host.spawn(bytes(programPath), ["go-retirement"]);
  // Observe startup or a real launch failure, rather than waiting a fixed delay.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      exit.then(code => { throw new Error(`guest exited before retirement: ${code}; ${stderr}`); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`guest startup timed out; ${stderr}`)), 30_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
  await host.destroy();
  const drained = progress.filter(event => event.phase === "draining").at(-1);
  console.log(JSON.stringify({ stdout, stderr, diagnostics, progress }));
  assert.equal(drained?.total, 1, "one live guest must be retired");
  assert.equal(drained.completed, 1, "the guest must unwind before forced termination");
  assert.equal(stderr, "");
  assert.deepEqual(diagnostics, []);
} finally { await host.destroy(); }
