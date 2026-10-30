import * as React from "react";
import { createRoot } from "react-dom/client";
import { LiveKernelHost, type DmesgLine, type PtyHandle, type WebPreviewTarget } from "../../../../web-libs/kandelo-session/src/kernel-host";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Shell } from "../../pages/kandelo/panes/Shell";
import { Inspector } from "../../pages/kandelo/panes/Inspector";
import "../../pages/kandelo/tokens.css";
import "../../pages/kandelo/styles.css";

export function mountPreviewFixture(container: HTMLElement) {
  const host = new LiveKernelHost({ status: "running" });
  const requests: WebPreviewTarget[] = [];
  const errors: string[] = [];
  const history = ["\x1b]777;kandelo-preview;1;http://localhost:3000/history\x07HISTORY_END\r\n"];
  let sink: ((data: Uint8Array) => void) | undefined;
  const pty: PtyHandle = {
    write() {}, resize() {}, close() { sink = undefined; },
    onData(callback) {
      for (const chunk of history) callback(new TextEncoder().encode(chunk));
      sink = callback;
      return () => { if (sink === callback) sink = undefined; };
    },
  };
  host.attachPty = async () => pty;
  host.setWebPreviewHandler({ async open(target) { requests.push(target); }, closeNetwork() {}, dispose() {} });
  const root = createRoot(container);
  let generation = 0;
  const recordError = (message: string) => { errors.push(message); };
  const render = () => root.render(<KernelHostProvider host={host}><div style={{ height: 300 }}><Shell key={generation} onPreviewError={recordError} /></div><div style={{ height: 250 }}><Inspector tab="syslog" /></div></KernelHostProvider>);
  render();
  return {
    requests, errors,
    send(data: string) { history.push(data); sink?.(new TextEncoder().encode(data)); },
    remount() { generation++; render(); },
    log(line: DmesgLine) { host.pushDmesg(line); },
    dispose() { root.unmount(); },
  };
}
