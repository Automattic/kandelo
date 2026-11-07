import {expect} from "@playwright/test";

/** The fault injector proves the original native call happened; fatal audit
 * samples it only at submission completion. Naming a particular op here would
 * invent per-call attribution and require the old synchronous oracle again. */
export function expectSubmittedBatchOom(auditRows:readonly any[],reset:{pid:number;message:string}):void {
  const boundaries=auditRows.filter(row=>row.cause==="out-of-memory");
  expect(boundaries).toHaveLength(1);
  const owner=reset.message.match(/pid ([0-9]+) session ([0-9]+) batch ([0-9]+) \(submit\)/);
  expect(owner).not.toBeNull();
  const [,pid,session,batch]=owner!;
  expect(Number(pid)).toBe(reset.pid);
  expect(boundaries[0]).toMatchObject({kind:"boundary",cause:"out-of-memory",mode:"fatal",
    call:'nativeBatchSample("submit")',observed:"OUT_OF_MEMORY",predicted:"accepted",
    entry:"host_gl_submit",pid:reset.pid,session:Number(session),batch:Number(batch),op:null,opArgs:null});
  expect(boundaries[0].entryArgs[0]).toBe(reset.pid);
}
