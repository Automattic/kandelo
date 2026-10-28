import { expect,it } from "vitest";
import { copyGbmFront } from "../src/webgl/gbm-front-copy";
import { createSurfaceResources } from "../src/webgl/surface-resources";
import { captureNativeGlErrors } from "../src/webgl/errors";
import { hasNativeRepair,repairNativeState } from "../src/webgl/native-recovery";
const READ=0x8ca8,DRAW=0x8ca9,COLOR0=0x8ce0;
function fixture() {
  const source={},destination={},oldRead={},oldDraw={};
  let read=oldRead,draw=oldDraw,scissor=true;
  const modes=new Map<unknown,number>([[source,0],[oldRead,COLOR0+1]]);
  const calls: Array<[string,unknown[]]>=[],errors: number[]=[],publicErrors={ errors: [] as number[] };
  let failDestination=false,failCopy=false,failRestore=false,failMemory=false,failMode=false;
  const gl={
    COLOR_BUFFER_BIT: 0x4000,NEAREST: 0x2600,isContextLost: () => false,
    getError: () => errors.shift()??0,
    getParameter: (p: number) => { if(p===0xc02&&failMode) { errors.push(0x502); return COLOR0; } return p===0x8caa? read:p===0x8ca6? draw:p===0xc11? scissor:modes.get(read); },
    bindFramebuffer: (which: number,value: object) => {
      calls.push(["bind",[which,value]]);
      if(which===DRAW&&value===destination&&failDestination) { errors.push(0x502); return; }
      if(which===DRAW&&value===oldDraw&&failRestore) { errors.push(0x502); return; }
      if(which===READ) read=value; else draw=value;
    },
    readBuffer: (value: number) => { calls.push(["readBuffer",[value]]); modes.set(read,value); },
    enable: () => { scissor=true; },disable: () => { scissor=false; },
    blitFramebuffer: (...args: unknown[]) => { calls.push(["blit",args]); if(failCopy) errors.push(0x502); if(failMemory) errors.push(0x505); },
  } as unknown as WebGL2RenderingContext;
  const surface=createSurfaceResources(7); surface.gl=gl; surface.renderTargetFbo=source; surface.surfaceSize={ width: 4,height: 3 };
  const target={ gl,fbo: destination,w: 4,h: 3 };
  return {
    gl,surface,target,calls,errors,publicErrors,
    copy: () => copyGbmFront(surface,target,() => captureNativeGlErrors(gl,publicErrors)),
    fault: (kind: string) => { failDestination=kind==="destination"; failCopy=kind==="copy"; failRestore=kind==="restore"; failMemory=kind==="memory"; failMode=kind==="mode"; },
    check: () => { expect(read).toBe(oldRead); expect(draw).toBe(oldDraw); expect(scissor).toBe(true); expect(modes.get(source)).toBe(0); },
  };
}
it("normalizes rows while preserving independent bindings, read mode, scissor and prior errors",() => {
  const f=fixture(); f.errors.push(0x500); expect(f.copy()).toBe(0); f.check();
  expect(f.publicErrors.errors).toEqual([0x500]); expect(f.gl.getError()).toBe(0);
  expect(f.calls.filter(([name]) => name==="blit")).toEqual([["blit",[0,0,4,3,0,3,4,0,0x4000,0x2600]]]);
});
it.each(["destination","copy"])("rejects %s failure and restores native state without leaking private errors",kind => {
  const f=fixture(); f.fault(kind); expect(f.copy()).toBe(-5); f.check();
  expect(f.publicErrors.errors).toEqual([]); expect(f.gl.getError()).toBe(0);
  expect(f.calls.filter(([name]) => name==="blit")).toHaveLength(kind==="destination"? 0:1);
});
it("retains a failed restoration for later repair",() => {
  const f=fixture(); f.fault("restore"); expect(f.copy()).toBe(-5); expect(hasNativeRepair(f.gl)).toBe(true);
  f.fault(""); expect(repairNativeState(f.gl)).toBe(true); f.check();
  expect(hasNativeRepair(f.gl)).toBe(false); expect(f.publicErrors.errors).toEqual([]);
});
it("rejects mismatched or aliased storage before native mutation",() => {
  const f=fixture(); f.target.w=5; expect(f.copy()).toBe(-22); expect(f.calls).toEqual([]);
  f.target.w=4; f.target.fbo=f.surface.renderTargetFbo!; expect(f.copy()).toBe(-22); expect(f.calls).toEqual([]);
});

it("retries a pending private restoration before another front copy",() => {
  const f=fixture(); f.fault("restore"); expect(f.copy()).toBe(-5); expect(hasNativeRepair(f.gl)).toBe(true);
  f.fault(""); expect(f.copy()).toBe(0); f.check(); expect(hasNativeRepair(f.gl)).toBe(false);
  expect(f.publicErrors.errors).toEqual([]);
});

it.each([["memory",-12],["mode",-5]] as const)("preserves state and public errors after %s failure",(kind,rc) => {
  const f=fixture(); f.fault(kind); expect(f.copy()).toBe(rc); f.check();
  expect(f.publicErrors.errors).toEqual([]); expect(f.gl.getError()).toBe(0);
});
