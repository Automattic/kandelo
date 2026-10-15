import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Inspector } from "../../pages/kandelo/panes/Inspector";
import { LiveKernelHost, type KernelLike } from "../../../../web-libs/kandelo-session/src/kernel-host";

export function mountInspectorWithFailedInit(container: HTMLElement): () => void {
  const serviceLog = new TextEncoder().encode("frankenphp-classic panic: diagnostic retained");
  const directory = (name: string, mode: number, size = 0) => ({ name, mode, size, uid: 0, gid: 0 });
  const kernel = {
    readDirFromVfs: async (path: string) => {
      if (path === "/") return [directory("var", 0o040755)];
      if (path === "/var") return [directory("log", 0o040755)];
      if (path === "/var/log") return [directory("frankenphp-classic.log", 0o100644, serviceLog.byteLength)];
      return null;
    },
    readFileFromVfs: async (path: string) => path === "/var/log/frankenphp-classic.log" ? serviceLog : null,
  } as KernelLike;
  const host = new LiveKernelHost({ kernel, status: "running" });
  host.setStatus("error");
  const root = ReactDOM.createRoot(container);
  root.render(React.createElement(KernelHostProvider, { host }, React.createElement(Inspector, { tab: "vfs" })));
  return () => root.unmount();
}
