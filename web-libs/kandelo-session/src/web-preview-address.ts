export interface WebPreviewTarget {
  hostname: string;
  port: number;
  path?: string;
  label?: string;
}

export const PREVIEW_OSC = 777;
export const PREVIEW_OSC_PREFIX = "kandelo-preview;1;";

export function validateWebPreviewTarget(target: WebPreviewTarget): void {
  const hostname = target.hostname;
  const peer = /^(?:peer-|10\.89\.0\.)([1-9]\d{0,2})$/.exec(hostname);
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "host"
    && !(peer && Number(peer[1]) <= 254)) {
    throw new Error("Choose localhost, host, or a connected Kandelo peer (peer-1 through peer-254)");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("Invalid web preview port");
  const path = target.path ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid web preview path");
}

export function parseWebPreviewAddress(address: string): WebPreviewTarget {
  if (address.length > 4096 || /[\\\u0000-\u0020\u007f]/.test(address)) throw new Error("Use an HTTP address without spaces or control characters (at most 4096 characters)");
  let url: URL;
  try { url = new URL(address.includes("://") ? address : `http://${address}`); }
  catch { throw new Error("Use an address such as http://localhost:3000/"); }
  if (url.protocol !== "http:" || url.username || url.password) throw new Error("Preview supports HTTP guest services, without URL credentials");
  const target = { hostname: url.hostname, port: Number(url.port || 80), path: url.pathname + url.search + url.hash };
  validateWebPreviewTarget(target);
  return target;
}
