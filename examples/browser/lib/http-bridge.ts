/**
 * HTTP Bridge — MessageChannel-based protocol for service worker ↔ main thread
 * HTTP request/response bridging.
 *
 * Architecture:
 *   1. Main thread creates a MessageChannel and sends port2 to the SW
 *   2. SW receives fetch events and sends requests through port2
 *   3. Main thread receives requests on port1, processes them, sends responses back
 *   4. SW resolves the fetch event with the response
 *
 * This avoids SharedArrayBuffer (which can't be sent to service workers
 * via postMessage in current Chromium) and doesn't require polling.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

// --- Service Worker Side ---

/** Pending request resolvers keyed by request ID */
const pendingRequests = new Map<
  number,
  { resolve: (resp: HttpResponse) => void; reject: (err: Error) => void }
>();
let nextRequestId = 0;
let bridgePort: MessagePort | null = null;

/**
 * Initialize the bridge port in the service worker.
 * Called when the SW receives the port via postMessage.
 */
export function initBridgePort(port: MessagePort): void {
  bridgePort = port;
  port.onmessage = (event) => {
    const msg = event.data;
    if (msg?.type === "http-response") {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        pending.resolve({
          status: msg.status,
          headers: msg.headers,
          body: msg.body,
        });
      }
    } else if (msg?.type === "http-error") {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        pending.reject(new Error(msg.error || "Bridge request failed"));
      }
    }
  };
}

/**
 * Send an HTTP request through the bridge and wait for the response.
 * Called from the service worker's fetch handler.
 */
export function bridgeFetch(request: HttpRequest): Promise<HttpResponse> {
  if (!bridgePort) {
    return Promise.reject(new Error("Bridge port not initialized"));
  }

  const requestId = nextRequestId++;

  return new Promise<HttpResponse>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    bridgePort!.postMessage({
      type: "http-request",
      requestId,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });
  });
}

/**
 * Check if the bridge port is initialized.
 */
export function isBridgeReady(): boolean {
  return bridgePort !== null;
}

// --- Main Thread Side ---

/**
 * HttpBridgeHost — Main thread side of the HTTP bridge.
 * Creates a MessageChannel and handles requests from the service worker.
 */
export class HttpBridgeHost {
  private port: MessagePort;
  private swPort: MessagePort;
  private handler:
    | ((requestId: number, request: HttpRequest) => void)
    | null = null;

  constructor() {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.swPort = channel.port2;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === "http-request") {
        const request: HttpRequest = {
          method: msg.method,
          url: msg.url,
          headers: msg.headers,
          body: msg.body,
        };
        this.handler?.(msg.requestId, request);
      }
    };
  }

  /** Get the port to send to the service worker. */
  getSwPort(): MessagePort {
    return this.swPort;
  }

  /** Set the request handler. Called when a request is received. */
  onRequest(handler: (requestId: number, request: HttpRequest) => void): void {
    this.handler = handler;
  }

  /** Send a response for the given request. */
  respond(requestId: number, response: HttpResponse): void {
    this.port.postMessage({
      type: "http-response",
      requestId,
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  }

  /** Signal an error for the given request. */
  error(requestId: number, message?: string): void {
    this.port.postMessage({
      type: "http-error",
      requestId,
      error: message || "Internal error",
    });
  }
}
