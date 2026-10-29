/**
 * Browser entry for preview-service-worker.spec.ts: the real owner side of
 * a guest web preview (`PreviewRelay` + `PreviewBridgeHost`), bundled by the
 * spec with esbuild, over a fake kernel. Each machine answers
 * `bridge:<label>:<method>:<path>`, or one of the configured HTML pages, so
 * the spec drives the real relay, the real preview service worker and the
 * real owner logic in every engine without booting a machine.
 */
import { PreviewBridgeHost, type KernelHttpRequest } from "../../lib/preview/preview-bridge";
import { PreviewRelay } from "../../lib/preview/preview-relay";

interface OwnerConfig {
  preview: string;
  scope: string;
  interceptor: string;
  /** Path (without query) -> HTML served for it, for every machine. */
  pages: Record<string, string>;
  /** Machine name -> the secret it commits to. */
  secrets: Record<string, string>;
}

const page = window as unknown as Record<string, unknown> & { __ownerConfig: OwnerConfig };
const config = page.__ownerConfig;
const requests: Array<{ label: string; method: string; url: string }> = [];
const lost: Array<{ name: string; reason: string }> = [];
const hosts = new Map<string, PreviewBridgeHost>();
const relay = PreviewRelay.forPage(config.preview, config.scope);
const encode = (text: string) => new TextEncoder().encode(text);

page.__requests = requests;
page.__lost = lost;
page.__workerChanges = 0;
relay.onWorkerChanged(() => {
  page.__workerChanges = (page.__workerChanges as number) + 1;
});
page.__relayReady = relay.ready();
page.__open = async (name: string, label: string): Promise<string> => {
  const host = await PreviewBridgeHost.open({
    relay,
    previewOrigin: config.preview,
    scope: config.scope,
    appOrigin: location.origin,
    port: 80,
    interceptorSource: config.interceptor,
    mintIdentity: async () => ({ name, secret: config.secrets[name]! }),
    window,
    onLost: (reason) => lost.push({ name, reason }),
    kernel: {
      fetchInKernel: async (_port: number, request: KernelHttpRequest) => {
        requests.push({ label, method: request.method, url: request.url });
        const html = config.pages[request.url.split("?")[0]!];
        if (html !== undefined) {
          return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: encode(html) };
        }
        return {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: encode(`bridge:${label}:${request.method}:${request.url}`),
        };
      },
    },
  });
  hosts.set(name, host);
  return host.name;
};
page.__verify = (name: string) => hosts.get(name)?.verify();
page.__frame = (name: string, path: string) => new Promise<void>((resolve) => {
  const frame = document.createElement("iframe");
  frame.name = name;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.onload = () => resolve();
  frame.src = `${config.preview}${config.scope}computer/${name}${path}`;
  document.body.append(frame);
});
