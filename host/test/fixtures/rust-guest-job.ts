import type { OwnedJobRead } from "../../src/owned-jobs";

/** Drain the real owned process family before inspecting its result. */
export async function readRustCompilerJob(host: {
  readOwnedJob(id: string, offset?: number, limit?: number): Promise<OwnedJobRead>;
  releaseOwnedJob(id: string): Promise<void>;
}, id: string, timeoutMs = 330_000) {
  let cursor = 0, stdout = "", stderr = "";
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await host.readOwnedJob(id, cursor, 65536);
    if (result.expired) throw new Error(`Rust compiler output expired: ${id}`);
    for (const chunk of result.chunks) {
      const text = decoders[chunk.stream].decode(chunk.bytes, { stream: true });
      if (chunk.stream === "stdout") stdout += text;
      else stderr += text;
    }
    cursor = result.next;
    if (result.terminationObserved && !result.hasMore) {
      await host.releaseOwnedJob(id);
      return { exitCode: result.exitCode, status: result.status,
        stdout: stdout + decoders.stdout.decode(), stderr: stderr + decoders.stderr.decode() };
    }
    if (Date.now() >= deadline) {
      throw new Error(`Rust compiler family did not retire: ${id}\n${stdout}\n${stderr}`);
    }
    if (!result.hasMore) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
