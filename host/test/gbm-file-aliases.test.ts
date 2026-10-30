import {expect,it} from "vitest";
import {compileSdkFixture} from "./support/compile-sdk-fixture";
import {runCentralizedProgram} from "./centralized-test-helper";
it.each(["wasm32","wasm64"] as const)("retains shared GEM names across GBM device aliases through the normal %s SDK",async arch=>{
  const fixture=compileSdkFixture(new URL("./fixtures/gbm-file-aliases.c",import.meta.url),["-lgbm", "-ldrm"],{arch});
  try {
    const result=await runCentralizedProgram({programPath:fixture.programPath,useDefaultRootfs:false,timeout:30000});
    expect(result.exitCode,result.stdout+result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("OK GBM file aliases retain shared GEM names and independent files stay separate");
  } finally {fixture.cleanup();}
},90000);
