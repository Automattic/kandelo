/** Read-only diagnostics using released Caddy/FrankenPHP APIs. */
export function caddyMemoryDiagnosticsConfig(config: string): string {
  const disabledAdmin = /^[\t ]*admin off[\t ]*$/gm;
  if ([...config.matchAll(disabledAdmin)].length !== 1) {
    throw new Error("Expected one disabled admin listener in the test Caddyfile");
  }
  return config.replace(disabledAdmin, "  admin 127.0.0.1:2019\n  metrics");
}

interface HttpHost {
  fetchInKernel(port: number, request: {
    method: string; url: string; headers: Record<string, string>; body: null;
  }, options: { timeoutMs: number }): Promise<{ status: number; body: Uint8Array }>;
}

const metricNames = [
  "go_memstats_heap_alloc_bytes",
  "go_memstats_heap_sys_bytes",
  "go_memstats_heap_idle_bytes",
  "go_memstats_heap_released_bytes",
  "go_memstats_sys_bytes",
  "go_goroutines",
  "go_threads",
  "frankenphp_total_threads",
] as const;

export async function readCaddyMemoryMetrics(host: HttpHost) {
  const startedAt = new Date().toISOString();
  const decoder = new TextDecoder();
  const request = async (url: string) => {
    const response = await host.fetchInKernel(2019, {
      method: "GET", url, headers: { Host: "127.0.0.1:2019" }, body: null,
    }, { timeoutMs: 30_000 });
    if (response.status !== 200) throw new Error(`Caddy ${url}: HTTP ${response.status}`);
    return decoder.decode(response.body);
  };
  const [prometheus, threadJson] = await Promise.all([
    request("/metrics"), request("/frankenphp/threads"),
  ]);
  const metrics = Object.fromEntries(metricNames.map(name => {
    const line = prometheus.split("\n").find(line => line.startsWith(`${name} `));
    const value = line === undefined ? NaN : Number(line.slice(name.length + 1));
    if (!Number.isFinite(value) || value < 0) throw new Error(`Missing/invalid Caddy metric ${name}`);
    return [name, value];
  })) as Record<typeof metricNames[number], number>;
  const threads: unknown = JSON.parse(threadJson);
  if (threads === null || typeof threads !== "object" ||
      !("ThreadDebugStates" in threads) || !Array.isArray(threads.ThreadDebugStates) ||
      threads.ThreadDebugStates.some(thread => thread === null || typeof thread !== "object" ||
        !Number.isFinite(thread.MemoryUsage) || thread.MemoryUsage < 0)) {
    throw new Error("Invalid upstream FrankenPHP thread memory response");
  }
  // These two requests cover a bounded interval, not an atomic snapshot.
  // Go Sys excludes C/engine allocations. PHP MemoryUsage is per-thread PHP
  // allocator usage, not all C memory. Released heap pages can be reused;
  // they do not establish physical reclamation. Keep the raw metrics too.
  return { startedAt, finishedAt: new Date().toISOString(), metrics, threads, prometheus };
}
