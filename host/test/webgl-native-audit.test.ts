import { afterEach, expect, it } from "vitest";
import {
  auditGlContext, glAuditEntry, isGlAuditEntryName, configureGlAudit, glAuditOn, nativeDecides, noteGlAuditOp,
  parseGlAuditMode, predictNextNativeCall, resetGlAuditForTesting, withGlAuditFrame, withNativePrediction,
  type GlAuditRecord,
} from "../src/webgl/native-audit";
import { nativePredictionGap } from "../src/webgl/native-predictions";
import { checkedGlCall, type CheckedGlOwner } from "../src/webgl/program-objects";
import { OP_TEX_PARAMETERI, OP_USE_PROGRAM, QOP_READ_PIXELS } from "../src/webgl/ops";

/** A renderer with GL error-flag semantics: each distinct flag is recorded
 * once until getError reads it. Methods live on the prototype, like WebGL. */
class FakeRenderer {
  flags: number[] = [];
  calls: string[] = [];
  nativeReads = 0;
  getError(): number { this.nativeReads++; return this.flags.shift() ?? 0; }
  // An own property, not a prototype method: only GL entry points are audited.
  raise = (error: number): void => { if (!this.flags.includes(error)) this.flags.push(error); };
  texParameteri(target: number, pname: number, param: number): void {
    this.calls.push(`texParameteri(${target},${pname},${param})`);
    if (param === 0xdead) this.raise(0x500);
  }
  bufferData(size: number): void { this.calls.push(`bufferData(${size})`); if (size > 1e9) this.raise(0x505); }
  useProgram(program: object | null): void { this.calls.push("useProgram"); if (program === null) return; this.raise(0x502); }
  isContextLost(): boolean { return false; }
}

function audit(mode: "record" | "fatal" = "record") {
  const records: GlAuditRecord[] = [], faults: string[] = [];
  configureGlAudit({ mode, sink: record => { if (record.kind !== "context") records.push(record); }, fault: message => {
    faults.push(message); throw new Error(message);
  } });
  const native = new FakeRenderer();
  const gl = auditGlContext(native as unknown as WebGL2RenderingContext);
  return { native, gl, records, faults };
}

afterEach(() => resetGlAuditForTesting());

it("announces each instrumented context once, never as a divergence", () => {
  const records: GlAuditRecord[] = [];
  configureGlAudit({ mode: "fatal", sink: record => records.push(record), fault: message => { throw new Error(message); } });
  const native = new FakeRenderer();
  auditGlContext(native as unknown as WebGL2RenderingContext);
  auditGlContext(native as unknown as WebGL2RenderingContext);
  expect(records.map(record => [record.kind, record.cause])).toEqual([["context", "instrumented"]]);
});

it("is inert unless configured", () => {
  const native = new FakeRenderer();
  expect(glAuditOn).toBe(false);
  expect(auditGlContext(native as unknown as WebGL2RenderingContext)).toBe(native);
  expect(Object.getOwnPropertyNames(native)).not.toContain("texParameteri");
  expect(parseGlAuditMode(undefined)).toBeUndefined();
  expect(parseGlAuditMode("off")).toBeUndefined();
  expect(parseGlAuditMode("fatal")).toBe("fatal");
  expect(() => parseGlAuditMode("yes")).toThrow(/record.*fatal/);
});

it("keeps the context's identity and hands every read error back to the host", () => {
  const { native, gl, records } = audit();
  expect(gl).toBe(native);
  // Two refusals from one site: the second records nothing new natively
  // (the flag is still set) but is still a divergence of its own.
  for (let i = 0; i < 2; i++) gl.texParameteri(0xde1, 0x2801, 0xdead);
  // The audit read the flag right after the first call; the host's own read
  // still sees it, once, exactly as without the audit.
  expect(gl.getError()).toBe(0x500);
  expect(gl.getError()).toBe(0);
  expect(records.map(record => [record.cause, record.observed, record.call])).toEqual([
    ["unpredicted", "INVALID_ENUM", "texParameteri(0xde1, 0x2801, 0xdead)"],
    ["unpredicted", "INVALID_ENUM", "texParameteri(0xde1, 0x2801, 0xdead)"],
  ]);
  expect(records[1].occurrence).toBe(2);
  expect(records[0].site).toMatch(/webgl-native-audit\.test/);
});

it("attributes a divergence to the import, frame and op that issued it", () => {
  const { gl, records } = audit();
  const env: Record<string, unknown> = {
    host_gl_submit: (_pid: number, _offset: number, _length: number, _session: number) =>
      withGlAuditFrame({ pid: 7, sessionId: 3 }, () => {
        const payload = new DataView(new Uint32Array([0xde1, 0x2801, 0xdead]).buffer);
        noteGlAuditOp(OP_TEX_PARAMETERI, payload);
        gl.texParameteri(0xde1, 0x2801, 0xdead);
        return 0;
      }),
    host_debug_log: () => 0,
  };
  const original = env.host_debug_log;
  for (const name of Object.keys(env)) {
    if (isGlAuditEntryName(name)) env[name] = glAuditEntry(name, env[name] as (...args: unknown[]) => unknown);
  }
  expect(env.host_debug_log).toBe(original);
  expect((env.host_gl_submit as (...args: number[]) => number)(7, 0, 12, 3)).toBe(0);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ entry: "host_gl_submit", entryArgs: [7, 0, 12, 3], pid: 7, session: 3,
    op: "OP_TEX_PARAMETERI", opArgs: "[0xde1,0x2801,0xdead] 12B" });
  expect(records[0].batch).toBeGreaterThan(0);
});

it("labels a native refusal the gap table leaves to the renderer for that op", () => {
  const { gl, records } = audit();
  const owner: CheckedGlOwner = { gl, errors: [] };
  const payload = new DataView(new ArrayBuffer(4));
  withGlAuditFrame({ pid: 1, sessionId: 1 }, () => {
    noteGlAuditOp(OP_USE_PROGRAM, payload);
    expect(checkedGlCall(owner, () => gl.useProgram({}))).toBe(false);
    // The same method under another op is not a recorded gap.
    noteGlAuditOp(OP_TEX_PARAMETERI, payload);
    expect(checkedGlCall(owner, () => gl.useProgram({}))).toBe(false);
  });
  expect(owner.errors).toEqual([0x502]);
  expect(records.map(record => record.cause)).toEqual(["native-decided", "unpredicted"]);
  expect(records[0].predicted).toMatch(/^native-decides glUseProgram: ES 2.0 2.10.3/);
});

it("labels a call site's own explicit prediction", () => {
  const { gl, records } = audit();
  const owner: CheckedGlOwner = { gl, errors: [] };
  const linkStatus = nativeDecides("useProgram", "test rule");
  expect(withNativePrediction(linkStatus, () => checkedGlCall(owner, () => gl.useProgram({})))).toBe(false);
  expect(records.map(record => [record.cause, record.predicted])).toEqual([["native-decided", "native-decides useProgram: test rule"]]);
});

it("keeps the gap table keyed by op, query and import", () => {
  expect(nativePredictionGap(OP_TEX_PARAMETERI, null, "host_gl_submit", "texParameteri")?.label).toBe("glTexParameter");
  expect(nativePredictionGap(OP_TEX_PARAMETERI, null, "host_gl_submit", "bindTexture")).toBeUndefined();
  expect(nativePredictionGap(null, QOP_READ_PIXELS, "host_gl_query", "readPixels")?.label).toBe("glReadPixels");
  expect(nativePredictionGap(null, null, "host_gbm_gpu_bo_create", "texImage2D")?.label).toBe("GBM/EGLImage GPU storage");
  expect(nativePredictionGap(null, null, "unscoped", "texImage2D")).toBeUndefined();
});

it("applies a next-call prediction to exactly one native call", () => {
  const { gl, records } = audit();
  predictNextNativeCall(nativeDecides("texParameteri", "ES 2.0 3.7.4 param value"));
  gl.texParameteri(0xde1, 0x2801, 0xdead);
  gl.getError();
  gl.texParameteri(0xde1, 0x2801, 0xdead);
  expect(records.map(record => record.cause)).toEqual(["native-decided", "unpredicted"]);
});

it("records OUT_OF_MEMORY as a boundary, never a divergence, even when fatal", () => {
  const { gl, records, faults } = audit("fatal");
  gl.bufferData(2e9);
  expect(records.map(record => [record.kind, record.cause])).toEqual([["boundary", "out-of-memory"]]);
  expect(faults).toEqual([]);
  expect(gl.getError()).toBe(0x505);
});

it("latches a fatal fault naming the call, op and process in fatal mode", () => {
  const { gl, records, faults } = audit("fatal");
  expect(() => withGlAuditFrame({ pid: 9, sessionId: 1 }, () => gl.texParameteri(0xde1, 0x2801, 0xdead)))
    .toThrow(/GL audit divergence \(unpredicted\): texParameteri\(0xde1, 0x2801, 0xdead\) raised INVALID_ENUM/);
  expect(records).toHaveLength(1);
  expect(faults[0]).toMatch(/pid 9 session 1 batch \d+/);
});

it("checks only methods that can raise GL errors", () => {
  const { native, gl } = audit();
  const reads = native.nativeReads;
  gl.isContextLost();
  expect(native.nativeReads).toBe(reads);
  gl.texParameteri(0xde1, 0x2801, 1);
  expect(native.nativeReads).toBe(reads + 1);
  expect(native.calls).toEqual(["texParameteri(3553,10241,1)"]);
});
