import { GlMuxer } from "../src/webgl/muxer.js";
import { defaultShadow } from "../src/webgl/shadow.js";
import { blitPresentTarget } from "../src/webgl/present-target.js";
import type { GlBinding } from "../src/webgl/registry.js";
import { afterEach, expect, it } from "vitest";
import { withNativeBatch } from "../src/webgl/native-batch.js";
import { checkedGlCall, checkedGlGroup, checkedGlSequence } from "../src/webgl/program-objects.js";
import { captureNativeGlErrors, recordGlError } from "../src/webgl/errors.js";
import { rendererLost, RENDERER_LOST } from "../src/webgl/renderer-loss.js";
import { NativeGlFault, reserveNativeRetirement, retireNativeRetirement } from "../src/webgl/native-recovery.js";
import { configureGlAudit, resetGlAuditForTesting } from "../src/webgl/native-audit.js";
import { setGlDiagnosticReporter } from "../src/webgl/diagnostics.js";

function setup() {
  const flags: number[] = [];
  let reads = 0;
  const gl = { getError: () => { reads++; return flags.shift() ?? 0; }, isContextLost: () => false } as unknown as WebGL2RenderingContext;
  const owner = { gl, pid: 100, sessionId: 7, errors: [] as number[] };
  return { gl, flags, owner, reads: () => reads };
}
afterEach(() => { resetGlAuditForTesting(); setGlDiagnosticReporter(null); });

it("uses host errors and one native sample for an entire submitted batch", () => {
  const { owner, reads } = setup();
  let calls = 0;
  expect(withNativeBatch(owner, "submit", () => {
    recordGlError(owner, 0x500);
    for (let i = 0; i < 20; i++) {
      expect(checkedGlCall(owner, () => { calls++; })).toBe(true);
      expect(checkedGlGroup(owner, [() => { calls++; }])).toBe(true);
      expect(checkedGlSequence(owner, [() => { calls++; }])).toBe(true);
      captureNativeGlErrors(owner.gl, owner);
    }
    return withNativeBatch(owner, "nested query", () => 8);
  })).toBe(8);
  expect(calls).toBe(60);
  expect(reads()).toBe(1);
  expect(owner.errors).toEqual([0x500]);
});

it.each([0x500, 0x502, 0x505])("resets only the guilty logical context for native flag %s", error => {
  const { owner, gl, flags } = setup();
  const peer = { gl, pid: 101, sessionId: 8, errors: [] as number[] };
  const messages: string[] = [];
  setGlDiagnosticReporter(d => messages.push(d.message));
  expect(withNativeBatch(owner, "submit", () => { flags.push(error); return 0; })).toBe(RENDERER_LOST);
  expect(rendererLost(owner)).toBe(true);
  expect(rendererLost(peer)).toBe(false);
  expect(owner.errors).toEqual([]);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(/pid 100 session 7 batch .*submit/);
  expect(messages[0]).toMatch(error === 0x505 ? /OUT_OF_MEMORY/ : /unpredicted/);
  let executed = false;
  expect(withNativeBatch(owner, "later", () => { executed = true; })).toBe(RENDERER_LOST);
  expect(executed).toBe(false);
  expect(withNativeBatch(peer, "peer", () => 4)).toBe(4);
});

it("a private allocation check cannot swallow the guest batch's native error", () => {
  const { owner, flags, gl } = setup();
  const privateOwner = { gl, errors: [] as number[] };
  setGlDiagnosticReporter(() => {});
  let allocated = false;
  expect(withNativeBatch(owner, "query", () => {
    flags.push(0x502, 0x501);
    checkedGlCall(privateOwner, () => { allocated = true; });
  })).toBe(RENDERER_LOST);
  expect(allocated).toBe(false);
  expect(privateOwner.errors).toEqual([]);
  expect(flags).toEqual([]);
});

it("keeps exact allocation checks outside guest acceptance", () => {
  const { owner, flags, reads } = setup();
  expect(checkedGlCall(owner, () => { flags.push(0x505); })).toBe(false);
  expect(owner.errors).toEqual([0x505]);
  expect(reads()).toBe(2);
});

it("is fatal under the native audit", () => {
  const { owner, flags } = setup();
  configureGlAudit({ mode: "fatal", sink: () => {}, fault: message => { throw new NativeGlFault(message); } });
  setGlDiagnosticReporter(() => {});
  expect(() => withNativeBatch(owner, "submit", () => { flags.push(0x502); })).toThrow(NativeGlFault);
});

it.each(["replay", "present"])("attributes an unchecked %s native refusal to its logical context", kind => {
  const { owner, flags, gl } = setup();
  const proxy = new Proxy(gl, { get: (target, key) => Reflect.get(target, key)
    ?? (key === "createVertexArray" ? () => ({}) : () => {}) });
  const binding = { ...owner, gl: proxy, shadow: defaultShadow(), clientArrayEndRequested: false,
    presentTarget: { fbo: {}, w: 1, h: 1 } } as unknown as GlBinding;
  const method = kind === "replay" ? "viewport" : "blitFramebuffer";
  Reflect.set(gl, method, () => { flags.push(0x502); });
  setGlDiagnosticReporter(() => {});
  expect(withNativeBatch(binding, kind, () => {
    if (kind === "replay") new GlMuxer(proxy).switchTo(binding);
    else blitPresentTarget(binding, binding as unknown as GlBinding["surface"]);
  })).toBe(RENDERER_LOST);
  expect(rendererLost(binding)).toBe(true);
});

it("retains fatal refused-deletion policy inside an otherwise predicted batch", () => {
  const { owner, flags, gl } = setup();
  Reflect.set(gl, "deleteTexture", () => { flags.push(0x502); });
  const retirement = reserveNativeRetirement(owner, [["deleteTexture", {}]])!;
  expect(() => withNativeBatch(owner, "submit", () => {
    retireNativeRetirement(retirement);
  })).toThrow(/refused deleteTexture/);
  expect(rendererLost(owner)).toBe(false);
});

it("keeps real WebGL context loss a reset boundary under audit", () => {
  const { owner, flags } = setup();
  configureGlAudit({ mode: "fatal", sink: () => {}, fault: message => { throw new NativeGlFault(message); } });
  expect(withNativeBatch(owner, "submit", () => { flags.push(0x9242); })).toBe(RENDERER_LOST);
  expect(rendererLost(owner)).toBe(true);
});
