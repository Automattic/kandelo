import { createPeerConnectionInvite, answerPeerConnectionInvite, type PeerConnectionDeclaration, type PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection";
import { bridgeRemoteSegmentChannels } from "@host/networking/remote-segment-browser";

/** Independent machines use ordinary UDP; sharing keeps its migration declaration. */
const declaration: PeerConnectionDeclaration = {
  purpose: "network",
  channels: [
    { label: "udp", options: { ordered: false, maxRetransmits: 0 } },
    { label: "network-control", options: { ordered: true } },
  ],
};
export const createNetworkInvite = () => createPeerConnectionInvite(declaration);
export const answerNetworkInvite = (code: string) => answerPeerConnectionInvite(code, declaration);
export function attachNetworkBridge(link: PeerConnection) {
  return bridgeRemoteSegmentChannels(link.channels.get("udp")!, link.channels.get("network-control")!, link.maxMessageSize, () => link.close());
}
