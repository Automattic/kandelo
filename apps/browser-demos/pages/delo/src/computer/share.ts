// The share tool of a delo computer: a panel with the computer's share link
// (see ../share.ts), copied to the clipboard when the panel opens. Returns
// the link, which option_share_read gives an agent.

import type { DeloDraft } from "../draft";
import type { DeloRegistry } from "../registry";
import { deloShareUrl } from "../share";
import { wirePanel } from "./panel";

export function wireShare(button: HTMLButtonElement, panel: HTMLElement, registry: DeloRegistry, draft: DeloDraft): string {
  const link = panel.querySelector("input");
  const status = panel.querySelector(".delo-share-status");
  if (!(link instanceof HTMLInputElement) || !(status instanceof HTMLElement)) throw new Error("The share panel is missing its link.");
  link.value = deloShareUrl(registry, draft, new URL("../", location.href).href);
  wirePanel(button, panel, () => {
    link.select();
    navigator.clipboard.writeText(link.value).then(
      () => { status.textContent = "the link is copied"; },
      () => { status.textContent = "copy the link"; },
    );
    return () => {};
  });
  return link.value;
}
