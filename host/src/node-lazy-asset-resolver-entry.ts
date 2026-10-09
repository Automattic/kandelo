import { parentPort, workerData } from "node:worker_threads";
import { resolveLazyAssetPaths } from "./binary-resolver";

// Carry the caller's discovered root explicitly; its environment override
// selects the same registry even when the worker starts from a different cwd.
const { repoRoot, urls } = workerData as { repoRoot: string; urls: string[] };
process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT = repoRoot;
parentPort!.postMessage(resolveLazyAssetPaths(urls));
parentPort!.close();
