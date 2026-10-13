import * as React from "react";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { answerNetworkInvite, attachNetworkBridge, createNetworkInvite } from "../../../lib/network-peer";
import { NetworkSessionController, sessionInvitation, type SessionState } from "../../../lib/network-session";

/**
 * Where rooms live. A deployment names its piplet with
 * VITE_KANDELO_SIGNALLING_URL; the dev server relays a local one. Without
 * either, sessions are unavailable and the panel says so.
 */
function signallingServer(): string | null {
  const configured = import.meta.env.VITE_KANDELO_SIGNALLING_URL as string | undefined;
  if (configured) return new URL(configured, location.href).href;
  if (import.meta.env.DEV) return new URL(`${import.meta.env.BASE_URL}__kandelo_signalling`, location.href).href;
  return null;
}

const transport = { createInvite: createNetworkInvite, answerInvite: answerNetworkInvite, bridge: attachNetworkBridge };

export function useNetworkSession(host: KernelHost) {
  const controller = React.useMemo(() => new NetworkSessionController({
    machine: () => host.getStatus() === "running" ? host : null,
    server: signallingServer,
    transport,
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
    // A session belongs to one running machine; booting another ends it.
    let previous = host.getStatus();
    const off = host.subscribeStatus((status) => {
      if (previous === "running" && status !== "running" && controller.getState().phase !== "offline") void controller.leave();
      previous = status;
    });
    return () => { off(); void controller.leave(); };
  }, [host, controller]);

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
    /** Decline the invitation this page was opened with. */
    dismissInvitation: () => setInvitation(null),
  };
}
export type NetworkSession = ReturnType<typeof useNetworkSession>;
export type { SessionState };
