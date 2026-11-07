import { growMemoryToCoverWithFreshBoundary } from "../../src/process-memory";

export interface GrowthInterleavingRequest {
  memory: WebAssembly.Memory;
  pointerWidth: 4 | 8;
  gate: SharedArrayBuffer;
}

/** Pause after the helper samples capacity, then let a real peer grow it. */
export function runGrowthInterleaving(
  { memory, pointerWidth, gate }: GrowthInterleavingRequest,
  paused: () => void,
) {
  const barrier = new Int32Array(gate);
  const nativeGrow = memory.grow.bind(memory);
  Object.defineProperty(memory, "grow", { value(delta: number) {
    paused();
    if (Atomics.wait(barrier, 0, 0, 10_000) === "timed-out") {
      throw new Error("Peer did not release the growth barrier");
    }
    return nativeGrow(delta);
  } });
  try {
    const boundary = growMemoryToCoverWithFreshBoundary(memory, 3 * 65_536, pointerWidth);
    return {
      type: "result", boundary: boundary ?? null,
      bytes: memory.buffer.byteLength,
      peerByte: new Uint8Array(memory.buffer)[65_536],
      freshZero: boundary === undefined ? null
        : new Uint8Array(memory.buffer, boundary).every(value => value === 0),
    };
  } catch (error) {
    return { type: "error", name: error instanceof Error ? error.name : "unknown",
      message: String(error), bytes: memory.buffer.byteLength };
  }
}
