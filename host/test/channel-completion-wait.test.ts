import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import ts from "typescript";
import { waitForChannelCompletion } from "../src/channel-completion-wait";
import {
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
} from "../src/generated/abi";

afterEach(() => vi.restoreAllMocks());

describe("borrowed channel completion wait", () => {
  it("re-enters after spurious wakes on the exact original view/index", () => {
    const words = new Int32Array(new SharedArrayBuffer(32));
    const wait = vi.spyOn(Atomics, "wait")
      .mockReturnValueOnce("ok")
      .mockReturnValueOnce("ok")
      .mockReturnValueOnce("not-equal");
    waitForChannelCompletion(words, 3);
    expect(wait.mock.calls).toEqual([
      [words, 3, CHANNEL_STATUS_PENDING],
      [words, 3, CHANNEL_STATUS_PENDING],
      [words, 3, CHANNEL_STATUS_PENDING],
    ]);
    expect([...words]).toEqual(Array(8).fill(0));
  });

  it("does not add retry or timeout policy for a non-ok primitive result", () => {
    const words = new Int32Array(new SharedArrayBuffer(4));
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    waitForChannelCompletion(words, 0);
    expect(wait).toHaveBeenCalledExactlyOnceWith(words, 0, CHANNEL_STATUS_PENDING);
  });

  it("preserves native exception identity without retrying or mutating status", () => {
    const words = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(words, 0, CHANNEL_STATUS_PENDING);
    const failure = new Error("native wait refused");
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => { throw failure; });
    let observed: unknown;
    try { waitForChannelCompletion(words, 0); } catch (error) { observed = error; }
    expect(observed).toBe(failure);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(words[0]).toBe(CHANNEL_STATUS_PENDING);
  });

  it("observes an already completed word using the actual native primitive", () => {
    const words = new Int32Array(new SharedArrayBuffer(8));
    Atomics.store(words, 1, CHANNEL_STATUS_COMPLETE);
    expect(waitForChannelCompletion(words, 1)).toBeUndefined();
    expect(words[1]).toBe(CHANNEL_STATUS_COMPLETE);
  });

  it("retains native invalid-index and non-shared-view errors", () => {
    expect(() => waitForChannelCompletion(new Int32Array(new SharedArrayBuffer(4)), -1)).toThrow(RangeError);
    expect(() => waitForChannelCompletion(new Int32Array(1), 0)).toThrow(TypeError);
  });
});

// Real Wasm calls the bundled production helper in a disposable Node worker.
// This is source-only wait/return behavior, not a normal C/kernel/lease proof.
describe("actual worker/Wasm channel-wait continuation", () => {
  let helper: string;
  let wasm: Uint8Array;
  beforeAll(() => {
    helper = buildSync({
      entryPoints: [fileURLToPath(new URL("../src/channel-completion-wait.ts", import.meta.url))],
      bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
    }).outputFiles[0].text;
    const directory = mkdtempSync(join(tmpdir(), "kandelo-channel-wait-"));
    try {
      const output = join(directory, "wait.wasm");
      execFileSync("wat2wasm", ["--enable-threads", "-", "-o", output], {
      input: `(module
        (import "env" "memory" (memory 1 1 shared))
        (import "host" "wait" (func $wait))
        (func (export "run") (result i32)
          call $wait
          i32.const 8 i32.const 8 i32.load i32.const 1 i32.add i32.store
          i32.const 4 i32.load))`,
      timeout: 10_000, maxBuffer: 1_048_576,
      });
      wasm = new Uint8Array(readFileSync(output));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function run(initiallyComplete: boolean, invalidIndex = false) {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const words = new Int32Array(memory.buffer);
    Atomics.store(words, 0, initiallyComplete ? CHANNEL_STATUS_COMPLETE : CHANNEL_STATUS_PENDING);
    if (initiallyComplete) Atomics.store(words, 1, 73);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {waitForChannelCompletion}=await import('data:text/javascript;base64,'+Buffer.from(workerData.helper).toString('base64'));
        const words=new Int32Array(workerData.memory.buffer);
        const module=await WebAssembly.compile(workerData.wasm);
        const instance=new WebAssembly.Instance(module,{env:{memory:workerData.memory},host:{wait:()=>waitForChannelCompletion(words,workerData.invalidIndex?-1:0)}});
        parentPort.postMessage({type:'ready'});
        try{const value=instance.exports.run();parentPort.postMessage({type:'returned',value,counter:words[2]});}
        catch(error){parentPort.postMessage({type:'error',name:error.name,message:String(error),counter:words[2]});}
        finally{parentPort.close();}
      })().catch(error=>{parentPort.postMessage({type:'setup-error',message:String(error)});parentPort.close();});
    `, { eval: true, workerData: { memory, wasm, helper, invalidIndex } });
    const messages: Array<Record<string, unknown>> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = new Promise<number>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("exit", resolve);
    });
    exit.catch(() => {});
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Actual wait worker deadline")), 5_000);
    });
    deadline.catch(() => {});
    try {
      await Promise.race([new Promise<void>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", message => {
          messages.push(message);
          if (message.type === "ready") {
            if (!initiallyComplete && !invalidIndex) {
              // Correct whether publication precedes or follows native wait.
              // Notification count is not used as proof the worker was parked.
              Atomics.store(words, 1, 91);
              Atomics.store(words, 0, CHANNEL_STATUS_COMPLETE);
              Atomics.notify(words, 0, 1);
            }
          } else if (message.type === "returned" || message.type === "error") resolve();
          else reject(new Error("Unexpected actual worker message " + JSON.stringify(message)));
        });
      }), deadline]);
      expect(await Promise.race([exit, deadline])).toBe(0);
      return { messages, counter: words[2] };
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }

  it("runs the actual Wasm continuation exactly once after early completion", async () => {
    const result = await run(true);
    expect(result.messages).toEqual([{ type: "ready" }, { type: "returned", value: 73, counter: 1 }]);
    expect(result.counter).toBe(1);
  });

  it("runs once after ordinary completion publication without a lost early wake", async () => {
    const result = await run(false);
    expect(result.messages).toEqual([{ type: "ready" }, { type: "returned", value: 91, counter: 1 }]);
    expect(result.counter).toBe(1);
  });

  it("does not execute the Wasm continuation after an actual native wait error", async () => {
    const result = await run(false, true);
    expect(result.messages[0]).toEqual({ type: "ready" });
    expect(result.messages[1]).toMatchObject({ type: "error", name: "RangeError", counter: 0 });
    expect(result.counter).toBe(0);
  });
});

it("routes all ten generated channel waits through the shared seam and retains independent lock waits", () => {
  const code = readFileSync(new URL("../src/worker-main.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("worker-main.ts", code, ts.ScriptTarget.Latest, true);
  const callers: string[] = [];
  const nativeLockWords: string[] = [];
  function enclosingName(node: ts.Node): string {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
      if (ts.isArrowFunction(parent)) {
        const owner = parent.parent;
        if (ts.isPropertyAssignment(owner)) return owner.name.getText(source);
        if (ts.isVariableDeclaration(owner)) return owner.name.getText(source);
      }
    }
    throw new Error("Unidentified wait caller");
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(source) === "waitForChannelCompletion") {
        expect(node.arguments.length).toBe(2);
        expect(node.arguments[0].getText(source)).toBe("i32");
        const caller = enclosingName(node);
        expect(node.arguments[1].getText(source).replace(/\s+/g, "")).toBe(
          caller === "sendForkSyscall" ? "(channelOffset+CH_STATUS)/4" : "(base+CH_STATUS)/4",
        );
        callers.push(caller);
      }
      if (node.expression.getText(source) === "Atomics.wait") nativeLockWords.push(node.arguments[0].getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callers.sort()).toEqual([
    "continuationMmap", "continuationMunmap", "kernel_exit", "kernel_clone", "kernel_fork",
    "invokeChannelSyscall", "allocateMemory", "deallocateMemory", "sendForkSyscall", "centralizedThreadWorkerMain",
  ].sort());
  expect(nativeLockWords.sort()).toEqual([
    "loaderOwner", "loaderOwner", "loaderOwner", "archiveLock", "archiveLock",
    "processDlopenOwner", "processDlopenLock",
  ].sort());
});
