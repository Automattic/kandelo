import { readFileSync } from "node:fs";
import { entryRoutesThrough } from "./lifecycle-routes";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  initializeBrowserCorsProxyForWorker,
} from "../src/browser-kernel-protocol";
import type {
  BrowserCorsProxyConfig,
} from "../src/networking/browser-cors-proxy";
import {
  createBrowserLazyFetcher,
} from "../src/vfs/browser-lazy-fetcher";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const entries = [
  ["Node", join(repoRoot, "host/src/node-kernel-worker-entry.ts")],
  ["browser", join(repoRoot, "host/src/browser-kernel-worker-entry.ts")],
] as const;
const processWorkerSource = readFileSync(
  join(repoRoot, "host/src/worker-main.ts"),
  "utf8",
);
/**
 * The fork half of every process and pthread Worker, written once
 * (`ForkWorker`, lane F step 3). It reports nothing about a fork any more.
 */
const forkWorkerSource = readFileSync(
  join(repoRoot, "host/src/worker-main-fork-support.ts"),
  "utf8",
);
/** The fork module, which reports every fork's outcome (lane F step 3c). */
const forkModuleSource = readFileSync(
  join(repoRoot, "crates/fork-module/src/lib.rs"),
  "utf8",
);
/** The kernel's formatting of those reports, the one copy of the words. */
const kernelDiagnosticSource = readFileSync(
  join(repoRoot, "crates/runtime-core/src/fork_diagnostic.rs"),
  "utf8",
);
const kernelWorkerSource = readFileSync(
  join(repoRoot, "host/src/kernel-worker.ts"),
  "utf8",
);
const nativeGuestSource = readFileSync(
  join(repoRoot, "crates/host-native/src/guest.rs"),
  "utf8",
);
/** The single implementation both entries call for shared lifecycle logic. */
const sharedLifecycleSource = readFileSync(
  join(repoRoot, "host/src/process-lifecycle.ts"),
  "utf8",
);

describe.each(entries)("%s kernel-worker diagnostic routing", (_name, path) => {
  const source = readFileSync(path, "utf8");

  it("reserves stderr protocol messages for the kernel's real onStderr bytes", () => {
    const stderrPosts = source.match(/type:\s*"stderr"/g) ?? [];
    expect(stderrPosts).toHaveLength(1);
    expect(source).toMatch(/onStderr:[\s\S]{0,160}type:\s*"stderr"/);
  });

  it("routes lifecycle, protocol, exec, clone, and thread failures as host diagnostics", () => {
    // The subject is that each failure class reaches main as a host
    // diagnostic, not which file raises it. `worker protocol` is now raised
    // once in `host/src/process-lifecycle.ts` on behalf of both entries, so
    // it is asserted there — and the entry must still bind the reporter, so
    // deleting the wire keeps failing this test.
    expect(source).toContain('source: "worker-main error message"');
    // `clone allocation` and `thread worker failure` join `worker protocol`
    // in `host/src/process-lifecycle.ts`: `handleClone` is now one
    // implementation serving both hosts, so each is raised once. That is
    // stronger than asserting it twice — a clone failure can no longer be
    // reported on one host and swallowed on the other — and the entry must
    // still bind the reporter and the handler, so deleting either wire keeps
    // failing this test.
    // `exec post-commit transition` joined them when `handleExec` became one
    // implementation: an exec that fails after the commit point can no longer
    // be reported on one host and swallowed on the other.
    for (const diagnosticSource of [
      "worker protocol",
      "clone allocation",
      "thread worker failure",
      "exec post-commit transition",
    ]) {
      expect(sharedLifecycleSource).toContain(`source: "${diagnosticSource}"`);
    }
    expect(entryRoutesThrough(source, "handleClone"), "entry routes clones").toBe(true);
    expect(entryRoutesThrough(source, "handleExec"), "entry routes execs").toBe(true);
    // Through the shared reporter, or raised in place with the same source.
    expect(
      entryRoutesThrough(source, "reportWorkerProtocolError")
        || source.includes('source: "worker protocol"'),
      "entry reports protocol failures as host diagnostics",
    ).toBe(true);
    expect(source).toContain("reportHostDiagnostic");
  });

  it("does not classify an ordinary nonzero process exit as a host failure", () => {
    expect(source).not.toContain("nonzero process exit");
    expect(source).not.toContain("reportedNonzeroProcessExits");
    expect(source).not.toContain("-> forcing exit");
  });

  it("wires a poisoned shared kernel instance to definitive worker teardown", () => {
    // The teardown itself is one implementation in
    // `host/src/process-lifecycle.ts` now, so it is asserted there. What each
    // entry still owes is the wire into the kernel and the one irreducibly
    // host-specific step: stopping its own worker realm once the kernel can no
    // longer coordinate anything.
    expect(sharedLifecycleSource).toMatch(
      /\bfunction\s+terminatePoisonedKernelWorker\s*\(\s*error:\s*Error\s*\)/,
    );
    expect(sharedLifecycleSource).toMatch(
      /post\(\{\s*type:\s*"kernel_fatal",\s*error:\s*detail\s*\}\)/,
    );
    expect(sharedLifecycleSource).toContain("host.stopKernelRealm()");
    // The kernel callback record is shared now, so the wire is asserted
    // there; the entry must still take that record.
    expect(sharedLifecycleSource).toMatch(
      /\bonKernelFatal:\s*terminatePoisonedKernelWorker\b/,
    );
    expect(source).toContain("...processLifecycleKernelCallbacks(),");
    expect(
      entryRoutesThrough(source, "terminatePoisonedKernelWorker"),
      "entry routes a fatal kernel to the shared teardown",
    ).toBe(true);
    expect(source).toMatch(/\bstopKernelRealm:\s*\(\)\s*=>/);
  });
});

it("does not log an ordinary process exit from the process worker", () => {
  expect(processWorkerSource).not.toContain("_start() returned, exitCode=");
});

it("binds one validated worker-owned proxy config to networking and lazy VFS", async () => {
  const fetchImpl = vi.fn(async () => new Response("artifact"));
  let lazyConfig: BrowserCorsProxyConfig | undefined;
  type CapturedTlsOptions = {
    corsProxy?: BrowserCorsProxyConfig;
    onCorsProxyDiagnostic?: (message: string) => void;
  };
  let tlsOptions: CapturedTlsOptions | undefined;
  const reports: Array<{
    diagnostic: { pid: number; source: string; message: string };
    level: "warn";
  }> = [];
  const sourceAllowedNames = ["Accept", "content-type", "Accept"];
  const sourceConfig = {
    url: "https://proxy.example/?",
    allowedRequestHeaderNames: sourceAllowedNames,
    allowAnonymousGetHeaderOmission: true,
  };

  const bindings = initializeBrowserCorsProxyForWorker(sourceConfig, {
    useLazyFetcher: true,
    createLazyFetcher: (config: BrowserCorsProxyConfig) => {
      lazyConfig = config;
      return createBrowserLazyFetcher(config, {
        fetchImpl,
        runtimeUrl: "https://demo.example/worker.js",
      });
    },
    createTlsBackend: (options: CapturedTlsOptions) => {
      tlsOptions = options;
      return { kind: "tls backend" };
    },
    reportHostDiagnostic: (
      diagnostic: { pid: number; source: string; message: string },
      level: "warn",
    ) => reports.push({ diagnostic, level }),
  });
  sourceConfig.url = "https://mutated.example/?";
  sourceAllowedNames.splice(0, sourceAllowedNames.length, "x-mutated");

  const workerCorsProxy = bindings.corsProxy!;
  expect(workerCorsProxy).toEqual({
    url: "https://proxy.example/?",
    allowedRequestHeaderNames: ["Accept", "content-type", "Accept"],
    allowAnonymousGetHeaderOmission: true,
  });
  expect(Object.isFrozen(workerCorsProxy)).toBe(true);
  expect(Object.isFrozen(workerCorsProxy.allowedRequestHeaderNames)).toBe(
    true,
  );
  expect(lazyConfig).toBe(workerCorsProxy);
  expect(tlsOptions?.corsProxy).toBe(workerCorsProxy);

  await bindings.lazyFetcher!("https://releases.example/artifact.tar.gz");
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://proxy.example/?https://releases.example/artifact.tar.gz",
    {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  );

  tlsOptions?.onCorsProxyDiagnostic?.("omitted x-unsupported");
  expect(reports).toEqual([{
    diagnostic: {
      pid: 0,
      source: "browser CORS proxy",
      message: "omitted x-unsupported",
    },
    level: "warn",
  }]);
});

it("rejects malformed worker-side proxy data before binding consumers", () => {
  const createLazyFetcher = vi.fn();
  const createTlsBackend = vi.fn();

  expect(() => initializeBrowserCorsProxyForWorker({
    url: "file:///tmp/not-a-proxy",
    allowedRequestHeaderNames: ["accept"],
    allowAnonymousGetHeaderOmission: true,
  }, {
    useLazyFetcher: true,
    createLazyFetcher,
    createTlsBackend,
    reportHostDiagnostic: vi.fn(),
  })).toThrow("browser CORS proxy URL must be an HTTP(S) URL");
  expect(createLazyFetcher).not.toHaveBeenCalled();
  expect(createTlsBackend).not.toHaveBeenCalled();
});

describe("an aborted fork says why", () => {
  // WHY THIS EXISTS. A fork that aborts leaves the parent intact and returns
  // `-errno` to the guest, which is correct -- and until 2026-09-15 it said
  // nothing to anyone. A guest that does not check `fork()`'s return then
  // fails somewhere else entirely, and the reason is gone: three separate
  // defects wore that disguise in a single day, each costing an afternoon of
  // probes compiled into the worker (census section 189).
  //
  // The invariant is EVERY abort path reports, not that some do. Every abort
  // -- a frame reserve that failed mid-unwind, a seal that failed, a child the
  // kernel refused -- is begun or recorded by the fork MODULE, and since lane
  // F step 3c (ruling 5) the module also REPORTS it, at the one abort finish,
  // through the kernel (`SYS_FORK_DIAGNOSTIC`). The kernel formats the words
  // once and every host logs them as they are; no Worker posts a report of
  // its own, so none can forget to, or say it differently.
  it("is reported by the module at the one abort finish, from its own record", () => {
    const finish = forkModuleSource.slice(
      forkModuleSource.indexOf('pub extern "C" fn fm_parent_finish('),
    );
    const body = finish.slice(0, finish.indexOf("\n    }\n"));
    expect(body, "the finish reports its abort record").toContain(
      "report_finish(Some(report), false)",
    );
    expect(forkModuleSource).toContain("diagnostic_wire::KIND_ABORTED");
    // No Worker reports on its own any more.
    for (const source of [forkWorkerSource, processWorkerSource, sharedLifecycleSource]) {
      expect(source).not.toContain("fork_aborted");
      expect(source).not.toContain("fork_module_frames\"");
    }
  });

  it("names the errno and a reason a reader can act on, in the kernel's words", () => {
    expect(kernelDiagnosticSource).toContain('"fork aborted with errno={}: {}"');
    // Each cause in words rather than a code. A capture that meets a
    // reference it cannot carry (a raw host externref) is refused inside the
    // fork module and arrives as "the capture could not seal" (EOPNOTSUPP).
    expect(kernelDiagnosticSource).toContain("the capture could not seal");
    expect(kernelDiagnosticSource).toContain("could not be reserved mid-unwind");
    expect(kernelDiagnosticSource).toContain(
      "the kernel refused to create the child process",
    );
  });

  it("reaches every host as a WARNING, because an abort can be correct", () => {
    // An abort is the right outcome for a reference kind the platform refuses
    // to reconstruct, so this must not read as a fault on the error channel.
    const route = sharedLifecycleSource.slice(
      sharedLifecycleSource.indexOf("onForkDiagnostic:"),
    ).slice(0, 700);
    expect(route).toContain("kind === FORK_DIAGNOSTIC_KINDS.aborted");
    expect(route).toContain(
      'reportHostDiagnostic({ pid, source: "fork", message: text }, "warn")',
    );
    // The kernel worker drains the kernel's queue on the fork-lifecycle wake,
    // for a process Worker and a pthread Worker alike (the channel names the
    // process; there is no per-Worker forwarding left to forget).
    expect(kernelWorkerSource).toContain('"kernel_drain_fork_diagnostics"');
    expect(kernelWorkerSource).toContain("this.callbacks.onForkDiagnostic?.(");
    // host-native prints the same line and counts the cause.
    expect(nativeGuestSource).toContain('"kernel_drain_fork_diagnostics"');
    expect(nativeGuestSource).toContain("fn report_fork_diagnostics(");
  });
});
