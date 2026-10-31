import * as React from "react";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { answerNetworkInvite, attachNetworkBridge, createNetworkInvite } from "../../../lib/network-peer";
import { NetworkSessionController, sessionInvitation, type SessionState } from "../../../lib/network-session";

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

export type InitialSessionInvitation = ReturnType<typeof sessionInvitation>;

export function useNetworkSession(host: KernelHost, initiallyOpen = true, dismissed = false, initialInvitation?: InitialSessionInvitation) {
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
    const found = initialInvitation === undefined ? sessionInvitation(location.href) : initialInvitation;
    if (found) {
      const url = new URL(location.href);
      url.searchParams.delete("network"); url.searchParams.delete("networkName");
      if (found.offer) url.hash = "";
      history.replaceState(history.state, "", url);
    }
    return dismissed ? null : found;
  });
  React.useEffect(() => {
    if (state.phase === "offline" || state.roomClosed) host.closeNetworkWebPreview?.();
  }, [host, state.phase, state.roomClosed]);
  // An invitation is spent once its room is gone or this computer leaves.
  React.useEffect(() => { if (state.roomClosed) setInvitation(null); }, [state.roomClosed]);
  React.useEffect(() => { if (state.phase === "connected" && invitation && !invitation.offer) setInvitation(null); }, [state.phase, invitation]);
  const [open, setOpen] = React.useState(initiallyOpen && invitation !== null);

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
    /** Read immediately at asynchronous launch boundaries, before React renders. */
    getState: () => controller.getState(),
    available: signallingServer() !== null,
    publishDependencies: controller.publishDependencies.bind(controller),
    publishActivities: controller.publishActivities.bind(controller),
    receiveDependency: controller.receiveDependency.bind(controller),
    create: (name: string) => controller.create(name),
    join: (room: string, name: string) => controller.join(room, name),
    leave,
    /** Decline the invitation this page was opened with. */
    dismissInvitation: () => setInvitation(null),
  };
}
export type NetworkSession = ReturnType<typeof useNetworkSession>;
export type { SessionState };
