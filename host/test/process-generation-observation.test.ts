import { describe, expect, it, vi } from "vitest";
import { deliverProcessGenerationEvent, ProcessGenerationObservations, type ProcessGenerationEventData as ProcessGenerationEvent } from "../src/process-generation-observation";
import { ExactProcessGenerationDetachLedger } from "../src/process-generation-detach";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import { ProcessMemoryAllocator } from "../src/process-memory";
import { retireSupersededExecGeneration, type ProcessGenerationOwnership } from "../src/process-lifecycle";
import { createWorkerQuiescence, runWithProcessWorkerQuiescence } from "../src/worker-quiescence";

function setup() {
  const owner = new ForkExternrefProcessOwner();
  const generation = { memory: new WebAssembly.Memory({ initial: 1 }) };
  const token = owner.startGeneration(41);
  const events: ProcessGenerationEvent[] = [];
  const observations = new ProcessGenerationObservations(event => events.push(event));
  observations.enable();
  observations.admit(41, generation, owner.generationId(token));
  const current = new Map([[41, generation]]);
  const ledger = new ExactProcessGenerationDetachLedger(
    pid => current.get(pid), pid => { current.delete(pid); },
    (generation, result) => observations.retired(generation, result),
  );
  const detach = (retire: Parameters<typeof ledger.detach>[0]["retire"],
      settle = () => {}, kernelDetach = () => true) => ledger.detach({
    pid: 41, generation, memory: generation.memory, detach: kernelDetach, settle, retire,
  });
  return { owner, generation, token, observations, events, current, ledger, detach };
}

const retired = (events: ProcessGenerationEvent[]) => events.filter(event => event.kind === "retired");

describe("real process generation observation", () => {
  it("retains the authenticated image ID across broker replacement and same-Memory aliases", async () => {
    const r = setup();
    const replacementToken = r.owner.replaceGeneration(r.token);
    const replacement = { memory: r.generation.memory };
    r.observations.admit(41, replacement, r.owner.generationId(replacementToken));
    r.current.set(41, replacement);
    r.observations.mainQuiescent(r.generation);
    await r.detach(commit => commit("quiescent"), () => {}, () => false);
    expect(retired(r.events)).toEqual([{ kind: "retired", pid: 41,
      executionId: r.token.id, mainFence: "acknowledged", threadFences: "acknowledged",
      threads: 0, acknowledgedThreads: 0, leaseDisposition: "quiescent", registration: "superseded", postCommitFailed: false }]);
    expect(replacementToken.id).not.toBe(r.token.id);
    expect(r.current.get(41)).toBe(replacement);
    // A late old-worker fence cannot acknowledge the successor sharing Memory.
    r.observations.mainQuiescent(r.generation);
    r.observations.retired(replacement, { leaseDisposition: "forced", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(retired(r.events)[1]).toMatchObject({ executionId: replacementToken.id, mainFence: "missing" });
  });

  it("semantic exit and synthetic settle do not prove the actual entry ACK", async () => {
    const r = setup();
    const synthetic = createWorkerQuiescence();
    synthetic.settle();
    r.observations.exited(r.generation, 0);
    expect(retired(r.events)).toEqual([]);
    await r.detach(commit => commit("forced"));
    expect(retired(r.events)[0]).toMatchObject({ leaseDisposition: "forced", mainFence: "missing" });
  });

  it("accepts the actual shared entry terminal message only after worker-main returns", async () => {
    const r = setup();
    let done!: () => void;
    const run = runWithProcessWorkerQuiescence({
      postMessage: message => {
        expect(message).toEqual({ type: "memory_quiescent", pid: 41 });
        r.observations.mainQuiescent(r.generation);
      }, close: () => {},
    }, { pid: 41 }, () => new Promise<void>(resolve => { done = resolve; }), () => {});
    r.observations.exited(r.generation, 0);
    expect(retired(r.events)).toHaveLength(0);
    done(); await run;
    await r.detach(commit => commit("quiescent"));
    expect(retired(r.events)[0]).toMatchObject({ mainFence: "acknowledged", leaseDisposition: "quiescent" });
  });

  it("a lost terminal post never becomes acknowledged after cleanup or timeout", async () => {
    const r = setup();
    await expect(runWithProcessWorkerQuiescence({
      postMessage: () => { throw Error("closed port"); }, close: () => {},
    }, { pid: 41 }, async () => {}, () => {})).rejects.toThrow("closed port");
    await r.detach(commit => commit("forced"));
    expect(retired(r.events)[0]).toMatchObject({ mainFence: "missing", leaseDisposition: "forced" });
  });

  it("retains the captured thread roster after removal and refuses unknown/duplicate ACKs", async () => {
    const r = setup();
    const first = {}, missing = {}, unrelated = {};
    r.observations.threadAdmitted(r.generation, first);
    r.observations.threadAdmitted(r.generation, missing);
    r.observations.threadAdmitted(r.generation, first);
    r.observations.threadQuiescent(r.generation, unrelated);
    r.observations.threadQuiescent(r.generation, first);
    r.observations.threadQuiescent(r.generation, first);
    // No dependency on a mutable threadWorkers map remaining populated.
    r.observations.mainQuiescent(r.generation);
    await r.detach(commit => commit("forced"));
    expect(retired(r.events)[0]).toMatchObject({ threads: 2, acknowledgedThreads: 1,
      mainFence: "acknowledged", threadFences: "missing", leaseDisposition: "forced" });
    r.observations.threadQuiescent(r.generation, missing);
    expect(retired(r.events)).toHaveLength(1);
  });

  it("does not use another generation's thread ACK", async () => {
    const r = setup();
    const thread = {}, other = {};
    r.observations.admit(42, other, 2);
    r.observations.threadAdmitted(r.generation, thread);
    r.observations.threadQuiescent(other, thread);
    await r.detach(commit => commit("forced"));
    expect(retired(r.events)[0]).toMatchObject({ acknowledgedThreads: 0, threadFences: "missing" });
  });

  it.each(["detach", "settle", "release"])("retains a failed %s and emits once only after actual retry commit", async failure => {
    const r = setup(); let reject = true, releases = 0;
    const check = (phase: string) => { if (reject && phase === failure) throw Error(phase); };
    const retire = (commit: (disposition?: "forced") => void) => { check("release"); releases++; commit("forced"); };
    const first = await r.detach(retire, () => check("settle"), () => { check("detach"); return true; });
    expect(first.status).toBe("retained-error");
    expect(retired(r.events)).toHaveLength(0);
    reject = false;
    await r.ledger.retryPending();
    expect(retired(r.events)).toHaveLength(1);
    expect(releases).toBe(1);
    await r.detach(retire);
    expect(releases).toBe(1);
    expect(retired(r.events)).toHaveLength(1);
  });

  it.each([true, false])("actual exec retirement records the committed lease choice (%s)", async quiescent => {
    const allocator = new ProcessMemoryAllocator({ maxMemories: 1, maxTotalBytes: 65536 });
    const lease = allocator.acquire({ ptrWidth: 4, initialPages: 1, maximumPages: 1 });
    const generation = { memory: lease.memory, memoryLease: lease };
    const events: ProcessGenerationEvent[] = [];
    const observations = new ProcessGenerationObservations(event => events.push(event));
    observations.enable();
    const owner = new ForkExternrefProcessOwner(), token = owner.startGeneration(41);
    observations.admit(41, generation, owner.generationId(token));
    const successor = { memory: lease.memory, memoryLease: lease };
    const current = new Map<number, ProcessGenerationOwnership>([[41, successor]]);
    const ledger = new ExactProcessGenerationDetachLedger(
      pid => current.get(pid), pid => { current.delete(pid); },
      (generation, result) => observations.retired(generation, result));
    if (quiescent) observations.mainQuiescent(generation);
    await retireSupersededExecGeneration(ledger, 41, generation, quiescent);
    expect(retired(events)[0]).toMatchObject({ registration: "superseded",
      leaseDisposition: quiescent ? "quiescent" : "forced",
      mainFence: quiescent ? "acknowledged" : "missing" });
    expect(current.get(41)).toBe(successor);
    expect(ledger.pendingCount).toBe(0);
  });

  it("a callback failure after actual lease commit does not discard or duplicate observation", async () => {
    const r = setup();
    const result = await r.detach(commit => { commit("forced"); throw Error("post-commit cleanup"); });
    expect(result).toMatchObject({ status: "released", postCommitError: expect.any(Error) });
    expect(retired(r.events)[0]).toMatchObject({ postCommitFailed: true });
    await r.ledger.retryPending();
    await r.detach(() => { throw Error("must not repeat physical release"); });
    expect(retired(r.events)).toHaveLength(1);
  });

  it("throw undefined after commit is still a committed callback failure", async () => {
    const r = setup();
    const result = await r.detach(commit => { commit("forced"); throw undefined; });
    expect(result).toHaveProperty("postCommitError");
    expect(retired(r.events)[0]).toMatchObject({ postCommitFailed: true });
  });

  it("has no records or emissions by default without an init subscription", () => {
    const emit = vi.fn(), observations = new ProcessGenerationObservations(emit);
    const generation = {}, thread = {};
    expect(observations.admit(41, generation, 1)).toBe(false);
    observations.mainQuiescent(generation);
    observations.threadAdmitted(generation, thread);
    observations.threadQuiescent(generation, thread);
    observations.exited(generation, 0);
    observations.retired(generation, { leaseDisposition: "forced", postCommitFailed: false, detachDisposition: "removed-or-absent" });
    expect(emit).not.toHaveBeenCalled();
    observations.enable();
    expect(observations.admit(41, generation, 1)).toBe(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "admitted", pid: 41, executionId: 1 });
  });

  it("does not observe an uncommitted lease retirement as complete", async () => {
    const r = setup();
    expect((await r.detach(() => {})).status).toBe("retained-error");
    expect(retired(r.events)).toHaveLength(0);
  });

  it("reports older unannotated commits as unobserved, never assumed quiescent", async () => {
    const r = setup();
    await r.detach(commit => commit());
    expect(retired(r.events)[0]).toMatchObject({ leaseDisposition: "unobserved", mainFence: "missing" });
  });

  it("publishes the completion tombstone before a throwing/reentrant observer", async () => {
    const generation = {}, memory = new WebAssembly.Memory({ initial: 1 });
    let current: object | undefined = generation;
    let callbackCalls = 0, releaseCalls = 0;
    const ledger = new ExactProcessGenerationDetachLedger<object>(
      () => current, () => { current = undefined; }, () => {
        callbackCalls++;
        void ledger.detach(transaction);
        throw Error("observer");
      });
    const transaction = { pid: 41, generation, memory, detach: () => true,
      settle: () => {}, retire: (commit: (mode?: "forced") => void) => { releaseCalls++; commit("forced"); } };
    expect((await ledger.detach(transaction)).status).toBe("released");
    expect((await ledger.detach(transaction)).status).toBe("released");
    expect(callbackCalls).toBe(1); expect(releaseCalls).toBe(1);
  });

  it("contains observer exceptions and freezes scalar snapshots", () => {
    const events: ProcessGenerationEvent[] = [];
    const observer = new ProcessGenerationObservations(event => {
      events.push(event); expect(Object.isFrozen(event)).toBe(true);
      expect(Object.values(event).every(value => value === null || !["object", "function"].includes(typeof value))).toBe(true);
      throw Error("observer");
    });
    observer.enable();
    const generation = {};
    expect(() => {
      observer.admit(41, generation, 1);
      observer.exited(generation, 0);
      observer.retired(generation, { leaseDisposition: "forced", detachDisposition: "removed-or-absent", postCommitFailed: false });
    }).not.toThrow();
    expect(events.map(event => event.kind)).toEqual(["admitted", "exited", "retired"]);
    observer.exited(generation, 1);
    observer.retired(generation, { leaseDisposition: "quiescent", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ postCommitFailed: false });
  });

  it("contains rejected async observers without delaying lifecycle completion", async () => {
    const rejected = Promise.reject(Error("async observer"));
    const delivered = deliverProcessGenerationEvent({ kind: "admitted", pid: 41, executionId: 1 }, () => rejected);
    expect(delivered).toBeUndefined();
    await Promise.resolve();
  });

  it("refuses conflicting/unknown admission without manufacturing a retirement", () => {
    const r = setup();
    expect(r.observations.admit(42, r.generation, 8)).toBe(false);
    expect(r.observations.admit(42, {}, 0)).toBe(false);
    r.observations.retired({}, { leaseDisposition: "quiescent", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(retired(r.events)).toEqual([]);
    expect(r.events).toHaveLength(1);
  });
});

// Execute the real production listener bodies with their captured identities.
// This is source-only callback wiring coverage, not a normal guest/browser run.
import { readFileSync } from "node:fs";
import ts from "typescript";

function actualMessageListener(host: "node" | "browser", name: string,
    captures: Record<string, unknown>): (message: unknown) => void {
  const path = new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(declaration, `actual ${host} ${name}`).toBeDefined();
  const callbacks: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "on" && node.arguments.length === 2
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "message") callbacks.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  };
  visit(declaration!);
  expect(callbacks).toHaveLength(1);
  const code = ts.transpileModule(`const listener = (${callbacks[0].getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(captures), `${code}\nreturn listener;`)(...Object.values(captures));
}

for (const host of ["node", "browser"] as const) {
  it(`${host} actual main listener refuses a stale worker or wrong PID`, async () => {
    const r = setup();
    const worker = {}, wrong = {};
    const process = { ...r.generation, worker, workerQuiescence: createWorkerQuiescence() };
    // Use an authenticated observation on the exact ProcessInfo captured by the map.
    r.observations.admit(41, process, 2);
    const processes = new Map([[41, process]]);
    const listen = (captured: object) => actualMessageListener(host, "installProcessWorkerListeners", {
      processes, pid: 41, worker: captured, generationObservations: r.observations,
      vforkLifetimes: { phaseForChild: () => undefined }, intentionallyTerminated: new WeakSet(),
    });
    listen(wrong)({ type: "memory_quiescent", pid: 41 });
    expect(process.workerQuiescence.settled).toBe(false);
    listen(worker)({ type: "memory_quiescent", pid: 99 });
    r.observations.retired(process, { leaseDisposition: "forced", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(retired(r.events)[0]).toMatchObject({ executionId: 2, mainFence: "missing" });
  });

  it(`${host} actual main listener records the exact worker's terminal message`, () => {
    const r = setup(), worker = {};
    const process = { worker, workerQuiescence: createWorkerQuiescence() };
    r.observations.admit(41, process, 2);
    const listener = actualMessageListener(host, "installProcessWorkerListeners", {
      processes: new Map([[41, process]]), pid: 41, worker, generationObservations: r.observations,
      vforkLifetimes: { phaseForChild: () => undefined }, intentionallyTerminated: new WeakSet(),
    });
    listener({ type: "memory_quiescent", pid: 41 });
    expect(process.workerQuiescence.settled).toBe(true);
    r.observations.retired(process, { leaseDisposition: "quiescent", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(retired(r.events)[0]).toMatchObject({ executionId: 2, mainFence: "acknowledged" });
  });

  it(`${host} actual thread listener retains ACK identity through registry removal`, () => {
    const r = setup();
    const threadEntry = { workerQuiescence: createWorkerQuiescence(), quiescent: false };
    const live = new Set([threadEntry]);
    r.observations.threadAdmitted(r.generation, threadEntry);
    const listener = actualMessageListener(host, "handleClone", {
      pid: 41, tid: 43, processInfo: r.generation, threadEntry,
      generationObservations: r.observations,
      exitedThreadWorkersOutliveThreads: false,
      terminateThreadEntry: () => { live.delete(threadEntry); return Promise.resolve(); },
    });
    listener({ type: "memory_quiescent", pid: 99, tid: 43 });
    expect(live.size).toBe(0); // Existing cleanup may settle; that is not our ACK.
    r.observations.retired(r.generation, { leaseDisposition: "forced", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(retired(r.events)[0]).toMatchObject({ threads: 1, acknowledgedThreads: 0, threadFences: "missing" });

    const next = {}, nextThread = { workerQuiescence: createWorkerQuiescence(), quiescent: false };
    r.observations.admit(42, next, 2);
    r.observations.threadAdmitted(next, nextThread);
    const nextListener = actualMessageListener(host, "handleClone", {
      pid: 42, tid: 43, processInfo: next, threadEntry: nextThread,
      generationObservations: r.observations, exitedThreadWorkersOutliveThreads: false,
      terminateThreadEntry: () => Promise.resolve(),
    });
    // The old listener cannot acknowledge the replacement generation reusing TID.
    listener({ type: "memory_quiescent", pid: 41, tid: 43 });
    nextListener({ type: "memory_quiescent", pid: 42, tid: 43 });
    r.observations.retired(next, { leaseDisposition: "quiescent", detachDisposition: "removed-or-absent", postCommitFailed: false });
    expect(retired(r.events)[1]).toMatchObject({ threads: 1, acknowledgedThreads: 1, threadFences: "acknowledged" });
  });

  it(`${host} all real admissions and retirement funnels use the shared observer`, () => {
    const source = readFileSync(new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url), "utf8");
    // One normal registration operation stays inside the authenticating wrapper;
    // all five root/vfork/fork/exec/posix_spawn ProcessInfo registrations use it.
    expect(source.match(/processes\.set\(/g)).toHaveLength(1);
    expect(source.match(/registerObservedProcess\(/g)).toHaveLength(6);
    expect(source).toContain("externrefProcessOwner.generationId(info.externrefGeneration)");
    expect(source).toContain("(generation, result) => generationObservations.retired(generation, result)");
    expect(source).toContain("generationObservations.exited(info, exitStatus)");
    expect(source.match(/generationObservations\.mainQuiescent\(/g)).toHaveLength(1);
    expect(source.match(/generationObservations\.threadQuiescent\(/g)).toHaveLength(1);
    // Each actual lease-commit call annotates its release choice. No default
    // unobserved legacy commit is mistaken for quiescence in production.
    const ast = ts.createSourceFile("entry.ts", source, ts.ScriptTarget.Latest, true);
    let commits = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "commit") {
        expect(node.arguments).toHaveLength(1); commits++;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(commits).toBe(8);
  });
}

for (const peer of ["node", "browser"] as const) {
  it(`${peer} actual proxy listener separates rebooted image IDs and rejects stale worker events`, async () => {
    const received: import("../src/process-generation-observation").ProcessGenerationEvent[] = [];
    const options = { onProcessGenerationEvent: (event: import("../src/process-generation-observation").ProcessGenerationEvent) => received.push(event) };
    const host = peer === "node"
      ? new (await import("../src/node-kernel-host")).NodeKernelHost(options)
      : new (await import("../src/browser-kernel-host")).BrowserKernel({ ...options, kernelOwnedFs: true });
    const file = new URL(`../src/${peer}-kernel-host.ts`, import.meta.url);
    const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const callbacks: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
          && node.getText(ast).includes("!== observationWorker")
          && node.getText(ast).includes("this.handleWorkerMessage(msg, observationRealm)")) callbacks.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(callbacks).toHaveLength(1);
    const code = ts.transpileModule(`const listener = (${callbacks[0].getText(ast)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const bind = new Function("observationWorker", "observationRealm", `${code}\nreturn listener;`);
    const first = {}, second = {};
    const setCurrent = (worker: object, started = true) => Object.assign(host, {
      [peer === "node" ? "worker" : "kernelWorkerHandle"]: worker, workerStarted: started,
    });
    const event = { type: "process_generation_event", event: { kind: "admitted", pid: 41, executionId: 1 } };
    const send = (listener: (message: unknown) => void) => listener(peer === "node" ? event : { data: event });
    const oldListener = bind.call(host, first, 1);
    setCurrent(first); send(oldListener);
    const newListener = bind.call(host, second, 2);
    setCurrent(second); send(oldListener); send(newListener);
    setCurrent(second, false); send(newListener);
    expect(received).toEqual([
      { ...event.event, realmId: 1 }, { ...event.event, realmId: 2 },
    ]);
    expect(received.every(Object.isFrozen)).toBe(true);
    const source = ast.text;
    expect(source.indexOf("this.processGenerationRealm === Number.MAX_SAFE_INTEGER"))
      .toBeLessThan(source.indexOf("const observationRealm = ++this.processGenerationRealm"));
  });
}

for (const peer of ["node", "browser"] as const) {
  it(`${peer} actual registration is silent without the normal init subscription`, () => {
    const source = ts.createSourceFile("entry.ts", readFileSync(new URL(`../src/${peer}-kernel-worker-entry.ts`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "registerObservedProcess");
    expect(declaration).toBeDefined();
    const code = ts.transpileModule(declaration!.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const build = new Function("processes", "observeProcessGenerations", "externrefProcessOwner", "generationObservations", `${code}\nreturn registerObservedProcess;`);
    for (const enabled of [false, true]) {
      const owner = new ForkExternrefProcessOwner(), token = owner.startGeneration(41);
      const authenticate = vi.spyOn(owner, "generationId");
      const emitted = vi.fn(), observations = new ProcessGenerationObservations(emitted);
      if (enabled) observations.enable();
      const info = { externrefGeneration: token }, current = new Map();
      const register = build(current, enabled, owner, observations);
      register(41, info);
      expect(current.get(41)).toBe(info); // Registration is unchanged in both modes.
      expect(authenticate).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(emitted).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled) expect(emitted).toHaveBeenCalledWith({ kind: "admitted", pid: 41, executionId: token.id });
    }
    expect(source.text).toContain("observeProcessGenerations = msg.observeProcessGenerations === true");
    expect(source.text).toContain("if (observeProcessGenerations) generationObservations.enable()");
    const host = readFileSync(new URL(`../src/${peer}-kernel-host.ts`, import.meta.url), "utf8");
    expect(host).toContain('observeProcessGenerations: typeof this.options.onProcessGenerationEvent === "function"');
  });
}
