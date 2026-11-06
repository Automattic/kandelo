import type { NetworkIO } from "../types";
import { BoundedHttpResponseChunks, buildRawHttpRequest, parseRawHttpResponse, type HttpRequest, type HttpResponse, type SendHttpRequestOptions } from "./in-kernel-http";

/** Worker-owned HTTP client on the same NetworkIO as guest sockets. */
export class SessionHttpClient {
  // Guest socket handles cross an i32 ABI. Host requests occupy a disjoint
  // JavaScript-only range; remote TCP stream IDs are allocated by the backend.
  private nextHandle = 0x1_0000_0000;
  private active = new Set<(error: Error) => void>();

  close(): void {
    for (const cancel of [...this.active]) cancel(new Error("Kandelo network session ended"));
  }

  fetch(network: NetworkIO, address: Uint8Array, port: number, request: HttpRequest, options: SendHttpRequestOptions = {}): Promise<HttpResponse> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("Invalid HTTP destination port"));
    if (this.active.size >= 32) return Promise.reject(new Error("Too many pending Kandelo HTTP requests"));
    const timeout = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000) return Promise.reject(new Error("Invalid HTTP timeout"));
    const chunks = new BoundedHttpResponseChunks(options.maxResponseBytes ?? 64 * 1024 * 1024);
    // One request per connection, including servers which otherwise keep it open.
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== "connection"));
    const raw = buildRawHttpRequest({ ...request, headers: { ...headers, Connection: "close" } });
    const handle = this.nextHandle++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let sent = 0;
      const deadline = Date.now() + timeout;
      const finish = (error?: unknown, response?: HttpResponse) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.active.delete(cancel);
        try { network.close(handle); } catch { /* Preserve the request's failure. */ }
        if (error) reject(error); else resolve(response!);
      };
      const cancel = (error: Error) => finish(error);
      const tick = () => {
        if (settled) return;
        try {
          if (Date.now() >= deadline) throw new Error("Kandelo HTTP request timed out");
          const status = network.connectStatus(handle);
          if (status !== 0 && status !== -11) throw new Error(`Kandelo HTTP connection failed: errno ${status}`);
          if (status === 0) {
            if (sent < raw.length) {
              try { sent += network.send(handle, raw.subarray(sent), 0); }
              catch (error) { if ((error as { errno?: number }).errno !== 11) throw error; }
            }
            // Bound each worker turn so a busy stream cannot starve the network.
            for (let n = 0; n < 16; n++) {
              let bytes: Uint8Array;
              try { bytes = network.recv(handle, 65536, 0); }
              catch (error) { if ((error as { errno?: number }).errno === 11) break; throw error; }
              if (!bytes.length) { finish(undefined, parseRawHttpResponse(chunks.concat(), request.method)); return; }
              chunks.push(bytes);
            }
          }
          timer = setTimeout(tick, 2);
        } catch (error) { finish(error); }
      };
      this.active.add(cancel);
      try { network.connect(handle, address, port); tick(); }
      catch (error) { finish(error); }
    });
  }
}
