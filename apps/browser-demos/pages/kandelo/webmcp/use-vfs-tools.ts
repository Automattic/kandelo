import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import { modelContextOf } from "./model-context";
import { registerVfsTools } from "./vfs-tool-registration";

/**
 * Register the tools under /etc/mcp and /home/maker/mcp with the browser's
 * WebMCP API and follow both directories while the machine runs: a file
 * written or deleted in the guest registers or unregisters its tool. A reboot
 * or replacement aborts everything and registers the next image's tools afresh.
 * `terminal` names the PTY a tool call is announced on.
 */
export function useVfsTools(terminal: () => string | null): void {
  const host = useKernelHost();
  const status = useStatus();
  const latest = React.useRef(terminal);
  latest.current = terminal;

  React.useEffect(() => {
    if (status !== "running") return;
    const context = modelContextOf(document);
    if (!context) return;
    const controller = new AbortController();
    void registerVfsTools(host, context, controller.signal, () => latest.current()).catch((error) => {
      console.error("WebMCP: registering tools failed", error);
    });
    return () => controller.abort();
  }, [host, status]);
}
