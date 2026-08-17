import { readFileSync } from "node:fs";
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

describe.each(entries)("%s kernel-worker diagnostic routing", (_name, path) => {
  const source = readFileSync(path, "utf8");

  it("reserves stderr protocol messages for the kernel's real onStderr bytes", () => {
    const stderrPosts = source.match(/type:\s*"stderr"/g) ?? [];
    expect(stderrPosts).toHaveLength(1);
    expect(source).toMatch(/onStderr:[\s\S]{0,160}type:\s*"stderr"/);
  });

  it("routes lifecycle, protocol, exec, clone, and thread failures as host diagnostics", () => {
    for (const diagnosticSource of [
      "worker protocol",
      "worker-main error message",
      "exec post-commit transition",
      "clone allocation",
      "thread worker failure",
    ]) {
      expect(source).toContain(`source: "${diagnosticSource}"`);
    }
    expect(source).toContain("reportHostDiagnostic({");
  });

  it("does not classify an ordinary nonzero process exit as a host failure", () => {
    expect(source).not.toContain("nonzero process exit");
    expect(source).not.toContain("reportedNonzeroProcessExits");
    expect(source).not.toContain("-> forcing exit");
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
