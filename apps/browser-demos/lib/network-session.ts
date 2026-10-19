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
 * except ordinary guest packets.
 */
import type { RemoteSegmentPeer } from "@host/networking/remote-segment-port";
import type { RemoteSessionSnapshot } from "@host/networking/remote-segment-runtime";
import { peerSignalPurpose, type PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection";
import * as signalling from "./peer-signalling";
import type { PeerAnswer, PeerInvite, PeerLink } from "./sharing-peer";

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
/** The machine-sharing side of a session, injectable like the network transport. */
export interface SharingTransport {
  createInvite(): Promise<PeerInvite>;
  answerInvite(code: string): Promise<PeerAnswer>;
}

/**
 * A computer this one can share a machine with, over its own `sharing` link.
 *
 * A session is a star, so a joiner's one partner is the hosting computer and
 * the host has one per joiner.
 */
export interface SharingPartner {
  readonly id: string;
  /** The name the session's network gives it: `host`, or `peer-N`. */
  readonly name: string;
  readonly link: PeerLink;
}

export interface SessionDependencies {
  /** The running machine, or null before one boots. */
  machine(): SessionMachine | null;
  /** The signalling endpoint, or null when none is configured. */
  server(): string | null;
  transport: SessionTransport;
  /** Without it, the session carries guest networking only. */
  sharing?: SharingTransport;
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
  /** The link that lets another computer join. Only the host shares it. */
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
  /**
   * Whether this computer's machine is on the session's guest network.
   *
   * Membership and the network are separate: a machine switch, such as
   * giving this computer's machine up to watch another's, detaches the
   * network and keeps the session and its sharing links.
   */
  networkAttached: boolean;
  partners: readonly SharingPartner[];
  /** Why a sharing link could not be made, while the session still runs. */
  sharingError: string | null;
}

/** The members a session admits, the hosting computer included. */
export const SESSION_MEMBER_CAP = 32;
const HOST_POLL_MS = 1500;
const SNAPSHOT_POLL_MS = 1000;
const LINK_CONNECT_TIMEOUT_MS = 45_000;
const NAME_MAX = 64;
/**
 * What follows a joiner's network join token in each of its `sharing` offers,
 * then a few random letters so a reconnect never reuses a token.
 */
const SHARING_JOIN_SUFFIX = "sharing";
const HOST_MEMBER_NAME = "host";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The room and display name a shared link carries, if it carries one. */
export function sessionInvitation(href: string): { room: string; name: string } | null {
  const url = new URL(href);
  const room = url.searchParams.get("network");
  if (!room || !signalling.validRoomToken(room)) return null;
  const name = (url.searchParams.get("networkName") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, NAME_MAX);
  return { room, name: name || "Network session" };
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

/** Whether a joiner's offer is for `sharing`; any other code is a network join. */
function isSharingOffer(code: string): boolean {
  try {
    return peerSignalPurpose(code) === "sharing";
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export class NetworkSessionController {
  private state: SessionState = { phase: "offline", name: null, room: null, link: null, error: null, errorDetail: null, roomClosed: false, snapshot: null, networkAttached: false, partners: [], sharingError: null };
  private joined = false;
  private readonly listeners = new Set<(state: SessionState) => void>();
  private generation = 0;
  private hostKey: string | null = null;
  private readonly bridges = new Set<NetworkBridge>();
  private readonly links = new Set<PeerConnection>();
  /** The member name each admitted network join was given, by join token. */
  private readonly memberNames = new Map<string, string>();
  /** This joiner's network join token, which its sharing offers extend. */
  private networkJoin: string | null = null;
  private readonly inFlight = new Set<string>();
  private readonly cancels = new Set<() => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  private readonly machine: () => SessionMachine | null;
  private readonly server: () => string | null;
  private readonly transport: SessionTransport;
  private readonly sharing: SharingTransport | null;
  private readonly pageHref: () => string;
  private readonly api: SessionSignalling;
  private readonly hostPollMs: number;
  private readonly snapshotPollMs: number;

  constructor(deps: SessionDependencies) {
    this.machine = deps.machine; this.server = deps.server;
    this.transport = deps.transport; this.pageHref = deps.pageHref;
    this.sharing = deps.sharing ?? null;
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
      this.set({ phase: "connected", link: sessionLink(this.pageHref(), room, trimmed), networkAttached: true });
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
      if (isSharingOffer(request.offer)) {
        await this.admitSharing(generation, server, room, key, request);
        return;
      }
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
        const member = await this.adopt(link, (bridge) => machine.attachRemotePeer(bridge.peer));
        this.memberNames.set(request.join, `peer-${String(member)}`);
      } finally { this.cancels.delete(answered.cancel); }
    } catch (error) {
      if (generation === this.generation) console.warn(`[network session] a computer could not join: ${describe(error)}`);
    }
  }

  /** Answer a joiner's `sharing` offer, made after its network join. */
  private async admitSharing(
    generation: number, server: string, room: string, key: string, request: signalling.RoomJoinRequest,
  ): Promise<void> {
    if (!this.sharing) {
      await this.api.refuseRoomJoin(server, room, key, request.join, "this computer does not share machines");
      return;
    }
    const answered = await this.sharing.answerInvite(request.offer);
    this.cancels.add(answered.cancel);
    try {
      await this.api.answerRoomJoin(server, room, key, request.join, answered.answer);
      const link = await withTimeout(answered.connected, LINK_CONNECT_TIMEOUT_MS, "the joining computer did not connect for sharing");
      if (generation !== this.generation) { link.close(); return; }
      const member = [...this.memberNames].find(([join]) => request.join.startsWith(join + SHARING_JOIN_SUFFIX));
      this.addPartner({ id: request.join, name: member?.[1] ?? "a joining computer", link });
    } finally { this.cancels.delete(answered.cancel); }
  }

  private addPartner(partner: SharingPartner): void {
    this.set({ partners: [...this.state.partners, partner] });
    partner.link.onClose(() => {
      if (!this.state.partners.includes(partner)) return;
      this.set({ partners: this.state.partners.filter((other) => other !== partner) });
      this.sharingLinkClosed();
    });
  }

  /**
   * A computer with no partner left and no network has nothing left of the
   * session, unless its room is still there. A host that switched machines
   * leaves it, as it always did. A joiner asks the room: a closed room means
   * the host left; an open one means only the sharing link went, and the
   * joiner can connect it again.
   */
  private sharingLinkClosed(): void {
    if (this.state.partners.length > 0 || this.state.networkAttached) return;
    if (!this.joined) {
      void this.leave();
      return;
    }
    const generation = this.generation;
    const server = this.server(), room = this.state.room;
    const roomOpen = server && room
      ? this.api.readRoom(server, room).then(() => true, () => false)
      : Promise.resolve(false);
    void roomOpen.then(async (open) => {
      if (open || generation !== this.generation) return;
      await this.teardown();
      this.set({ phase: "error", link: null, roomClosed: true,
        error: "The network session ended: the connection to the hosting computer closed. The host left, or the link between you failed.",
        errorDetail: null });
    });
  }

  /** Close the sharing link with one partner; the session stays. */
  disconnectPartner(id: string): void {
    this.state.partners.find((partner) => partner.id === id)?.link.close();
  }

  /** Open this joiner's sharing link to the host again, after it closed. */
  async reconnectSharing(): Promise<void> {
    const server = this.server(), room = this.state.room, join = this.networkJoin;
    if (!this.joined || this.state.partners.length > 0 || !server || !room || !join) return;
    this.set({ sharingError: null });
    await this.joinSharing(this.generation, server, room, join);
  }

  /** Open this joiner's `sharing` link to the host, through the same room. */
  private async joinSharing(generation: number, server: string, room: string, join: string): Promise<void> {
    if (!this.sharing) return;
    try {
      const invite = await this.sharing.createInvite();
      this.cancels.add(invite.cancel);
      try {
        const sharingJoin = join + SHARING_JOIN_SUFFIX + this.api.randomRoomToken(6);
        await this.api.postRoomJoin(server, room, sharingJoin, invite.invite);
        const answer = await this.api.waitForRoomAnswer(server, room, sharingJoin, () => generation === this.generation);
        if (answer === null || generation !== this.generation) { invite.cancel(); return; }
        const link = await withTimeout(invite.acceptAnswer(answer), LINK_CONNECT_TIMEOUT_MS, "the hosting computer did not connect for sharing");
        if (generation !== this.generation) { link.close(); return; }
        this.addPartner({ id: HOST_MEMBER_NAME, name: HOST_MEMBER_NAME, link });
      } finally { this.cancels.delete(invite.cancel); }
    } catch (error) {
      if (generation === this.generation) this.set({ sharingError: describe(error) });
    }
  }

  private adopt<T>(link: PeerConnection, attach: (bridge: NetworkBridge) => Promise<T>): Promise<T> {
    let bridge: NetworkBridge;
    try { bridge = this.transport.bridge(link); } catch (error) { link.close(); throw error; }
    this.links.add(link); this.bridges.add(bridge);
    link.onClose(() => { this.links.delete(link); this.bridges.delete(bridge); bridge.close(); });
    return attach(bridge).catch((error) => { bridge.close(); link.close(); throw error; });
  }

  /** Join the session a shared link names. */
  async join(room: string, name: string): Promise<void> {
    const generation = ++this.generation;
    try {
      if (!this.api.validRoomToken(room)) throw new Error("This network link is not valid.");
      const { machine, server } = this.requirements();
      this.set({ phase: "joining", room, name, link: null, error: null, errorDetail: null, roomClosed: false, sharingError: null });
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
        this.networkJoin = join;
        await this.joinSharing(generation, server, room, join);
      } finally { this.cancels.delete(invite.cancel); }
      if (generation !== this.generation) return;
      this.joined = true;
      this.set({ phase: "connected", networkAttached: true });
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
      if (generation !== this.generation || !machine || !this.state.networkAttached) return;
      try {
        const snapshot = await machine.remoteNetworkSnapshot();
        if (generation !== this.generation || !this.state.networkAttached) return;
        if (snapshot.state === "offline" && this.state.partners.length > 0) {
          // The guest network ended and the sharing links did not: the
          // session goes on without its network.
          this.set({ networkAttached: false, snapshot: null, errorDetail: snapshot.lastDisconnect });
          return;
        }
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
    // The room closes before the links do: a joiner that loses its link asks
    // the room whether the host left, and must find it gone.
    const server = this.server(), key = this.hostKey, room = this.state.room;
    this.hostKey = null;
    if (server && key && room) await this.api.closeRoom(server, room, key).catch(() => {});
    for (const bridge of this.bridges) bridge.close();
    for (const link of this.links) link.close();
    this.bridges.clear(); this.links.clear(); this.inFlight.clear(); this.memberNames.clear();
    this.networkJoin = null;
    const partners = this.state.partners;
    this.set({ partners: [], networkAttached: false });
    for (const partner of partners) partner.link.close();
    await this.machine()?.leaveRemoteNetwork().catch(() => {});
  }

  /** Leave the session. A host leaving ends it for every member. */
  async leave(): Promise<void> {
    await this.teardown();
    this.joined = false;
    this.set({ phase: "offline", name: null, room: null, link: null, error: null, errorDetail: null, roomClosed: false, snapshot: null, sharingError: null });
  }

  /**
   * This computer's machine stopped or was replaced. Its guest network went
   * with it; the session and its sharing links stay.
   */
  async machineChanged(): Promise<void> {
    if (!this.state.networkAttached) return;
    for (const bridge of this.bridges) bridge.close();
    for (const link of this.links) link.close();
    this.bridges.clear(); this.links.clear();
    this.set({ networkAttached: false, snapshot: null });
    this.sharingLinkClosed();
  }
}
