import { expect, it, vi } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";

type Alias = { pid: number; bo: number; addr: number; len: number; offset: number };
it.each(["wasm32","wasm64"] as const)("%s rolls back actual exported fork after its second native BO bind refuses", async arch => {
  const fixture=compileSdkFixture(new URL("../../programs/dri_fork_bind_rollback.c",import.meta.url),[],{arch,forkInstrument:true});
  const controls: Array<{mockRestore():void}>=[];
  const failures: string[]=[],attempts: Alias[]=[],unbound: Alias[]=[],laterPids=new Set<number>();
  let failedPid: number|undefined,parentPid=0,rejected=false,replacement=false,afterReplacement=false;
  let original: Array<{bo:number;addr:number;len:number;value:number}>=[];
  try {
    const result=await runCentralizedProgram({programPath:fixture.programPath,useDefaultRootfs:false,timeout:45000,
      onKernelReady(kernel,pid) {
        parentPid=pid;
        const registry=kernel.bos,bind=registry.bind.bind(registry),unbind=registry.unbind.bind(registry);
        const check=(condition: unknown,message: string) => {if(!condition)failures.push(message);};
        // Wrap the actual import receiver, never Rust exports or cleanup.
        // Collect observations without throwing inside the kernel import:
        // assertions there would themselves change the rollback being tested.
        controls.push(vi.spyOn(registry,"bind").mockImplementation((owner,bo,addr,len,offset=0,allocation) => {
          if(owner===pid) {
            const prior=original.find(value=>value.addr===addr && value.bo!==bo);
            if(prior) {replacement=true;afterReplacement=true;}
            return bind(owner,bo,addr,len,offset,allocation);
          }
          failedPid??=owner;
          if(owner!==failedPid) {laterPids.add(owner);return bind(owner,bo,addr,len,offset,allocation);}
          attempts.push({pid:owner,bo,addr,len,offset});
          if(attempts.length===1) {
            original=registry.listForPid(pid).map(entry=>({bo:entry.bo_id,addr:entry.binding!.addr,len:entry.binding!.len,value:registry.pixelView(entry.bo_id)![0]}));
            check(original.length===2,"fork must start with exactly two real parent BO mappings");
            // Canonical SAB bytes are lazy until the real bind/prime path
            // publishes them. Keep that raw baseline for rollback isolation,
            // but witness public parent stores in their actual mapped views.
            const parentMemory=kernel.getProcessMemory(pid);
            const parentWritten=original.map(value=>parentMemory&&value.addr<parentMemory.buffer.byteLength
              ?new Uint8Array(parentMemory.buffer,value.addr,1)[0]:undefined);
            check(parentWritten.sort((a,b)=>(a??-1)-(b??-1)).join(",")==="37,73","normal parent writes are absent from actual parent BO mappings");
            const rc=bind(owner,bo,addr,len,offset,allocation);
            check(rc===0 && registry.findBindingByAddr(owner,addr)===bo,"first child alias was not actually admitted");
            return rc;
          }
          if(attempts.length===2) {
            check(!rejected && registry.findBindingByAddr(owner,addr)===undefined,"second child alias already had effects before refusal");
            rejected=true;return -1;
          }
          failures.push("failed child attempted a later native bind");
          return bind(owner,bo,addr,len,offset,allocation);
        }));
        controls.push(vi.spyOn(registry,"unbind").mockImplementation((owner,bo,addr,len) => {
          unbind(owner,bo,addr,len);
          if(owner!==failedPid) return;
          check(!afterReplacement,"old failed-child cleanup ran after parent address replacement");
          check(addr!==undefined && len!==undefined,"rollback lost exact alias range");
          unbound.push({pid:owner,bo,addr:addr!,len:len!,offset:0});
          check(registry.findBindingByAddr(owner,addr!)===undefined,"rollback retained a child mapping");
          check(kernel.getProcessMemory(owner)===undefined,"failed fork published child Memory before allocation succeeded");
          for(const before of original) {
            const current=registry.get(pid,before.bo);
            check(current?.binding?.addr===before.addr && current.binding.len===before.len,"child rollback changed a parent mapping");
            check(registry.pixelView(before.bo)?.[0]===before.value,"child rollback changed parent BO storage");
          }
        }));
      },
    });
    expect(result.exitCode,result.stdout+result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("OK second inherited BO bind refusal retires exact child and preserves replacement resources");
    expect(failures).toEqual([]);expect(rejected).toBe(true);expect(attempts).toHaveLength(2);
    expect(failedPid).toBeGreaterThan(parentPid);expect(replacement).toBe(true);
    expect(laterPids.size).toBe(1);expect([...laterPids][0]).toBeGreaterThan(failedPid!);
    expect(unbound.map(({bo,addr,len})=>({bo,addr,len}))).toEqual(attempts.map(({bo,addr,len})=>({bo,addr,len})));
  } finally {for(const control of controls.reverse())control.mockRestore();fixture.cleanup();}
},90000);
