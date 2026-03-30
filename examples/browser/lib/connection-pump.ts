/**
 * Connection pump — bridges HTTP requests/responses between the HTTP bridge
 * and the kernel's pipe-backed sockets. This is the browser equivalent of
 * handleIncomingTcpConnection in kernel-worker.ts.
 */
import type { BrowserKernel } from "./browser-kernel";
import type { HttpRequest, HttpResponse, HttpBridgeHost } from "./http-bridge";

const encoder = new TextEncoder();

/**
 * Handle an incoming HTTP request by injecting it as a TCP connection
 * into the kernel's listening socket, pumping the request data through
 * the recv pipe, and reading the response from the send pipe.
 */
export function handleHttpRequest(
  kernel: BrowserKernel,
  bridge: HttpBridgeHost,
  requestId: number,
  request: HttpRequest,
  listenerPort: number,
): void {
  const target = kernel.pickListenerTarget(listenerPort);
  if (!target) {
    bridge.error(requestId, "No listener target available");
    return;
  }

  const recvPipeIdx = kernel.injectConnection(
    target.pid,
    target.fd,
    [127, 0, 0, 1],
    Math.floor(Math.random() * 60000) + 1024,
  );
  if (recvPipeIdx < 0) {
    bridge.error(requestId, "Failed to inject connection");
    return;
  }

  const sendPipeIdx = recvPipeIdx + 1;

  // Build raw HTTP request to write to the recv pipe
  const rawRequest = buildRawHttpRequest(request);

  // Write request data to recv pipe
  const written = kernel.pipeWrite(target.pid, recvPipeIdx, rawRequest);
  if (written < rawRequest.length) {
    console.warn(
      `[connection-pump] Partial write: ${written}/${rawRequest.length}`,
    );
  }

  // Close write end — signals end of request body
  kernel.pipeCloseWrite(target.pid, recvPipeIdx);

  // Wake any blocked readers
  kernel.wakeBlockedReaders(recvPipeIdx);

  // Start pumping response from send pipe
  pumpResponse(kernel, bridge, requestId, target.pid, sendPipeIdx);
}

/**
 * Build a raw HTTP/1.1 request from the bridge request.
 */
function buildRawHttpRequest(request: HttpRequest): Uint8Array {
  let header = `${request.method} ${request.url} HTTP/1.1\r\n`;

  for (const [key, value] of Object.entries(request.headers)) {
    header += `${key}: ${value}\r\n`;
  }

  if (request.body && !request.headers["content-length"]) {
    header += `Content-Length: ${request.body.length}\r\n`;
  }

  // Ensure Connection: close so the server closes the connection when done
  if (!request.headers["connection"]) {
    header += `Connection: close\r\n`;
  }

  header += `\r\n`;

  const headerBytes = encoder.encode(header);
  if (!request.body || request.body.length === 0) {
    return headerBytes;
  }

  const result = new Uint8Array(headerBytes.length + request.body.length);
  result.set(headerBytes, 0);
  result.set(request.body, headerBytes.length);
  return result;
}

/**
 * Pump response data from the kernel's send pipe and send it back
 * via the HTTP bridge when complete.
 */
function pumpResponse(
  kernel: BrowserKernel,
  bridge: HttpBridgeHost,
  requestId: number,
  pid: number,
  sendPipeIdx: number,
): void {
  const chunks: Uint8Array[] = [];

  const pump = () => {
    const data = kernel.pipeRead(pid, sendPipeIdx);
    if (data) {
      chunks.push(data);
    }

    // Check if the write end is closed (response complete)
    const writeOpen = kernel.pipeIsWriteOpen(pid, sendPipeIdx);
    if (!writeOpen && !data) {
      // Response complete
      kernel.pipeCloseRead(pid, sendPipeIdx);
      const rawResponse = concatChunks(chunks);
      const parsed = parseRawHttpResponse(rawResponse);
      bridge.respond(requestId, parsed);
      return;
    }

    // Keep pumping — use shorter delay when we got data
    setTimeout(pump, data ? 0 : 2);
  };

  // Start pumping immediately
  pump();
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const decoder = new TextDecoder();

/**
 * Parse a raw HTTP/1.1 response into status, headers, and body.
 */
function parseRawHttpResponse(data: Uint8Array): HttpResponse {
  const text = decoder.decode(data);

  // Find header/body separator
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    // No proper HTTP response — return as-is
    return { status: 200, headers: {}, body: data };
  }

  const headerText = text.slice(0, headerEnd);

  // Parse status line
  const lines = headerText.split("\r\n");
  const statusLine = lines[0];
  const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;

  // Parse headers
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(": ");
    if (colon >= 0) {
      const key = lines[i].slice(0, colon);
      const value = lines[i].slice(colon + 2);
      headers[key] = value;
    }
  }

  // Body is everything after header separator (use byte offset, not string offset)
  let byteHeaderEnd = 0;
  for (let i = 0; i < data.length - 3; i++) {
    if (
      data[i] === 13 &&
      data[i + 1] === 10 &&
      data[i + 2] === 13 &&
      data[i + 3] === 10
    ) {
      byteHeaderEnd = i + 4;
      break;
    }
  }
  const body = data.subarray(byteHeaderEnd);

  return { status, headers, body: new Uint8Array(body) };
}
