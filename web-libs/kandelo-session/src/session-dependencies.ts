/** Installed packages own destinations and download sources; invitations only identify content. */
export const MAX_DEPENDENCY_BYTES = 64 * 1024 * 1024;
export const MAX_DEPENDENCIES = 2;
export interface SessionDependency {
  id: string; title: string; path: string; allowFile: boolean; hint: string; fileWarning?: string;
  sources: { id: string; title: string; url: string; sha256: string; size: number; installedPath?: string; informationUrl?: string; offerDefaults?: Record<string, string | number>; warning?: string }[];
}
export interface OfferedDependency {
  id: string; name: string; sha256: string; size: number; delivery: "peer" | "hint"; source?: string;
}
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const validId = (value: unknown): value is string => typeof value === "string" && identifier.test(value);
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const string = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const exact = (v: any, allowed: string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const size = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= MAX_DEPENDENCY_BYTES;
export function validateDependencies(value: unknown): asserts value is SessionDependency[] {
  if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES) throw new Error("Invalid activity dependencies");
  const ids = new Set<string>(), paths = new Set<string>();
  for (const d of value) {
    // Temporary, package-owned destinations avoid overwriting the user's original data.
    if (!exact(d, ["id", "title", "path", "allowFile", "hint", "sources", "fileWarning"]) || !validId(d.id) || ids.has(d.id)
      || (d.fileWarning !== undefined && !string(d.fileWarning))
      || !string(d.title) || !string(d.hint, 1024) || typeof d.allowFile !== "boolean"
      || typeof d.path !== "string" || !/^\/tmp\/[a-zA-Z0-9._-]+$/.test(d.path) || [".", ".."].includes(d.path.slice(5)) || paths.has(d.path)
      || !Array.isArray(d.sources) || d.sources.length > 8) throw new Error("Invalid activity dependency");
    ids.add(d.id); paths.add(d.path);
    const sources = new Set<string>();
    for (const s of d.sources) {
      if (!exact(s, ["id", "title", "url", "sha256", "size", "installedPath", "informationUrl", "offerDefaults", "warning"]) || !validId(s.id) || sources.has(s.id)
        || (s.warning !== undefined && !string(s.warning))
        || !string(s.title) || !string(s.url, 2048) || !validDigest(s.sha256) || !size(s.size)
        || (s.installedPath !== undefined && (typeof s.installedPath !== "string" || !/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(s.installedPath) || s.installedPath.split("/").some((component: string) => component === "." || component === "..")))) throw new Error("Invalid dependency source");
      if (s.offerDefaults !== undefined && (!exact(s.offerDefaults, Object.keys(s.offerDefaults)) || Object.keys(s.offerDefaults).length > 16 || Object.entries(s.offerDefaults).some(([key, value]) => !validId(key) || (typeof value === "string" ? !string(value, 128) : !Number.isSafeInteger(value))))) throw new Error("Invalid source defaults");
      if (s.informationUrl !== undefined) {
        if (!string(s.informationUrl, 2048)) throw new Error("Invalid source information URL");
        const info = new URL(s.informationUrl);
        if (info.protocol !== "https:" || info.username || info.password) throw new Error("Source information requires HTTPS");
      }
      const url = new URL(s.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Dependency sources require HTTPS");
      sources.add(s.id);
    }
    if (!d.allowFile && d.sources.length === 0) throw new Error("Dependency has no available source");
  }
}
export function validateOfferedDependencies(value: unknown): asserts value is OfferedDependency[] {
  if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES) throw new Error("Invalid invitation dependencies");
  const ids = new Set<string>();
  for (const d of value) {
    if (!exact(d, ["id", "name", "sha256", "size", "delivery", "source"]) || !validId(d.id) || ids.has(d.id)
      || !string(d.name, 128) || !validDigest(d.sha256) || !size(d.size) || !["peer", "hint"].includes(d.delivery)
      || (d.source !== undefined && !validId(d.source))) throw new Error("Invalid invitation dependency");
    ids.add(d.id);
  }
}
export function resolveDependencies(declared: SessionDependency[], offered: OfferedDependency[]) {
  validateOfferedDependencies(offered);
  if (declared.length !== offered.length) throw new Error("Invitation dependency list does not match the activity");
  return declared.map(dependency => {
    const content = offered.find(d => d.id === dependency.id);
    if (!content) throw new Error("Missing invitation dependency");
    const source = dependency.sources.find(s => s.id === content.source);
    if (content.source ? !source || source.sha256 !== content.sha256 || source.size !== content.size : !dependency.allowFile) throw new Error("Invalid invitation dependency source");
    return { dependency, content, source };
  });
}
export async function dependencyDigest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyDependency(bytes: Uint8Array, expected: Pick<OfferedDependency, "sha256" | "size">) {
  if (bytes.length !== expected.size || await dependencyDigest(bytes) !== expected.sha256) throw new Error("Activity data does not match the invitation's size and SHA-256 fingerprint");
}
/** Bound the response while reading, including servers that omit or lie about Content-Length. */
export async function fetchDependency(source: { url: string; sha256: string; size: number }, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetchImpl(source.url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok || !response.body) throw new Error(`Could not download activity data (${response.status})`);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(source.size);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new Error("Activity download exceeds declared size");
      bytes.set(value, offset); offset += value.length;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (offset !== bytes.length) throw new Error("Activity download is incomplete");
  await verifyDependency(bytes, source);
  return bytes;
}
