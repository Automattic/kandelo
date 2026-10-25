import { BrowserCorsProxy } from "../../../../../host/src/networking/browser-cors-proxy";
import { resolveBrowserCorsProxyConfig } from "../../../lib/browser-cors-proxy";
import type { PackageSessions, SessionOfferType } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { dependencyDigest, fetchDependency, MAX_DEPENDENCY_BYTES, verifyDependency, type OfferedDependency, type SessionDependency } from "../../../../../web-libs/kandelo-session/src/session-dependencies";
export type DependencySelections = Record<string, { source: string; file?: File }>;
export async function localDependency(host: KernelHost, path: string, expected: Pick<OfferedDependency, "sha256" | "size">) {
  const entries = await host.readVfsDir(path.slice(0, path.lastIndexOf("/")) || "/");
  const stat = entries?.find(entry => entry.name === path.slice(path.lastIndexOf("/") + 1));
  if (!stat || (stat.mode & 0o170000) !== 0o100000 || stat.size !== expected.size) return null;
  const bytes = await host.readFile(path);
  try { await verifyDependency(bytes, expected); return bytes; } catch { return null; }
}
export async function selectedDependency(host: KernelHost, dependency: SessionDependency, selection: DependencySelections[string] | undefined, delivery: "peer" | "hint", signal: AbortSignal) {
  const source = dependency.sources.find(s => s.id === (selection?.source ?? dependency.sources[0]?.id));
  let bytes: Uint8Array;
  let name: string;
  if (selection?.source === "file") {
    if (!dependency.allowFile || !selection.file) throw new Error(`Choose a file for ${dependency.title}`);
    if (selection.file.size <= 0 || selection.file.size > MAX_DEPENDENCY_BYTES) throw new Error("Activity files must be between 1 byte and 64 MiB");
    bytes = new Uint8Array(await selection.file.arrayBuffer()); name = selection.file.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128) || dependency.title;
  } else {
    if (!source) throw new Error(`Choose a source for ${dependency.title}`);
    bytes = await localDependency(host, dependency.path, source)
      ?? (source.installedPath ? await localDependency(host, source.installedPath, source) : null)
      ?? await fetchActivityDependency(source, signal);
    name = source.title.slice(0, 128);
  }
  const content: OfferedDependency = { id: dependency.id, name, sha256: await dependencyDigest(bytes), size: bytes.length, delivery, ...(source && selection?.source !== "file" ? { source: source.id } : {}) };
  return { content, bytes };
}

/** Discovery-only activities can be offered by any member. Server-address joins
 * and peer data delivery currently belong to the room's WebRTC hub. */
export function activityRequiresHost(manifest: PackageSessions, type: SessionOfferType) {
  const launch = manifest.joins.find(join => join.id === type.join)?.launch;
  return !!type.requiresHost || !!manifest.dependencies?.length || !!launch && (launch.surface === "web"
    ? launch.host === "network.host"
    : launch.args.some(arg => typeof arg === "object" && "field" in arg && arg.field === "network.host"));
}

/** Reuse the host's configured transport when a release download needs CORS. */
export async function fetchActivityDependency(source: { url: string; size: number; sha256: string }, signal: AbortSignal) {
  const proxy = new BrowserCorsProxy(resolveBrowserCorsProxyConfig({
    configuredUrl: import.meta.env.VITE_CORS_PROXY_URL,
    development: import.meta.env.DEV,
    baseUrl: import.meta.env.BASE_URL,
    pageUrl: window.location.href,
  }));
  const transport: typeof fetch = async (url, init) => {
    try { return await fetch(url, init); }
    catch (error) {
      if (signal.aborted) throw error;
      return proxy.fetch({ method: "GET", headers: [], targetUrl: String(url) }, (target, options) => fetch(target, { ...options, signal, credentials: "omit", referrerPolicy: "no-referrer" }));
    }
  };
  return fetchDependency(source, signal, transport);
}
