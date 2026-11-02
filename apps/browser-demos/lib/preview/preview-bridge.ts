/**
 * PreviewBridgeHost: the owning tab's side of one machine's web preview.
 *
 * The preview service worker (on the preview origin) turns each guest request
 * for `<scope>computer/<name>/…` into an `http-request` on this machine's
 * bridge port. This host answers it with `BrowserKernel.fetchInKernel` and
 * owns everything that must not live on the guest's origin: the machine's
 * cookie jar, the forwarded headers, redirect and body URL rewriting, and
 * the blob-iframe interceptor injection. It also re-issues a guest's
 * cross-origin reads (`proxy-fetch`) through this app's normal `fetch()`
 * path, credentialless, so the CORS proxy and its credential gate treat them
 * like any page read.
 *
 * Every message on the port is untrusted preview-origin input: fields are
 * validated, the path stays inside this machine, and nothing here answers
 * with more than the machine's own server or a credentialless proxy read.
 *
 * OWNING THE NAME: the preview origin is shared by every guest, so the
 * preview service worker cannot tell an owner from another page by who
 * sends a message. The machine's name commits to a secret only this host
 * holds (`MachineIdentity`, see MACHINE_NAME_PATTERN in ./protocol); the
 * worker binds a port to the name, or drops it, only for a message that
 * carries that secret, and replaces any port it held. So this host simply
 * binds again whenever the worker may have lost its port: when it restarted
 * (`preview-need-bridge`), was replaced (`preview-worker-changed`), or does
 * not answer a ping (`verify`). A rebind can fail only by not being
 * confirmed (`onLost("unreachable")`, shown until a later rebind succeeds).
 *
 * ORDERING: binds of one name never overlap (a notice during a bind, the
 * first one included, schedules one more after it), and every bind and
 * closing carries a larger sequence number than the last. A bind this host
 * gave up on can still reach the worker late, after the bind that replaced
 * it (the relay retries delivery while the worker starts); the worker
 * ignores any bind or closing older than the newest it accepted for the
 * name, so a late bind never installs the closed port of a bind that timed
 * out over a live one.
 */
import { MachineCookieJar } from "./cookie-jar";
import { mintMachineIdentity, type MachineIdentity } from "./machine-names";
import { PreviewBindRefused, type PreviewRelay } from "./preview-relay";
import {
  PREVIEW_PROTOCOL_VERSION,
  machinePathPrefix,
  type BridgeHttpRequest,
  type BridgeProxyFetch,
  type BridgeResponseMessage,
} from "./protocol";
import {
  cspRestrictsScripts,
  injectBlobIframeInterceptor,
  rewriteLocation,
  rewriteSameHostUrls,
  shouldRewriteBody,
  translateFramePolicy,
  type PreviewLocation,
} from "./response-shaping";

export interface KernelHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface KernelHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PreviewKernel {
  fetchInKernel(
    port: number,
    request: KernelHttpRequest,
    options?: { timeoutMs?: number; hostname?: string },
  ): Promise<KernelHttpResponse>;
}

export interface PreviewResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface PreviewNavigation {
  /** Path and query inside the machine. */
  path: string;
  /** HTTP status, or null when the request failed. */
  status: number | null;
  method: string;
}

/** Why a preview stopped reaching this tab's machine. */
export type PreviewLossReason = "unreachable";

export interface PreviewBridgeOptions {
  relay: Pick<PreviewRelay, "bind" | "closing" | "onNeedBridge" | "onWorkerChanged">;
  previewOrigin: string;
  /** Deployment scope, `/` or `/prefix/`. */
  scope: string;
  /** Kandelo's own origin, for the viewer-shell URL. */
  appOrigin: string;
  kernel: PreviewKernel;
  /** In-machine TCP port (or a peer's, with `hostname`). */
  port: number;
  hostname?: string;
  timeoutMs?: number;
  interceptorSource?: string;
  debugLog?: (line: string) => void;
  onRequestStart?: (request: { method: string; url: string }) =>
    ((status: number | null, error?: string) => void) | undefined;
  onPendingRequests?: (count: number) => void;
  onNavigation?: (navigation: PreviewNavigation) => void;
  /** Tests only: a fixed identity instead of a fresh one. */
  mintIdentity?: () => Promise<MachineIdentity>;
  /** The page's fetch, for guests' cross-origin reads. */
  fetch?: typeof fetch;
  /** Window for pagehide; absent in tests. */
  window?: Pick<Window, "addEventListener" | "removeEventListener">;
  /**
   * The preview no longer reaches this machine: the preview origin did not
   * confirm a rebind. `onRestored` follows when a later rebind succeeds.
   */
  onLost?: (reason: PreviewLossReason, message: string) => void;
  onRestored?: () => void;
  /**
   * Origins a guest's cross-origin read must never reach through this tab:
   * the configured CORS proxy and credential relay. Their own endpoints
   * (a quota session, a credential exchange) answer the page, not a guest.
   */
  refusedProxyOrigins?: string[];
  /** How long `verify()` waits for the worker's answer on the port. */
  pingTimeoutMs?: number;
}

const UNREACHABLE_MESSAGE =
  "The preview origin did not confirm this computer's web preview; requests to it may fail.";

const MAX_PATH_BYTES = 16 * 1024;
const MAX_PROXY_BODY_BYTES = 64 * 1024 * 1024;
const MAX_PROBE_REDIRECTS = 10;
const DEFAULT_PING_TIMEOUT_MS = 3_000;
const RETIRED_PORT_GRACE_MS = 30_000;
const METHOD_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const HOP_BY_HOP = new Set(["transfer-encoding", "connection", "keep-alive"]);
const PROXY_REQUEST_HEADERS = new Set([
  "accept", "accept-language", "content-language", "if-modified-since",
  "if-none-match", "if-range", "range",
]);
const PROXY_RESPONSE_HEADERS = [
  "accept-ranges", "cache-control", "content-language", "content-range",
  "content-type", "etag", "expires", "last-modified",
];

export class PreviewBridgeHost {
  /** Mint a name, bind it in the preview service worker, and serve it. */
  static async open(options: PreviewBridgeOptions): Promise<PreviewBridgeHost> {
    const identity = await (options.mintIdentity ?? (() => mintMachineIdentity()))();
    const host = new PreviewBridgeHost(identity, options);
    try {
      await host.bindSerialized();
    } catch (error) {
      host.dispose();
      if (error instanceof PreviewBindRefused && error.code === "version-mismatch") {
        throw new Error(
          "The preview origin runs a different preview protocol than this app; deploy both bundles together.",
        );
      }
      throw error;
    }
    return host;
  }

  /** Absolute URL of the machine root on the preview origin, ending in `/`. */
  readonly url: string;
  /** Kandelo's viewer-shell URL for this machine, ending in `/`. */
  readonly viewerUrl: string;
  readonly name: string;
  /**
   * Proves this tab owns `name`; sent only to this tab's relay frame. A
   * private field, so no serialization or reflection of this object shows it.
   */
  readonly #secret: string;
  private readonly location: PreviewLocation;
  private readonly jar: MachineCookieJar;
  private port: MessagePort | null = null;
  /** Requests each port is still answering; a replaced port closes at 0. */
  private readonly inFlight = new Map<MessagePort, number>();
  /** Replaced ports still in their grace period. */
  private readonly retiring = new Map<MessagePort, ReturnType<typeof setTimeout>>();
  /** Replaced ports past their grace period; closed once idle. */
  private readonly retired = new Set<MessagePort>();
  private pending = 0;
  private disposed = false;
  private lost: PreviewLossReason | null = null;
  /** Settles when the bind in progress does; null when none is. */
  private rebinding: Promise<void> | null = null;
  private rebindAgain = false;
  /** Last sequence number sent with a bind or closing. */
  private seq = 0;
  private readonly pings = new Map<number, () => void>();
  private nextPingId = 1;
  private readonly cleanups: Array<() => void> = [];

  private constructor(identity: MachineIdentity, private readonly options: PreviewBridgeOptions) {
    this.name = identity.name;
    this.#secret = identity.secret;
    const name = identity.name;
    const prefix = machinePathPrefix(options.scope, name);
    this.url = `${options.previewOrigin}${prefix}`;
    this.viewerUrl = `${options.appOrigin}${prefix}`;
    this.location = { previewOrigin: options.previewOrigin, machineRoot: prefix.slice(0, -1) };
    this.jar = new MachineCookieJar(this.location.machineRoot);
    // The preview service worker restarted (need-bridge) or was replaced by
    // a new version (worker-changed): either way it may hold no port for
    // this name. Binding again with the secret replaces whatever it holds,
    // so a late or forged notice costs one rebind and nothing else. The jar
    // is untouched.
    this.cleanups.push(options.relay.onNeedBridge(name, () => void this.rebind()));
    this.cleanups.push(options.relay.onWorkerChanged(() => void this.rebind()));
    const pageWindow = options.window;
    if (pageWindow) {
      const pagehide = (event: Event) => {
        // A bfcache suspension keeps the tab and its machine alive.
        if ((event as PageTransitionEvent).persisted) return;
        options.relay.closing(name, this.#secret, ++this.seq);
      };
      pageWindow.addEventListener("pagehide", pagehide);
      this.cleanups.push(() => pageWindow.removeEventListener("pagehide", pagehide));
    }
  }

  /**
   * Make one request through the same path guest requests take (jar,
   * forwarded headers, rewriting), following redirects that stay inside the
   * machine. Used for readiness probes, which therefore see what the frame
   * would see.
   */
  async probe(path: string): Promise<PreviewResponse> {
    let current = path;
    for (let hop = 0; ; hop++) {
      const response = await this.serve({
        method: "GET",
        url: current,
        headers: [["accept", "text/html,*/*"]],
        body: null,
        navigation: false,
      });
      const location = response.headers.get("location");
      if (hop >= MAX_PROBE_REDIRECTS || response.status < 300 || response.status >= 400 || !location) {
        return response;
      }
      const target = new URL(location, this.url);
      if (target.origin !== this.options.previewOrigin || !target.pathname.startsWith(this.location.machineRoot + "/")) {
        return response;
      }
      current = target.pathname.slice(this.location.machineRoot.length) + target.search;
    }
  }

  /** Names and paths of the cookies this machine holds; never values. */
  cookieEntries(): Array<{ name: string; path: string }> {
    return this.jar.entries();
  }

  /**
   * Check that the preview worker still holds this host's port, and bind a
   * fresh one if it does not. Used when the preview origin reports this
   * machine offline: the owner trusts its own port, not a message any guest
   * page could forge.
   */
  async verify(): Promise<void> {
    if (this.disposed) return;
    if (await this.ping()) return;
    await this.rebind();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.port) {
      this.options.relay.closing(this.name, this.#secret, ++this.seq);
      this.port = null;
    }
    for (const port of this.inFlight.keys()) {
      port.onmessage = null;
      port.close();
    }
    this.inFlight.clear();
    for (const timer of this.retiring.values()) clearTimeout(timer);
    this.retiring.clear();
    this.retired.clear();
    for (const fail of this.pings.values()) fail();
    this.pings.clear();
    this.jar.clear();
  }

  private ping(): Promise<boolean> {
    const port = this.port;
    if (!port) return Promise.resolve(false);
    const id = this.nextPingId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        resolve(false);
      }, this.options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS);
      this.pings.set(id, () => {
        clearTimeout(timer);
        this.pings.delete(id);
        resolve(port === this.port);
      });
      port.postMessage({ type: "bridge-ping", v: PREVIEW_PROTOCOL_VERSION, id });
    });
  }

  private rebind(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.rebinding) {
      // A notice that arrives mid-bind may come from a worker the current
      // bind did not reach; bind once more after it.
      this.rebindAgain = true;
      return this.rebinding;
    }
    return this.bindSerialized().then(() => {
      this.options.debugLog?.(`Preview bridge for ${this.name} restored`);
      if (this.lost !== null) {
        this.lost = null;
        this.options.onRestored?.();
      }
    }, (error: unknown) => {
      if (this.disposed) return;
      this.options.debugLog?.(`Preview bridge for ${this.name} could not be restored: ${String(error)}`);
      if (this.lost === null) {
        this.lost = "unreachable";
        this.options.onLost?.("unreachable", UNREACHABLE_MESSAGE);
      }
    });
  }

  /**
   * Bind a fresh port as the only bind of this name in progress. The relay
   * rejects a pending bind when the same name is bound again, so `open`'s
   * first bind goes through here too: a notice that arrives during it waits
   * for it and then binds once more.
   */
  private bindSerialized(): Promise<void> {
    const bound = this.bindFreshPort();
    this.rebinding = bound.then(() => undefined, () => undefined).finally(() => {
      this.rebinding = null;
      if (this.rebindAgain && !this.disposed) {
        this.rebindAgain = false;
        void this.rebind();
      }
    });
    return bound;
  }

  private async bindFreshPort(): Promise<void> {
    if (this.disposed) throw new Error("Preview bridge is disposed");
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => this.onPortMessage(channel.port1, event);
    this.inFlight.set(channel.port1, 0);
    try {
      await this.options.relay.bind(this.name, this.#secret, channel.port2, ++this.seq);
    } catch (error) {
      this.closePort(channel.port1);
      throw error;
    }
    if (this.disposed) {
      this.closePort(channel.port1);
      throw new Error("Preview bridge is disposed");
    }
    const previous = this.port;
    this.port = channel.port1;
    // The worker may still send requests it routed before the rebind on the
    // previous port, and their messages can arrive after this confirmation
    // (they travel on another channel). Answer there for a while, then close
    // it once it is idle.
    if (previous) {
      const timer = setTimeout(() => {
        this.retiring.delete(previous);
        this.retired.add(previous);
        this.retirePortWhenIdle(previous);
      }, RETIRED_PORT_GRACE_MS);
      this.retiring.set(previous, timer);
    }
  }

  private closePort(port: MessagePort): void {
    port.onmessage = null;
    port.close();
    this.inFlight.delete(port);
    this.retired.delete(port);
  }

  // Only a replaced port past its grace period closes: a port whose bind is
  // still unconfirmed already carries requests and must stay open.
  private retirePortWhenIdle(port: MessagePort): void {
    if (this.retired.has(port) && (this.inFlight.get(port) ?? 0) === 0) this.closePort(port);
  }

  private onPortMessage(port: MessagePort, event: MessageEvent): void {
    const message = event.data as BridgeHttpRequest | BridgeProxyFetch | { type: "bridge-pong"; v: number; id: number } | null;
    if (!message || typeof message !== "object" || message.v !== PREVIEW_PROTOCOL_VERSION) return;
    if (!Number.isSafeInteger(message.id)) return;
    if (message.type === "bridge-pong") {
      if (port === this.port) this.pings.get(message.id)?.();
      return;
    }
    if (!this.inFlight.has(port)) return;
    this.inFlight.set(port, this.inFlight.get(port)! + 1);
    // Answer on the port the request came in on, even if a rebind replaced
    // it meanwhile: the worker that sent it waits there.
    const reply = (response: BridgeResponseMessage) => {
      const count = this.inFlight.get(port);
      if (count === undefined) return;
      this.inFlight.set(port, count - 1);
      if (response.type === "http-response") port.postMessage(response, [response.body]);
      else port.postMessage(response);
      this.retirePortWhenIdle(port);
    };
    const fail = (error: unknown) => reply({
      type: "http-error",
      v: PREVIEW_PROTOCOL_VERSION,
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
    if (message.type === "http-request") {
      this.serveGuest(message).then(reply, fail);
    } else if (message.type === "proxy-fetch") {
      this.serveProxyFetch(message).then(reply, fail);
    } else {
      fail(new Error("Unknown preview request"));
    }
  }

  private async serveGuest(message: BridgeHttpRequest): Promise<BridgeResponseMessage> {
    if (!Array.isArray(message.headers)) throw new Error("Malformed preview request headers");
    const body = message.body instanceof ArrayBuffer ? message.body : null;
    const response = await this.serve({
      method: message.method,
      url: message.url,
      headers: message.headers,
      body,
      navigation: message.navigation === true,
    });
    // Transfer an exact, unshared copy: the port crosses into another origin.
    const view = response.body;
    const bytes = view.buffer instanceof ArrayBuffer && view.byteOffset === 0 &&
        view.byteLength === view.buffer.byteLength
      ? view.buffer
      : view.slice().buffer as ArrayBuffer;
    return {
      type: "http-response",
      v: PREVIEW_PROTOCOL_VERSION,
      id: message.id,
      status: response.status,
      headers: [...response.headers],
      body: bytes,
    };
  }

  private async serve(request: {
    method: unknown;
    url: unknown;
    headers: [unknown, unknown][];
    body: ArrayBuffer | null;
    navigation: boolean;
  }): Promise<PreviewResponse> {
    const method = typeof request.method === "string" && METHOD_PATTERN.test(request.method)
      ? request.method
      : null;
    const path = request.url;
    if (
      method === null || typeof path !== "string" || !path.startsWith("/") ||
      path.startsWith("//") || path.length > MAX_PATH_BYTES || /[\u0000-\u001f\u007f\s]/.test(path)
    ) {
      throw new Error("Malformed preview request");
    }
    const requestUrl = new URL(this.location.machineRoot + path, this.options.previewOrigin);
    const headers: Record<string, string> = {};
    for (const pair of request.headers) {
      if (!Array.isArray(pair)) continue;
      const [name, value] = pair;
      if (typeof name !== "string" || typeof value !== "string" || !HEADER_NAME_PATTERN.test(name)) continue;
      const key = name.toLowerCase();
      headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
    }
    const previewHost = requestUrl.host;
    headers.host = previewHost;
    headers["x-forwarded-host"] = previewHost;
    headers["x-forwarded-prefix"] = this.location.machineRoot;
    headers["x-forwarded-proto"] = requestUrl.protocol.replace(":", "");
    headers["x-forwarded-uri"] = requestUrl.pathname + requestUrl.search;
    const jarCookies = this.jar.headerFor(requestUrl.pathname);
    if (jarCookies) {
      headers.cookie = headers.cookie ? `${headers.cookie}; ${jarCookies}` : jarCookies;
    }
    const body = request.body && request.body.byteLength > 0 ? new Uint8Array(request.body) : null;

    const completed = this.options.onRequestStart?.({ method, url: path });
    this.setPending(1);
    let response: KernelHttpResponse;
    try {
      response = await this.options.kernel.fetchInKernel(
        this.options.port,
        { method, url: path, headers, body },
        { timeoutMs: this.options.timeoutMs, hostname: this.options.hostname },
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.options.debugLog?.(`preview fetch failed: ${method} ${path}: ${text}`);
      completed?.(null, text);
      if (request.navigation) this.options.onNavigation?.({ path, status: null, method });
      throw error;
    } finally {
      this.setPending(-1);
    }
    completed?.(response.status);
    let shaped: PreviewResponse;
    try {
      shaped = this.shape(response, requestUrl, method);
    } catch (error) {
      if (request.navigation) this.options.onNavigation?.({ path, status: null, method });
      throw error;
    }
    // After shaping, so the jar already holds this response's cookies.
    if (request.navigation) this.options.onNavigation?.({ path, status: shaped.status, method });
    return shaped;
  }

  private shape(response: KernelHttpResponse, requestUrl: URL, method: string): PreviewResponse {
    const headers = new Headers();
    const setCookies: string[] = [];
    for (const [key, value] of Object.entries(response.headers)) {
      const lower = key.toLowerCase();
      if (lower === "set-cookie") {
        // The in-kernel parser joins repeated Set-Cookie lines with "\n".
        // They are consumed here and never returned to the browser.
        setCookies.push(...value.split("\n"));
        continue;
      }
      if (HOP_BY_HOP.has(lower)) continue;
      try {
        headers.append(key, value);
      } catch {
        // A header value the Fetch API cannot carry is dropped, not invented.
      }
    }
    this.jar.store(setCookies);

    let status = response.status;
    if (status < 200 || status > 599) {
      throw new Error(`Guest server answered with HTTP status ${status}, which a preview cannot carry`);
    }
    const location = headers.get("location");
    if (status >= 300 && status < 400 && location) {
      headers.set("location", rewriteLocation(location, requestUrl, this.location));
      if ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD") status = 303;
      return { status, headers, body: new Uint8Array(0) };
    }
    const link = headers.get("link");
    if (link) headers.set("link", rewriteSameHostUrls(link, this.location));

    // The guest's own policy decides whether a helper script may be added,
    // before any framing translation below adds a policy of Kandelo's. An
    // application's script policy is its own: never insert an undeclared
    // inline helper into a document whose CSP governs scripts.
    const guestRestrictsScripts = cspRestrictsScripts(headers.get("content-security-policy"));
    translateFramePolicy(headers, this.options.appOrigin);
    let body = response.body;
    if (shouldRewriteBody(headers)) {
      const text = new TextDecoder().decode(body);
      let rewritten = rewriteSameHostUrls(text, this.location);
      const type = (headers.get("content-type") ?? "").toLowerCase();
      if (type.startsWith("text/html") && !guestRestrictsScripts) {
        rewritten = injectBlobIframeInterceptor(rewritten, this.options.interceptorSource ?? "");
      }
      if (rewritten !== text) {
        body = new TextEncoder().encode(rewritten);
        headers.delete("content-length");
      }
    }
    return { status, headers, body };
  }

  private async serveProxyFetch(message: BridgeProxyFetch): Promise<BridgeResponseMessage> {
    let target: URL;
    try {
      target = new URL(String(message.url));
    } catch {
      throw new Error("Malformed cross-origin preview request");
    }
    const method = message.method === "HEAD" ? "HEAD" : message.method === "GET" ? "GET" : null;
    if (
      method === null || (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username || target.password ||
      target.origin === this.options.previewOrigin || target.origin === this.options.appOrigin
    ) {
      throw new Error("The preview may only read other sites with GET or HEAD");
    }
    if ((this.options.refusedProxyOrigins ?? []).includes(target.origin)) {
      throw new Error("A preview may not call Kandelo's CORS proxy or credential relay directly");
    }
    const headers = new Headers();
    if (Array.isArray(message.headers)) {
      for (const pair of message.headers) {
        if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
        if (PROXY_REQUEST_HEADERS.has(pair[0].toLowerCase())) headers.set(pair[0], pair[1]);
      }
    }
    const fetchImpl = this.options.fetch ?? fetch;
    // Credentialless and referrer-free: the Kandelo service worker routes
    // this through the deployment's CORS proxy like any page read, and its
    // credential gate refuses credentials as it does for every window.
    const response = await fetchImpl(target.href, {
      method,
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PROXY_BODY_BYTES) {
      throw new Error("Cross-origin preview response is too large");
    }
    const body = method === "HEAD" ? new ArrayBuffer(0) : await response.arrayBuffer();
    if (body.byteLength > MAX_PROXY_BODY_BYTES) {
      throw new Error("Cross-origin preview response is too large");
    }
    const out: [string, string][] = [];
    for (const name of PROXY_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) out.push([name, value]);
    }
    return {
      type: "http-response",
      v: PREVIEW_PROTOCOL_VERSION,
      id: message.id,
      status: response.status,
      headers: out,
      body,
    };
  }

  private setPending(delta: 1 | -1): void {
    this.pending = Math.max(0, this.pending + delta);
    this.options.onPendingRequests?.(this.pending);
  }
}
