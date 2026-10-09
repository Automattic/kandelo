import { pathToFileURL } from "node:url";
import { findRepoRoot, type LazyAssetResolution } from "./binary-resolver";
import { NodeWorkerAdapter, type WorkerAdapter, type WorkerHandle } from "./worker-adapter";

function currentModuleUrl(): string {
  return typeof __filename === "undefined" ? import.meta.url : pathToFileURL(__filename).href;
}

/** Own one asynchronous freshness checkpoint for the image's whole URL cohort.
 * The first lazy read starts it; unused assets require no resolver preparation.
 * Paths remain pinned to that checkpoint. Late URLs get their own checkpoint;
 * neither lookup invokes a blocking resolver on the syscall worker.
 */
export class NodeLazyAssetResolver {
  private readonly resolutions = new Map<string, Promise<LazyAssetResolution>>();
  private readonly pending = new Set<(error: Error) => void>();
  private readonly terminations = new Set<Promise<unknown>>();
  private cohort: string[];
  private closed = false;

  constructor(
    urls: readonly string[],
    private readonly adapter: WorkerAdapter = new NodeWorkerAdapter(
      new URL("./node-lazy-asset-resolver-entry.ts", currentModuleUrl()),
      // The canonical checker authenticates source-owned module locations.
      // A temporary bundle would lose that provenance and skip source checks.
      { bundleSource: false },
    ),
  ) {
    this.cohort = [...new Set(urls)];
  }

  async resolve(url: string): Promise<string> {
    if (this.closed) throw new Error("Lazy asset resolver is closed");
    if (this.cohort.length > 0) {
      const urls = this.cohort;
      this.cohort = [];
      const checkpoint = this.start(urls);
      for (const member of urls) {
        this.resolutions.set(member, checkpoint.then((results) => results.get(member)!));
      }
    }
    let result = this.resolutions.get(url);
    if (!result) {
      result = this.start([url]).then((results) => results.get(url)!);
      this.resolutions.set(url, result);
    }
    const resolution = await result;
    if ("error" in resolution) throw resolution.error;
    return resolution.path;
  }

  private start(urls: string[]): Promise<Map<string, LazyAssetResolution>> {
    // Capture failures as per-URL data, including construction and discovery
    // failures. An unused broken asset must not fail boot or reject unhandled.
    return new Promise((resolve) => {
      let worker: WorkerHandle | undefined;
      let finished = false;
      const terminate = () => {
        if (!worker) return;
        const termination = worker.terminate().catch(() => {});
        this.terminations.add(termination);
        void termination.then(() => this.terminations.delete(termination));
      };
      const finish = (results: Map<string, LazyAssetResolution>) => {
        if (finished) return;
        finished = true;
        this.pending.delete(fail);
        if (worker) {
          worker.off("message", onMessage);
          worker.off("error", fail);
          worker.off("exit", onExit);
        }
        terminate();
        resolve(results);
      };
      const fail = (error: Error) => {
        finish(new Map(urls.map((url) => [url, { error }])));
      };
      const onExit = (code: number) => fail(new Error(
        `Lazy asset resolver exited before replying (status ${code})`,
      ));
      const onMessage = (message: unknown) => {
        if (!(message instanceof Map) || urls.some((url) => {
          const value = message.get(url);
          return !value || !(typeof value.path === "string" || value.error instanceof Error);
        })) {
          fail(new Error("Invalid lazy asset resolver reply"));
          return;
        }
        finish(message as Map<string, LazyAssetResolution>);
      };
      this.pending.add(fail);
      try {
        const repoRoot = findRepoRoot(process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT);
        worker = this.adapter.createWorker({ repoRoot, urls });
        worker.on("message", onMessage);
        worker.on("error", fail);
        worker.on("exit", onExit);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cohort = [];
    for (const cancel of this.pending) cancel(new Error("Lazy asset resolver was destroyed"));
    this.resolutions.clear();
    await Promise.all(this.terminations);
  }
}
