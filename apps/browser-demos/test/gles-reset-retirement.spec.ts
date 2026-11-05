import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {expect,test} from "@playwright/test";
import {resolveBinary} from "../../../host/src/binary-resolver";
import {compileSdkFixture} from "../../../host/test/support/compile-sdk-fixture";
import {KandeloImageFs} from "../../../images/vfs/lib/kandelo-image-fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
import {installResetRetirementProbe} from "./support/gl-reset-retirement";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
test.use({serviceWorkers:"block"});
test.beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-reset-retirement.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const mode of ["last","shared","shared-reverse","proof-retry","logical-last","logical-foreign","logical-peer","logical-peer-query"] as const) for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
  test(`${mode} ${arch} retires reset contexts before process exit (${audit??"production"})`,async({page,baseURL,browser})=>{
    test.setTimeout(90_000);
    const image=KandeloImageFs.create();image.mkdir("/bin",0o755);
    const programBytes=readFileSync(fixtures.get(arch)!.programPath);image.writeFile("/bin/probe",programBytes,0o755);
    const imageBytes=await image.saveImage(),kernelPath=resolveBinary("kernel.wasm"),kernelBytes=readFileSync(kernelPath);
    const kernelSha256=createHash("sha256").update(kernelBytes).digest("hex"),programSha256=createHash("sha256").update(programBytes).digest("hex");
    await page.route("**/__program_loss_kernel",r=>r.fulfill({body:kernelBytes}));
    await page.route("**/__program_loss_image",r=>r.fulfill({body:Buffer.from(imageBytes)}));
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await installBrowserMemoryBoundaryProbe(page);await page.goto(new URL("/trap-signal-test.html",baseURL).href);
    await installResetRetirementProbe(page,mode);
    const source=fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts",import.meta.url));
    const result=await page.evaluate(async({url,mode,audit})=>{
      const {BrowserKernel}=await import(/* @vite-ignore */ url);
      const state={stdout:"",stderr:"",diagnostics:[] as any[]};
      let armed!:()=>void,retry!:()=>void,retired!:()=>void;
      const ready=new Promise<void>(resolve=>{armed=resolve;}),retrying=new Promise<void>(resolve=>{retry=resolve;}),retirement=new Promise<void>(resolve=>{retired=resolve;});
      const kernel=new BrowserKernel({kernelOwnedFs:true,glAudit:audit,
        onStdout:(bytes:Uint8Array)=>{state.stdout+=new TextDecoder().decode(bytes);if(state.stdout.includes("ARM\n"))armed();if(state.stdout.includes("RETRY\n"))retry();if(state.stdout.includes("RETIRED\n"))retired();},
        onStderr:(bytes:Uint8Array)=>{state.stderr+=new TextDecoder().decode(bytes);},
        onHostDiagnostic:(value:unknown)=>state.diagnostics.push(value)});
      try{
        await kernel.initFromImage({kernelWasm:await(await fetch("/__program_loss_kernel")).arrayBuffer(),
          vfsImage:new Uint8Array(await(await fetch("/__program_loss_image")).arrayBuffer())});
        const child=await kernel.spawnFromVfs("/bin/probe",["reset-retirement",mode],{uid:0,gid:0});
        await Promise.race([ready,child.exit.then((status:number)=>{throw new Error(`guest ended before arm: ${status} ${JSON.stringify(state)}`);})]);
        const control=await(window as any).__resetRetirementRequest("lose");
        if(!(control.lost||control.oom))throw new Error("retirement loss control did not arm");
        kernel.appendStdinData(child.pid,new TextEncoder().encode("x\n"));
        let blocked:any=null;
        if(mode==="proof-retry"){
          await Promise.race([retrying,child.exit.then((status:number)=>{throw new Error(`guest ended before retry ${status} ${JSON.stringify(state)}`);})]);
          blocked=await(window as any).__resetRetirementRequest("stats");
          await(window as any).__resetRetirementRequest("release-proof");kernel.appendStdinData(child.pid,new TextEncoder().encode("r\n"));
        }
        const explicit=await Promise.race([retirement.then(()=>true),child.exit.then(()=>false)]);
        const beforeExit=explicit?await(window as any).__resetRetirementRequest("stats"):null;
        if(explicit)kernel.appendStdinData(child.pid,new TextEncoder().encode("y\n"));
        const status=await child.exit;return{...state,status,beforeExit,blocked};
      }finally{try{await kernel.destroy();}finally{(window as any).__disposeResetRetirement();}}
    },{url:new URL(`/@fs${source}`,baseURL).href,mode,audit});
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({engine:test.info().project.name,mode,arch,audit,kernelPath,kernelSha256,programSha256,version:browser.version(),...result},null,2));
    expect(result.status,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe(mode==="proof-retry"?"ARM\nRETRY\nRETIRED\nPASS reset contexts retire before exit":"ARM\nRETIRED\nPASS reset contexts retire before exit");
    expect(result.beforeExit).not.toBeNull();
    const native=result.beforeExit,shared=["shared","shared-reverse","proof-retry"].includes(mode),logical=mode.startsWith("logical-");
    expect(native.publicContexts).toBe(0);expect(native.executions).toBe(0);expect(native.bindings).toBe(0);
    expect(native.destroyCalls).toBe(mode==="proof-retry"?3:shared||["logical-foreign","logical-peer","logical-peer-query"].includes(mode)?2:1);
    expect(native.nativeLive).toBe(0);expect(native.created).toBeGreaterThan(0);
    expect(native.injections).toBe(logical?1:0);
    if(logical){expect(native.deleted).toBe(native.created);expect(result.stderr).toBe("");}
    else expect(native.lost).toBe(true);
    if(mode==="proof-retry"){
      expect(result.blocked).toMatchObject({publicContexts:3,executions:2,destroyCalls:0});
      expect(native.scopeRefusals).toBeGreaterThan(0);
      expect(result.stderr.trim().split("\n").every((line:string)=>/^Kandelo graphics: (retirement )?reset scope unavailable for context [0-9]+; (reset retained locally|ownership retained)$/.test(line))).toBe(true);
      expect(result.stderr).toContain("retirement reset scope unavailable");
    }else expect(result.stderr).toBe("");
    const resets=result.diagnostics.filter((d:any)=>d.source==="gl-context-reset");expect(resets).toHaveLength(logical?1:0);
    if(logical){expect(resets[0].message).toContain("OUT_OF_MEMORY");expect(resets[0].message).toMatch(/pid [0-9]+ session [0-9]+ batch [0-9]+/);}
    const rows=result.diagnostics.filter((d:any)=>d.source==="gl-audit").map((d:any)=>JSON.parse(d.message));
    expect(rows.filter((r:any)=>r.kind==="divergence")).toEqual([]);
    if(audit)expect(rows.some((r:any)=>r.cause==="instrumented")).toBe(true);
    expect(result.diagnostics.filter((d:any)=>!["gl-audit","gl-context-reset"].includes(d.source))).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
