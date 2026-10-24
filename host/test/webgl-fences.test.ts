import { expect, it, vi } from "vitest";
import { GlContextRegistry, type GlBindingInput } from "../src/webgl/registry.js";
import { GlFenceOwner } from "../src/webgl/fences.js";
import { hasNativeRepair, repairNativeState } from "../src/webgl/native-recovery.js";
import { GlMuxer } from "../src/webgl/muxer.js";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { setupMainForward, type GlForwardMessage } from "../src/webgl/main-forward.js";
import { createGlForwardQueryMailbox, prepareGlForwardQuery, waitForGlForwardQuery } from "../src/webgl/main-forward-query.js";

function driver() {
  let serial = 0;
  const live = new Set<WebGLSync>();
  const deleted: WebGLSync[] = [];
  const errors: number[] = [];
  let status: unknown = 0x9118, creation = 0, deletion = 0;
  let lost = false;
  const gl = {
    getError() { return errors.shift() ?? 0; },
    isContextLost() { return lost; },
    fenceSync(condition: number, flags: number) {
      expect([condition, flags]).toEqual([0x9117, 0]);
      const fence = { serial: ++serial } as WebGLSync;
      live.add(fence);
      if (creation) errors.push(creation);
      return fence;
    },
    getSyncParameter(fence: WebGLSync, parameter: number) {
      expect(parameter).toBe(0x9114);
      expect(live.has(fence)).toBe(true);
      return status;
    },
    deleteSync(fence: WebGLSync) {
      if (deletion) { errors.push(deletion); return; }
      expect(live.delete(fence)).toBe(true);
      deleted.push(fence);
    },
    getParameter() { return null; },
  } as unknown as WebGL2RenderingContext;
  return { gl, live, deleted, errors,
    status(value: unknown) { status = value; },
    creationError(value: number) { creation = value; },
    deletionError(value: number) { deletion = value; },
    lose() { lost = true; },
  };
}
function fixture() {
  const native = driver();
  const owner = new GlFenceOwner();
  const source = { gl: native.gl, errors: [] as number[] };
  return { native, owner, source };
}
function published(value: ReturnType<typeof fixture>) {
  const candidate = value.owner.prepare(value.source)!;
  expect(candidate).not.toBeNull();
  expect(candidate.publish()).toBe(true);
  return candidate.token;
}

it("keeps prepared fences private and cancels an unaccepted creation reply", () => {
  const { native, owner, source } = fixture();
  const candidate = owner.prepare(source)!;
  expect(owner.acquire(candidate.token)).toBeNull();
  candidate.cancel(); candidate.cancel();
  expect(candidate.publish()).toBe(false);
  expect(owner.destroy(candidate.token)).toBe(false);
  expect(native.live.size).toBe(0);
  expect(native.deleted).toHaveLength(1);
});
it("never cancels an accepted creation through a late cancellation", () => {
  const value = fixture(), token = published(value);
  const lease = value.owner.acquire(token)!;
  expect(lease).not.toBeNull();
  lease.release(); value.owner.destroy(token);
  // Publication is a one-way transfer from candidate to public authority.
  const candidate = value.owner.prepare(value.source)!;
  candidate.publish(); candidate.cancel();
  expect(value.owner.destroy(candidate.token)).toBe(true);
  value.owner.close();
});
it("retains both waiters after public destruction and deletes once on final release", () => {
  const value = fixture(), token = published(value);
  const first = value.owner.acquire(token)!, second = value.owner.acquire(token)!;
  expect(first.poll(value.source)).toBe(false);
  expect(value.owner.destroy(token)).toBe(true);
  expect(value.owner.acquire(token)).toBeNull();
  expect(value.owner.destroy(token)).toBe(false);
  value.native.status(0x9119);
  expect(first.poll(value.source)).toBe(true);
  first.release(); first.release();
  expect(first.poll(value.source)).toBeNull();
  expect(value.native.deleted).toHaveLength(0);
  expect(second.poll(value.source)).toBe(true);
  second.release();
  expect(value.native.deleted).toHaveLength(1);
});
it("retains a waiter through session close without accepting new public handles", () => {
  const value = fixture(), token = published(value);
  const waiter = value.owner.acquire(token)!;
  value.owner.close(); value.owner.close();
  expect(value.owner.acquire(token)).toBeNull();
  expect(value.owner.prepare(value.source)).toBeNull();
  value.native.status(0x9119);
  expect(waiter.poll(value.source)).toBe(true);
  expect(value.native.deleted).toHaveLength(0);
  waiter.release();
  expect(value.native.deleted).toHaveLength(1);
});
it("does not reuse a cancelled or deleted token", () => {
  const value = fixture();
  const cancelled = value.owner.prepare(value.source)!; cancelled.cancel();
  const first = published(value); value.owner.destroy(first);
  const next = published(value);
  expect(cancelled.token).toBeLessThan(first);
  expect(first).toBeLessThan(next);
  for (const invalid of [cancelled.token, first, 0, -1, 0x1_0000_0000, NaN, next + 1]) {
    expect(value.owner.acquire(invalid)).toBeNull();
    expect(value.owner.destroy(invalid)).toBe(false);
  }
  value.owner.close();
});
it("cleans a returned native candidate when creation acknowledgement fails", () => {
  const value = fixture();
  value.native.creationError(0x505);
  expect(value.owner.prepare(value.source)).toBeNull();
  expect(value.native.deleted).toHaveLength(1);
  expect(value.source.errors).toEqual([]);
});
it("preserves existing GL flags while keeping internal creation errors private", () => {
  const value = fixture();
  value.native.errors.push(0x500);
  value.native.creationError(0x505);
  expect(value.owner.prepare(value.source)).toBeNull();
  expect(value.source.errors).toEqual([0x500]);
});
it("retains rejected candidate deletion and fences admission until cleanup succeeds", () => {
  const value = fixture();
  value.native.creationError(0x505); value.native.deletionError(0x502);
  expect(value.owner.prepare(value.source)).toBeNull();
  expect(value.native.live.size).toBe(1);
  expect(hasNativeRepair(value.native.gl)).toBe(true);
  expect(value.owner.prepare(value.source)).toBeNull();
  value.native.creationError(0); value.native.deletionError(0);
  expect(repairNativeState(value.native.gl)).toBe(true);
  expect(value.native.deleted).toHaveLength(1);
  const token = published(value); value.owner.destroy(token);
  expect(value.native.deleted).toHaveLength(2);
});
it("keeps failed final deletion owned after session removal", () => {
  const value = fixture(); published(value);
  value.native.deletionError(0x502); value.owner.close();
  expect(hasNativeRepair(value.native.gl)).toBe(true);
  expect(value.native.live.size).toBe(1);
  value.native.deletionError(0);
  expect(repairNativeState(value.native.gl)).toBe(true);
  expect(value.native.deleted).toHaveLength(1);
  expect(repairNativeState(value.native.gl)).toBe(true);
  expect(value.native.deleted).toHaveLength(1);
});
it.each([undefined, null, 0, 0x9117, 0.5])("does not turn malformed native status %s into completion", (status) => {
  const value = fixture(), token = published(value);
  const lease = value.owner.acquire(token)!;
  value.native.status(status);
  expect(lease.poll(value.source)).toBeNull();
  lease.release(); value.owner.destroy(token);
});
it("preserves the current GL owner's pending errors during polling", () => {
  const value = fixture(), token = published(value);
  const lease = value.owner.acquire(token)!;
  const other = { errors: [] as number[] };
  value.native.errors.push(0x501);
  expect(lease.poll(other)).toBe(false);
  expect(other.errors).toEqual([0x501]);
  expect(value.source.errors).toEqual([]);
  lease.release(); value.owner.destroy(token);
});
it("does not report context loss as a signaled fence", () => {
  const value = fixture(), token = published(value);
  const lease = value.owner.acquire(token)!;
  value.native.status(0x9119); value.native.lose();
  expect(lease.poll(value.source)).toBeNull();
  lease.release(); value.owner.close();
});
it("retains native fences across logical context destruction and recreation", () => {
  const registry = new GlContextRegistry(), native = driver();
  registry.bind({ pid: 7, sessionId: 11, cmdbufAddr: 4096, cmdbufLen: 4096 });
  const binding = registry.get(7, 11)!; binding.gl = native.gl; binding.contextId = 1;
  const candidate = binding.fences.prepare(binding)!; candidate.publish();
  const waiter = binding.fences.acquire(candidate.token)!;
  registry.destroyContext(7, 11);
  expect(binding.gl).toBeNull();
  expect(native.deleted).toHaveLength(0);
  const replacement = driver(); binding.gl = replacement.gl; binding.contextId = 2;
  const next = binding.fences.prepare(binding)!; next.publish();
  expect(next.token).toBeGreaterThan(candidate.token);
  native.status(0x9119);
  expect(waiter.poll(null)).toBe(true);
  binding.fences.destroy(candidate.token); waiter.release();
  expect(native.deleted).toHaveLength(1);
  expect(replacement.deleted).toHaveLength(0);
  registry.unbind(7, 11);
  expect(replacement.deleted).toHaveLength(1);
});

it.each(["fd-close", "process-exit"] as const)("captures a peer's flags before retiring a creatorless fence on %s", (path) => {
  const native = driver();
  const gl = new Proxy(native.gl, { get(target, name) {
    return Reflect.get(target, name) ?? (() => null);
  } });
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({ io: {}, memory,
    instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096),
    pointerWidth: 4,
  }) as any;
  kernel.gl.bind({ pid: 7, sessionId: 11, cmdbufAddr: 4096, cmdbufLen: 4096 });
  kernel.gl.bind({ pid: 8, sessionId: 22, cmdbufAddr: 4096, cmdbufLen: 4096 });
  const creator = kernel.gl.get(7, 11)!, peer = kernel.gl.get(8, 22)!;
  creator.gl = peer.gl = gl; creator.contextId = 1; peer.contextId = 2;
  const candidate = creator.fences.prepare(creator)!; candidate.publish();
  kernel.gl.destroyContext(7, 11);
  expect(creator.gl).toBeNull();
  const muxer = new GlMuxer(gl); kernel.gl_muxers.set(gl, muxer);
  muxer.switchTo(peer);
  native.errors.push(0x500);
  if (path === "process-exit") kernel.releaseProcessViews(7);
  else kernel.testAuthority.buildImportObject(memory).env.host_gl_unbind(7, 11);
  expect(peer.errors).toEqual([0x500]);
  expect(native.deleted).toHaveLength(1);
  expect(kernel.gl.get(7, 11)).toBeUndefined();
  kernel.releaseProcessViews(8);
});

it("preserves a forwarded peer's flags when unbinding a creatorless fence", () => {
  const native = driver();
  const gl = new Proxy(native.gl, { get(target, name) {
    return Reflect.get(target, name) ?? (() => null);
  } });
  let registry!: GlContextRegistry;
  const original = GlContextRegistry.prototype.bind;
  const observe = vi.spyOn(GlContextRegistry.prototype, "bind").mockImplementation(function (this: GlContextRegistry, input: GlBindingInput) {
    original.call(this, input); registry = this;
  });
  let listener: ((event: MessageEvent) => void) | null = null;
  const worker = {
    addEventListener(_type: "message", value: (event: MessageEvent) => void) { listener = value; },
    removeEventListener() { listener = null; },
  };
  const fire = (data: GlForwardMessage) => listener!({ data } as MessageEvent);
  const dispose = setupMainForward(worker, { width: 1, height: 1, getContext: () => gl } as unknown as HTMLCanvasElement, 7);
  try {
    for (const sessionId of [11, 12]) {
      const mailbox = createGlForwardQueryMailbox(); prepareGlForwardQuery(mailbox, 0);
      fire({ type: "gl_forward_create_context", pid: 7, sessionId, mailbox });
      expect(waitForGlForwardQuery(mailbox).rc).toBe(0);
    }
    const creator = registry.get(7, 11)!, peer = registry.get(7, 12)!;
    const candidate = creator.fences.prepare(creator)!; candidate.publish();
    fire({ type: "gl_forward_destroy_context", pid: 7, sessionId: 11 });
    expect(creator.gl).toBeNull();
    const bytes = new Uint8Array(8), words = new DataView(bytes.buffer);
    words.setUint16(0, 1, true); words.setUint16(2, 4, true); words.setUint32(4, 0x4000, true);
    fire({ type: "gl_forward_submit", pid: 7, sessionId: 12, bytes });
    expect(peer.errors).toEqual([]);
    native.errors.push(0x500);
    fire({ type: "gl_forward_unbind", pid: 7, sessionId: 11 });
    expect(peer.errors).toEqual([0x500]);
    expect(native.deleted).toHaveLength(1);
  } finally { dispose(); observe.mockRestore(); }
});

it("releases an empty cleanup reservation when native fence allocation returns null", () => {
  const value = fixture();
  value.native.gl.fenceSync = () => null;
  expect(value.owner.prepare(value.source)).toBeNull();
  expect(value.native.live.size).toBe(0);
  expect(value.native.deleted).toHaveLength(0);
  expect(hasNativeRepair(value.native.gl)).toBe(false);
});
it("does not allocate a native fence when publication metadata cannot be reserved", () => {
  const value = fixture();
  const entries = (value.owner as any).fences as Map<number, unknown>;
  const reserve = vi.spyOn(entries, "set").mockImplementation(() => { throw new Error("allocation rejected"); });
  expect(value.owner.prepare(value.source)).toBeNull();
  expect(value.native.live.size).toBe(0);
  expect(value.native.deleted).toHaveLength(0);
  expect(hasNativeRepair(value.native.gl)).toBe(false);
  reserve.mockRestore();
  const token = published(value); value.owner.destroy(token);
});
it("refuses token exhaustion instead of wrapping onto an older identity", () => {
  const value = fixture();
  (value.owner as any).serial = 0xffff_fffe;
  const finalToken = published(value);
  expect(finalToken).toBe(0xffff_ffff);
  expect(value.owner.prepare(value.source)).toBeNull();
  expect(value.native.live.size).toBe(1);
  value.owner.destroy(finalToken);
  expect(value.native.deleted).toHaveLength(1);
});
