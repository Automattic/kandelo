import * as React from "react";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { answerNetworkInvite, attachNetworkBridge, createNetworkInvite } from "../../../lib/network-peer";
import { NetworkSessionController, sessionInvitation, type SessionState, type SharingPartner } from "../../../lib/network-session";
import { answerSharingInvite, createSharingInvite } from "../../../lib/sharing-peer";

/**
 * Production uses signalling/piplet.php under the deployment base unless
 * overridden with VITE_KANDELO_SIGNALLING_URL; dev relays a local piplet.
 */
function signallingServer(): string | null {
  const configured = import.meta.env.VITE_KANDELO_SIGNALLING_URL as string | undefined;
  if (configured) return new URL(configured, location.href).href;
  if (import.meta.env.DEV) return new URL(`${import.meta.env.BASE_URL}__kandelo_signalling`, location.href).href;
  return new URL(`${import.meta.env.BASE_URL}signalling/piplet.php`, location.href).href;
}

const transport = { createInvite: createNetworkInvite, answerInvite: answerNetworkInvite, bridge: attachNetworkBridge };
const sharing = { createInvite: createSharingInvite, answerInvite: answerSharingInvite };

export function useNetworkSession(host: KernelHost) {
  const controller = React.useMemo(() => new NetworkSessionController({
    machine: () => host.getStatus() === "running" ? host : null,
    server: signallingServer,
    transport,
    sharing,
    pageHref: () => location.href,
  }), [host]);
  const state = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    () => controller.getState(),
  );
  // A link only names a session. Joining it waits for the person's click,
  // because joining reveals this computer's network address to the host.
  //
  // The room token is a capability, so it is read into memory once and taken
  // out of the address bar at once. Left there, it would ride along wherever
  // the page URL goes: launching another computer keeps unrelated parameters,
  // and the Share dialog builds machine links from the current address. Kept
  // in memory, an unjoined invitation still survives a machine switch.
  const [invitation, setInvitation] = React.useState(() => {
    const found = sessionInvitation(location.href);
    if (found) {
      const url = new URL(location.href);
      url.searchParams.delete("network"); url.searchParams.delete("networkName");
      history.replaceState(history.state, "", url);
    }
    return found;
  });
  // An invitation is spent once its room is gone or this computer leaves.
  React.useEffect(() => { if (state.roomClosed) setInvitation(null); }, [state.roomClosed]);
  const [open, setOpen] = React.useState(invitation !== null);

  React.useEffect(() => {
    // The guest network belongs to one running machine, so a machine switch
    // detaches it; the session and its sharing links outlive the switch.
    let previous = host.getStatus();
    const off = host.subscribeStatus((status) => {
      if (previous === "running" && status !== "running") void controller.machineChanged();
      previous = status;
    });
    return () => { off(); void controller.leave(); };
  }, [host, controller]);

  // One sharing pair at a time. A joiner's one partner is the host; the host
  // picks among its joiners, and a lone joiner needs no picking.
  const [chosen, setChosen] = React.useState<string | null>(null);
  const partner: SharingPartner | null = state.partners.find((candidate) => candidate.id === chosen)
    ?? (state.partners.length === 1 ? state.partners[0]! : null);

  const leave = React.useCallback(async () => {
    await controller.leave();
    setInvitation(null);
  }, [controller]);

  return {
    state, open, setOpen, invitation,
    available: signallingServer() !== null,
    create: (name: string) => controller.create(name),
    join: (room: string, name: string) => controller.join(room, name),
    leave,
    partner,
    choosePartner: setChosen,
    /**
     * Give this computer's machine up to watch the partner's. An invitation
     * boots the session's machine here, so this machine is that copy.
     */
    watch: () => host.releaseMachine(),
    /** Decline the invitation this page was opened with. */
    dismissInvitation: () => setInvitation(null),
  };
}
export type NetworkSession = ReturnType<typeof useNetworkSession>;
export type { SessionState };
