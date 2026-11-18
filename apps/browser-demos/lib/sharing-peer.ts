/**
 * The `sharing` peer connection: one machine shown to, followed by, or handed
 * to another computer.
 *
 * Four ordered, reliable, chunked channels — the checkpoint handover, the
 * framebuffer mirror, the terminal mirror and the replication decision log —
 * so the transports speak to a remote computer exactly as they speak to a
 * same-origin tab. Each label equals the BroadcastChannel name its transport
 * uses on one origin.
 */
import type { ChunkedMessageChannel } from "@host/migration/channel-chunked";
import {
  answerPeerConnectionInvite,
  createPeerConnectionInvite,
  parseIceServers,
  type PeerConnection,
  type PeerConnectionDeclaration,
} from "../../../web-libs/kandelo-session/src/peer-connection";

const HANDOVER_LABEL = "kandelo-checkpoint-handover";
const MIRROR_LABEL = "kandelo-framebuffer-mirror";
const TERMINAL_LABEL = "kandelo-terminal-mirror";
const REPLICATION_LABEL = "kandelo-replication-log";

/**
 * How much mirrored pixel traffic may wait in the wire's send buffer.
 *
 * Every queued byte is delay the watching computer sees, and a mirror frame
 * is droppable: the publisher would rather skip to the current frame than
 * deliver an old one. The handover keeps the deep default instead, because a
 * checkpoint is one message that wants the wire kept busy end to end. So does
 * the replication log: a skipped decision is a replica that stopped being the
 * same machine, so that traffic may be delayed but never dropped.
 */
const MIRROR_HIGH_WATER_BYTES = 128 * 1024;
const MIRROR_LOW_WATER_BYTES = 32 * 1024;

const declaration: PeerConnectionDeclaration = {
  purpose: "sharing",
  channels: [
    { label: HANDOVER_LABEL, chunking: {} },
    { label: MIRROR_LABEL, chunking: { highWaterBytes: MIRROR_HIGH_WATER_BYTES, lowWaterBytes: MIRROR_LOW_WATER_BYTES } },
    { label: TERMINAL_LABEL, chunking: {} },
    { label: REPLICATION_LABEL, chunking: {} },
  ],
};

/** A deployment's VITE_KANDELO_ICE_SERVERS apply here as they do to `network`. */
function sharingDeclaration(): PeerConnectionDeclaration {
  const configured = import.meta.env.VITE_KANDELO_ICE_SERVERS as string | undefined;
  return configured ? { ...declaration, iceServers: parseIceServers(configured) } : declaration;
}

export interface PeerLink {
  readonly handover: ChunkedMessageChannel;
  readonly mirror: ChunkedMessageChannel;
  readonly terminal: ChunkedMessageChannel;
  readonly replication: ChunkedMessageChannel;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface PeerInvite {
  readonly invite: string;
  acceptAnswer(answer: string): Promise<PeerLink>;
  cancel(): void;
}

export interface PeerAnswer {
  readonly answer: string;
  readonly connected: Promise<PeerLink>;
  cancel(): void;
}

function sharingLink(connection: PeerConnection): PeerLink {
  const channel = (label: string) => connection.messages.get(label)!;
  return {
    handover: channel(HANDOVER_LABEL),
    mirror: channel(MIRROR_LABEL),
    terminal: channel(TERMINAL_LABEL),
    replication: channel(REPLICATION_LABEL),
    onClose: (listener) => connection.onClose(listener),
    close: () => connection.close(),
  };
}

export async function createSharingInvite(): Promise<PeerInvite> {
  const invite = await createPeerConnectionInvite(sharingDeclaration());
  return {
    invite: invite.invite,
    acceptAnswer: async (answer) => sharingLink(await invite.acceptAnswer(answer)),
    cancel: () => invite.cancel(),
  };
}

export async function answerSharingInvite(code: string): Promise<PeerAnswer> {
  const answered = await answerPeerConnectionInvite(code, sharingDeclaration());
  const connected = answered.connected.then(sharingLink);
  void connected.catch(() => {});
  return { answer: answered.answer, connected, cancel: () => answered.cancel() };
}
