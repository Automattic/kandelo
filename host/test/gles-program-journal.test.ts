import {afterAll,beforeAll,expect,test} from "vitest";
import {runCentralizedProgram} from "./centralized-test-helper";
import {compileSdkFixture} from "./support/compile-sdk-fixture";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("./fixtures/gles-program-journal.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`error-${arch}`,compileSdkFixture(new URL("./fixtures/gles-error-drain-receipt.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`retirement-${arch}`,compileSdkFixture(new URL("./fixtures/gles-reset-retirement.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`hotpaths-${arch}`,compileSdkFixture(new URL("./fixtures/gles-driver-hotpaths.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`owned-${arch}`,compileSdkFixture(new URL("./fixtures/gles-owned-buffers.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`framebuffer-${arch}`,compileSdkFixture(new URL("./fixtures/gles-owned-framebuffers.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`inline-${arch}`,compileSdkFixture(new URL("./fixtures/gles-owned-inline.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(`draw-reset-${arch}`,compileSdkFixture(new URL("./fixtures/gles-owned-draw-reset.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
},120_000);
afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} refuses GLES admission explicitly without a renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(arch)!.programPath,
      argv:["program-journal","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("PASS explicit no-renderer EGL refusal");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");
    expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} error-drain guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`error-${arch}`)!.programPath,
      argv:["error-drain","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("PASS no renderer refuses error-drain guest");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");
    expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} reset-retirement guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`retirement-${arch}`)!.programPath,
      argv:["reset-retirement","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("PASS reset retirement refuses missing renderer");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");
    expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} hot-path guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`hotpaths-${arch}`)!.programPath,
      argv:["hotpaths","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("PASS hotpaths refuses absent renderer");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");
    expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} owned-buffer guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`owned-${arch}`)!.programPath,
      argv:["owned-buffers","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);expect(result.stdout.trim()).toBe("PASS owned buffers refuse absent renderer");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} owned-framebuffer guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`framebuffer-${arch}`)!.programPath,
      argv:["owned-framebuffers","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);expect(result.stdout.trim()).toBe("PASS owned framebuffers refuse absent renderer");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} owned-inline guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`inline-${arch}`)!.programPath,
      argv:["owned-inline","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);expect(result.stdout.trim()).toBe("PASS owned inline refuses absent renderer");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");expect(result.hostDiagnostics).toEqual([]);
  },40_000);

for(const arch of ["wasm32","wasm64"] as const)
  test(`${arch} owned-draw-reset guest refuses absent Node renderer`,async()=>{
    const result=await runCentralizedProgram({programPath:fixtures.get(`draw-reset-${arch}`)!.programPath,
      argv:["owned-draw-reset","no-renderer"],useDefaultRootfs:false,timeout:30_000});
    expect(result.exitCode,JSON.stringify(result)).toBe(0);expect(result.stdout.trim()).toBe("PASS owned draw reset refuses absent renderer");
    expect(result.stderr).toBe("eglInitialize: no GLES renderer is available on this host\n");expect(result.hostDiagnostics).toEqual([]);
  },40_000);
