/** Purpose-checked WebRTC connections, independent of their consumers. */
import {
  ChunkedMessageChannel,
  type ChunkedMessageChannelOptions,
} from "../../../host/src/migration/channel-chunked";

const CODE_PREFIX = "kandelo1:";
const MAX_CODE_LENGTH = 64 * 1024;
const GATHERING_WAIT_MS = 3000;
const CONNECTION_WAIT_MS = 30_000;
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const MAX_ICE_SERVERS = 8;
const MAX_ICE_SERVERS_TEXT = 8 * 1024;

/**
 * Parse a deployment's ICE server list, JSON in RTCIceServer form:
 * `[{"urls": "stun:stun.example:3478"}, {"urls": ["turn:…"], "username": "…", "credential": "…"}]`.
 * The list is deployment configuration, so a malformed one fails loudly
 * instead of falling back to the defaults and connecting through servers the
 * deployment did not choose.
 */
export function parseIceServers(text: string): RTCIceServer[] {
  if (text.length > MAX_ICE_SERVERS_TEXT) throw new Error("the ICE server list exceeds 8 KiB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the ICE server list is not JSON");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ICE_SERVERS) {
    throw new Error(`the ICE server list must be an array of 1 to ${MAX_ICE_SERVERS} servers`);
  }
  return value.map((entry, index) => {
    const where = `ICE server ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where} is not an object`);
    const { urls, username, credential, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`${where} has unknown fields: ${Object.keys(rest).join(", ")}`);
    const list = Array.isArray(urls) ? urls : [urls];
    if (list.length === 0 || !list.every((url) => typeof url === "string" && /^(stuns?|turns?):\S+$/i.test(url))) {
      throw new Error(`${where} needs stun:, stuns:, turn: or turns: urls`);
    }
    if (username !== undefined && typeof username !== "string") throw new Error(`${where} username must be a string`);
    if (credential !== undefined && typeof credential !== "string") throw new Error(`${where} credential must be a string`);
    const server: RTCIceServer = { urls: list as string[] };
    if (username !== undefined) server.username = username;
    if (credential !== undefined) server.credential = credential;
    return server;
  });
}

export interface PeerChannelDeclaration {
  readonly label: string;
  readonly options?: RTCDataChannelInit;
  /** Chunking requires ordered, reliable delivery. Omit for raw datagrams. */
  readonly chunking?: ChunkedMessageChannelOptions;
}

export interface PeerConnectionDeclaration {
  readonly purpose: string;
  readonly channels: readonly PeerChannelDeclaration[];
  readonly iceServers?: RTCIceServer[];
}

export interface PeerConnection {
  readonly channels: ReadonlyMap<string, RTCDataChannel>;
  readonly messages: ReadonlyMap<string, ChunkedMessageChannel>;
  /** Negotiated SCTP message ceiling, available once the channels open. */
  readonly maxMessageSize: number;
  onClose(listener: () => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): void;
}

export interface PeerConnectionInvite {
  readonly invite: string;
  acceptAnswer(answer: string): Promise<PeerConnection>;
  cancel(): void;
}

export interface PeerConnectionAnswer {
  readonly answer: string;
  readonly connected: Promise<PeerConnection>;
  cancel(): void;
}

interface Signal {
  type: "offer" | "answer";
  sdp: string;
  purpose: string;
  channels: string[];
}

function validateDeclaration(declaration: PeerConnectionDeclaration): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(declaration.purpose)) {
    throw new Error("the peer connection needs a declared purpose");
  }
  const labels = new Set<string>();
  if (declaration.channels.length === 0 || declaration.channels.length > 32) {
    throw new Error("declare between one and 32 peer channels");
  }
  for (const { label, options, chunking } of declaration.channels) {
    if (!label || label.length > 128 || labels.has(label)) {
      throw new Error("peer channel labels must be unique and bounded");
    }
    labels.add(label);
    if (options?.negotiated) {
      throw new Error("peer channels must use in-band negotiation");
    }
    if (chunking && (options?.ordered === false
      || options?.maxRetransmits !== undefined
      || options?.maxPacketLifeTime !== undefined)) {
      throw new Error("chunked peer channels require ordered, reliable delivery");
    }
  }
}

export function encodePeerSignal(
  description: RTCSessionDescriptionInit,
  declaration: PeerConnectionDeclaration,
): string {
  validateDeclaration(declaration);
  if ((description.type !== "offer" && description.type !== "answer") || !description.sdp) {
    throw new Error("a peer connect code needs an offer or answer with SDP");
  }
  const json = JSON.stringify({
    type: description.type, sdp: description.sdp,
    purpose: declaration.purpose,
    channels: declaration.channels.map(({ label }) => label).sort(),
  });
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > Math.floor((MAX_CODE_LENGTH - CODE_PREFIX.length) / 4) * 3) {
    throw new Error("the peer connect code exceeds 64 KiB");
  }
  const code = CODE_PREFIX + btoa(String.fromCharCode(...bytes));
  if (code.length > MAX_CODE_LENGTH) throw new Error("the peer connect code exceeds 64 KiB");
  return code;
}

function readPeerSignal(code: string): Signal {
  const trimmed = code.trim();
  if (trimmed.length > MAX_CODE_LENGTH || !trimmed.startsWith(CODE_PREFIX)) {
    throw new Error("this is not a bounded Kandelo connect code");
  }
  try {
    const bytes = Uint8Array.from(atob(trimmed.slice(CODE_PREFIX.length)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("the Kandelo connect code is malformed");
  }
}

/** The purpose a connect code declares, so a receiver can route it to its consumer. */
export function peerSignalPurpose(code: string): string {
  const signal = readPeerSignal(code);
  if (!signal || typeof signal.purpose !== "string") {
    throw new Error("the Kandelo connect code declares no purpose");
  }
  return signal.purpose;
}

export function decodePeerSignal(
  code: string,
  declaration: PeerConnectionDeclaration,
  type: "offer" | "answer",
): RTCSessionDescriptionInit {
  validateDeclaration(declaration);
  const signal = readPeerSignal(code);
  if (!signal || signal.type !== type || typeof signal.sdp !== "string" || !signal.sdp) {
    throw new Error(`the connect code must contain a ${type} with SDP`);
  }
  // SDP's application section contains no channel labels. Reject a different
  // consumer before allocating a connection or waiting for impossible channels.
  if (signal.purpose !== declaration.purpose) {
    throw new Error(`this connect code is for ${String(signal.purpose)}, expected ${declaration.purpose}`);
  }
  const labels = declaration.channels.map(({ label }) => label).sort();
  if (!Array.isArray(signal.channels)
    || JSON.stringify(signal.channels) !== JSON.stringify(labels)) {
    throw new Error("the connect code declares a different peer channel set");
  }
  return { type: signal.type, sdp: signal.sdp };
}

function gatheringSettled(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState === "complete") settle();
    };
    const timer = setTimeout(settle, GATHERING_WAIT_MS);
    connection.addEventListener("icegatheringstatechange", check);
  });
}

/** Own incoming channels and their delivery settings from arrival. */
function connectionLifecycle(declaration: PeerConnectionDeclaration) {
  const iceServers = declaration.iceServers ?? ICE_SERVERS;
  const hasTurn = iceServers.some(({ urls }) =>
    (Array.isArray(urls) ? urls : [urls]).some((url) => /^turns?:/i.test(url)));
  const rtc = new RTCPeerConnection({ iceServers });
  const channels = new Map<string, RTCDataChannel>();
  const messages = new Map<string, ChunkedMessageChannel>();
  const closeListeners = new Set<() => void>();
  const failureListeners = new Set<(error: Error) => void>();
  const readyListeners = new Set<() => void>();
  let closed = false;
  let failure: Error | null = null;
  let connectionFailure: Error | null = null;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    connectionFailure = error ?? null;
    failure = error ?? new Error("the peer connection closed before connecting");
    for (const channel of messages.values()) channel.close();
    for (const channel of channels.values()) channel.close();
    rtc.close();
    for (const listener of [...readyListeners]) listener();
    if (error) for (const listener of [...failureListeners]) listener(error);
    for (const listener of [...closeListeners]) listener();
  };
  const link: PeerConnection = {
    channels, messages,
    get maxMessageSize() { return rtc.sctp?.maxMessageSize ?? 65536; },
    onClose: (listener) => {
      if (closed) listener();
      else closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    onFailure: (listener) => {
      // Setup awaits can finish after ICE fails; retain the real failure for
      // consumers that subscribe after that handoff, as onClose already does.
      if (connectionFailure) listener(connectionFailure);
      else if (!closed) failureListeners.add(listener);
      return () => { failureListeners.delete(listener); };
    },
    close: () => close(),
  };
  const register = (channel: RTCDataChannel) => {
    const declared = declaration.channels.find(({ label }) => label === channel.label);
    if (!declared || channels.has(channel.label) || closed) {
      channel.close();
      close(new Error("the peer sent an undeclared or duplicate channel"));
      return;
    }
    const options = declared.options;
    if (channel.ordered !== (options?.ordered ?? true)
      || channel.maxRetransmits !== (options?.maxRetransmits ?? null)
      || channel.maxPacketLifeTime !== (options?.maxPacketLifeTime ?? null)
      || channel.protocol !== (options?.protocol ?? "")) {
      channel.close();
      close(new Error("the peer channel delivery settings do not match the declaration"));
      return;
    }
    channel.binaryType = "arraybuffer";
    channels.set(channel.label, channel);
    if (declared.chunking) messages.set(channel.label, new ChunkedMessageChannel(channel, declared.chunking));
    channel.addEventListener("open", () => {
      for (const listener of [...readyListeners]) listener();
    });
    channel.addEventListener("close", () => close());
    channel.addEventListener("error", () => close(new Error(`peer channel ${channel.label} failed`)));
    for (const listener of [...readyListeners]) listener();
  };
  rtc.addEventListener("datachannel", (event) => register(event.channel));
  rtc.addEventListener("connectionstatechange", () => {
    if (rtc.connectionState === "failed") {
      close(new Error(hasTurn
        ? "the peer connection failed — no route between the peers with the configured ICE servers"
        : "the peer connection failed — no direct route between the peers, and no TURN relay is configured"));
    } else if (rtc.connectionState === "closed") close();
    for (const listener of [...readyListeners]) listener();
  });
  const connected = () => new Promise<PeerConnection>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (closed) finish(() => reject(failure));
      else if (channels.size === declaration.channels.length
        && [...channels.values()].every((channel) => channel.readyState === "open")) {
        finish(() => resolve(link));
      } else if (rtc.connectionState === "connected" && timer === undefined) {
        // A human may take minutes to carry the answer back. Bound missing
        // channel arrival only after ICE connects, not that manual exchange.
        timer = setTimeout(() => close(new Error(
          "the peer connection timed out waiting for its declared channels",
        )), CONNECTION_WAIT_MS);
      }
    };
    const finish = (done: () => void) => {
      clearTimeout(timer);
      readyListeners.delete(settle);
      done();
    };
    readyListeners.add(settle);
    settle();
  });
  return { rtc, register, connected, close };
}

export async function createPeerConnectionInvite(
  declaration: PeerConnectionDeclaration,
): Promise<PeerConnectionInvite> {
  validateDeclaration(declaration);
  const lifecycle = connectionLifecycle(declaration);
  const { rtc } = lifecycle;
  try {
    for (const { label, options } of declaration.channels) lifecycle.register(rtc.createDataChannel(label, options));
    await rtc.setLocalDescription(await rtc.createOffer());
    await gatheringSettled(rtc);
    return {
      invite: encodePeerSignal(rtc.localDescription!, declaration),
      acceptAnswer: async (answer) => {
        try {
          await rtc.setRemoteDescription(decodePeerSignal(answer, declaration, "answer"));
          return await lifecycle.connected();
        } catch (error) {
          lifecycle.close();
          throw error;
        }
      },
      cancel: () => lifecycle.close(),
    };
  } catch (error) {
    lifecycle.close();
    throw error;
  }
}

export async function answerPeerConnectionInvite(
  invite: string,
  declaration: PeerConnectionDeclaration,
): Promise<PeerConnectionAnswer> {
  const description = decodePeerSignal(invite, declaration, "offer");
  const lifecycle = connectionLifecycle(declaration);
  try {
    await lifecycle.rtc.setRemoteDescription(description);
    await lifecycle.rtc.setLocalDescription(await lifecycle.rtc.createAnswer());
    await gatheringSettled(lifecycle.rtc);
    const connected = lifecycle.connected();
    // The caller may publish its answer before awaiting the connection.
    // Attach a handler now; cancellation must not be an unhandled rejection.
    void connected.catch(() => {});
    return {
      answer: encodePeerSignal(lifecycle.rtc.localDescription!, declaration),
      connected,
      cancel: () => lifecycle.close(),
    };
  } catch (error) {
    lifecycle.close();
    throw error;
  }
}
