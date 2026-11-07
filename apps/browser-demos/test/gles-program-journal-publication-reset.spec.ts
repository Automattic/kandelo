import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {expect,test} from "@playwright/test";
import {resolveBinary} from "../../../host/src/binary-resolver";
import {compileSdkFixture} from "../../../host/test/support/compile-sdk-fixture";
import {KandeloImageFs} from "../../../images/vfs/lib/kandelo-image-fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
import {installProgramPublicationReset} from "./support/gl-program-publication-reset";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
test.use({serviceWorkers:"block"});
test.beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-program-journal.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const mode of ["publication-reset","publication-reset-peer","publication-reset-snapshot"] as const) for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
  test(`${mode} ${arch} recovers native OOM during shared metadata publication (${audit??"production"})`,async({page,baseURL,browser})=>{
    test.setTimeout(90_000);
    const image=KandeloImageFs.create();image.mkdir("/bin",0o755);
    const programBytes=readFileSync(fixtures.get(arch)!.programPath);image.writeFile("/bin/probe",programBytes,0o755);
    const imageBytes=await image.saveImage(),kernelPath=resolveBinary("kernel.wasm"),kernelBytes=readFileSync(kernelPath);
    const kernelSha256=createHash("sha256").update(kernelBytes).digest("hex"),programSha256=createHash("sha256").update(programBytes).digest("hex");
    await page.route("**/__program_loss_kernel",r=>r.fulfill({body:kernelBytes}));
    await page.route("**/__program_loss_image",r=>r.fulfill({body:Buffer.from(imageBytes)}));
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await installBrowserMemoryBoundaryProbe(page);await page.goto(new URL("/trap-signal-test.html",baseURL).href);
    await installProgramPublicationReset(page,mode==="publication-reset-snapshot");
    const source=fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts",import.meta.url));
    const result=await page.evaluate(async({url,mode,audit})=>{
      const {BrowserKernel}=await import(/* @vite-ignore */ url);
      const state={stdout:"",stderr:"",diagnostics:[] as any[]};
      let armed!:()=>void,retired!:()=>void;
      const ready=new Promise<void>(resolve=>{armed=resolve;}),retirement=new Promise<void>(resolve=>{retired=resolve;});
      const kernel=new BrowserKernel({kernelOwnedFs:true,glAudit:audit,
        onStdout:(bytes:Uint8Array)=>{state.stdout+=new TextDecoder().decode(bytes);if(state.stdout.includes("ARM\n"))armed();if(state.stdout.includes("RETIRED\n"))retired();},
        onStderr:(bytes:Uint8Array)=>{state.stderr+=new TextDecoder().decode(bytes);},
        onHostDiagnostic:(value:unknown)=>state.diagnostics.push(value)});
      try{
        await kernel.initFromImage({kernelWasm:await(await fetch("/__program_loss_kernel")).arrayBuffer(),
          vfsImage:new Uint8Array(await(await fetch("/__program_loss_image")).arrayBuffer())});
        const child=await kernel.spawnFromVfs("/bin/probe",["program-journal-loss",mode],{uid:0,gid:0});
        await Promise.race([ready,child.exit.then((status:number)=>{throw new Error(`guest ended before arm: ${status} ${JSON.stringify(state)}`);})]);
        const control=await(window as any).__publicationResetRequest("arm");
        if(!control.armed)throw new Error("native OOM control not armed");
        kernel.appendStdinData(child.pid,new TextEncoder().encode("x\n"));
        const explicit=await Promise.race([retirement.then(()=>true),child.exit.then(()=>false)]);
        const beforeExit=explicit?await(window as any).__publicationResetRequest("stats"):null;
        if(explicit)kernel.appendStdinData(child.pid,new TextEncoder().encode("y\n"));
        const status=await child.exit,native=await(window as any).__publicationResetRequest("stats");
        return{...state,status,native,beforeExit};
      }finally{try{await kernel.destroy();}finally{(window as any).__disposePublicationReset();}}
    },{url:new URL(`/@fs${source}`,baseURL).href,mode,audit});
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({engine:test.info().project.name,mode,arch,audit,kernelPath,kernelSha256,programSha256,version:browser.version(),...result},null,2));
    expect(result.status,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("ARM\nRETIRED\nPASS publication reset preserves healthy prefix");expect(result.stderr).toBe("");
    expect(result.beforeExit).not.toBeNull();
    expect(result.beforeExit.live).toBe(0);expect(result.beforeExit.deleted).toBe(result.beforeExit.created);
    expect(result.beforeExit.injections).toBe(1);expect(result.beforeExit.errors).toBe(1);
    expect(result.native.injections).toBe(1);expect(result.native.errors).toBe(1);
    expect(result.native.partial).toMatchObject({status:2,action:3,sequence:3,ticket:3});
    // Foreign reset notification preserves the healthy owner's exact records:
    // its final Use(0) stays local instead of falling back to legacy mutation.
    const peer=mode==="publication-reset-peer";
    expect(result.native.entries).toBe(peer?4:3);expect(result.native.duplicates).toBe(0);
    expect(result.native.owners).toHaveLength(mode==="publication-reset-peer"?2:1);
    expect(result.native.executions).toEqual([3,4,5].map(ticket=>({owner:1,ticket})));
    expect(result.native.selectionNames).toHaveLength(3);
    const next=result.native.selectionNames[1];expect(next).toBeGreaterThan(0);
    expect(result.native.selectionNames).toEqual([0,next,0]);
    expect(result.native.publications).toEqual([
      {owner:1,ticket:3,sequence:3,name:0},
      ...(peer?[{owner:2,ticket:1,sequence:4,name:0}]:[]),
      {owner:1,ticket:4,sequence:peer?5:4,name:next},
      {owner:1,ticket:5,sequence:peer?6:5,name:0},
    ]);
    expect(result.native.snapshots).toBeGreaterThan(mode==="publication-reset"?0:1);
    expect(result.native.corrupted).toBe(mode==="publication-reset-snapshot"?1:0);
    expect(result.native.readonlyErrors).toBe(0);expect(result.native.readonlyDeletes).toBe(0);
    expect(result.native.created).toBeGreaterThan(0);expect(result.native.deleted).toBe(result.native.created);expect(result.native.live).toBe(0);
    const resets=result.diagnostics.filter((d:any)=>d.source==="gl-context-reset");expect(resets).toHaveLength(1);
    expect(resets[0].message).toContain("OUT_OF_MEMORY");expect(resets[0].message).toMatch(/pid [0-9]+ session [0-9]+ batch [0-9]+/);
    const auditRows=result.diagnostics.filter((d:any)=>d.source==="gl-audit").map((d:any)=>JSON.parse(d.message));
    expect(auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);
    if(audit){
      expect(auditRows.some((r:any)=>r.cause==="instrumented")).toBe(true);
      expect(auditRows.some((r:any)=>r.cause==="out-of-memory")).toBe(true);
    }
    expect(result.diagnostics.filter((d:any)=>!["gl-audit","gl-context-reset"].includes(d.source))).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
