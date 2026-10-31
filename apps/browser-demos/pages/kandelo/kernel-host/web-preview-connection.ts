import type { BrowserKernel } from "@host/browser-kernel-host";
import type { LiveKernelHost, WebPreviewState, WebPreviewTarget } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { setupServiceWorkerFetchBridge } from "../../../lib/init/sw-bridge-fetch";
import { observePreviewRequest } from "../panes/preview-progress";
import { validateWebPreviewTarget } from "../../../../../web-libs/kandelo-session/src/web-preview-address";

/** A boot-scoped preview connection; changing destinations retires its bridge. */
export class WebPreviewConnection {
  private sequence = 0;
  private disposeBridge?: () => void;
  private original: WebPreviewState | null | undefined;
  private network = false;
  private pendingNetwork = false;
  private opening = false;
  constructor(private host: LiveKernelHost, private kernel: BrowserKernel,
    private swUrl: string, private scope: string, private isCurrent: () => boolean) {}

  async open(target: WebPreviewTarget): Promise<void> {
    validateWebPreviewTarget(target);
    if (this.opening) throw new Error("A web preview connection is already in progress; wait for it to finish");
    this.opening = true;
    const hostname = target.hostname;
    const local = hostname === "localhost" || hostname === "127.0.0.1";
    const path = target.path ?? "/";
    const current = ++this.sequence;
    this.pendingNetwork = !local;
    const active = () => this.isCurrent() && this.sequence === current;
    let preparedBridge: Awaited<ReturnType<typeof setupServiceWorkerFetchBridge>> | undefined;
    try {
      // Keep the working page until the next destination has answered.
      const response = await this.kernel.fetchInKernel(target.port, {
        method: "GET", url: path.split("#", 1)[0]!, headers: { Host: `${hostname}:${target.port}` }, body: null,
      }, { hostname: local ? undefined : hostname, timeoutMs: 90_000, maxResponseBytes: 64 * 1024 * 1024 });
      if (!active()) throw new Error("Web preview connection was replaced");
      if (response.status >= 500) throw new Error(`Web server returned HTTP ${response.status}`);
      preparedBridge = await setupServiceWorkerFetchBridge(this.swUrl, this.scope, this.kernel, target.port, crypto.randomUUID(), {
        hostname: local ? undefined : hostname,
        timeoutMs: 90_000,
        onRequestStart: request => active() ? observePreviewRequest(this.host, request.url) : undefined,
        onPendingRequests: count => { if (active()) this.host.setWebPreviewPendingRequests(count); },
      });
      if (!active()) throw new Error("Web preview connection was replaced");
      if (this.original === undefined) this.original = this.host.getWebPreview();
      this.disposeBridge?.();
      this.disposeBridge = preparedBridge.dispose;
      this.network = !local;
      this.host.setWebPreview({ label: target.label ?? `${hostname}:${target.port}`, url: preparedBridge.appPrefix,
        destination: { hostname, port: target.port }, initialPath: path, port: local ? target.port : undefined, status: "running" });
      preparedBridge = undefined;
    } finally {
      this.opening = false;
      preparedBridge?.dispose();
      if (active()) this.pendingNetwork = false;
    }
  }
  closeNetwork(): void {
    if (this.network) this.close();
    else if (this.pendingNetwork) { this.sequence++; this.pendingNetwork = false; }
  }
  private close(): void {
    this.sequence++;
    this.disposeBridge?.(); this.disposeBridge = undefined;
    this.network = false;
    if (this.original !== undefined && this.isCurrent()) this.host.setWebPreview(this.original);
    this.original = undefined;
  }
  dispose(): void {
    this.sequence++; this.disposeBridge?.(); this.disposeBridge = undefined;
    this.original = undefined;
  }
}
