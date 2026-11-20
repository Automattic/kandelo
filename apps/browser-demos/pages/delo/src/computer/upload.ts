// The upload tool of a delo computer: a file picker that offers the chosen
// files to the computer through Kandelo exchange, and a panel with each
// batch's status. The computer's exchange agent decides where they go.

import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { wirePanel } from "./panel";

export function wireUpload(host: KernelHost, button: HTMLButtonElement, panel: HTMLElement): void {
  const picker = panel.querySelector("input[type=file]");
  const choose = panel.querySelector("button");
  const list = panel.querySelector("ul");
  if (!(picker instanceof HTMLInputElement) || !(choose instanceof HTMLButtonElement) || !(list instanceof HTMLUListElement)) {
    throw new Error("The upload panel is missing its picker, button, or list.");
  }
  const exchange = host.getExchange();
  const render = () => {
    list.replaceChildren(...exchange.batches.map((batch) => {
      const item = document.createElement("li");
      item.className = `delo-batch is-${batch.phase}`;
      const name = document.createElement("span");
      name.textContent = batch.names.join(", ");
      const status = document.createElement("span");
      status.className = "delo-batch-status";
      status.textContent = batch.status || batch.phase;
      item.append(name, status);
      return item;
    }));
    list.hidden = list.children.length === 0;
  };
  exchange.subscribeBatches(render);
  render();
  choose.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])];
    picker.value = "";
    if (files.length === 0) return;
    void exchange.offer(files.map((file) => ({ name: file.name, source: file, mimeType: file.type || undefined, modifiedMs: file.lastModified })), "picker");
  });
  wirePanel(button, panel);
}
