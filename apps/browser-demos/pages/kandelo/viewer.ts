/**
 * Kandelo viewer shell: what `<app origin><scope>computer/<name>/<path>` opens.
 *
 * Guest pages live on the preview origin, and a browser partitions service
 * workers by the top-level site (WebKit by the top-level origin), so a guest
 * page opened as its own tab may not reach the preview service worker that
 * holds the owning tab's bridge. This page is a Kandelo-origin document that
 * owns no machine: it embeds the relay and a sandboxed preview frame, which
 * land in the owner's partition and use the owner's bridge. It is the address
 * users share and terminal links open. See docs/browser-support.md, "Guest
 * web previews run on their own origin".
 */
import { NO_PREVIEW_ORIGIN_MESSAGE, configuredPreviewOrigin } from "../../lib/preview/config";
import { PreviewRelay } from "../../lib/preview/preview-relay";
import {
  PREVIEW_FRAME_ALLOW,
  PREVIEW_FRAME_SANDBOX,
  isLegacyMachineName,
  isMachineName,
} from "../../lib/preview/protocol";

const scope = import.meta.env.BASE_URL;
const status = document.querySelector<HTMLElement>(".kviewer-status")!;
const nameLabel = document.querySelector<HTMLElement>(".kviewer-name")!;

function show(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("is-error", error);
}

function start(): void {
  const base = `${scope}computer/`;
  const name = window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length).split("/")[0]
    : "";
  if (isLegacyMachineName(name)) {
    // Names used to be three words with nothing to prove ownership. Such a
    // link names no computer now; say so rather than guess at one.
    nameLabel.textContent = name;
    show(
      "This link uses an older Kandelo computer address, which no longer works. " +
        "Open the computer again from the tab that runs it to get its current address.",
      true,
    );
    return;
  }
  if (!isMachineName(name)) {
    show("This address does not name a Kandelo computer.", true);
    return;
  }
  nameLabel.textContent = name;
  document.title = `Kandelo computer ${name}`;
  let previewOrigin: string | null;
  try {
    previewOrigin = configuredPreviewOrigin();
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), true);
    return;
  }
  if (previewOrigin === null) {
    show(NO_PREVIEW_ORIGIN_MESSAGE, true);
    return;
  }
  const relay = PreviewRelay.forPage(previewOrigin, scope);
  let frame: HTMLIFrameElement | null = null;
  let offline = false;
  relay.onMachineStatus(name, () => {
    // Take the frame down: a machine that is not running has nothing to
    // show, and nothing it showed should stay interactive.
    offline = true;
    frame?.remove();
    frame = null;
    show("This computer is no longer running: the browser tab that ran it was closed. Reload to try again.", true);
  });
  relay.ready().then(() => {
    if (offline) return;
    frame = document.createElement("iframe");
    frame.className = "kviewer-frame";
    frame.title = `Kandelo computer ${name}`;
    frame.setAttribute("sandbox", PREVIEW_FRAME_SANDBOX);
    frame.allow = PREVIEW_FRAME_ALLOW;
    // The preview worker treats a navigation whose referrer is a Kandelo
    // page as Kandelo's own (see requesterMachine in
    // preview-origin/preview-service-worker.js).
    frame.referrerPolicy = "origin";
    frame.addEventListener("load", () => {
      if (!offline) show("Live");
    });
    frame.src = `${previewOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`;
    document.body.append(frame);
    show("Loading…");
  }, (error: unknown) => {
    show(error instanceof Error ? error.message : String(error), true);
  });
}

start();
