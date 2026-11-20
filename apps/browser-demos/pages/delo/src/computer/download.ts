// The download tool of a delo computer: a panel with the files the computer
// publishes through Kandelo exchange (`kandelo-publish`), each with Save,
// which hands its bytes to the browser, and Dismiss. Either one releases the
// file from the computer.

import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { wirePanel } from "./panel";

export function wireDownload(host: KernelHost, button: HTMLButtonElement, panel: HTMLElement): void {
  const list = panel.querySelector("ul");
  const empty = panel.querySelector(".delo-panel-empty");
  if (!(list instanceof HTMLUListElement) || !(empty instanceof HTMLElement)) throw new Error("The download panel is missing its list.");
  const exchange = host.getExchange();
  const save = async (id: string, name: string, type: string | undefined) => {
    const blob = await new Response(exchange.readOutput(id)).blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(type === undefined ? blob : new Blob([blob], { type }));
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    exchange.finishOutput(id);
  };
  const render = () => {
    const outputs = exchange.outputs;
    const label = outputs.length === 0 ? "Download" : `Download (${outputs.length})`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.classList.toggle("has-badge", outputs.length > 0);
    empty.hidden = outputs.length > 0;
    list.replaceChildren(...outputs.map((output) => {
      const item = document.createElement("li");
      item.className = "delo-output";
      const name = document.createElement("span");
      name.textContent = output.withdrawn ? `${output.name} (withdrawn)` : output.name;
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "delo-action";
      saveButton.textContent = "Save";
      saveButton.disabled = output.withdrawn;
      saveButton.addEventListener("click", () => save(output.id, output.name, output.mimeType).catch((error) => {
        name.textContent = `${output.name}: ${error instanceof Error ? error.message : String(error)}`;
      }));
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "delo-action";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => exchange.finishOutput(output.id));
      item.append(name, saveButton, dismiss);
      return item;
    }));
  };
  exchange.subscribeOutputs(render);
  render();
  wirePanel(button, panel);
}
