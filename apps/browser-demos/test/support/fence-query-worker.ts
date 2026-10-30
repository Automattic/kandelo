import { createWasmPosixKernelTestHarness } from "../../../../host/src/kernel";
import { createKernelScratchTestInstance } from "../../../../host/test/support/kernel-scratch-instance";
import { createMainForwardChannel } from "../../../../host/src/webgl/main-forward";
import * as O from "../../../../host/src/webgl/ops";

// Exercise actual host imports and the existing forwarding mailbox using a
// synthetic Rust scratch/identity fixture. No guest memory reaches the page.
self.onmessage = async ({ data }) => {
  if (data.type !== "start_fence_query") return;
  try {
    const pid = 91, session = 131, forwarded = data.mode === "forwarded";
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const kernel = createWasmPosixKernelTestHarness({ io: {} as any, memory, pointerWidth: 4,
      callbacks: { getProcessMemory: () => memory },
      instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096) });
    kernel.gl.bind({ pid, sessionId: session, cmdbufAddr: 4096, cmdbufLen: 4096 });
    const binding = kernel.gl.get(pid, session)!;
    let gl: WebGL2RenderingContext | null = null, created = 0, deleted = 0;
    if (forwarded) {
      const channel = createMainForwardChannel(self, pid, session);
      kernel.gl.attachMainForward(pid, channel, session);
      if (channel.onCreateContext(session) !== 0) throw new Error("Forwarded context creation failed");
    } else {
      gl = (data.canvas as OffscreenCanvas).getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error("Worker WebGL2 required");
      const allocate = gl.fenceSync.bind(gl), destroy = gl.deleteSync.bind(gl);
      gl.fenceSync = (condition, flags) => { const value = allocate(condition, flags); if (value) created++; return value; };
      gl.deleteSync = sync => { if (sync) deleted++; destroy(sync); };
      binding.gl = gl;
    }
    binding.contextId = session;
    const imports = kernel.testAuthority.buildImportObject(memory).env as Record<string, (...args: any[]) => any>;
    const submit = (op: number, payload: Uint8Array) => {
      const packet = new Uint8Array(4 + payload.byteLength), header = new DataView(packet.buffer);
      header.setUint16(0, op, true); header.setUint16(2, payload.byteLength, true); packet.set(payload, 4);
      new Uint8Array(memory.buffer, 4096, packet.byteLength).set(packet);
      const rc = imports.host_gl_submit(pid, 0, packet.byteLength, session);
      if (rc !== 0) throw new Error(`Host submit ${op} failed: ${rc}`);
    };
    const color = new Uint8Array(16), colors = new DataView(color.buffer);
    [1, 0, 0, 1].forEach((value, index) => colors.setFloat32(index * 4, value, true));
    submit(O.OP_CLEAR_COLOR, color);
    const mask = new Uint8Array(4); new DataView(mask.buffer).setUint32(0, 0x4000, true);
    submit(O.OP_CLEAR, mask);
    const query = (op: number, token: number) => {
      new DataView(memory.buffer).setUint32(64, token, true);
      const rc = imports.host_gl_query(pid, op, 64, 4, 128, 16, session);
      if (rc !== 16) throw new Error(`Fence query failed: ${rc}`);
      const reply = new DataView(memory.buffer, 128, 16);
      const words = Array.from({ length: 4 }, (_, index) => reply.getUint32(index * 4, true));
      if (words[1] !== token || words[3] !== 0x47514c33) throw new Error("Malformed fence reply");
      return words;
    };
    const initial = query(O.QOP_CREATE_FENCE, 7), repeated = query(O.QOP_CREATE_FENCE, 7);
    if (initial[0] !== 0 || repeated[0] !== 0) throw new Error("Creation rejected");
    if (imports.host_gl_query(pid, O.QOP_FLUSH, 0, 0, 0, 0, session) !== 0) throw new Error("Server flush failed");
    imports.host_gl_destroy_context(pid, session);
    if (binding.contextId !== null) throw new Error("Creator did not retire");
    let signaled = false;
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      const reply = query(O.QOP_FENCE_STATUS, 7);
      if (reply[0] !== 0) throw new Error("Retained fence disappeared");
      if (reply[2] === 1) { signaled = true; break; }
    }
    if (!signaled) throw new Error("Fence did not complete");
    query(O.QOP_RELEASE_FENCE, 7); query(O.QOP_RELEASE_FENCE, 7);
    const retired = query(O.QOP_FENCE_STATUS, 7);
    let pixels: number[] | null = null;
    if (gl) {
      const output = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, output);
      pixels = [...output];
      if (gl.getError() !== 0) throw new Error("Native GL error");
    }
    imports.host_gl_unbind(pid, session);
    self.postMessage({ type: "fence_query_result", signaled, retired: retired[0], created, deleted, pixels });
  } catch (error) { self.postMessage({ type: "fence_query_result", error: String(error) }); }
};
