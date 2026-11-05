import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {expect,test} from "@playwright/test";
import {resolveBinary} from "../../../host/src/binary-resolver";
import {compileSdkFixture} from "../../../host/test/support/compile-sdk-fixture";
import {KandeloImageFs} from "../../../images/vfs/lib/kandelo-image-fs";
import {installBrowserMemoryBoundaryProbe,memoryBoundaryFailures} from "./support/browser-memory-boundary";
import {installProgramLifetimeProbe} from "./support/gl-program-lifetime";

const fixtures=new Map<string,ReturnType<typeof compileSdkFixture>>();
test.use({serviceWorkers:"block"});
test.beforeAll(()=>{
  for(const arch of ["wasm32","wasm64"] as const)
    fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-driver-hotpaths.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const mode of ["ordinary","admitted","automatic"] as const) for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
  test(`${mode} ${arch} checks journal transport and captured execution (${audit??"production"})`,async({page,baseURL,browser})=>{
    test.setTimeout(90_000);
    const image=KandeloImageFs.create();image.mkdir("/bin",0o755);
    const programBytes=readFileSync(fixtures.get(arch)!.programPath);
    image.writeFile("/bin/probe",programBytes,0o755);
    const imageBytes=await image.saveImage();
    const kernelPath=resolveBinary("kernel.wasm"),kernelBytes=readFileSync(kernelPath);
    const kernelSha256=createHash("sha256").update(kernelBytes).digest("hex");
    const programSha256=createHash("sha256").update(programBytes).digest("hex");
    await page.route("**/__program_journal_kernel",r=>r.fulfill({body:kernelBytes}));
    await page.route("**/__program_journal_image",r=>r.fulfill({body:Buffer.from(imageBytes)}));
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(new URL("/trap-signal-test.html",baseURL).href);
    await installProgramLifetimeProbe(page);
    const source=fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts",import.meta.url));
    const result=await page.evaluate(async({url,audit,mode})=>{
      const {BrowserKernel}=await import(/* @vite-ignore */ url);
      const state={stdout:"",stderr:"",diagnostics:[] as any[]};
      const kernel=new BrowserKernel({kernelOwnedFs:true,glAudit:audit,
        onStdout:(b:Uint8Array)=>{state.stdout+=new TextDecoder().decode(b);},
        onStderr:(b:Uint8Array)=>{state.stderr+=new TextDecoder().decode(b);},
        onHostDiagnostic:(value:unknown)=>state.diagnostics.push(value)});
      try{
        await kernel.initFromImage({kernelWasm:await(await fetch("/__program_journal_kernel")).arrayBuffer(),
          vfsImage:new Uint8Array(await(await fetch("/__program_journal_image")).arrayBuffer())});
        const child=await kernel.spawnFromVfs("/bin/probe",["program-journal",mode],{uid:0,gid:0});
        const status=await child.exit;
        const native=await(window as any).__programLifetimeStats();return{...state,status,native};
      }finally{try{await kernel.destroy();}finally{(window as any).__disposeProgramLifetimeProbe();}}
    },{url:new URL(`/@fs${source}`,baseURL).href,audit,mode});
    const evidence={engine:test.info().project.name,arch,audit,mode,kernelPath,kernelSha256,programSha256,version:browser.version(),...result};
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify(evidence,null,2));
    const lines=result.stdout.trim().split("\n");
    const counts=lines.filter((line:string)=>line.startsWith("COUNT ")).map((line:string)=>JSON.parse(line.slice(6)));
    const setup=lines.filter((line:string)=>line.startsWith("SETUP ")).map((line:string)=>JSON.parse(line.slice(6)));
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({...evidence,counts,setup},null,2));
    expect(counts).toHaveLength(14);
    const byName=new Map(counts.map((c:any)=>[c.operation,c]));
    expect(byName.size).toBe(14);
    expect(counts.every((c:any)=>c.iterations===20)).toBe(true);
    for(const name of ["array-definition-small","attribute-default","clear-default"])
      expect((byName.get(name) as any).total).toBe(0);
    expect((byName.get("program-pair") as any).total).toBe(mode==="ordinary"?40:0);
    expect((byName.get("matrix4") as any).total).toBe(mode==="ordinary"?20:0);
    expect(setup).toHaveLength(14);
    expect(setup.find((row:any)=>row.operation==="matrix4").deviceRequests).toBe(mode==="admitted"?3:mode==="automatic"?0:1);
    expect(lines).toContain(`INITIAL_MATRIX ${mode==="automatic"?2:1}`);
    expect(lines).toContain("MATRIX_PROOFS 19");
    // Permit future improvements, while rejecting one drain for every large
    // definition. Rollover still revokes the exact prefix and needs recovery.
    expect((byName.get("array-definition-large") as any).total).toBeLessThanOrEqual(4);
    expect((byName.get("array-definition-large") as any).min).toBe(0);
    expect(result.status,JSON.stringify(result)).toBe(0);
    expect(lines.at(-1)).toBe("PASS hotpath request attribution");
    expect(result.stderr).toBe("");
    expect(result.native.created).toBeGreaterThan(0);expect(result.native.deleted).toBe(result.native.created);
    expect(result.native.live).toBe(0);
    const auditRows=result.diagnostics.filter((d:any)=>d.source==="gl-audit").map((d:any)=>JSON.parse(d.message));
    expect(auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);
    if(audit)expect(auditRows.some((r:any)=>r.cause==="instrumented")).toBe(true);
    expect(result.diagnostics.filter((d:any)=>d.source!=="gl-audit")).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
