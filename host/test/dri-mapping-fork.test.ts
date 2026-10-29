import {expect,it} from "vitest";
import {compileSdkFixture} from "./support/compile-sdk-fixture";
import {runCentralizedProgram} from "./centralized-test-helper";
it.each(["wasm32","wasm64"] as const)("retains and synchronizes inherited CPU mappings through the normal %s SDK",async arch=>{
  const fixture=compileSdkFixture(new URL("./fixtures/dri-mapping-fork.c",import.meta.url),[],{arch,forkInstrument:true});
  try {
    const result=await runCentralizedProgram({programPath:fixture.programPath,useDefaultRootfs:false,timeout:30000});
    expect(result.exitCode,result.stdout+result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("OK inherited DRI mapping survives descriptor and writer retirement");
  } finally {fixture.cleanup();}
},90000);
