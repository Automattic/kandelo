import {readFileSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {expect,test} from "@playwright/test";
import {resolveBinary} from "../../../host/src/binary-resolver";
import {compileSdkFixture} from "../../../host/test/support/compile-sdk-fixture";
import {KandeloImageFs} from "../../../images/vfs/lib/kandelo-image-fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
test.use({serviceWorkers:"block"});
test.beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-program-sharing.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
  test(`${arch} keeps a selected program across newly shared peer deletion (${audit??"production"})`,async({page,baseURL,browser})=>{
    test.setTimeout(90_000);
    const image=KandeloImageFs.create();image.mkdir("/bin",0o755);
    image.writeFile("/bin/probe",readFileSync(fixtures.get(arch)!.programPath),0o755);
    const imageBytes=await image.saveImage();
    await page.route("**/__program_sharing_kernel",r=>r.fulfill({body:readFileSync(resolveBinary("kernel.wasm"))}));
    await page.route("**/__program_sharing_image",r=>r.fulfill({body:Buffer.from(imageBytes)}));
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(new URL("/trap-signal-test.html",baseURL).href);
    const source=fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts",import.meta.url));
    const result=await page.evaluate(async({url,audit})=>{
      const {BrowserKernel}=await import(/* @vite-ignore */ url);
      const state={stdout:"",stderr:"",diagnostics:[] as any[]};
      const kernel=new BrowserKernel({kernelOwnedFs:true,glAudit:audit,
        onStdout:(b:Uint8Array)=>{state.stdout+=new TextDecoder().decode(b);},
        onStderr:(b:Uint8Array)=>{state.stderr+=new TextDecoder().decode(b);},
        onHostDiagnostic:(value:unknown)=>state.diagnostics.push(value)});
      try{
        await kernel.initFromImage({kernelWasm:await(await fetch("/__program_sharing_kernel")).arrayBuffer(),
          vfsImage:new Uint8Array(await(await fetch("/__program_sharing_image")).arrayBuffer())});
        const child=await kernel.spawnFromVfs("/bin/probe",["program-sharing","render"],{uid:0,gid:0});
        const status=await child.exit;
        return{...state,status};
      }finally{await kernel.destroy();}
    },{url:new URL(`/@fs${source}`,baseURL).href,audit});
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({arch,audit,version:browser.version(),...result},null,2));
    expect(result.status,JSON.stringify(result)).toBe(0);
    expect(result.stdout.trim()).toBe("PASS selected program survives a newly shared peer deletion");
    expect(result.stderr).toBe("");
    const auditRows=result.diagnostics.filter((d:any)=>d.source==="gl-audit").map((d:any)=>JSON.parse(d.message));
    expect(auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);
    if(audit)expect(auditRows.some((r:any)=>r.cause==="instrumented")).toBe(true);
    expect(result.diagnostics.filter((d:any)=>d.source!=="gl-audit")).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
