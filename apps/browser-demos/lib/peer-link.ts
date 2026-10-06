/** Session sharing consumes a generic, purpose-checked peer connection. */
import type { ChunkedMessageChannel } from "@host/migration/channel-chunked";
import {
  answerPeerConnectionInvite,
  createPeerConnectionInvite,
  type PeerConnection,
  type PeerConnectionDeclaration,
} from "../../../web-libs/kandelo-session/src/peer-connection";

const HANDOVER = "kandelo-checkpoint-handover";
const MIRROR = "kandelo-framebuffer-mirror";
const TERMINAL = "kandelo-terminal-mirror";
const REPLICATION = "kandelo-replication-log";

export const MIGRATION_PEER_CONNECTION: PeerConnectionDeclaration = {
  purpose: "migration",
  channels: [
    { label: HANDOVER, chunking: {} },
    // Mirrored frames are droppable. Keep their buffer shallow; handover and
    // replication retain the deep default so accepted state is never dropped.
    { label: MIRROR, chunking: { highWaterBytes: 128 * 1024, lowWaterBytes: 32 * 1024 } },
    { label: TERMINAL, chunking: {} },
    { label: REPLICATION, chunking: {} },
  ],
};

export interface PeerLink {
  readonly handover: ChunkedMessageChannel;
  readonly mirror: ChunkedMessageChannel;
  readonly terminal: ChunkedMessageChannel;
  readonly replication: ChunkedMessageChannel;
  onClose(listener: () => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): void;
}

export interface PeerInvite {
  readonly invite: string;
  acceptAnswer(answer: string): Promise<PeerLink>;
  cancel(): void;
}

function migrationLink(connection: PeerConnection): PeerLink {
  return {
    handover: connection.messages.get(HANDOVER)!,
    mirror: connection.messages.get(MIRROR)!,
    terminal: connection.messages.get(TERMINAL)!,
    replication: connection.messages.get(REPLICATION)!,
    onClose: connection.onClose,
    onFailure: connection.onFailure,
    close: connection.close,
  };
}

export async function createMigrationPeerInvite(): Promise<PeerInvite> {
  const invite = await createPeerConnectionInvite(MIGRATION_PEER_CONNECTION);
  return {
    invite: invite.invite,
    acceptAnswer: async (answer) => migrationLink(await invite.acceptAnswer(answer)),
    cancel: invite.cancel,
  };
}

export async function answerMigrationPeerInvite(
  code: string,
): Promise<{ answer: string; connected: Promise<PeerLink>; cancel(): void }> {
  const response = await answerPeerConnectionInvite(code, MIGRATION_PEER_CONNECTION);
  const connected = response.connected.then(migrationLink);
  void connected.catch(() => {});
  return { answer: response.answer, connected, cancel: response.cancel };
}
