import { SessionDependencyPeer, DEPENDENCY_CHANNEL } from "../../../web-libs/kandelo-session/src/session-dependency-peer";
import { MAX_DEPENDENCY_BYTES, type OfferedDependency } from "../../../web-libs/kandelo-session/src/session-dependencies";
import { ACTIVITY_CHANNEL, SessionActivityPeer, activityOffersMessage } from "../../../web-libs/kandelo-session/src/session-activity-peer";
/**
 * Network sessions between Kandelo computers: create one, share its link,
 * join one from a link, and leave.
 *
 * The hosting computer is the centre of a star: it owns the session's
 * 10.89.0.0/24 addresses and forwards every packet between joiners. The
 * kernel worker does all of that (`host/src/networking/remote-segment*.ts`);
 * this module only matches computers through the signalling server and
 * carries each WebRTC link's bytes to the worker. Every computer keeps its
 * own machine; nothing about either machine's state crosses the link
 * except guest packets, host activity offers and explicitly published dependencies.
 */
import type { RemoteSegmentPeer } from "@host/networking/remote-segment-port";
import type { RemoteSessionSnapshot } from "@host/networking/remote-segment-runtime";
import type { PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection";
import * as signalling from "./peer-signalling";
import { decodeSessionInvitation } from "../../../web-libs/kandelo-session/src/session-invitation";
import type { SessionOffer } from "../../../web-libs/kandelo-session/src/package-sessions";

/** A running machine's session controls, as BrowserKernel provides them. */
export interface SessionMachine {
  hostRemoteNetwork(): Promise<string>;
  joinRemoteNetwork(peer: RemoteSegmentPeer): Promise<string>;
  attachRemotePeer(peer: RemoteSegmentPeer): Promise<number>;
  leaveRemoteNetwork(): Promise<void>;
  remoteNetworkSnapshot(): Promise<RemoteSessionSnapshot>;
}

export interface NetworkBridge { peer: RemoteSegmentPeer; close(): void }
/** The WebRTC side, injectable so the matching logic is testable in Node. */
export interface SessionTransport {
  createInvite(): Promise<{ invite: string; acceptAnswer(answer: string): Promise<PeerConnection>; cancel(): void }>;
  answerInvite(code: string): Promise<{ answer: string; connected: Promise<PeerConnection>; cancel(): void }>;
  bridge(link: PeerConnection): NetworkBridge;
}
export type SessionSignalling = typeof signalling;

export interface SessionDependencies {
  /** The running machine, or null before one boots. */
  machine(): SessionMachine | null;
  /** The signalling endpoint, or null when none is configured. */
  server(): string | null;
  transport: SessionTransport;
  /** The page a shared link should open. */
  pageHref(): string;
  api?: SessionSignalling;
  hostPollMs?: number;
  snapshotPollMs?: number;
}

export type SessionPhase = "offline" | "hosting" | "joining" | "connected" | "error";
export interface SessionState {
  phase: SessionPhase;
  /** The session's human-readable name. */
  name: string | null;
  room: string | null;
  /** The link that lets another computer join. Any connected member can share it. */
  link: string | null;
  error: string | null;
  /** The kernel worker's own words for why a session ended, when it did. */
  errorDetail: string | null;
  /**
   * The room this computer used is gone (expired, closed, or never there),
   * so its invitation cannot be joined again.
   */
  roomClosed: boolean;
  snapshot: RemoteSessionSnapshot | null;
  /** Only the room host publishes joinable activities. Null until received. */
  remoteActivities?: SessionOffer[] | null;
  activityError?: string | null;
}

/** The members a session admits, the hosting computer included. */
export const SESSION_MEMBER_CAP = 32;
const HOST_POLL_MS = 1500;
const SNAPSHOT_POLL_MS = 1000;
const LINK_CONNECT_TIMEOUT_MS = 45_000;
const NAME_MAX = 64;

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The room and display name a shared link carries, if it carries one. */
export function sessionInvitation(href: string): { room: string; name: string; offer?: SessionOffer } | null {
  const url = new URL(href);
  const room = url.searchParams.get("network");
  const offer = decodeSessionInvitation(url.hash);
  if (!room || !signalling.validRoomToken(room)) {
    if (offer) throw new Error("An activity invitation requires a valid network room");
    return null;
  }
  const name = (url.searchParams.get("networkName") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, NAME_MAX);
  return { room, name: name || "Network session", ...(offer ? { offer } : {}) };
}

/**
 * The page parameters that name the machine, as a Share link and a gallery
 * launch write them: the image and the profile within it. An invitation opens
 * the machine its host set the session up on.
 */
const MACHINE_PARAMS = ["vfs", "profile"] as const;

/**
 * A shareable link: this page and the machine it runs, plus the session.
 * Never the fragment, where boot descriptors and startup scripts travel, or
 * any other parameter: a script-bearing link has its own consent flow, and an
 * invitation is not one.
 */
export function sessionLink(pageHref: string, room: string, name: string): string {
  const page = new URL(pageHref);
  const url = new URL(page.origin + page.pathname);
  for (const key of MACHINE_PARAMS) {
    const value = page.searchParams.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set("network", room);
  url.searchParams.set("networkName", name);
  return url.href;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export class NetworkSessionController {
  private state: SessionState = { phase: "offline", name: null, room: null, link: null, error: null, errorDetail: null, roomClosed: false, snapshot: null };
  private joined = false;
  private readonly dependencyPeers = new Map<PeerConnection, SessionDependencyPeer>();
  private sharedDependencies = new Map<string, Uint8Array>();
  private sharedActivities: SessionOffer[] = [];
  private readonly activityPeers = new Map<PeerConnection, SessionActivityPeer>();

  publishActivities(offers: SessionOffer[]): void {
    if (this.joined) throw new Error("Only the hosting computer can advertise activities");
    activityOffersMessage(offers);
    if (JSON.stringify(offers) === JSON.stringify(this.sharedActivities)) return;
    this.sharedActivities = structuredClone(offers);
    for (const peer of this.activityPeers.values()) peer.publish();
  }

  publishDependencies(files: Map<string, Uint8Array>): void {
    if (files.size > 2 || [...files.values()].some(bytes => bytes.length > MAX_DEPENDENCY_BYTES)) throw new Error("Too much activity data");
    this.sharedDependencies = new Map(files);
  }
  receiveDependency(content: OfferedDependency, signal: AbortSignal, progress: (received: number) => void): Promise<Uint8Array> {
    const peer = this.dependencyPeers.values().next().value;
    if (!peer || !this.joined) throw new Error("Connect to the hosting computer before receiving activity data");
    return peer.receive(content, signal, progress);
  }
  private readonly listeners = new Set<(state: SessionState) => void>();
  private generation = 0;
  private hostKey: string | null = null;
  private readonly bridges = new Set<NetworkBridge>();
  private readonly links = new Set<PeerConnection>();
  private readonly inFlight = new Set<string>();
  private readonly cancels = new Set<() => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  private readonly machine: () => SessionMachine | null;
  private readonly server: () => string | null;
  private readonly transport: SessionTransport;
  private readonly pageHref: () => string;
  private readonly api: SessionSignalling;
  private readonly hostPollMs: number;
  private readonly snapshotPollMs: number;

  constructor(deps: SessionDependencies) {
    this.machine = deps.machine; this.server = deps.server;
    this.transport = deps.transport; this.pageHref = deps.pageHref;
    this.api = deps.api ?? signalling;
    this.hostPollMs = deps.hostPollMs ?? HOST_POLL_MS;
    this.snapshotPollMs = deps.snapshotPollMs ?? SNAPSHOT_POLL_MS;
  }

  getState(): SessionState { return this.state; }
  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  private requirements(): { machine: SessionMachine; server: string } {
    const machine = this.machine();
    if (!machine) throw new Error("Start a computer before connecting it to a network.");
    const server = this.server();
    if (!server) throw new Error("No signalling server is configured for network sessions.");
    return { machine, server };
  }

  private schedule(run: () => void, ms: number): void {
    this.timers.push(setTimeout(run, ms));
  }

  /** Host a new session on this computer and start admitting joiners. */
  async create(name: string): Promise<void> {
    const generation = ++this.generation;
    const trimmed = name.trim().slice(0, NAME_MAX) || "Network session";
    try {
      const { machine, server } = this.requirements();
      const room = this.api.randomRoomToken();
      this.hostKey = this.api.randomRoomToken();
      this.set({ phase: "hosting", name: trimmed, room, link: null, error: null, errorDetail: null, roomClosed: false });
      this.joined = false;
      await machine.hostRemoteNetwork();
      try {
        await this.api.hostRoom(server, room, this.hostKey, trimmed);
      } catch (error) {
        await machine.leaveRemoteNetwork().catch(() => {});
        throw error;
      }
      if (generation !== this.generation) return;
      this.set({ phase: "connected", link: sessionLink(this.pageHref(), room, trimmed) });
      this.pollSnapshot(generation);
      this.hostLoop(generation, server, room, trimmed);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  private hostLoop(generation: number, server: string, room: string, name: string): void {
    const tick = async () => {
      if (generation !== this.generation || !this.hostKey) return;
      try {
        const hosted = await this.api.hostRoom(server, room, this.hostKey, name);
        for (const request of hosted.joins) {
          if (this.inFlight.has(request.join)) continue;
          this.inFlight.add(request.join);
          void this.admit(generation, server, room, request).finally(() => this.inFlight.delete(request.join));
        }
      } catch (error) {
        // The room is the only way new computers find this one; members
        // already connected keep their links either way.
        if (generation === this.generation) this.set({ error: `The signalling server is unreachable: ${describe(error)}` });
      }
      if (generation === this.generation) this.schedule(() => { void tick(); }, this.hostPollMs);
    };
    this.schedule(() => { void tick(); }, this.hostPollMs);
  }

  private async admit(generation: number, server: string, room: string, request: signalling.RoomJoinRequest): Promise<void> {
    const key = this.hostKey!;
    const machine = this.machine();
    try {
      // Joins being admitted right now count against the cap too.
      const members = (this.state.snapshot?.members.length ?? 1) + this.inFlight.size - 1;
      if (!machine || members >= SESSION_MEMBER_CAP) {
        await this.api.refuseRoomJoin(server, room, key, request.join, "the session is full");
        return;
      }
      const answered = await this.transport.answerInvite(request.offer);
      this.cancels.add(answered.cancel);
      try {
        await this.api.answerRoomJoin(server, room, key, request.join, answered.answer);
        const link = await withTimeout(answered.connected, LINK_CONNECT_TIMEOUT_MS, "the joining computer did not connect");
        if (generation !== this.generation) { link.close(); return; }
        await this.adopt(link, (bridge) => machine.attachRemotePeer(bridge.peer), true);
      } finally { this.cancels.delete(answered.cancel); }
    } catch (error) {
      if (generation === this.generation) console.warn(`[network session] a computer could not join: ${describe(error)}`);
    }
  }

  private adopt(link: PeerConnection, attach: (bridge: NetworkBridge) => Promise<unknown>, hosting = false): Promise<unknown> {
    let bridge: NetworkBridge;
    try { bridge = this.transport.bridge(link); } catch (error) { link.close(); throw error; }
    const channel = link.channels.get(DEPENDENCY_CHANNEL);
    if (channel) this.dependencyPeers.set(link, new SessionDependencyPeer(channel, () => this.sharedDependencies));
    const activityChannel = link.channels.get(ACTIVITY_CHANNEL);
    const generation = this.generation;
    if (activityChannel) this.activityPeers.set(link, new SessionActivityPeer(activityChannel, hosting,
      () => this.sharedActivities,
      offers => { if (generation === this.generation && !hosting) this.set({ remoteActivities: offers, activityError: null }); },
      message => { if (generation === this.generation && !hosting) this.set({ remoteActivities: [], activityError: message }); }));
    this.links.add(link); this.bridges.add(bridge);
    link.onClose(() => { this.dependencyPeers.get(link)?.dispose(); this.dependencyPeers.delete(link); this.activityPeers.get(link)?.dispose(); this.activityPeers.delete(link); this.links.delete(link); this.bridges.delete(bridge); bridge.close(); });
    return attach(bridge).catch((error) => { bridge.close(); link.close(); throw error; });
  }

  /** Join the session a shared link names. */
  async join(room: string, name: string): Promise<void> {
    const generation = ++this.generation;
    try {
      if (!this.api.validRoomToken(room)) throw new Error("This network link is not valid.");
      const { machine, server } = this.requirements();
      this.set({ phase: "joining", room, name, link: null, error: null, errorDetail: null, roomClosed: false, remoteActivities: null, activityError: null });
      const hosted = await this.api.readRoom(server, room);
      this.set({ name: hosted.name });
      const invite = await this.transport.createInvite();
      this.cancels.add(invite.cancel);
      try {
        const join = this.api.randomRoomToken();
        await this.api.postRoomJoin(server, room, join, invite.invite);
        const answer = await this.api.waitForRoomAnswer(server, room, join, () => generation === this.generation);
        if (answer === null || generation !== this.generation) { invite.cancel(); return; }
        const link = await withTimeout(invite.acceptAnswer(answer), LINK_CONNECT_TIMEOUT_MS, "the hosting computer did not connect");
        if (generation !== this.generation) { link.close(); return; }
        await this.adopt(link, (bridge) => machine.joinRemoteNetwork(bridge.peer));
      } finally { this.cancels.delete(invite.cancel); }
      if (generation !== this.generation) return;
      this.joined = true;
      this.set({ phase: "connected", link: sessionLink(this.pageHref(), room, this.state.name ?? name) });
      this.pollSnapshot(generation);
    } catch (error) {
      if (generation === this.generation) {
        await this.teardown();
        this.fail(error);
        if (error instanceof this.api.RoomClosedError) this.set({ roomClosed: true });
      }
    }
  }

  private pollSnapshot(generation: number): void {
    const tick = async () => {
      const machine = this.machine();
      if (generation !== this.generation || !machine) return;
      try {
        const snapshot = await machine.remoteNetworkSnapshot();
        if (generation !== this.generation) return;
        if (snapshot.state === "offline") {
          // The session ended under this computer. A joiner cannot tell its
          // host leaving from the link failing — both close the link — so
          // say exactly that, with the worker's own reason as detail. The
          // host closes its room when it leaves, so a joiner's room is gone.
          await this.teardown();
          this.set({ phase: "error", snapshot, link: null, roomClosed: this.joined,
            error: this.joined
              ? "The network session ended: the connection to the hosting computer closed. The host left, or the link between you failed."
              : "The network session ended.",
            errorDetail: snapshot.lastDisconnect });
          return;
        }
        this.set({ snapshot });
      } catch (error) {
        if (generation === this.generation) this.set({ error: describe(error) });
      }
      if (generation === this.generation) this.schedule(() => { void tick(); }, this.snapshotPollMs);
    };
    void tick();
  }

  private fail(error: unknown): void {
    this.set({ phase: "error", error: describe(error), errorDetail: null, link: null });
  }

  private async teardown(): Promise<void> {
    this.generation++;
    for (const peer of this.dependencyPeers.values()) peer.dispose();
    for (const peer of this.activityPeers.values()) peer.dispose();
    this.activityPeers.clear(); this.sharedActivities = [];
    this.dependencyPeers.clear(); this.sharedDependencies.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
    for (const bridge of this.bridges) bridge.close();
    for (const link of this.links) link.close();
    this.bridges.clear(); this.links.clear(); this.inFlight.clear();
    const server = this.server(), key = this.hostKey, room = this.state.room;
    this.hostKey = null;
    if (server && key && room) await this.api.closeRoom(server, room, key).catch(() => {});
    await this.machine()?.leaveRemoteNetwork().catch(() => {});
  }

  /** Leave the session. A host leaving ends it for every member. */
  async leave(): Promise<void> {
    await this.teardown();
    this.joined = false;
    this.set({ phase: "offline", name: null, room: null, link: null, error: null, errorDetail: null, roomClosed: false, snapshot: null, remoteActivities: null, activityError: null });
  }
}
