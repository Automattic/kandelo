import { CAPTURED_STDIO, CentralizedKernelWorker } from "@host/kernel-worker";
import { installBrowserSetImmediatePolyfill } from "@host/browser-immediate-polyfill";
import { BrowserWorkerAdapter } from "@host/worker-adapter-browser";
import { detectPtrWidth, extractHeapBase } from "@host/constants";
import { LocalVirtualNetwork } from "@host/networking/virtual-network";
import { DeviceFileSystem } from "@host/vfs/device-fs";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { BrowserTimeProvider } from "@host/vfs/time";
import { DEFAULT_MOUNT_SPEC, resolveForBrowser } from "@host/vfs/default-mounts";
import { VirtualPlatformIO } from "@host/vfs/vfs";
import type { PlatformIO } from "@host/types";
import type { CentralizedWorkerInitMessage, WorkerToHostMessage } from "@host/worker-protocol";
import type { WorkerHandle } from "@host/worker-adapter";
import kernelWasmUrl from "@kernel-wasm?url";
import rootfsVfsUrl from "@rootfs-vfs?url";
import workerEntryUrl from "@host/worker-entry-browser.ts?worker&url";
import ncWasmUrl from "@binaries/programs/wasm32/nc.wasm?url";
import curlWasmUrl from "@binaries/programs/wasm32/curl.wasm?url";

installBrowserSetImmediatePolyfill();

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 72 + 65536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MachineId = "alpha" | "beta" | "gamma";
type StepId = "udp" | "tcp" | "curl";

interface ArtifactSet {
  kernel: ArrayBuffer;
  rootfs: Uint8Array;
  nc: ArrayBuffer;
  curl: ArrayBuffer;
}

interface RunOptions {
  machine: MachineId;
  address: [number, number, number, number];
  programName: string;
  programBytes: ArrayBuffer;
  argv: string[];
  stdin?: string;
  timeoutMs?: number;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let artifactsPromise: Promise<ArtifactSet> | null = null;
let running = false;

function post(data: unknown): void {
  self.postMessage(data);
}

function machine(machine: MachineId, status: string): void {
  post({ type: "machine", machine, status });
}

function step(stepId: StepId, status: "running" | "passed" | "failed"): void {
  post({ type: "step", step: stepId, status });
}

function log(machineId: string, stream: "stdout" | "stderr" | "stdin" | "system", text: string): void {
  if (text.length === 0) return;
  post({ type: "log", machine: machineId, stream, text });
}

function result(stepId: StepId, title: string, ok: boolean, detail: string): void {
  post({ type: "result", step: stepId, title, ok, detail });
}

async function loadArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status}`);
  return response.arrayBuffer();
}

async function loadArtifacts(): Promise<ArtifactSet> {
  if (!artifactsPromise) {
    artifactsPromise = Promise.all([
      loadArrayBuffer(kernelWasmUrl),
      loadArrayBuffer(rootfsVfsUrl),
      loadArrayBuffer(ncWasmUrl),
      loadArrayBuffer(curlWasmUrl),
    ]).then(([kernel, rootfs, nc, curl]) => ({
      kernel,
      rootfs: new Uint8Array(rootfs),
      nc,
      curl,
    }));
  }
  return artifactsPromise;
}

function createProcessMemory(ptrWidth: 4 | 8, initialPages = 17): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(initialPages) as unknown as number,
      maximum: BigInt(MAX_PAGES) as unknown as number,
      shared: true,
      address: "i64",
    } as WebAssembly.MemoryDescriptor);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: MAX_PAGES,
    shared: true,
  });
}

function growToMax(memory: WebAssembly.Memory, ptrWidth: 4 | 8, currentPages: number): void {
  const pages = MAX_PAGES - currentPages;
  if (pages <= 0) return;
  if (ptrWidth === 8) {
    memory.grow(BigInt(pages) as unknown as number);
  } else {
    memory.grow(pages);
  }
}

function createMachineIO(
  network: LocalVirtualNetwork,
  rootfs: Uint8Array,
  machineId: MachineId,
  address: [number, number, number, number],
): PlatformIO {
  const mounts = [
    {
      mountPoint: "/dev/shm",
      backend: MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024)),
    },
    { mountPoint: "/dev", backend: new DeviceFileSystem() },
    ...resolveForBrowser(DEFAULT_MOUNT_SPEC, rootfs),
  ];
  const io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());
  io.network = network.attachMachine({ id: machineId, address, hostnames: [machineId] });
  return io;
}

async function runProgram(
  network: LocalVirtualNetwork,
  artifacts: ArtifactSet,
  options: RunOptions,
): Promise<RunResult> {
  const workers = new Map<number, WorkerHandle>();
  const ptrWidth = detectPtrWidth(options.programBytes);
  const pid = 100;
  let stdout = "";
  let stderr = "";
  let settled = false;

  machine(options.machine, `running ${options.programName}`);

  const io = createMachineIO(network, artifacts.rootfs, options.machine, options.address);
  const workerAdapter = new BrowserWorkerAdapter(workerEntryUrl);

  let resolveExit!: (status: number) => void;
  let rejectExit!: (error: Error) => void;
  const exitPromise = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const kernelWorker = new CentralizedKernelWorker(
    {
      maxWorkers: 4,
      dataBufferSize: 65536,
      useSharedMemory: true,
    },
    io,
    {
      onExit: (exitPid, exitStatus) => {
        if (settled) return;
        if (exitPid !== pid) return;
        settled = true;
        kernelWorker.unregisterProcess(exitPid);
        workers.get(exitPid)?.terminate().catch(() => {});
        workers.delete(exitPid);
        resolveExit(exitStatus);
      },
      onExitGroup: (exitPid) => {
        const worker = workers.get(exitPid);
        worker?.terminate().catch(() => {});
        workers.delete(exitPid);
      },
    },
  );
  kernelWorker.usePolling = false;
  (kernelWorker as CentralizedKernelWorker & { relistenBatchSize: number }).relistenBatchSize = 8;
  kernelWorker.setOutputCallbacks({
    onStdout: (data) => {
      const text = decoder.decode(data);
      stdout += text;
      log(options.machine, "stdout", text);
    },
    onStderr: (data) => {
      const text = decoder.decode(data);
      stderr += text;
      log(options.machine, "stderr", text);
    },
  });

  await kernelWorker.init(artifacts.kernel);

  const memory = createProcessMemory(ptrWidth);
  const channelOffset = (MAX_PAGES - 2) * 65536;
  growToMax(memory, ptrWidth, 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(pid, memory, [channelOffset], {
    argv: options.argv,
    ptrWidth,
    stdio: CAPTURED_STDIO,
  });
  const initialHeapBase = extractHeapBase(options.programBytes);
  if (initialHeapBase !== null) kernelWorker.setBrkBase(pid, initialHeapBase);
  if (options.stdin !== undefined) {
    kernelWorker.setStdinData(pid, encoder.encode(options.stdin));
  }

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes: options.programBytes,
    memory,
    channelOffset,
    argv: options.argv,
    ptrWidth,
  };
  const mainWorker = workerAdapter.createWorker(initData);
  workers.set(pid, mainWorker);

  const timeout = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    for (const worker of workers.values()) worker.terminate().catch(() => {});
    workers.clear();
    rejectExit(new Error(`${options.machine} ${options.programName} timed out after ${timeout}ms`));
  }, timeout);

  mainWorker.on("error", (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectExit(error);
  });
  mainWorker.on("message", (message: unknown) => {
    const m = message as WorkerToHostMessage;
    if (m.type === "error" && m.pid === pid && !settled) {
      settled = true;
      clearTimeout(timer);
      rejectExit(new Error(m.message));
    }
  });

  try {
    const exitCode = await exitPromise;
    clearTimeout(timer);
    machine(options.machine, exitCode === 0 ? "passed" : `failed ${exitCode}`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    for (const worker of workers.values()) worker.terminate().catch(() => {});
    workers.clear();
    network.detachMachine(options.machine);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandLine(argv: string[]): string {
  return argv.map((part) => part.includes(" ") ? JSON.stringify(part) : part).join(" ");
}

async function runUdp(network: LocalVirtualNetwork, artifacts: ArtifactSet): Promise<boolean> {
  step("udp", "running");
  const port = 24126;
  const serverArgv = ["nc", "-n", "-c", "-u", "-l", "-p", String(port), "-w", "3"];
  const clientArgv = ["nc", "-n", "-u", "-c", "10.88.0.2", String(port)];
  log("runner", "system", `UDP alpha: ${commandLine(serverArgv)}\nUDP beta: ${commandLine(clientArgv)}`);
  log("beta", "stdin", "hello from beta over udp\n");
  const server = runProgram(network, artifacts, {
    machine: "alpha",
    address: [10, 88, 0, 2],
    programName: "nc udp listen",
    programBytes: artifacts.nc,
    argv: serverArgv,
    stdin: "",
  });
  await wait(100);
  const client = runProgram(network, artifacts, {
    machine: "beta",
    address: [10, 88, 0, 3],
    programName: "nc udp send",
    programBytes: artifacts.nc,
    argv: clientArgv,
    stdin: "hello from beta over udp\n",
  });
  const [serverResult, clientResult] = await Promise.all([server, client]);
  const ok = serverResult.exitCode === 0 &&
    clientResult.exitCode === 0 &&
    serverResult.stdout.includes("hello from beta over udp");
  step("udp", ok ? "passed" : "failed");
  result("udp", "UDP datagram", ok, ok
    ? "alpha received beta's datagram through POSIX recv/read on a UDP socket."
    : `server=${serverResult.exitCode}, client=${clientResult.exitCode}`);
  return ok;
}

async function runTcp(network: LocalVirtualNetwork, artifacts: ArtifactSet): Promise<boolean> {
  step("tcp", "running");
  const port = 24125;
  const serverArgv = ["nc", "-n", "-l", "-p", String(port), "-w", "3"];
  const clientArgv = ["nc", "-n", "-c", "10.88.0.2", String(port)];
  log("runner", "system", `TCP alpha: ${commandLine(serverArgv)}\nTCP beta: ${commandLine(clientArgv)}`);
  log("beta", "stdin", "hello from beta over tcp\n");
  const server = runProgram(network, artifacts, {
    machine: "alpha",
    address: [10, 88, 0, 2],
    programName: "nc tcp listen",
    programBytes: artifacts.nc,
    argv: serverArgv,
    stdin: "",
  });
  await wait(100);
  const client = runProgram(network, artifacts, {
    machine: "beta",
    address: [10, 88, 0, 3],
    programName: "nc tcp send",
    programBytes: artifacts.nc,
    argv: clientArgv,
    stdin: "hello from beta over tcp\n",
  });
  const [serverResult, clientResult] = await Promise.all([server, client]);
  const ok = serverResult.exitCode === 0 &&
    clientResult.exitCode === 0 &&
    serverResult.stdout.includes("hello from beta over tcp");
  step("tcp", ok ? "passed" : "failed");
  result("tcp", "TCP stream", ok, ok
    ? "alpha accepted beta's TCP connection and received stream data."
    : `server=${serverResult.exitCode}, client=${clientResult.exitCode}`);
  return ok;
}

async function runCurl(network: LocalVirtualNetwork, artifacts: ArtifactSet): Promise<boolean> {
  step("curl", "running");
  const port = 18080;
  const body = "hello from alpha via curl\n";
  const response = [
    "HTTP/1.0 200 OK",
    "Content-Type: text/plain",
    `Content-Length: ${encoder.encode(body).length}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
  const serverArgv = ["nc", "-n", "-l", "-p", String(port), "-w", "5"];
  const clientArgv = ["curl", "-sS", "--max-time", "4", `http://10.88.0.2:${port}/`];
  log("runner", "system", `HTTP alpha: ${commandLine(serverArgv)}\nHTTP gamma: ${commandLine(clientArgv)}`);
  log("runner", "system", `HTTP alpha stdin: generated ${encoder.encode(response).length} byte response\n`);
  log("alpha", "stdin", `${response.replaceAll("\r\n", "\n")}`);
  const server = runProgram(network, artifacts, {
    machine: "alpha",
    address: [10, 88, 0, 2],
    programName: "nc http listen",
    programBytes: artifacts.nc,
    argv: serverArgv,
    stdin: response,
    timeoutMs: 20_000,
  });
  await wait(100);
  const client = runProgram(network, artifacts, {
    machine: "gamma",
    address: [10, 88, 0, 4],
    programName: "curl",
    programBytes: artifacts.curl,
    argv: clientArgv,
    timeoutMs: 20_000,
  });
  const [serverResult, clientResult] = await Promise.all([server, client]);
  const ok = serverResult.exitCode === 0 &&
    clientResult.exitCode === 0 &&
    clientResult.stdout.includes(body);
  step("curl", ok ? "passed" : "failed");
  result("curl", "curl over TCP", ok, ok
    ? "gamma fetched alpha's HTTP response through curl over the virtual TCP backend."
    : `server=${serverResult.exitCode}, curl=${clientResult.exitCode}`);
  return ok;
}

async function runAll(): Promise<void> {
  if (running) return;
  running = true;
  post({ type: "status", status: "loading artifacts" });
  try {
    const artifacts = await loadArtifacts();
    post({ type: "status", status: "running" });
    const network = new LocalVirtualNetwork();
    log("runner", "system", "Virtual addresses: alpha=10.88.0.2 beta=10.88.0.3 gamma=10.88.0.4\n");
    const outcomes = [
      await runUdp(network, artifacts),
      await runTcp(network, artifacts),
      await runCurl(network, artifacts),
    ];
    post({ type: "done", ok: outcomes.every(Boolean) });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}

self.onmessage = (event: MessageEvent<{ type: string }>) => {
  if (event.data.type === "run") {
    void runAll();
  }
};

post({ type: "ready" });
