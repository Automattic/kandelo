import type {
  BrowserKernel,
  BrowserKernelOptions,
} from "@host/browser-kernel-host";

import { MySqlBrowserClient, type MySqlResult } from "../../lib/mysql-client";
import { RedisBrowserClient, type RedisResult } from "../../lib/redis-client";
import {
  fetchProtectedCandidateVfs,
  fetchProtectedBrowserEvidenceAsset,
  candidateEvidenceKernelInitOptions,
  PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
  readInjectedProtectedBrowserEvidence,
  type InjectedProtectedCandidateVfsV1,
} from "../kandelo/kernel-host/candidate-evidence-vfs";
import { completedPtyCommand } from "./pty-command";

const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_CAPTURE_CHUNKS = 4_096;
const MAX_WORKERS = 24;

export interface ProductEvidenceProcessObservation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProductEvidenceBrowserAdapter {
  readonly ready: Promise<void>;
  exec(
    argv: string[],
    env?: Record<string, string>,
    stdin?: string,
  ): Promise<ProductEvidenceProcessObservation>;
  pty(input: string): Promise<ProductEvidenceProcessObservation>;
  startService(): Promise<void>;
  fetchHttp(path: string): Promise<{ status: number; body: string }>;
  verifyWordPressLogin(): Promise<{
    adminBody: string;
    adminStatus: number;
    authenticatedCookie: boolean;
    loginBody: string;
    loginStatus: number;
    redirectLocation: string;
    redirectStatus: number;
  }>;
  queryMySql(statement: string): Promise<MySqlResult>;
  queryRedis(...request: string[]): Promise<RedisResult>;
  observeFramebuffer(request: {
    programPath: string;
    argv: string[];
  }): Promise<{ nonzeroPixels: number }>;
  observeModeset(request: {
    programPath: string;
    argv: string[];
    width: number;
    height: number;
  }): Promise<{
    commitCount: number;
    nonzeroPixels: number;
    width: number;
    height: number;
  }>;
  destroy(): Promise<void>;
}

declare global {
  interface Window {
    __KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__?: ProductEvidenceBrowserAdapter;
  }
}

class BoundedBrowserOutput {
  private readonly decoder = new TextDecoder();
  private chunks = 0;
  private bytes = 0;
  private text = "";
  private overflow: Error | undefined;

  constructor(private readonly onOverflow?: (error: Error) => void) {}

  append(data: unknown): void {
    if (this.overflow !== undefined) return;
    if (!(data instanceof Uint8Array)) {
      this.overflow = new Error("candidate runtime emitted a malformed output chunk");
      this.onOverflow?.(this.overflow);
      return;
    }
    if (data.byteLength === 0) return;
    this.chunks += 1;
    if (
      this.chunks > MAX_CAPTURE_CHUNKS ||
      data.byteLength > MAX_CAPTURE_BYTES - this.bytes
    ) {
      this.overflow = new Error("candidate runtime output exceeded its protected bound");
      this.onOverflow?.(this.overflow);
      return;
    }
    this.bytes += data.byteLength;
    this.text += this.decoder.decode(data, { stream: true });
  }

  value(): string {
    if (this.overflow !== undefined) throw this.overflow;
    return this.text + this.decoder.decode();
  }
}

function checkedEvidence(): InjectedProtectedCandidateVfsV1 {
  const evidence = readInjectedProtectedBrowserEvidence(
    window.__KANDELO_ABI_STAGING_BROWSER_EVIDENCE__,
  );
  if (evidence === undefined) {
    throw new Error("protected browser evidence boot input is required");
  }
  if (!new Set([
    "doom",
    "generic-exec",
    "mariadb",
    "mariadb-suite",
    "modeset",
    "nginx",
    "nginx-php",
    "node",
    "php-suite",
    "redis",
    "shell",
    "sqlite-suite",
    "wordpress-mariadb",
    "wordpress-sqlite",
  ]).has(evidence.vfs.profile)) {
    throw new Error(
      `protected browser evidence profile has no generic adapter: ${evidence.vfs.profile}`,
    );
  }
  return evidence;
}

function bootEnvironment(evidence: InjectedProtectedCandidateVfsV1): string[] {
  return Object.entries(evidence.boot.env).map(([name, value]) => `${name}=${value}`);
}

function normalizeArgv(argv: string[]): string[] {
  if (
    !Array.isArray(argv) || argv.length < 1 || argv.length > 64 ||
    argv.some((value) =>
      typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      new TextEncoder().encode(value).byteLength > 4_096
    )
  ) {
    throw new Error("protected browser evidence argv is outside its bound");
  }
  if (!argv[0]!.startsWith("/")) {
    throw new Error("protected browser evidence executable is not absolute");
  }
  return argv.slice();
}

function mergeEnvironment(
  evidence: InjectedProtectedCandidateVfsV1,
  overrides: Record<string, string> | undefined,
): string[] {
  if (overrides === undefined) return bootEnvironment(evidence);
  const entries = Object.entries(overrides);
  if (entries.length > 64) {
    throw new Error("protected browser evidence environment is outside its bound");
  }
  const merged = { ...evidence.boot.env };
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== "string") {
      throw new Error("protected browser evidence environment is invalid");
    }
    if (new TextEncoder().encode(value).byteLength > 64 * 1024 || value.includes("\0")) {
      throw new Error("protected browser evidence environment value is outside its bound");
    }
    merged[name] = value;
  }
  return Object.entries(merged).map(([name, value]) => `${name}=${value}`);
}

async function waitForListener(
  kernel: BrowserKernel,
  port: number,
  timeoutMilliseconds = 30_000,
): Promise<void> {
  await waitForCondition(
    async () => await kernel.pickListenerTarget(port) !== null,
    `candidate service did not listen on port ${port}`,
    timeoutMilliseconds,
  );
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMessage: string,
  timeoutMilliseconds = 30_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error(timeoutMessage);
}

function servicePort(profile: string): number {
  if (profile === "redis") return 6379;
  if (profile === "mariadb" || profile === "mariadb-suite") return 3306;
  if (
    profile === "nginx" || profile === "nginx-php" ||
    profile === "wordpress-mariadb" || profile === "wordpress-sqlite"
  ) {
    return 80;
  }
  throw new Error(`protected browser profile has no manifest service: ${profile}`);
}

function boundedInput(value: unknown, label: string, maximum = MAX_CAPTURE_BYTES): string {
  if (
    typeof value !== "string" || value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new Error(`${label} is outside its protected bound`);
  }
  return value;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const selected = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return selected?.[1] ?? "";
}

function responseCookies(headers: Record<string, string>): string[] {
  const value = headerValue(headers, "set-cookie");
  if (value === "") return [];
  const cookies = value.split("\n").map((entry) => entry.split(";", 1)[0]!.trim());
  if (
    cookies.length > 32 ||
    cookies.some((cookie) => cookie.length === 0 || cookie.length > 4_096)
  ) {
    throw new Error("candidate WordPress cookies exceed their protected bound");
  }
  return cookies;
}

async function canvasNonzeroPixels(canvas: HTMLCanvasElement): Promise<number> {
  const sample = document.createElement("canvas");
  sample.width = 64;
  sample.height = 64;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("protected modeset pixel sampler is unavailable");
  const bitmap = await createImageBitmap(canvas);
  try {
    context.drawImage(bitmap, 0, 0, sample.width, sample.height);
  } finally {
    bitmap.close();
  }
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  let nonzero = 0;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset] !== 0 || pixels[offset + 1] !== 0 || pixels[offset + 2] !== 0) {
      nonzero += 1;
    }
  }
  return nonzero;
}

async function boundedLifecycle<T>(
  operation: Promise<T>,
  timeoutMilliseconds = 2_000,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("candidate browser cleanup exceeded its bound")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function createAdapter(): Promise<ProductEvidenceBrowserAdapter> {
  const evidence = checkedEvidence();
  const status = document.getElementById("status");
  let kernel!: BrowserKernel;
  let fatalError: Error | undefined;
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => {});
  const failRuntime = (error: Error): void => {
    if (fatalError !== undefined) return;
    fatalError = error;
    rejectFatal(error);
    if (kernel !== undefined) void kernel.destroy().catch(() => {});
  };
  const guarded = async <T>(operation: Promise<T>): Promise<T> => {
    if (fatalError !== undefined) throw fatalError;
    return await Promise.race([operation, fatal]);
  };
  const stdout = new BoundedBrowserOutput(failRuntime);
  const stderr = new BoundedBrowserOutput(failRuntime);
  let operationStdout: BoundedBrowserOutput | undefined;
  let operationStderr: BoundedBrowserOutput | undefined;
  let operationPid: number | undefined;
  let service: { pid: number; exit: Promise<number> } | undefined;
  let serviceStart: Promise<void> | undefined;
  let mysql: MySqlBrowserClient | undefined;
  let redis: RedisBrowserClient | undefined;
  const activePids = new Set<number>();
  let ptySession: {
    pid: number;
    output: BoundedBrowserOutput;
    offset: number;
    sequence: number;
  } | undefined;

  const exactHost = await import(
    /* @vite-ignore */ evidence.runtime.browserHost.url
  ) as { BrowserKernel?: new (options: BrowserKernelOptions) => BrowserKernel };
  if (typeof exactHost.BrowserKernel !== "function") {
    throw new Error("exact browser host entry does not export BrowserKernel");
  }
  kernel = new exactHost.BrowserKernel({
    kernelOwnedFs: true,
    maxWorkers: MAX_WORKERS,
    maxProcessMemoryBytes: PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
    onProcessStdout(pid, data) {
      stdout.append(data);
      if (pid === operationPid) operationStdout?.append(data);
    },
    onProcessStderr(pid, data) {
      stderr.append(data);
      if (pid === operationPid) operationStderr?.append(data);
    },
  });

  const [kernelBytes, vfsBytes] = await Promise.all([
    fetchProtectedBrowserEvidenceAsset(evidence.runtime.kernelAsset),
    fetchProtectedCandidateVfs(evidence.vfs),
  ]);

  await kernel.initFromImage(candidateEvidenceKernelInitOptions(
    evidence,
    kernelBytes,
    new Uint8Array(vfsBytes),
  ));
  if (status) status.textContent = "Exact candidate runtime ready.";

  const assertRuntimeOutput = (): void => {
    stdout.value();
    stderr.value();
  };

  const trackProcess = (process: { pid: number; exit: Promise<number> }) => {
    activePids.add(process.pid);
    void process.exit.then(
      () => activePids.delete(process.pid),
      () => activePids.delete(process.pid),
    );
    return process;
  };

  const spawnManifestBoot = async (pty = false) => {
    const argv = evidence.boot.argv.slice();
    const requested = argv[0]!;
    const candidates = requested.startsWith("/")
      ? [requested]
      : (evidence.boot.env.PATH ?? "").split(":").map((directory) => {
        if (!directory.startsWith("/") || directory.includes("\0")) {
          throw new Error("manifest boot PATH contains a non-absolute entry");
        }
        return `${directory === "/" ? "" : directory}/${requested}`;
      });
    if (candidates.length === 0) {
      throw new Error("manifest boot executable cannot be resolved from PATH");
    }
    for (const candidate of candidates) {
      const snapshot = await kernel.readFileSnapshotFromVfs(candidate);
      if (
        snapshot === null ||
        (snapshot.mode & 0o170000) !== 0o100000 ||
        (snapshot.mode & 0o111) === 0
      ) {
        continue;
      }
      return trackProcess(await kernel.spawnFromVfs(candidate, argv, {
        cwd: evidence.boot.cwd,
        uid: evidence.boot.uid,
        gid: evidence.boot.gid,
        env: bootEnvironment(evidence),
        pty,
        ...(pty ? { ptyCols: 120, ptyRows: 40 } : {}),
      }));
    }
    throw new Error("manifest boot executable is absent or not executable");
  };

  const terminate = async (pid: number): Promise<void> => {
    if (!activePids.has(pid)) return;
    try {
      await boundedLifecycle(kernel.terminateProcess(pid));
    } finally {
      activePids.delete(pid);
    }
  };

  const startService = async (): Promise<void> => {
    if (serviceStart !== undefined) return serviceStart;
    serviceStart = (async () => {
      service = await spawnManifestBoot();
      void service.exit.then((exitCode) => {
        if (exitCode !== 0) {
          console.error(`candidate service exited with status ${exitCode}`);
        }
      });
      await guarded(waitForListener(kernel, servicePort(evidence.vfs.profile)));
      assertRuntimeOutput();
    })();
    return serviceStart;
  };

  return {
    ready: Promise.resolve(),
    async exec(argv, env, stdin) {
      const checked = normalizeArgv(argv);
      operationStdout = new BoundedBrowserOutput(failRuntime);
      operationStderr = new BoundedBrowserOutput(failRuntime);
      try {
        const process = trackProcess(await kernel.spawnFromVfs(checked[0]!, checked, {
          cwd: evidence.boot.cwd,
          uid: evidence.boot.uid,
          gid: evidence.boot.gid,
          env: mergeEnvironment(evidence, env),
          ...(stdin === undefined
            ? {}
            : { stdin: new TextEncoder().encode(boundedInput(stdin, "exec stdin")) }),
        }));
        operationPid = process.pid;
        const exitCode = await guarded(process.exit);
        assertRuntimeOutput();
        return {
          exitCode,
          stdout: operationStdout.value(),
          stderr: operationStderr.value(),
        };
      } finally {
        operationPid = undefined;
        operationStdout = undefined;
        operationStderr = undefined;
      }
    },
    async pty(input) {
      const command = boundedInput(input, "PTY input", 4_096);
      if (ptySession === undefined) {
        const process = await spawnManifestBoot(true);
        const output = new BoundedBrowserOutput(failRuntime);
        kernel.onPtyOutput(process.pid, (data) => output.append(data));
        ptySession = { pid: process.pid, output, offset: 0, sequence: 0 };
      }
      const session = ptySession;
      const marker = `__KANDELO_EVIDENCE_STATUS_${++session.sequence}__`;
      const payload = `${command}\nprintf '\\n${marker}:%s\\n' "$?"\n`;
      kernel.ptyWrite(session.pid, new TextEncoder().encode(payload));
      await guarded(waitForCondition(
        () => completedPtyCommand(
          session.output.value(),
          session.offset,
          marker,
        ) !== undefined,
        "protected browser PTY command did not complete",
        60_000,
      ));
      const completed = completedPtyCommand(
        session.output.value(),
        session.offset,
        marker,
      );
      if (completed === undefined) {
        throw new Error("protected browser PTY status disappeared after completion");
      }
      session.offset = completed.nextOffset;
      assertRuntimeOutput();
      return { exitCode: completed.exitCode, stdout: completed.stdout, stderr: "" };
    },
    startService,
    async fetchHttp(path) {
      if (!path.startsWith("/") || path.includes("\0") || path.length > 4_096) {
        throw new Error("protected browser evidence HTTP path is invalid");
      }
      await startService();
      const response = await guarded(kernel.fetchInKernel(80, {
        method: "GET",
        url: path,
        headers: { Host: "localhost", Connection: "close" },
        body: null,
      }, { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024 }));
      assertRuntimeOutput();
      return {
        status: response.status,
        body: new TextDecoder().decode(response.body),
      };
    },
    async verifyWordPressLogin() {
      await startService();
      const request = async (
        method: string,
        path: string,
        headers: Record<string, string>,
        body: Uint8Array | null,
      ) => await guarded(kernel.fetchInKernel(80, {
        method,
        url: path,
        headers: { Host: "localhost", Connection: "close", ...headers },
        body,
      }, { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024 }));
      const login = await request("GET", "/wp-login.php", {}, null);
      const loginCookies = responseCookies(login.headers);
      if (!loginCookies.some((cookie) => cookie.startsWith("wordpress_test_cookie="))) {
        throw new Error("candidate WordPress login did not issue its test cookie");
      }
      const form = new URLSearchParams({
        log: "admin",
        pwd: "password",
        "wp-submit": "Log In",
        redirect_to: "/wp-admin/",
        testcookie: "1",
      }).toString();
      const redirect = await request("POST", "/wp-login.php", {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: loginCookies.join("; "),
      }, new TextEncoder().encode(form));
      const redirectCookies = responseCookies(redirect.headers);
      const allCookies = [...loginCookies, ...redirectCookies];
      const rawLocation = headerValue(redirect.headers, "location");
      if (rawLocation === "") {
        throw new Error("candidate WordPress login response lacks a redirect location");
      }
      const redirectUrl = new URL(rawLocation, "http://localhost");
      if (
        redirectUrl.origin !== "http://localhost" ||
        redirectUrl.username !== "" || redirectUrl.password !== "" ||
        redirectUrl.hash !== ""
      ) {
        throw new Error("candidate WordPress login redirects outside its in-kernel origin");
      }
      const location = `${redirectUrl.pathname}${redirectUrl.search}`;
      const admin = await request("GET", "/wp-admin/", {
        Cookie: allCookies.join("; "),
      }, null);
      assertRuntimeOutput();
      return {
        adminBody: new TextDecoder().decode(admin.body),
        adminStatus: admin.status,
        authenticatedCookie: allCookies.some((cookie) =>
          /^(?:wordpress_logged_in_|wordpress_sec_)/u.test(cookie)
        ),
        loginBody: new TextDecoder().decode(login.body),
        loginStatus: login.status,
        redirectLocation: location,
        redirectStatus: redirect.status,
      };
    },
    async queryMySql(statement) {
      await startService();
      mysql ??= await MySqlBrowserClient.connect(kernel, 3306);
      const result = await guarded(mysql.query(statement));
      assertRuntimeOutput();
      return result;
    },
    async queryRedis(...request) {
      await startService();
      redis ??= await RedisBrowserClient.connect(kernel, 6379);
      const result = await guarded(redis.command(...request));
      assertRuntimeOutput();
      return result;
    },
    async observeFramebuffer(request) {
      const argv = normalizeArgv(request.argv);
      if (request.programPath !== argv[0]) {
        throw new Error("protected framebuffer program differs from argv");
      }
      const process = trackProcess(await kernel.spawnFromVfs(
        request.programPath,
        argv,
        {
          cwd: evidence.boot.cwd,
          uid: evidence.boot.uid,
          gid: evidence.boot.gid,
          env: bootEnvironment(evidence),
        },
      ));
      let exitCode: number | undefined;
      void process.exit.then((code) => { exitCode = code; });
      try {
        let nonzeroPixels = 0;
        await guarded(waitForCondition(() => {
          if (exitCode !== undefined) {
            throw new Error(`candidate framebuffer process exited with status ${exitCode}`);
          }
          const binding = kernel.framebuffers.get(process.pid);
          if (binding === undefined) return false;
          if (
            binding.addr !== 0 || binding.len !== 0 ||
            binding.fmt !== "BGRA32" || binding.w !== 640 || binding.h !== 400 ||
            binding.stride !== 2_560 || binding.hostBuffer === null
          ) {
            throw new Error("candidate framebuffer binding differs from fbDOOM contract");
          }
          nonzeroPixels = 0;
          for (let offset = 0; offset + 3 < binding.hostBuffer.length; offset += 4) {
            if (
              binding.hostBuffer[offset] !== 0 ||
              binding.hostBuffer[offset + 1] !== 0 ||
              binding.hostBuffer[offset + 2] !== 0
            ) {
              nonzeroPixels += 1;
            }
          }
          return nonzeroPixels > 0;
        }, "candidate fbDOOM framebuffer remained empty", 180_000));
        assertRuntimeOutput();
        return { nonzeroPixels };
      } finally {
        await terminate(process.pid);
      }
    },
    async observeModeset(request) {
      const argv = normalizeArgv(request.argv);
      if (
        request.programPath !== argv[0] || request.width !== 1920 ||
        request.height !== 1080
      ) {
        throw new Error("protected modeset request differs from its display contract");
      }
      const canvas = document.createElement("canvas");
      canvas.width = request.width;
      canvas.height = request.height;
      canvas.style.width = "640px";
      canvas.style.height = "360px";
      canvas.setAttribute("aria-label", "protected modeset scanout");
      document.body.append(canvas);
      const offscreen = canvas.transferControlToOffscreen();
      const statsBuffer = new SharedArrayBuffer(64);
      const stats = new Int32Array(statsBuffer);
      kernel.kmsAttachCanvas(1, offscreen, statsBuffer, { mode: "webgl2" });
      const process = trackProcess(await kernel.spawnFromVfs(
        request.programPath,
        argv,
        {
          cwd: evidence.boot.cwd,
          uid: evidence.boot.uid,
          gid: evidence.boot.gid,
          env: bootEnvironment(evidence),
        },
      ));
      let exitCode: number | undefined;
      void process.exit.then((code) => { exitCode = code; });
      try {
        await guarded(waitForCondition(() => {
          if (exitCode !== undefined) {
            throw new Error(`candidate modeset process exited with status ${exitCode}`);
          }
          return Atomics.load(stats, 2) === request.width &&
            Atomics.load(stats, 3) === request.height &&
            Atomics.load(stats, 5) > 0 && Atomics.load(stats, 6) > 0;
        }, "candidate modeset process did not commit a scanout", 180_000));
        let nonzeroPixels = 0;
        await guarded(waitForCondition(async () => {
          nonzeroPixels = await canvasNonzeroPixels(canvas);
          return nonzeroPixels > 0;
        }, "candidate modeset scanout rendered no visible pixels", 180_000));
        assertRuntimeOutput();
        return {
          commitCount: Atomics.load(stats, 5),
          nonzeroPixels,
          width: Atomics.load(stats, 2),
          height: Atomics.load(stats, 3),
        };
      } finally {
        canvas.remove();
        await terminate(process.pid);
      }
    },
    async destroy() {
      mysql?.close();
      if (ptySession !== undefined) kernel.clearPtyOutput(ptySession.pid);
      for (const pid of [...activePids]) {
        try {
          await terminate(pid);
        } catch (error) {
          console.warn(String(error));
        }
      }
      await kernel.destroy();
    },
  };
}

let resolveAdapter!: (adapter: ProductEvidenceBrowserAdapter) => void;
let rejectAdapter!: (error: unknown) => void;
const ready = new Promise<ProductEvidenceBrowserAdapter>((resolve, reject) => {
  resolveAdapter = resolve;
  rejectAdapter = reject;
});
const protectedFacade = Object.freeze<ProductEvidenceBrowserAdapter>({
  ready: ready.then(() => undefined),
  exec: async (...args) => (await ready).exec(...args),
  pty: async (...args) => (await ready).pty(...args),
  startService: async () => (await ready).startService(),
  fetchHttp: async (...args) => (await ready).fetchHttp(...args),
  verifyWordPressLogin: async () => (await ready).verifyWordPressLogin(),
  queryMySql: async (...args) => (await ready).queryMySql(...args),
  queryRedis: async (...args) => (await ready).queryRedis(...args),
  observeFramebuffer: async (...args) => (await ready).observeFramebuffer(...args),
  observeModeset: async (...args) => (await ready).observeModeset(...args),
  destroy: async () => (await ready).destroy(),
});
Object.defineProperty(window, "__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__", {
  configurable: false,
  enumerable: false,
  value: protectedFacade,
  writable: false,
});
void createAdapter().then(resolveAdapter, rejectAdapter);

ready.catch((error) => {
  const status = document.getElementById("status");
  if (status) status.textContent = `Exact candidate runtime failed: ${String(error)}`;
  console.error(error);
});
