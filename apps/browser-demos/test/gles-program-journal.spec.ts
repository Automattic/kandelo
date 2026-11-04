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
    fixtures.set(arch,compileSdkFixture(new URL("../../../host/test/fixtures/gles-program-journal.c",import.meta.url),
      ["-pthread","-lEGL","-lGLESv2"],{arch,forkInstrument:true}));
});
test.afterAll(()=>{for(const fixture of fixtures.values())fixture.cleanup();});
for(const mode of ["legacy-selection","render","preflight","recovery","errors","abandon","exit-pending","uniform-interleave","lifecycle-unbound","lifecycle-current-peer","driver-dispatch","driver-local","driver-sharing","driver-wrap","driver-errors","driver-relink","driver-retirement","driver-recovery","driver-fork","driver-cache","driver-cold-refusal","driver-failed-link","driver-malformed","driver-indeterminate","driver-error-recovery","driver-error-suffix"] as const) for(const arch of ["wasm32","wasm64"] as const) for(const audit of [undefined,"fatal"] as const)
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
    await installProgramLifetimeProbe(page,mode==="driver-recovery"?"lost-publication":mode==="driver-cold-refusal"?"refuse-registration":mode==="driver-malformed"?"malformed-reserve":(mode==="driver-indeterminate"||mode==="driver-error-recovery"||mode==="driver-error-suffix")?"indeterminate-publication":false);
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
    let driverCounters:{pairs:number;warmDeviceRequests:number}|undefined;
    let selectionCounters:{pairs:number;selectionDeviceRequests:number;links:number;linkDeviceRequests:number}|undefined;
    if(mode==="legacy-selection") {
      expect(lines).toHaveLength(2);expect(lines[0]).toMatch(/^SELECTION_COUNTERS /);
      selectionCounters=JSON.parse(lines[0].slice("SELECTION_COUNTERS ".length));
      expect(selectionCounters!.pairs).toBe(20);expect(selectionCounters!.links).toBe(20);
      // Each checked mutation needs one entry. Extra entries are measured,
      // never encoded as required behavior of the optional feature.
      expect(selectionCounters!.selectionDeviceRequests).toBeGreaterThanOrEqual(40);
      expect(selectionCounters!.linkDeviceRequests).toBeGreaterThanOrEqual(20);
    }else
    if(mode.startsWith("driver-")&&mode!=="driver-dispatch"&&mode!=="driver-cold-refusal"&&mode!=="driver-indeterminate"&&mode!=="driver-error-recovery"&&mode!=="driver-error-suffix"&&result.status===0) {
      expect(lines).toHaveLength(2);expect(lines[0]).toMatch(/^DRIVER_COUNTERS /);
      driverCounters=JSON.parse(lines[0].slice("DRIVER_COUNTERS ".length));
      expect(driverCounters!.pairs).toBe(mode==="driver-wrap"?300:20);
      if(mode==="driver-wrap") {
        expect(driverCounters!.warmDeviceRequests).toBeGreaterThan(0);
        expect(driverCounters!.warmDeviceRequests).toBeLessThan(20);
      }else expect(driverCounters!.warmDeviceRequests).toBe(0);
    }else expect(lines).toHaveLength(1);
    writeFileSync(test.info().outputPath("guest-result.json"),JSON.stringify({engine:test.info().project.name,arch,audit,mode,kernelPath,kernelSha256,programSha256,
      version:browser.version(),driverCounters,selectionCounters,...result},null,2));
    expect(result.status,JSON.stringify(result)).toBe(0);
    expect(lines.at(-1)).toBe(`PASS journal wire ${mode}`);
    expect(result.stderr).toBe("");
    expect(result.native.created).toBeGreaterThan(0);expect(result.native.deleted).toBe(result.native.created);
    expect(result.native.live).toBe(0);
    if(mode==="driver-recovery") {
      expect(result.native.recovery.dropped).toBe(1);
      expect(result.native.recovery.duplicates).toBe(0);
      expect(result.native.recovery.reads).toBeGreaterThanOrEqual(2);
    }
    if(mode==="driver-cold-refusal") {
      expect(result.native.recovery.refused).toBe(1);expect(result.native.recovery.duplicates).toBe(0);
      expect(result.native.recovery.unreleasedCaptures).toBe(0);
    }
    if(mode==="driver-malformed") {
      expect(result.native.recovery.corrupted).toBe(2);expect(result.native.recovery.duplicates).toBe(0);
      expect(result.native.recovery.reads).toBeGreaterThanOrEqual(2);
    }
    if(mode==="driver-indeterminate"||mode==="driver-error-recovery"||mode==="driver-error-suffix") {
      expect(result.native.recovery.dropped).toBe(1);expect(result.native.recovery.refusedReads).toBe(1);
      expect(result.native.recovery.duplicateIntents).toBe(0);expect(result.native.recovery.duplicates).toBe(0);
    }
    const auditRows=result.diagnostics.filter((d:any)=>d.source==="gl-audit").map((d:any)=>JSON.parse(d.message));
    expect(auditRows.filter((r:any)=>r.kind==="divergence")).toEqual([]);
    if(audit)expect(auditRows.some((r:any)=>r.cause==="instrumented")).toBe(true);
    expect(result.diagnostics.filter((d:any)=>d.source!=="gl-audit")).toEqual([]);
    expect(errors).toEqual([]);expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
