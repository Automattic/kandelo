import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { MockWorkerHandle } from "../src/worker-adapter";
import { createWorkerQuiescence } from "../src/worker-quiescence";
import { classifiedSignalOrFallback, classifiedTrapExitStatus, signalExitStatus } from "../src/trap-signals";
import { signalFromExitStatus } from "../src/process-lifecycle";
import { ProcessGenerationObservations } from "../src/process-generation-observation";

const PID = 41, OTHER = 73, THREAD = 101;
type Host = "node" | "browser";

/** Execute the actual complete listener body. These are source controls for
 * message authority, not a normal guest launch or an actual browser realm. */
function listenerControl(host: Host, ptrWidth: 4 | 8) {
  const url = new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url);
  const source = ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
  const names = host === "node" ? ["installProcessWorkerListeners", "installCrashSafetyNet",
    "finalizeProcessWorker", "processWorkerErrorDisposition", "unexpectedWorkerCrashDisposition",
    "finalizeProcessWorkerError", "finalizeUnexpectedWorkerError"] : ["installProcessWorkerListeners"];
  const declarations = names.map(name => {
    const node = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw Error(`missing actual ${host} ${name}`);return node.getText(source);
  });
  const lifecycleUrl = new URL("../src/process-lifecycle.ts", import.meta.url);
  const lifecycle = ts.createSourceFile(lifecycleUrl.pathname, readFileSync(lifecycleUrl, "utf8"), ts.ScriptTarget.Latest, true);
  const timers: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {if (ts.isFunctionDeclaration(node) && node.name?.text === "handleVmInterruptTimer") timers.push(node);ts.forEachChild(node, visit);};
  visit(lifecycle);if(timers.length!==1)throw Error("ambiguous actual shared timer handler");
  const code = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const timerCode = ts.transpileModule(timers[0].getText(lifecycle), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const makeGeneration = () => ({ worker: new MockWorkerHandle(), ptrWidth,
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1 }),
    workerQuiescence: createWorkerQuiescence(), execRetirement: createWorkerQuiescence() });
  const original = makeGeneration(), other = makeGeneration();
  const processes = new Map([[PID, original], [OTHER, other]]);
  const observations = new ProcessGenerationObservations(() => {}); observations.enable();
  observations.admit(PID, original, 1); observations.admit(OTHER, other, 2);
  const mainQuiescent = vi.spyOn(observations, "mainQuiescent");
  const unexpected = () => { throw Error("unexpected non-fence listener path"); };
  const finalizations = vi.fn(), diagnostics = vi.fn(), scheduledTimers = vi.fn();
  const actualTimer = new Function("host",timerCode+"\nreturn handleVmInterruptTimer;")({vmInterruptTimers:{handleRequest:scheduledTimers}}) as (...args: unknown[]) => void;
  const timerDispatches = vi.fn(actualTimer), intentionallyTerminated = new WeakSet<object>();
  const dependencies = { processes, generationObservations: observations,
    vforkLifetimes: { phaseForChild: () => undefined }, traceVforkMechanism: unexpected,
    intentionallyTerminated, processTeardowns:new Map(), kernelWorker:{notifyHostProcessCrashed:vi.fn()},
    async finishProcessExit(pid:number,status:number,worker:MockWorkerHandle) {finalizations(pid,status,worker);},
    handleExit(pid:number,status:number,_signal:number,worker:MockWorkerHandle) {finalizations(pid,status,worker);},
    classifiedSignalOrFallback,classifiedTrapExitStatus,signalExitStatus,signalFromExitStatus,
    reportHostDiagnostic:diagnostics,formatProcessFailureContext:()=>"source control context",
    handleVmInterruptTimer:timerDispatches, dispatchForkHostImport:unexpected,SIGSEGV:11 };
  const install = new Function(...Object.keys(dependencies), code + "\nreturn installProcessWorkerListeners;")(
    ...Object.values(dependencies)) as (worker: MockWorkerHandle, pid: number) => void;
  install(original.worker, PID); install(other.worker, OTHER);
  return { original, other, mainQuiescent, finalizations,diagnostics,scheduledTimers,timerDispatches,intentionallyTerminated,
    replace() { const next = makeGeneration(); processes.set(PID, next); observations.admit(PID, next, 3); install(next.worker, PID); return next; },
  };
}

for (const host of ["node", "browser"] as const) for (const width of [4, 8] as const) {
  describe(`${host} actual main-fence identity (${width})`, () => {
    for (const type of ["memory_quiescent", "exec_retired"] as const) {
      const invalid = [
        ["foreign live process PID", { pid: OTHER }],
        ["missing PID", {}],
        ["thread PID without tid", { pid: THREAD }],
        ["string PID", { pid: String(PID) }],
        ["main PID with thread tid", { pid: PID, tid: THREAD }],
        ["main PID with zero tid", { pid: PID, tid: 0 }],
        ["foreign PID with thread tid", { pid: OTHER, tid: THREAD }],
        ["main PID with null tid", { pid: PID, tid: null }],
      ] as const;
      for (const [label, identity] of invalid) it(`${type} rejects ${label}`, () => {
        const r = listenerControl(host, width);
        r.original.worker.simulateMessage({ type, ...identity });
        expect(r.original.workerQuiescence.settled).toBe(false);
        expect(r.original.execRetirement.settled).toBe(false);
        expect(r.other.workerQuiescence.settled).toBe(false);
        expect(r.other.execRetirement.settled).toBe(false);
        expect(r.mainQuiescent).not.toHaveBeenCalled();
      });
      it(`${type} accepts the genuine main identity only`, () => {
        const r = listenerControl(host, width);
        r.original.worker.simulateMessage({ type, pid: PID });
        expect(r.original.workerQuiescence.settled).toBe(type === "memory_quiescent");
        expect(r.original.execRetirement.settled).toBe(type === "exec_retired");
        expect(r.other.workerQuiescence.settled).toBe(false);
        expect(r.other.execRetirement.settled).toBe(false);
        if (type === "memory_quiescent") expect(r.mainQuiescent).toHaveBeenCalledExactlyOnceWith(r.original);
        else expect(r.mainQuiescent).not.toHaveBeenCalled();
      });
    }
    it("old Worker ACK cannot settle a replacement generation", () => {
      const r = listenerControl(host, width), next = r.replace();
      for (const type of ["memory_quiescent", "exec_retired"] as const) r.original.worker.simulateMessage({ type, pid: PID });
      expect(r.original.workerQuiescence.settled).toBe(false); expect(r.original.execRetirement.settled).toBe(false);
      expect(next.workerQuiescence.settled).toBe(false); expect(next.execRetirement.settled).toBe(false);
      expect(r.mainQuiescent).not.toHaveBeenCalled();
      for (const type of ["memory_quiescent", "exec_retired"] as const) {
        for (const identity of [{ pid: OTHER }, {}, { pid: THREAD }, { pid: PID, tid: THREAD }])
          next.worker.simulateMessage({ type, ...identity });
      }
      expect(next.workerQuiescence.settled).toBe(false); expect(next.execRetirement.settled).toBe(false);
      expect(r.other.workerQuiescence.settled).toBe(false); expect(r.other.execRetirement.settled).toBe(false);
      expect(r.mainQuiescent).not.toHaveBeenCalled();
      for (const type of ["memory_quiescent", "exec_retired"] as const) next.worker.simulateMessage({ type, pid: PID });
      expect(next.workerQuiescence.settled).toBe(true); expect(next.execRetirement.settled).toBe(true);
      expect(r.original.workerQuiescence.settled).toBe(false); expect(r.original.execRetirement.settled).toBe(false);
      expect(r.mainQuiescent).toHaveBeenCalledExactlyOnceWith(next);
    });
  });
}

for (const host of ["node", "browser"] as const) for (const width of [4, 8] as const) {
  describe(`${host} actual main lifecycle payload identity (${width})`, () => {
    for (const type of ["error","exit","vm_interrupt_timer"] as const) {
      const body={type,message:"control init failure",status:23,seconds:1,timedOutPtr:32,vmInterruptPtr:64};
      for (const [label,identity] of [["foreign PID",{pid:OTHER}],["missing PID",{}],["string PID",{pid:String(PID)}],["thread PID",{pid:THREAD}]] as const) {
        it(`${type} rejects ${label} before lifecycle dispatch`,()=>{
          const r=listenerControl(host,width);r.original.worker.simulateMessage({...body,...identity});
          // The shared timer body's own PID check must also protect the actual
          // scheduling boundary; dispatch parity is a separate entry invariant.
          expect(r.scheduledTimers).not.toHaveBeenCalled();
          expect(r.finalizations).not.toHaveBeenCalled();expect(r.diagnostics).not.toHaveBeenCalled();
          expect(r.timerDispatches).not.toHaveBeenCalled();
          expect(r.original.workerQuiescence.settled).toBe(false);expect(r.other.workerQuiescence.settled).toBe(false);
          r.original.worker.simulateMessage({...body,pid:PID});
          if(type==="vm_interrupt_timer")expect(r.scheduledTimers).toHaveBeenCalledExactlyOnceWith(PID,r.original,{...body,pid:PID});
          else expect(r.finalizations).toHaveBeenCalledExactlyOnceWith(PID,type==="exit"?23:-1,r.original.worker);
        });
      }
      it(`${type} authentic current realm payload remains accepted`,()=>{
        const r=listenerControl(host,width);r.original.worker.simulateMessage({...body,pid:PID});
        if(type==="vm_interrupt_timer")expect(r.scheduledTimers).toHaveBeenCalledExactlyOnceWith(PID,r.original,{...body,pid:PID});
        else expect(r.finalizations).toHaveBeenCalledExactlyOnceWith(PID,type==="exit"?23:-1,r.original.worker);
      });
      it(`${type} old Worker cannot act on the same-PID replacement`,()=>{
        const r=listenerControl(host,width),next=r.replace();r.original.worker.simulateMessage({...body,pid:PID});
        expect(r.finalizations).not.toHaveBeenCalled();expect(r.scheduledTimers).not.toHaveBeenCalled();expect(r.diagnostics).not.toHaveBeenCalled();
        next.worker.simulateMessage({...body,pid:PID});
        if(type==="vm_interrupt_timer")expect(r.scheduledTimers).toHaveBeenCalledExactlyOnceWith(PID,next,{...body,pid:PID});
        else expect(r.finalizations).toHaveBeenCalledExactlyOnceWith(PID,type==="exit"?23:-1,next.worker);
      });
    }
    for (const kind of ["error","exit"] as const) {
      const emit=(worker:MockWorkerHandle)=>kind==="error"?worker.simulateError(new Error("native Worker event")):worker.simulateExit(7);
      it(`authentic Worker ${kind} EVENT requires no message PID`,()=>{
        const r=listenerControl(host,width);emit(r.original.worker);
        expect(r.finalizations).toHaveBeenCalledExactlyOnceWith(PID,139,r.original.worker);
        expect(r.diagnostics).toHaveBeenCalledOnce();expect(r.mainQuiescent).not.toHaveBeenCalled();
      });
      it(`stale Worker ${kind} EVENT cannot affect replacement`,()=>{
        const r=listenerControl(host,width),next=r.replace();emit(r.original.worker);
        expect(r.finalizations).not.toHaveBeenCalled();expect(r.diagnostics).not.toHaveBeenCalled();
        emit(next.worker);expect(r.finalizations).toHaveBeenCalledExactlyOnceWith(PID,139,next.worker);
      });
      it(`intentional termination suppresses Worker ${kind} EVENT`,()=>{
        const r=listenerControl(host,width);r.intentionallyTerminated.add(r.original.worker);emit(r.original.worker);
        expect(r.finalizations).not.toHaveBeenCalled();expect(r.diagnostics).not.toHaveBeenCalled();
      });
    }
  });
}
