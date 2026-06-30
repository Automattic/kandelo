#!/usr/bin/env tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findRepoRoot, tryResolveBinary } from "../host/src/binary-resolver";
import { NodeKernelHost } from "../host/src/node-kernel-host";

const REPO_ROOT = findRepoRoot();
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.SPIDERMONKEY_NODE_JS_SHELL_PORT ?? 5311);
const DEFAULT_TIMEOUT_MS = Number(process.env.SPIDERMONKEY_WRAPPER_TIMEOUT_MS ?? 600_000);
const MAX_WORKERS = Number(process.env.SPIDERMONKEY_NODE_JS_SHELL_MAX_WORKERS ?? 8);
const DEFAULT_THREAD_SLOTS = Number(process.env.SPIDERMONKEY_NODE_THREAD_SLOTS ?? 64);
const MAX_PAGES = process.env.SPIDERMONKEY_NODE_MAX_PAGES === undefined
  ? undefined
  : Number(process.env.SPIDERMONKEY_NODE_MAX_PAGES);

interface RunRequest {
  argv: string[];
  cwd?: string;
  env?: string[];
  timeoutMs?: number;
}

interface ActiveRun {
  stdout: string;
  stderr: string;
}

function resolveJsWasm(): string {
  const candidates = [
    process.env.SPIDERMONKEY_WASM,
    tryResolveBinary("programs/js.wasm"),
    tryResolveBinary("programs/spidermonkey.wasm"),
    join(REPO_ROOT, "packages/registry/spidermonkey/bin/js.wasm"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "SpiderMonkey js.wasm not found. Run: bash packages/registry/spidermonkey/build-spidermonkey.sh",
    );
  }
  return found;
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function readVarU32(bytes: Uint8Array, offset: { value: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (offset.value >= bytes.length) throw new Error("truncated wasm varuint32");
    const byte = bytes[offset.value++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
    if (shift > 35) throw new Error("invalid wasm varuint32");
  }
}

function skipName(bytes: Uint8Array, offset: { value: number }) {
  const length = readVarU32(bytes, offset);
  offset.value += length;
  if (offset.value > bytes.length) throw new Error("truncated wasm name");
}

function readMemoryMaximumPages(bytes: Uint8Array, offset: { value: number }): number | undefined {
  const flags = readVarU32(bytes, offset);
  readVarU32(bytes, offset); // minimum
  if ((flags & 0x1) === 0) return undefined;
  return readVarU32(bytes, offset);
}

function detectWasmMaximumMemoryPages(wasmBytes: ArrayBuffer): number | undefined {
  const bytes = new Uint8Array(wasmBytes);
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    return undefined;
  }

  let pos = 8;
  while (pos < bytes.length) {
    const sectionId = bytes[pos++];
    const sectionSizeOffset = { value: pos };
    const sectionSize = readVarU32(bytes, sectionSizeOffset);
    const sectionStart = sectionSizeOffset.value;
    const sectionEnd = sectionStart + sectionSize;
    if (sectionEnd > bytes.length) return undefined;

    const offset = { value: sectionStart };
    if (sectionId === 2) {
      const count = readVarU32(bytes, offset);
      for (let i = 0; i < count; i++) {
        skipName(bytes, offset);
        skipName(bytes, offset);
        const kind = bytes[offset.value++];
        switch (kind) {
          case 0x00: // function
            readVarU32(bytes, offset);
            break;
          case 0x01: { // table
            offset.value++; // element type
            const flags = readVarU32(bytes, offset);
            readVarU32(bytes, offset);
            if ((flags & 0x1) !== 0) readVarU32(bytes, offset);
            break;
          }
          case 0x02: // memory
            return readMemoryMaximumPages(bytes, offset);
          case 0x03: // global
            offset.value += 2;
            break;
          default:
            return undefined;
        }
      }
    } else if (sectionId === 5) {
      const count = readVarU32(bytes, offset);
      if (count > 0) return readMemoryMaximumPages(bytes, offset);
    }
    pos = sectionEnd;
  }
  return undefined;
}

function readJsonBody(req: IncomingMessage): Promise<RunRequest> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
    ),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main() {
  const jsPath = resolveJsWasm();
  const jsBytes = loadBytes(jsPath);
  const detectedMaxPages = detectWasmMaximumMemoryPages(jsBytes);
  const maxPages = MAX_PAGES === undefined
    ? detectedMaxPages
    : Math.min(MAX_PAGES, detectedMaxPages ?? MAX_PAGES);
  const activeRuns = new Map<number, ActiveRun>();
  const runPids = new Map<ActiveRun, Set<number>>();
  const liveRuns = new Set<ActiveRun>();
  const pendingOutput = new Map<number, ActiveRun>();
  const pendingChildrenByParent = new Map<number, number[]>();
  const decoder = new TextDecoder();
  let outputSequence = 0;

  function appendOutput(
    target: Map<number, ActiveRun>,
    pid: number,
    stream: "stdout" | "stderr",
    data: Uint8Array,
  ) {
    let run = target.get(pid);
    if (!run) {
      run = { stdout: "", stderr: "" };
      target.set(pid, run);
    }
    run[stream] += decoder.decode(data);
  }

  function onlyLiveRun(): ActiveRun | undefined {
    // Fast feature probes can emit stdout with currentHandlePid unset. Assign
    // that orphan output only when there is no concurrent shell request.
    return liveRuns.size === 1 ? liveRuns.values().next().value : undefined;
  }

  async function drainRunOutput(): Promise<void> {
    for (;;) {
      const before = outputSequence;
      await delay(0);
      if (outputSequence === before) return;
    }
  }

  function attachRunPid(pid: number, run: ActiveRun) {
    const pending = pendingOutput.get(pid);
    if (pending) {
      run.stdout += pending.stdout;
      run.stderr += pending.stderr;
      pendingOutput.delete(pid);
    }

    activeRuns.set(pid, run);
    let pids = runPids.get(run);
    if (!pids) {
      pids = new Set<number>();
      runPids.set(run, pids);
    }
    pids.add(pid);

    const pendingChildren = pendingChildrenByParent.get(pid);
    if (pendingChildren) {
      pendingChildrenByParent.delete(pid);
      for (const childPid of pendingChildren) {
        attachRunPid(childPid, run);
      }
    }
  }

  const host = new NodeKernelHost({
    maxWorkers: MAX_WORKERS,
    defaultThreadSlots: DEFAULT_THREAD_SLOTS,
    maxPages,
    onStdout: (pid, data) => {
      const run = activeRuns.get(pid);
      const orphanRun = pid === 0 ? onlyLiveRun() : undefined;
      if (run) run.stdout += decoder.decode(data);
      else if (orphanRun) orphanRun.stdout += decoder.decode(data);
      else appendOutput(pendingOutput, pid, "stdout", data);
      outputSequence++;
    },
    onStderr: (pid, data) => {
      const run = activeRuns.get(pid);
      const orphanRun = pid === 0 ? onlyLiveRun() : undefined;
      if (run) run.stderr += decoder.decode(data);
      else if (orphanRun) orphanRun.stderr += decoder.decode(data);
      else appendOutput(pendingOutput, pid, "stderr", data);
      outputSequence++;
    },
    onProcessEvent: (event) => {
      if (event.kind === "spawn" && event.ppid !== undefined) {
        const parentRun = activeRuns.get(event.ppid);
        if (parentRun) {
          attachRunPid(event.pid, parentRun);
        } else {
          const children = pendingChildrenByParent.get(event.ppid) ?? [];
          children.push(event.pid);
          pendingChildrenByParent.set(event.ppid, children);
        }
      }
    },
    onResolveExec: (path) => {
      const base = basename(path);
      if (base === "js" || base === "js.wasm" || base === "spidermonkey.wasm") {
        return jsBytes;
      }
      const candidates = [
        path,
        path.endsWith(".wasm") ? path : `${path}.wasm`,
        resolve(process.cwd(), path),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return loadBytes(candidate);
      }
      return null;
    },
  });
  await host.init();

  async function runShell(req: IncomingMessage, res: ServerResponse) {
    const run: ActiveRun = { stdout: "", stderr: "" };
    let pid: number | undefined;
    liveRuns.add(run);
    try {
      const body = await readJsonBody(req);
      const argv = ["js", ...body.argv];
      const exit = host.spawn(jsBytes, argv, {
        cwd: body.cwd || REPO_ROOT,
        env: body.env,
        onStarted: (startedPid) => {
          pid = startedPid;
          attachRunPid(startedPid, run);
        },
      });
      const exitCode = await withTimeout(exit, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await drainRunOutput();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
      }));
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.includes("TIMEOUT") && pid !== undefined) {
        await host.terminateProcess(pid, -1).catch(() => {});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        exitCode: -1,
        stdout: run.stdout,
        stderr: run.stderr,
        error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
      }));
    } finally {
      liveRuns.delete(run);
      const pids = runPids.get(run);
      if (pids) {
        for (const runPid of pids) {
          activeRuns.delete(runPid);
          pendingOutput.delete(runPid);
          pendingChildrenByParent.delete(runPid);
        }
        runPids.delete(run);
      } else if (pid !== undefined) {
        activeRuns.delete(pid);
        pendingOutput.delete(pid);
        pendingChildrenByParent.delete(pid);
      }
    }
  }

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    void runShell(req, res);
  });

  await new Promise<void>((resolveListen) => {
    server.listen(SERVER_PORT, SERVER_HOST, resolveListen);
  });
  console.error(`node js shell bridge listening on http://${SERVER_HOST}:${SERVER_PORT}/run`);

  const shutdown = async () => {
    server.close();
    await host.destroy().catch(() => {});
  };
  process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.on("SIGINT", () => { void shutdown().finally(() => process.exit(130)); });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
