// The network tool of a delo computer: create a network session and share
// its link, or join one from a link another computer shared. The link is a
// delo session link (see ../share.ts); a computer page opened with one
// joins its session once the machine runs. The session
// controller and the WebRTC transport are the platform's
// (lib/network-session.ts, lib/network-peer.ts); every computer keeps its own
// machine, and only guest packets cross the link. The panel and the network
// tools an agent calls (see page-tools.ts) drive the same session.

import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { answerNetworkInvite, attachNetworkBridge, createNetworkInvite } from "../../../../lib/network-peer";
import { NetworkSessionController, sessionInvitation, type SessionState } from "../../../../lib/network-session";
import type { DeloDraft } from "../draft";
import type { DeloRegistry } from "../registry";
import { deloShareUrl, withDeloSession, withoutDeloSession } from "../share";
import { wirePanel } from "./panel";

/** Production serves signalling/piplet.php under the deployment base unless
 *  VITE_KANDELO_SIGNALLING_URL overrides it; the dev server relays a local
 *  piplet. */
function signallingServer(): string {
  const configured = import.meta.env.VITE_KANDELO_SIGNALLING_URL as string | undefined;
  if (configured) return new URL(configured, location.href).href;
  if (import.meta.env.DEV) return new URL(`${import.meta.env.BASE_URL}__kandelo_signalling`, location.href).href;
  return new URL(`${import.meta.env.BASE_URL}signalling/piplet.php`, location.href).href;
}

/** What the network tools return: the session as the panel shows it. */
export type DeloNetworkState = {
  phase: SessionState["phase"];
  /** The delo session link another computer joins with. */
  link: string | null;
  /** This computer's address in the session. */
  address: string | null;
  members: { address: string; hostname: string }[];
  error: string | null;
};

export interface DeloNetwork {
  read(): DeloNetworkState;
  create(): Promise<DeloNetworkState>;
  /** Join the session a link names; throws when it names none. */
  join(link: string): Promise<DeloNetworkState>;
  leave(): Promise<DeloNetworkState>;
}

const PHASE: Record<SessionState["phase"], string> = {
  offline: "not in a network session",
  hosting: "creating the session",
  joining: "joining the session",
  connected: "connected",
  error: "the session failed",
};

export function wireNetwork(host: KernelHost, button: HTMLButtonElement, panel: HTMLElement, registry: DeloRegistry, draft: DeloDraft): DeloNetwork {
  const status = panel.querySelector(".delo-network-status");
  const offline = panel.querySelector(".delo-network-offline");
  const online = panel.querySelector(".delo-network-online");
  const create = panel.querySelector(".delo-network-create");
  const join = panel.querySelector(".delo-network-join");
  const invitation = panel.querySelector(".delo-network-invitation");
  const link = panel.querySelector(".delo-network-link");
  const copy = panel.querySelector(".delo-network-copy");
  const leave = panel.querySelector(".delo-network-leave");
  if (!(status instanceof HTMLElement) || !(offline instanceof HTMLElement) || !(online instanceof HTMLElement)
    || !(create instanceof HTMLButtonElement) || !(join instanceof HTMLFormElement) || !(invitation instanceof HTMLInputElement)
    || !(link instanceof HTMLInputElement) || !(copy instanceof HTMLButtonElement) || !(leave instanceof HTMLButtonElement)) {
    throw new Error("The network panel is missing an element.");
  }
  const controller = new NetworkSessionController({
    machine: () => host.getStatus() === "running" ? host : null,
    server: signallingServer,
    transport: { createInvite: createNetworkInvite, answerInvite: answerNetworkInvite, bridge: attachNetworkBridge },
    pageHref: () => location.href,
  });
  const render = (state: SessionState) => {
    const lines = [state.error ?? PHASE[state.phase]];
    if (state.snapshot?.address) lines.push(`address ${state.snapshot.address}`);
    if (state.snapshot) lines.push(`${state.snapshot.members.length} ${state.snapshot.members.length === 1 ? "member" : "members"}`);
    status.textContent = lines.join(" · ");
    status.classList.toggle("is-error", state.phase === "error");
    offline.hidden = state.phase !== "offline" && state.phase !== "error";
    online.hidden = !offline.hidden;
    link.value = linkOf(state);
    copy.disabled = state.link === null;
  };
  const linkOf = (state: SessionState) => state.link === null ? "" : withDeloSession(share, state.room!, state.name!);
  const share = deloShareUrl(registry, draft, new URL("../", location.href).href);
  controller.subscribe(render);
  render(controller.getState());
  const fail = (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("is-error");
  };
  create.addEventListener("click", () => controller.create(draft.name).catch(fail));
  const joinLink = (href: string) => {
    const found = sessionInvitation(href);
    if (found === null) throw new Error("this is not a network session link");
    return controller.join(found.room, found.name);
  };
  join.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      joinLink(invitation.value.trim()).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
  copy.addEventListener("click", () => {
    link.select();
    navigator.clipboard.writeText(link.value).catch(() => {});
  });
  leave.addEventListener("click", () => controller.leave().catch(fail));
  let invited = sessionInvitation(location.href);
  if (invited !== null) history.replaceState(history.state, "", withoutDeloSession(location.href));
  const accept = () => {
    if (invited === null || host.getStatus() !== "running") return;
    const { room, name } = invited;
    invited = null;
    controller.join(room, name).catch(fail);
  };
  host.subscribeStatus((machine) => {
    if (machine !== "running" && controller.getState().phase !== "offline") void controller.leave();
    accept();
  });
  wirePanel(button, panel);
  if (invited !== null) button.click();
  accept();
  const read = (): DeloNetworkState => {
    const state = controller.getState();
    return {
      phase: state.phase,
      link: linkOf(state) || null,
      address: state.snapshot?.address ?? null,
      members: state.snapshot?.members.map(({ address, hostname }) => ({ address, hostname })) ?? [],
      error: state.error,
    };
  };
  return {
    read,
    create: () => controller.create(draft.name).then(read),
    join: (href) => joinLink(href).then(read),
    leave: () => controller.leave().then(read),
  };
}
