import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {expect,test} from "../playwright-test";
import {resolveBinary} from "../../../host/src/binary-resolver";
import {compileSdkFixture} from "../../../host/test/support/compile-sdk-fixture";
import {KandeloImageFs} from "../../../images/vfs/lib/kandelo-image-fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
import {installProgramPublicationFault} from "./support/gl-program-publication-fault";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
test.use({serviceWorkers:"block"});
test.beforeAll(()=>{for(const arch of ["wasm32","wasm64"] as const)
  fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-program-journal.c",import.meta.url),
    ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const kind of ["publication","receipt"] as const) for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
  test(`${kind} ${arch} reports a journal bookkeeping fault before later work (${audit??"production"})`,async({page,baseURL,browser})=>{
    test.setTimeout(90_000);
    const image=KandeloImageFs.create();image.mkdir("/bin",0o755);
    const programBytes=readFileSync(fixtures.get(arch)!.programPath);image.writeFile("/bin/probe",programBytes,0o755);
    const imageBytes=await image.saveImage(),kernelPath=resolveBinary("kernel.wasm"),kernelBytes=readFileSync(kernelPath);
    const kernelSha256=createHash("sha256").update(kernelBytes).digest("hex"),programSha256=createHash("sha256").update(programBytes).digest("hex");
    await page.route("**/__journal_fault_kernel",r=>r.fulfill({body:kernelBytes}));
    await page.route("**/__journal_fault_image",r=>r.fulfill({body:Buffer.from(imageBytes)}));
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await installBrowserMemoryBoundaryProbe(page);await page.goto(new URL("/trap-signal-test.html",baseURL).href);
    await installProgramPublicationFault(page,kind);
    const source=fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts",import.meta.url));
    const result=await page.evaluate(async({url,audit})=>{
      const {BrowserKernel}=await import(/* @vite-ignore */ url);
      const state={stdout:"",stderr:"",diagnostics:[] as any[]};
      const kernel=new BrowserKernel({kernelOwnedFs:true,glAudit:audit,
        onStdout:(bytes:Uint8Array)=>{state.stdout+=new TextDecoder().decode(bytes);},
        onStderr:(bytes:Uint8Array)=>{state.stderr+=new TextDecoder().decode(bytes);},
        onHostDiagnostic:(value:unknown)=>state.diagnostics.push(value)});
      try{
        await kernel.initFromImage({kernelWasm:await(await fetch("/__journal_fault_kernel")).arrayBuffer(),
          vfsImage:new Uint8Array(await(await fetch("/__journal_fault_image")).arrayBuffer())});
        const child=await kernel.spawnFromVfs("/bin/probe",["journal-fault","driver-local"],{uid:0,gid:0});
        let status:number|null=null,failure:string|null=null,followup:string|null=null;
        try{status=await child.exit;}catch(error){failure=String(error);}
        try{const next=await kernel.spawnFromVfs("/bin/probe",["journal-fault","no-renderer"],{uid:0,gid:0});await next.exit;}
        catch(error){followup=String(error);}
        const injected=await(window as any).__programPublicationFault();
        return{...state,status,failure,followup,injected};
      }finally{try{await kernel.destroy();}finally{(window as any).__disposeProgramPublicationFault();}}
    },{url:new URL(`/@fs${source}`,baseURL).href,audit});
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({engine:test.info().project.name,kind,arch,audit,kernelPath,kernelSha256,programSha256,version:browser.version(),...result},null,2));
    expect(result.status,JSON.stringify(result)).toBeNull();
    expect(result.failure).toMatch(/Kernel worker failed: Program journal transaction.*pid 100 session [0-9]+ transaction [0-9]+ action 3/);
    expect(result.followup).toBe(result.failure);
    expect(result.injected).toMatchObject({kind,published:kind==="publication"?1:2,status:2,action:3,ticket:kind==="publication"?1:2});
    const fatal=result.diagnostics.filter((d:any)=>d.source==="kernel fatal");expect(fatal).toHaveLength(1);
    expect(fatal[0].message).toContain(`controlled journal ${kind} failure after metadata effects`);
    expect(result.diagnostics.filter((d:any)=>!["gl-audit","kernel fatal"].includes(d.source))).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
