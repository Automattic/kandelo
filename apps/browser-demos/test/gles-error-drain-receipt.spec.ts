import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {expect,test} from "../playwright-test";
import {resolveBinary} from "../../../host/src/binary-resolver";
import {compileSdkFixture} from "../../../host/test/support/compile-sdk-fixture";
import {KandeloImageFs} from "../../../images/vfs/lib/kandelo-image-fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
import {installErrorDrainReceiptFault} from "./support/gl-error-drain-receipt";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
test.use({serviceWorkers:"block"});
test.beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-error-drain-receipt.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const mode of ["none","lost","magic","duplicate","read-lost"] as const) for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
  test(`${mode} ${arch} recovers error-drain replies without losing guest flags (${audit??"production"})`,async({page,baseURL,browser})=>{
    test.setTimeout(90_000);
    const image=KandeloImageFs.create();image.mkdir("/bin",0o755);
    const programBytes=readFileSync(fixtures.get(arch)!.programPath);image.writeFile("/bin/probe",programBytes,0o755);
    const imageBytes=await image.saveImage(),kernelPath=resolveBinary("kernel.wasm"),kernelBytes=readFileSync(kernelPath);
    const kernelSha256=createHash("sha256").update(kernelBytes).digest("hex"),programSha256=createHash("sha256").update(programBytes).digest("hex");
    await page.route("**/__program_loss_kernel",r=>r.fulfill({body:kernelBytes}));
    await page.route("**/__program_loss_image",r=>r.fulfill({body:Buffer.from(imageBytes)}));
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await installBrowserMemoryBoundaryProbe(page);await page.goto(new URL("/trap-signal-test.html",baseURL).href);
    await installErrorDrainReceiptFault(page,mode);
    const source=fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts",import.meta.url));
    const result=await page.evaluate(async({url,mode,audit})=>{
      const {BrowserKernel}=await import(/* @vite-ignore */ url);
      const state={stdout:"",stderr:"",diagnostics:[] as any[]};
      let armed!:()=>void;
      const ready=new Promise<void>(resolve=>{armed=resolve;});
      const kernel=new BrowserKernel({kernelOwnedFs:true,glAudit:audit,
        onStdout:(bytes:Uint8Array)=>{state.stdout+=new TextDecoder().decode(bytes);if(state.stdout.includes("ARM\n"))armed();},
        onStderr:(bytes:Uint8Array)=>{state.stderr+=new TextDecoder().decode(bytes);},
        onHostDiagnostic:(value:unknown)=>state.diagnostics.push(value)});
      try{
        await kernel.initFromImage({kernelWasm:await(await fetch("/__program_loss_kernel")).arrayBuffer(),
          vfsImage:new Uint8Array(await(await fetch("/__program_loss_image")).arrayBuffer())});
        const child=await kernel.spawnFromVfs("/bin/probe",["error-drain",mode],{uid:0,gid:0});
        await Promise.race([ready,child.exit.then((status:number)=>{throw new Error(`guest ended before arm: ${status} ${JSON.stringify(state)}`);})]);
        const control=await(window as any).__errorDrainRequest("arm");
        if(!control.armed)throw new Error("error-drain control not armed");
        kernel.appendStdinData(child.pid,new TextEncoder().encode("x\n"));
        const status=await child.exit,native=await(window as any).__errorDrainRequest("stats");
        return{...state,status,native};
      }finally{try{await kernel.destroy();}finally{(window as any).__disposeErrorDrain();}}
    },{url:new URL(`/@fs${source}`,baseURL).href,mode,audit});
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({engine:test.info().project.name,mode,arch,audit,kernelPath,kernelSha256,programSha256,version:browser.version(),...result},null,2));
    expect(result.status,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("ARM\nPASS error drain preserves flags without replay");expect(result.stderr).toBe("");
    expect(result.native.injections).toBe(mode==="none"?0:1);
    expect(result.native.recoveryFaults).toBe(mode==="read-lost"?1:0);
    expect(result.native.reads).toBe(mode==="none"?0:mode==="read-lost"?2:1);
    expect(result.native.drains).toBe(mode==="none"?2:3);
    expect(result.native.transactions).toEqual(mode==="none"?[2,3]:[2,3,4]);expect(result.native.requestMode).toBe(0x47524350);
    expect(result.diagnostics.filter((d:any)=>d.source!=="gl-audit")).toEqual([]);
    expect(result.diagnostics.filter((d:any)=>d.source==="gl-audit").map((d:any)=>JSON.parse(d.message)).filter((r:any)=>r.kind==="divergence")).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
