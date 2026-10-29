import {expect,it} from "vitest";
import {compileSdkFixture} from "./support/compile-sdk-fixture";
import {runCentralizedProgram} from "./centralized-test-helper";
it.each(["wasm32","wasm64"] as const)("retains and synchronizes inherited CPU mappings through the normal %s SDK",async arch=>{
  const fixture=compileSdkFixture(new URL("./fixtures/dri-mapping-fork.c",import.meta.url),[],{arch,forkInstrument:true});
  try {
    const result=await runCentralizedProgram({programPath:fixture.programPath,useDefaultRootfs:false,timeout:30000});
    expect(result.exitCode,result.stdout+result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "OK inherited DRI mapping survives descriptor and writer retirement",
      "OK middle-unmap fragments retain storage offsets across fork",
      "OK prefix and suffix unmaps preserve the surviving mapping across fork",
      "OK fixed anonymous replacement retires only the replaced DRI interval",
      "OK fixed file replacement retires only the replaced DRI interval",
    ]);
  } finally {fixture.cleanup();}
},90000);
