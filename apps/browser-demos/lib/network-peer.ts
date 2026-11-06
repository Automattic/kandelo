import { DEPENDENCY_CHANNEL } from "../../../web-libs/kandelo-session/src/session-dependency-peer";
import { ACTIVITY_CHANNEL } from "../../../web-libs/kandelo-session/src/session-activity-peer";
import { createPeerConnectionInvite, answerPeerConnectionInvite, parseIceServers, type PeerConnectionDeclaration, type PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection";
import { bridgeRemoteSegmentChannels } from "@host/networking/remote-segment-browser";

/** Independent machines use ordinary UDP and TCP; sharing keeps its migration declaration. */
const declaration: PeerConnectionDeclaration = {
  purpose: "network-activities-v2",
  channels: [
    { label: DEPENDENCY_CHANNEL, options: { ordered: true } },
    { label: ACTIVITY_CHANNEL, options: { ordered: true } },
    { label: "udp", options: { ordered: false, maxRetransmits: 0 } },
    { label: "network-control-v2", options: { ordered: true } },
  ],
};
/**
 * A deployment names its ICE servers (STUN, and TURN for networks STUN cannot
 * cross) with VITE_KANDELO_ICE_SERVERS; without it the peer connection's
 * public STUN defaults apply. Parsed when a connection is made, so a
 * malformed list surfaces as that session's error rather than a broken page.
 */
function networkDeclaration(): PeerConnectionDeclaration {
  const configured = import.meta.env.VITE_KANDELO_ICE_SERVERS as string | undefined;
  return configured ? { ...declaration, iceServers: parseIceServers(configured) } : declaration;
}
export const createNetworkInvite = () => createPeerConnectionInvite(networkDeclaration());
export const answerNetworkInvite = (code: string) => answerPeerConnectionInvite(code, networkDeclaration());
export function attachNetworkBridge(link: PeerConnection) {
  return bridgeRemoteSegmentChannels(link.channels.get("udp")!, link.channels.get("network-control-v2")!, link.maxMessageSize, () => link.close());
}
