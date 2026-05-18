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
    console.error(`[connection-pump] No listener target for port ${listenerPort}`);
    bridge.error(requestId, "No listener target available");
    return;
  }
  console.log(`[connection-pump] target pid=${target.pid} fd=${target.fd} for port ${listenerPort}`);
  const recvPipeIdx = kernel.injectConnection(
    target.pid,
    target.fd,
    [127, 0, 0, 1],
    Math.floor(Math.random() * 60000) + 1024,
  );
  if (recvPipeIdx < 0) {
    console.error(`[connection-pump] injectConnection failed: ${recvPipeIdx}`);
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

  // Don't close the recv pipe write end here — closing it causes POLLHUP
  // on the pipe, which nginx interprets as "client disconnected" when it
  // polls the client fd while waiting for an upstream (FastCGI) response.
  // The Connection: close header tells nginx the request is complete.

  // Wake any blocked readers
  kernel.wakeBlockedReaders(recvPipeIdx);

  console.log(`[connection-pump] request written, pumping response pipe=${sendPipeIdx}`);
  // Start pumping response from send pipe
  pumpResponse(kernel, bridge, requestId, target.pid, sendPipeIdx, recvPipeIdx);
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
  recvPipeIdx: number,
): void {
  const chunks: Uint8Array[] = [];
  let sawWriteOpen = false;

  let pumpCount = 0;
  const pump = () => {
    const data = kernel.pipeRead(pid, sendPipeIdx);
    if (data) {
      chunks.push(data);
      // Wake any process blocked writing to this pipe — our read freed
      // buffer space, so a blocked writer (e.g. nginx sending a large
      // response) can now continue.
      kernel.wakeBlockedWriters(sendPipeIdx);
    }

    const writeOpen = kernel.pipeIsWriteOpen(pid, sendPipeIdx);
    if (writeOpen && !sawWriteOpen) {
      sawWriteOpen = true;
      console.log(`[pump ${requestId}] write end opened, pid=${pid} pipe=${sendPipeIdx}`);
    }
    pumpCount++;
    if (pumpCount <= 5 || (pumpCount % 1000 === 0)) {
      console.log(`[pump ${requestId}] tick #${pumpCount} writeOpen=${writeOpen} sawWrite=${sawWriteOpen} data=${data ? data.length : 0} totalChunks=${chunks.length}`);
    }

    // Only treat write-end-closed as "response complete" if we've seen it
    // open first. Before the server accepts the connection, the pipe's write
    // end isn't associated with any process yet and appears closed.
    if (sawWriteOpen && !writeOpen && !data) {
      // Response complete — clean up both pipes
      kernel.pipeCloseRead(pid, sendPipeIdx);
      kernel.pipeCloseWrite(pid, recvPipeIdx);
      const rawResponse = concatChunks(chunks);
      console.log(`[connection-pump] response complete, ${rawResponse.length} bytes`);
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

  // Parse headers — preserve multiple Set-Cookie values joined by \n
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(": ");
    if (colon >= 0) {
      const key = lines[i].slice(0, colon);
      const value = lines[i].slice(colon + 2);
      if (key.toLowerCase() === "set-cookie" && headers[key]) {
        headers[key] += "\n" + value;
      } else {
        headers[key] = value;
      }
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
  let body = data.subarray(byteHeaderEnd);

  // Decode chunked transfer encoding if present
  const te = headers["Transfer-Encoding"] || headers["transfer-encoding"];
  if (te && te.toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
    // Remove Transfer-Encoding since we decoded it
    delete headers["Transfer-Encoding"];
    delete headers["transfer-encoding"];
  }

  return { status, headers, body: new Uint8Array(body) };
}

/**
 * Decode chunked transfer encoding from raw bytes.
 */
function decodeChunked(data: Uint8Array): Uint8Array {
  const result: Uint8Array[] = [];
  let pos = 0;

  while (pos < data.length) {
    // Find \r\n that ends the chunk size line
    let lineEnd = -1;
    for (let i = pos; i < data.length - 1; i++) {
      if (data[i] === 0x0d && data[i + 1] === 0x0a) {
        lineEnd = i;
        break;
      }
    }
    if (lineEnd < 0) break;

    // Parse chunk size (ASCII hex)
    const sizeLine = decoder.decode(data.subarray(pos, lineEnd)).trim();
    const chunkSize = parseInt(sizeLine, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) break;

    result.push(data.subarray(chunkStart, chunkEnd));

    // Skip past chunk data + \r\n
    pos = chunkEnd + 2;
  }

  return concatChunks(result);
}
