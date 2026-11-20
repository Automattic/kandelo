// The internals tool of a delo computer: a panel with the kernel's process
// table, read again on every process event while the panel is open.

import type { KernelHost, ProcessInfo } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { wirePanel } from "./panel";

const COLUMNS: (keyof ProcessInfo)[] = ["pid", "ppid", "user", "state", "cmdline"];

export function wireInternals(host: KernelHost, button: HTMLButtonElement, panel: HTMLElement): void {
  const table = panel.querySelector("tbody");
  const error = panel.querySelector(".delo-panel-error");
  if (!(table instanceof HTMLTableSectionElement) || !(error instanceof HTMLElement)) throw new Error("The internals panel is missing its table or error element.");
  wirePanel(button, panel, () => {
    let open = true;
    const render = () => {
      host.enumProcs().then((procs) => {
        if (!open) return;
        error.hidden = true;
        table.replaceChildren(...procs.map((proc) => {
          const row = document.createElement("tr");
          for (const column of COLUMNS) {
            const cell = document.createElement("td");
            cell.textContent = String(proc[column]);
            row.append(cell);
          }
          return row;
        }));
      }, (reason) => {
        if (!open) return;
        table.replaceChildren();
        error.textContent = `the process table could not be read: ${reason instanceof Error ? reason.message : String(reason)}`;
        error.hidden = false;
      });
    };
    const process = host.subscribeProcessEvents(render);
    const status = host.subscribeStatus(render);
    render();
    return () => {
      open = false;
      process();
      status();
    };
  });
}
