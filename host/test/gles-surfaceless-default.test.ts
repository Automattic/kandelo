import {afterAll,beforeAll,expect,test} from "vitest";
import {runCentralizedProgram} from "./centralized-test-helper";
import {compileSdkFixture} from "./support/compile-sdk-fixture";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("./fixtures/gles-surfaceless-default.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
},120_000);
afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} refuses GLES admission explicitly without a renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(arch)!.programPath,
      argv:["surfaceless-default","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("PASS explicit no-renderer EGL refusal");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");
    expect(result.hostDiagnostics).toEqual([]);
  },40_000);
