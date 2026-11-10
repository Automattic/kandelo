import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { WasmDebugInfo, type SourceLocation } from "../../host/src/wasm-debug-info";
import type { WorkerDebugTarget, DebugEvent } from "./node-worker-debugger";

export interface RustDebugCallbacks {
  ready(target: WorkerDebugTarget): Promise<void>;
  event(target: WorkerDebugTarget, event: DebugEvent): Promise<void>;
  retired(target: WorkerDebugTarget): void;
}

/** Source-level commands shared by the Node and Chromium worker transports. */
export function createRustDebugSession(bytes: Uint8Array, breakpoint: string,
  commands: string[] | undefined, stop: () => void) {
  const match = /^(.*):([1-9][0-9]*)$/.exec(breakpoint);
  if (!match) throw new Error("breakpoint must be FILE:LINE (one-based)");
  if (bytes.byteLength > 256 * 1024 ** 2) throw new Error("debug module exceeds 256 MiB");
  const debug = new WasmDebugInfo(bytes.buffer);
  const locations = debug.breakpoints(match[1], Number(match[2]));
  if (!locations.length) throw new Error(`no mapped executable instruction for ${JSON.stringify(breakpoint)}; build with debug=2`);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const modules = new Set<string>();
  const identities = new Map<string, Promise<void>>();
  const installed = new Set<string>();
  const urls = new Set<string>();
  let wasHit = false;
  let stepping: { target: string; source?: SourceLocation; count: number } | undefined;
  const terminal = commands ? undefined : createInterface({ input: process.stdin, output: process.stderr });
  const log = (text: string) => process.stderr.write(text + "\n");
  const sourceText = (source?: SourceLocation) => source ? `${JSON.stringify(source.file)}:${source.line}:${source.column}` : "<unmapped instruction>";
  async function install(target: WorkerDebugTarget, url: string) {
    const key = `${target.id}:${url}`;
    if (installed.has(key)) return;
    installed.add(key);
    for (const location of locations) await target.send("Debugger.setBreakpointByUrl", { url, lineNumber: 0, columnNumber: location.pc });
  }
  async function prompt(target: WorkerDebugTarget, frames: any[], source?: SourceLocation): Promise<void> {
    for (;;) {
      const command = commands ? commands.shift() ?? "continue" : (await terminal!.question("rust-debug> ")).trim();
      if (command === "where" || command === "bt") {
        for (const frame of frames) {
          const known = modules.has(`${target.id}:${frame.location.scriptId}`);
          const found = known ? debug.resolvePc(frame.location.columnNumber) : undefined;
          log(`  ${JSON.stringify(found?.name ?? frame.functionName)} ${sourceText(found?.location)}`);
        }
      } else if (command === "next" || command === "n") {
        stepping = { target: target.id, source, count: 1 };
        await target.send("Debugger.stepOver"); return;
      } else if (command === "continue" || command === "c") {
        stepping = undefined; await target.send("Debugger.resume"); return;
      } else if (command === "quit" || command === "q") {
        stop(); return;
      } else log("commands: next (n), continue (c), where (bt), quit (q)");
    }
  }
  const callbacks: RustDebugCallbacks = {
    retired: target => {
      const prefix = `${target.id}:`;
      for (const key of modules) if (key.startsWith(prefix)) modules.delete(key);
      for (const key of installed) if (key.startsWith(prefix)) installed.delete(key);
      for (const key of identities.keys()) if (key.startsWith(prefix)) identities.delete(key);
      if (stepping?.target === target.id) stepping = undefined;
    },
    ready: async target => { for (const url of urls) await install(target, url); },
    event: async (target, event) => {
      const params = event.params;
      if (event.method === "Debugger.scriptParsed" && params.scriptLanguage === "WebAssembly") {
        if (params.length !== bytes.length) return;
        const identity = (async () => {
          const result = await target.send<{ bytecode?: string }>("Debugger.getScriptSource", { scriptId: params.scriptId });
          if (createHash("sha256").update(Buffer.from(result.bytecode ?? "", "base64")).digest("hex") === expected) {
            modules.add(`${target.id}:${params.scriptId}`); urls.add(params.url);
            await install(target, params.url);
          }
        })();
        identities.set(`${target.id}:${params.scriptId}`, identity);
        await identity;
      } else if (event.method === "Debugger.paused") {
        const frame = params.callFrames[0];
        await identities.get(`${target.id}:${frame.location.scriptId}`);
        const known = modules.has(`${target.id}:${frame.location.scriptId}`);
        const found = known ? debug.resolvePc(frame.location.columnNumber) : undefined;
        const hit = known && params.hitBreakpoints?.length > 0;
        if (hit) wasHit = true;
        if (stepping?.target === target.id && !hit) {
          const a = stepping.source, b = found?.location;
          if (!b || (a?.file === b.file && a.line === b.line && a.column === b.column)) {
            if (++stepping.count > 4096) throw new Error("source step exceeded 4096 instructions");
            await target.send("Debugger.stepOver"); return;
          }
          stepping = undefined;
        } else if (!hit) { await target.send("Debugger.resume"); return; }
        log(`paused worker ${target.id}: ${JSON.stringify(found?.name ?? frame.functionName)} ${sourceText(found?.location)}`);
        await prompt(target, params.callFrames, found?.location);
      }
    },
  };
  return {
    callbacks, expected, locations,
    get wasHit() { return wasHit; },
    close() { terminal?.close(); },
  };
}
