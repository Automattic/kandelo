import { afterEach, expect, it } from "vitest";
import { auditGlContext, configureGlAudit, nativeDecides, resetGlAuditForTesting, withGlAuditEntry,
  withNativePrediction, type GlAuditRecord } from "../src/webgl/native-audit.js";
import { withNativeBatch, withNativeBookkeeping } from "../src/webgl/native-batch.js";
import { checkedGlCall, checkedGlGroup, checkedGlSequence } from "../src/webgl/program-objects.js";
import { NativeGlFault } from "../src/webgl/native-recovery.js";
import { setGlDiagnosticReporter } from "../src/webgl/diagnostics.js";
import { rendererLost, RENDERER_LOST } from "../src/webgl/renderer-loss.js";

// Prototype methods reproduce WebGL's method ownership. The counter is inside
// the ORIGINAL getter, so it includes the oracle captured before interception;
// counting the public gl.getError wrapper would miss the regression.
class Renderer {
  nativeReads = 0;
  calls = 0;
  flags: number[] = [];
  lost = false;
  raise = (error: number): void => { if (!this.flags.includes(error)) this.flags.push(error); };
  getError(): number { this.nativeReads++; return this.flags.shift() ?? 0; }
  isContextLost(): boolean { return this.lost; }
  clear(): void { this.calls++; }
  viewport(_x: number, _y: number, width: number): void { this.calls++; if (width < 0) this.raise(0x501); }
  allocate(): void { this.calls++; this.raise(0x505); }
  mixedFailure(): void { this.calls++; this.raise(0x502); this.raise(0x505); }
  objectWithOom(): object { const value={owned:true}; this.raise(0x505); return value; }
  throwNative(): void { this.calls++; throw new TypeError("native argument conversion failed"); }
}
function setup(mode: "record" | "fatal" = "fatal") {
  const records: GlAuditRecord[] = [], faults: string[] = [], diagnostics: string[] = [];
  configureGlAudit({ mode, sink: r => records.push(r), fault: message => {
    faults.push(message); throw new NativeGlFault(message);
  } });
  setGlDiagnosticReporter(diagnostic => diagnostics.push(diagnostic.message));
  const native = new Renderer(), gl = auditGlContext(native as unknown as WebGL2RenderingContext);
  const owner = { gl, pid: 100, sessionId: 7, errors: [] as number[] };
  const peer = { gl, pid: 101, sessionId: 8, errors: [0x500] };
  const batch = (work: () => number | void) => withGlAuditEntry("host_gl_submit", [100, 0, 0, 7], 7,
    () => withNativeBatch(owner, "prototype-counter submission", work));
  return { native, gl, owner, peer, records, faults, diagnostics, batch };
}
afterEach(() => { resetGlAuditForTesting(); setGlDiagnosticReporter(null); });

it("samples the REAL native getter once for a fatal audited accepted batch", () => {
  const {native, gl, owner, records, batch} = setup();
  owner.errors.push(0x500);
  expect(batch(() => {
    for (let i = 0; i < 12; i++) {
      expect(checkedGlCall(owner, () => gl.clear(0))).toBe(true);
      expect(checkedGlGroup(owner, [() => gl.clear(0)])).toBe(true);
      expect(checkedGlSequence(owner, [() => gl.clear(0)])).toBe(true);
    }
    return withNativeBatch(owner, "nested same owner", () => 19);
  })).toBe(19);
  expect(native.calls).toBe(36);
  expect(native.nativeReads).toBe(1);
  expect(owner.errors).toEqual([0x500]);
  expect(records.map(r => r.kind)).toEqual(["context"]);
});

it("retains the record-mode per-call oracle inventory", () => {
  const {native, gl, owner, records, batch} = setup("record");
  batch(() => { for (let i = 0; i < 5; i++) checkedGlCall(owner, () => gl.clear(0)); });
  expect(native.nativeReads).toBe(6);
  expect(records.map(r => r.kind)).toEqual(["context"]);
});

it("does not consume older audit-held guest flags as a new batch failure", () => {
  const {native, gl, owner, batch} = setup();
  withNativePrediction({kind:"error",error:0x501,label:"older rejected native call"}, () => gl.viewport(0,0,-1,0));
  const before = native.nativeReads;
  expect(batch(() => { checkedGlCall(owner, () => gl.clear(0)); })).toBe(0);
  expect(native.nativeReads - before).toBe(1);
  expect(rendererLost(owner)).toBe(false);
  expect(gl.getError()).toBe(0x501);
  expect(gl.getError()).toBe(0);
});

it("attributes an unexpected accepted-call flag to its real batch and owner", () => {
  const {gl, owner, peer, records, diagnostics, batch} = setup();
  expect(() => batch(() => { checkedGlCall(owner, () => gl.viewport(0,0,-1,0)); })).toThrow(NativeGlFault);
  expect(rendererLost(owner)).toBe(true);
  expect(rendererLost(peer)).toBe(false);
  expect(peer.errors).toEqual([0x500]);
  expect(records.at(-1)).toMatchObject({kind:"divergence",cause:"batch-native-error",call:expect.stringContaining("nativeBatchSample"),pid:100,session:7,observed:"INVALID_VALUE",op:null});
  expect(diagnostics.join("\n")).toMatch(/pid 100 session 7/);
});

it("resets the original owner for a native throw without inventing an observed flag", () => {
  const {native, owner, peer, records, diagnostics, batch} = setup();
  expect(() => batch(() => { checkedGlCall(owner, () => native.throwNative()); })).toThrow(NativeGlFault);
  expect(rendererLost(owner)).toBe(true);
  expect(rendererLost(peer)).toBe(false);
  expect(records.filter(r => r.kind !== "context")).toEqual([]);
  expect(diagnostics.join("\n")).toMatch(/native call threw.*native argument conversion failed.*pid 100 session 7/);
});

it("preserves exact checks outside guest batches", () => {
  const {native, gl, owner} = setup();
  expect(checkedGlCall(owner, () => gl.clear(0))).toBe(true);
  expect(native.nativeReads).toBe(3);
});

it("retains nested bookkeeping checks and the guest's older error queue", () => {
  const {native, gl, owner, batch} = setup(); owner.errors.push(0x500);
  batch(() => { checkedGlCall(owner, () => { expect(withNativeBookkeeping(() => checkedGlCall(owner, () => gl.clear(0)))).toBe(true); }); });
  expect(native.nativeReads).toBe(4);
  expect(owner.errors).toEqual([0x500]);
});

it("keeps derived-owner explicit native checks inside an accepted batch", () => {
  const {native, gl, owner, batch} = setup();
  const derived = { gl, errors: [] as number[] };
  batch(() => { expect(checkedGlCall(derived, () => gl.clear(0))).toBe(true); });
  // Derived ownership is not guest prediction: its pre/post real checks remain.
  expect(native.nativeReads).toBeGreaterThanOrEqual(3);
  expect(derived.errors).toEqual([]); expect(rendererLost(owner)).toBe(false);
});

it("fences a derived owner's unexpected native flag before it can publish", () => {
  const {gl, owner, peer, batch} = setup(); const derived = {gl,errors:[] as number[]}; let published = false;
  expect(() => batch(() => { if (checkedGlCall(derived, () => gl.viewport(0,0,-1,0))) published = true; })).toThrow(NativeGlFault);
  expect(published).toBe(false); expect(rendererLost(owner)).toBe(true); expect(rendererLost(peer)).toBe(false);
});

it("refuses reentry into a peer's logical batch before native work", () => {
  const {native, peer, batch} = setup();
  expect(() => batch(() => withNativeBatch(peer, "foreign nested owner", () => { native.clear(); }))).toThrow(/different logical context/);
  expect(native.calls).toBe(0);
});

it("keeps explicit native error predictions independently checked", () => {
  const {gl, owner, records, batch} = setup();
  expect(() => batch(() => { withNativePrediction({kind:"error",error:0x501,label:"must reject"}, () => gl.clear(0)); })).toThrow(/missing-error/);
  expect(records.at(-1)).toMatchObject({kind:"divergence",cause:"missing-error",pid:100,session:7});
  expect(rendererLost(owner)).toBe(true); // The exact mismatch resets its owner before aborting.
});

it("retains native-decided gap checks rather than fabricating accepted outcomes", () => {
  const {gl, records, batch} = setup();
  expect(() => batch(() => { withNativePrediction(nativeDecides("gap","unpredicted rule"), () => gl.viewport(0,0,-1,0)); })).toThrow(NativeGlFault);
  expect(records.at(-1)).toMatchObject({kind:"divergence",cause:"native-decided",pid:100,session:7});
});

it.each(["allocate", "mixedFailure"] as const)("retains the OOM boundary and peer isolation for %s", method => {
  const {native, owner, peer, records, faults, diagnostics, batch} = setup();
  expect(batch(() => { checkedGlCall(owner, () => native[method]()); })).toBe(RENDERER_LOST);
  expect(rendererLost(owner)).toBe(true);expect(rendererLost(peer)).toBe(false);expect(faults).toEqual([]);
  expect(records.at(-1)).toMatchObject({kind:"boundary",cause:"out-of-memory",call:expect.stringContaining("nativeBatchSample"),pid:100,session:7});
  expect(diagnostics.join("\n")).toContain("native OUT_OF_MEMORY");
});


it("keeps live imports coherent across fatal, record, reset and fatal reconfiguration", () => {
  const {native,gl,owner}=setup();
  const run=()=>withNativeBatch(owner,"transition",()=>{for(let i=0;i<4;i++)checkedGlCall(owner,()=>gl.clear(0));});
  let before=native.nativeReads;run();expect(native.nativeReads-before).toBe(1);
  configureGlAudit({mode:"record",sink:()=>{},fault:m=>{throw new NativeGlFault(m);}});
  before=native.nativeReads;run();expect(native.nativeReads-before).toBe(5);
  resetGlAuditForTesting();
  before=native.nativeReads;run();expect(native.nativeReads-before).toBe(1);
  configureGlAudit({mode:"fatal",sink:()=>{},fault:m=>{throw new NativeGlFault(m);}});
  before=native.nativeReads;run();expect(native.nativeReads-before).toBe(1);
});


it("marks deferred raw work even when an idle-only submission would skip sampling", () => {
  const {native,gl,owner}=setup();
  expect(withNativeBatch(owner,"raw replay",()=>gl.clear(0),false)).toBe(0);
  expect(native.nativeReads).toBe(1);
  expect(()=>withNativeBatch(owner,"raw refused replay",()=>gl.viewport(0,0,-1,0),false)).toThrow(NativeGlFault);
  expect(rendererLost(owner)).toBe(true);
});
it.each(["bookkeeping","native-decides"] as const)("fences deferred errors before the next %s native operation", exact => {
  const {native,gl,owner,peer,batch}=setup();
  expect(()=>batch(()=>{
    checkedGlCall(owner,()=>gl.viewport(0,0,-1,0));
    if(exact==="bookkeeping")withNativeBookkeeping(()=>checkedGlCall(owner,()=>gl.clear(0)));
    else withNativePrediction(nativeDecides("transition","exact probe"),()=>gl.clear(0));
  })).toThrow(NativeGlFault);
  expect(native.calls).toBe(1);expect(rendererLost(owner)).toBe(true);expect(rendererLost(peer)).toBe(false);
});
it("keeps deferred OOM precedence before an exact bookkeeping receiver executes",()=>{
  const {native,gl,owner,peer,faults,batch}=setup();
  expect(batch(()=>{checkedGlCall(owner,()=>native.mixedFailure());withNativeBookkeeping(()=>checkedGlCall(owner,()=>gl.clear(0)));})).toBe(RENDERER_LOST);
  expect(native.calls).toBe(1);expect(rendererLost(owner)).toBe(true);expect(rendererLost(peer)).toBe(false);expect(faults).toEqual([]);
});
it("retains an exact OOM allocation result for its reserved custody before reset",()=>{
  const {native,owner,peer,batch}=setup();let reserved:object|null=null;
  expect(batch(()=>{withNativeBookkeeping(()=>checkedGlCall(owner,()=>{reserved=native.objectWithOom();}));})).toBe(RENDERER_LOST);
  expect(reserved).toEqual({owned:true});expect(rendererLost(owner)).toBe(true);expect(rendererLost(peer)).toBe(false);
});
it("retains an exact boundary flag until submission completion if a raw utility omits its drain",()=>{
  const {native,owner,batch}=setup();
  expect(batch(()=>{withNativeBookkeeping(()=>{native.allocate();return true;});})).toBe(RENDERER_LOST);
  expect(rendererLost(owner)).toBe(true);
});


it("keeps a nested physical submission's undrained exact boundary on the outer token",()=>{
  const {native,owner,peer,batch}=setup();
  expect(batch(()=>withNativeBatch(owner,"nested same physical batch",()=>{
    withNativeBookkeeping(()=>{native.allocate();return true;});
  }))).toBe(RENDERER_LOST);
  expect(rendererLost(owner)).toBe(true);expect(rendererLost(peer)).toBe(false);
});
it("does not start sampling while a nested same-owner call still shares outer work",()=>{
  const {native,gl,owner,batch}=setup();
  batch(()=>{gl.clear(0);withNativeBatch(owner,"nested",()=>gl.clear(0));gl.clear(0);});
  expect(native.calls).toBe(3);expect(native.nativeReads).toBe(1);
});
