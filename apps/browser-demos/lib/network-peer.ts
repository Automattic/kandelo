import { createPeerConnectionInvite, answerPeerConnectionInvite, type PeerConnectionDeclaration, type PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection";
import { bridgeRemoteSegmentChannels } from "@host/networking/remote-segment-browser";

/** Independent machines use ordinary UDP and TCP; sharing keeps its migration declaration. */
const declaration: PeerConnectionDeclaration = {
  purpose: "network",
  channels: [
    { label: "udp", options: { ordered: false, maxRetransmits: 0 } },
    { label: "network-control-v2", options: { ordered: true } },
  ],
};
export const createNetworkInvite = () => createPeerConnectionInvite(declaration);
export const answerNetworkInvite = (code: string) => answerPeerConnectionInvite(code, declaration);
export function attachNetworkBridge(link: PeerConnection) {
  return bridgeRemoteSegmentChannels(link.channels.get("udp")!, link.channels.get("network-control-v2")!, link.maxMessageSize, () => link.close());
}
