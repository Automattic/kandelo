import { isPrivateHost } from "./network-policy.ts";

export interface Socket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<void>;
  close(): Promise<void>;
  startTls(options: { expectedServerHostname: string }): Socket;
}
export type Connect = (address: { hostname: string; port: number },
  options: { secureTransport: "off" | "starttls"; allowHalfOpen: boolean }) => Socket;
interface TransportOptions {
  dnsFetch?: typeof globalThis.fetch;
  connect?: Connect;
}

const MAX_HEADER_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

function canonicalAddress(address: string): string {
  const url = new URL(`http://${address.includes(":") ? `[${address}]` : address}/`);
  if (url.pathname !== "/" || url.port || url.username || url.password || url.search || url.hash ||
      (!url.hostname.startsWith("[") && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))) throw new Error("Invalid DNS address");
  if (isPrivateHost(url.hostname)) throw new Error("Forbidden DNS address");
  return url.hostname;
}

export async function resolvePublicAddresses(host: string, dnsFetch: typeof fetch,
  signal: AbortSignal): Promise<string[]> {
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return [canonicalAddress(host.replace(/^\[|\]$/g, ""))];
  }
  const results = await Promise.all(["A", "AAAA"].map(async type => {
    // Fixed public IP: this bootstrap fetch cannot be rebound by the target.
    // TLS verifies 1.1.1.1's certificate; redirects are forbidden.
    const response = await dnsFetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { Accept: "application/dns-json" }, redirect: "error", signal, cache: "no-store" });
    if (!response.ok) { await response.body?.cancel(); throw new Error("DNS lookup failed"); }
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_HEADER_BYTES) throw new Error("DNS answer too large");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.Status !== 0 || (data.Answer !== undefined && !Array.isArray(data.Answer))) throw new Error("Invalid DNS answer");
    const addresses: string[] = [];
    for (const record of data.Answer ?? []) {
      if (record.type === 1 || record.type === 28) {
        if (typeof record.data !== "string") throw new Error("Invalid DNS address");
        const address = canonicalAddress(record.data);
        if ((record.type === 28) !== address.startsWith("[")) throw new Error("DNS address family mismatch");
        addresses.push(address);
      }
    }
    return addresses;
  }));
  const addresses = [...new Set(results.flat())];
  if (addresses.length === 0) throw new Error("Hostname could not be resolved");
  return addresses;
}

/** Bounded HTTP/1.x framing; no interim headers or trailers escape to clients. */
class WireReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer = new Uint8Array(0);
  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }
  async fill(): Promise<boolean> {
    const next = await this.reader.read();
    if (next.done) return false;
    const joined = new Uint8Array(this.buffer.length + next.value.length);
    joined.set(this.buffer); joined.set(next.value, this.buffer.length); this.buffer = joined;
    return true;
  }
  async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.findIndex((value, i) => value === 13 && this.buffer[i + 1] === 10);
      if (end >= 0) {
        if (end > MAX_HEADER_BYTES) throw new Error("HTTP line too long");
        const line = decoder.decode(this.buffer.subarray(0, end)); this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("HTTP line too long");
      if (!await this.fill()) throw new Error("Incomplete HTTP headers");
    }
  }
  async bytes(max: number): Promise<Uint8Array | undefined> {
    while (this.buffer.length === 0) if (!await this.fill()) return;
    const chunk = this.buffer.slice(0, max); this.buffer = this.buffer.slice(chunk.length); return chunk;
  }
  async headers(): Promise<Headers> {
    const headers = new Headers();
    let size = 0;
    for (;;) {
      const line = await this.line(); size += line.length + 2;
      if (size > MAX_HEADER_BYTES) throw new Error("HTTP headers too large");
      if (line === "") return headers;
      const colon = line.indexOf(":");
      if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))) throw new Error("Invalid HTTP header");
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
  }
}

export function createPinnedFetch(options: TransportOptions = {}) {
  return async (value: string, init: RequestInit & { duplex: "half" }): Promise<Response> => {
    const target = new URL(value);
    const addresses = await resolvePublicAddresses(target.hostname, options.dnsFetch ?? globalThis.fetch, init.signal!);
    const connect = options.connect ?? (await import("cloudflare:sockets")).connect;
    // No hostname is passed to connect. DNS can change after validation and
    // cannot influence this socket. HTTPS verifies the original name via SNI.
    let socket = connect({ hostname: addresses[0].replace(/^\[|\]$/g, ""),
      port: Number(target.port || (target.protocol === "https:" ? 443 : 80)) },
      { secureTransport: target.protocol === "https:" ? "starttls" : "off", allowHalfOpen: true });
    let closed = false;
    let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const close = async () => {
      if (closed) return;
      closed = true;
      init.signal!.removeEventListener("abort", onAbort);
      await socket.close().catch(() => {});
      // A response can finish or be cancelled while the client is still
      // uploading. Close that byte pipe too; don't leave a pending read alive.
      await uploadReader?.cancel().catch(close);
    };
    const onAbort = () => { void close(); };
    init.signal!.addEventListener("abort", onAbort, { once: true });
    socket.closed.catch(close);
    try {
      if (init.signal!.aborted) throw new Error("Request aborted");
      await socket.opened;
      if (target.protocol === "https:") {
        socket = socket.startTls({ expectedServerHostname: target.hostname.replace(/^\[|\]$/g, "") });
        socket.closed.catch(close);
        await socket.opened;
      }
      const outgoing = new Headers(init.headers);
      outgoing.set("host", target.host);
      outgoing.set("connection", "close");
      outgoing.delete("content-length"); outgoing.delete("transfer-encoding");
      const uploadBody = init.body as ReadableStream<Uint8Array> | undefined;
      if (uploadBody) outgoing.set("transfer-encoding", "chunked");
      else if (init.method === "POST") outgoing.set("content-length", "0");
      const writer = socket.writable.getWriter();
      await writer.write(encoder.encode(`${init.method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
        [...outgoing].map(([name, value]) => `${name}: ${value}\r\n`).join("") + "\r\n"));
      let uploadError: unknown;
      const upload = (async () => {
        try {
          if (uploadBody) {
            const reader = uploadBody.getReader();
            uploadReader = reader;
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (chunk.value.length === 0) continue;
                await writer.write(encoder.encode(`${chunk.value.length.toString(16)}\r\n`));
                await writer.write(chunk.value); await writer.write(encoder.encode("\r\n"));
              }
              await writer.write(encoder.encode("0\r\n\r\n"));
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
              uploadReader = undefined;
            }
          }
        } finally { writer.releaseLock(); }
      })().catch(async error => { uploadError = error; await close(); });
      const wire = new WireReader(socket.readable);
      let status = 0;
      let headers = new Headers();
      for (let interim = 0; interim < 9; interim++) {
        const line = await wire.line();
        const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: .*)?$/.exec(line);
        if (!match) throw new Error("Invalid HTTP status");
        status = Number(match[1]); headers = await wire.headers();
        if (status === 101) throw new Error("Protocol switching is not supported");
        if (status >= 200) break;
      }
      if (status < 200) throw new Error("Too many interim responses");
      if (init.method === "HEAD" || [204, 205, 304].includes(status)) {
        await upload; if (uploadError) throw uploadError;
        await close(); return new Response(null, { status, headers });
      }
      const transfer = headers.get("transfer-encoding");
      const chunked = transfer !== null;
      if (chunked && transfer.toLowerCase() !== "chunked") throw new Error("Unsupported transfer encoding");
      const length = headers.get("content-length");
      if (!chunked && length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new Error("Invalid content length");
      let remaining = length === null || chunked ? Infinity : Number(length);
      let chunkRemaining = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (uploadError) throw uploadError;
            if (chunked && chunkRemaining === 0) {
              const line = await wire.line();
              if (!/^[0-9a-f]+(?:;[^\r\n]*)?$/i.test(line)) throw new Error("Invalid chunk size");
              chunkRemaining = parseInt(line, 16);
              if (!Number.isSafeInteger(chunkRemaining)) throw new Error("Invalid chunk size");
              if (chunkRemaining === 0) { await wire.headers(); remaining = 0; }
            }
            if (remaining === 0) {
              await upload; if (uploadError) throw uploadError;
              await close(); controller.close(); return;
            }
            const bytes = await wire.bytes(Math.min(64 * 1024, chunked ? chunkRemaining : remaining));
            if (!bytes) {
              if (chunked || remaining !== Infinity) throw new Error("Incomplete HTTP body");
              await upload; if (uploadError) throw uploadError;
              await close(); controller.close(); return;
            }
            if (chunked) {
              chunkRemaining -= bytes.length;
              if (chunkRemaining === 0 && await wire.line() !== "") throw new Error("Invalid chunk terminator");
            } else remaining -= bytes.length;
            controller.enqueue(bytes);
          } catch (error) { await close(); controller.error(error); }
        },
        async cancel() { await close(); },
      }, { highWaterMark: 0 });
      return new Response(body, { status, headers, encodeBody: "manual" } as ResponseInit);
    } catch (error) { await close(); throw error; }
  };
}
