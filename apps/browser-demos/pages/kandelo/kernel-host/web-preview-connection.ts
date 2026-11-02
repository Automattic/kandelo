import type { BrowserKernel } from "@host/browser-kernel-host";
import type { LiveKernelHost, WebPreviewState, WebPreviewTarget } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PreviewBridgeHost } from "../../../lib/preview/preview-bridge";
import { openMachinePreview } from "./machine-preview";

/** A boot-scoped preview connection; changing destinations retires its bridge. */
export class WebPreviewConnection {
  private sequence = 0;
  private disposeBridge?: () => void;
  private original: WebPreviewState | null | undefined;
  private network = false;
  private pendingNetwork = false;
  constructor(private host: LiveKernelHost, private kernel: BrowserKernel,
    private isCurrent: () => boolean) {}

  async open(target: WebPreviewTarget): Promise<void> {
    const hostname = target.hostname;
    const local = hostname === "localhost" || hostname === "127.0.0.1";
    if (!local && hostname !== "host" && !/^peer-(?:[1-9]\d{0,2})$/.test(hostname) && !/^10\.89\.0\.(?:[1-9]\d{0,2})$/.test(hostname)) throw new Error("Choose localhost or a computer on this Kandelo network");
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("Invalid web preview port");
    const path = target.path ?? "/";
    if (!path.startsWith("/") || path.startsWith("//") || path.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid web preview path");
    const current = ++this.sequence;
    this.pendingNetwork = !local;
    const active = () => this.isCurrent() && this.sequence === current;
    let preparedBridge: PreviewBridgeHost | undefined;
    try {
      // Keep the working page until the next destination has answered.
      const response = await this.kernel.fetchInKernel(target.port, {
        method: "GET", url: path.split("#", 1)[0]!, headers: { Host: `${hostname}:${target.port}` }, body: null,
      }, { hostname: local ? undefined : hostname, timeoutMs: 90_000, maxResponseBytes: 64 * 1024 * 1024 });
      if (!active()) throw new Error("Web preview connection was replaced");
      if (response.status >= 500) throw new Error(`Web server returned HTTP ${response.status}`);
      preparedBridge = await openMachinePreview(this.host, this.kernel, {
        port: target.port,
        hostname: local ? undefined : hostname,
        timeoutMs: 90_000,
        isCurrent: active,
      });
      if (!active()) throw new Error("Web preview connection was replaced");
      if (this.original === undefined) this.original = this.host.getWebPreview();
      this.disposeBridge?.();
      const bridge = preparedBridge;
      this.disposeBridge = () => bridge.dispose();
      this.network = !local;
      this.host.setWebPreview({ label: target.label ?? `${hostname}:${target.port}`, url: bridge.url, viewerUrl: bridge.viewerUrl,
        destination: { hostname, port: target.port }, initialPath: path, port: local ? target.port : undefined, status: "running" });
      preparedBridge = undefined;
    } finally {
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
