import type {
  NetworkAddress,
  NetworkIO,
  TcpListenTarget,
  UdpDatagram,
  UdpReceiveTarget,
} from "../types";
import { NET_READINESS } from "../generated/abi";
import { RemoteVirtualNetwork, type RemoteSegmentSnapshot } from "./remote-segment";
import { RemoteSegmentPortTransport, type RemoteSegmentInit, type RemoteSegmentPeer } from "./remote-segment-port";

const ENOENT = 2;
const EOPNOTSUPP = 95;
const EADDRNOTAVAIL = 99;
const ENETUNREACH = 101;
const ECONNRESET = 104;
const ENOTCONN = 107;
const ECONNREFUSED = 111;
const JOIN_ASSIGNMENT_TIMEOUT_MS = 30_000;

const fail = (errno: number): never => {
  throw Object.assign(new Error(`network errno ${errno}`), { errno });
};
const wildcard = (addr: Uint8Array) => addr.length === 4 && addr.every((octet) => octet === 0);
const limitedBroadcast = (addr: Uint8Array) => addr.length === 4 && addr.every((octet) => octet === 255);

/** What this machine's session network is doing, as the UI may show it. */
export type RemoteSessionState = "offline" | "hosting" | "joining" | "joined";
export interface RemoteSessionSnapshot extends RemoteSegmentSnapshot {
  state: RemoteSessionState;
  /** Why the last session ended on its own (the host left, the link failed). */
  lastDisconnect: string | null;
}

interface RecordedUdpBinding { addr: Uint8Array; port: number; target: UdpReceiveTarget; inSegment: boolean }
interface RecordedTcpListener { addr: Uint8Array; port: number; target: TcpListenTarget; inSegment: boolean }

/**
 * The machine's network as the kernel sees it, for the machine's whole life.
 *
 * WHY a fixed object in front of a changing segment: a person creates or
 * joins a session on a computer that is already running, so the session's
 * network has to appear and disappear under live guest sockets, like a
 * cable plugged into an existing interface. The kernel worker registers a
 * guest's UDP bindings and TCP listeners with whatever `io.network` is at
 * bind time and keeps no copy of their addresses, so swapping `io.network`
 * would strand every binding made before the swap. This object stays put,
 * records the bindings itself, and replays wildcard ones into each new
 * segment — a program listening on `0.0.0.0` before the session started
 * hears the session once it joins, as it would on Linux.
 *
 * Without a segment it behaves exactly as the backend it wraps, and with no
 * backend exactly as an absent network does in `kernel.ts`, so installing it
 * changes nothing until a session starts.
 */
export class SessionNetwork implements NetworkIO {
  private segment?: RemoteVirtualNetwork;
  private readonly udp = new Map<string, RecordedUdpBinding>();
  private readonly tcp = new Map<string, RecordedTcpListener>();
  private readonly segmentHandles = new Set<number>();
  /** Connections whose session ended under them: they report a reset. */
  private readonly resetHandles = new Set<number>();

  constructor(private readonly fallback?: NetworkIO) {}

  get attached(): RemoteVirtualNetwork | undefined { return this.segment; }

  get localAddress(): Uint8Array | undefined {
    return this.segment?.localAddress ?? this.fallback?.localAddress;
  }

  /** The netmask that belongs to whichever address `localAddress` reports. */
  get localNetmask(): Uint8Array | undefined {
    return this.segment?.localAddress ? this.segment.localNetmask : this.fallback?.localNetmask;
  }

  /** Route the session's subnet through `segment`, replaying wildcard endpoints. */
  attach(segment: RemoteVirtualNetwork): void {
    if (this.segment) throw new Error("this machine is already in a network session");
    this.segment = segment;
    for (const [id, binding] of this.udp) {
      if (binding.inSegment) continue;
      const result = segment.bindUdp(id, binding.addr, binding.port, binding.target);
      if (result !== 0) console.warn(`[session network] UDP ${binding.port} could not join the session: errno ${result}`);
    }
    for (const [id, listener] of this.tcp) {
      if (listener.inSegment) continue;
      const result = segment.listenTcp(id, listener.addr, listener.port, listener.target);
      if (result !== 0) console.warn(`[session network] TCP ${listener.port} could not join the session: errno ${result}`);
    }
  }

  /**
   * Remove the session's subnet. Its address disappears, its streams reset,
   * and endpoints bound to it specifically stop receiving; wildcard
   * endpoints keep whatever the wrapped backend gives them.
   */
  detach(): void {
    const segment = this.segment;
    if (!segment) return;
    this.segment = undefined;
    for (const handle of this.segmentHandles) this.resetHandles.add(handle);
    this.segmentHandles.clear();
    for (const [id, binding] of [...this.udp]) if (binding.inSegment) this.udp.delete(id);
    for (const [id, listener] of [...this.tcp]) if (listener.inSegment) this.tcp.delete(id);
    segment.close();
  }

  private routesToSegment(addr: Uint8Array): boolean {
    return Boolean(this.segment) && RemoteVirtualNetwork.routes(addr);
  }

  udpSourceAddress(destination: Uint8Array): Uint8Array | number {
    if (this.segment && (RemoteVirtualNetwork.routes(destination) || limitedBroadcast(destination))) {
      return this.segment.udpSourceAddress(destination);
    }
    return this.fallback?.udpSourceAddress?.(destination) ?? ENETUNREACH;
  }

  connect(handle: number, addr: Uint8Array, port: number, source?: NetworkAddress): void {
    this.resetHandles.delete(handle);
    if (this.routesToSegment(addr)) {
      this.segmentHandles.add(handle);
      this.segment!.connect(handle, addr, port, source);
      return;
    }
    if (!this.fallback) fail(ECONNREFUSED);
    this.fallback!.connect(handle, addr, port, source);
  }

  connectStatus(handle: number): number {
    if (this.resetHandles.has(handle)) return ECONNRESET;
    if (this.segmentHandles.has(handle)) return this.segment!.connectStatus(handle);
    return this.fallback?.connectStatus(handle) ?? ENOTCONN;
  }

  send(handle: number, data: Uint8Array, flags: number): number {
    if (this.resetHandles.has(handle)) fail(ECONNRESET);
    if (this.segmentHandles.has(handle)) return this.segment!.send(handle, data, flags);
    if (!this.fallback) fail(ENOTCONN);
    return this.fallback!.send(handle, data, flags);
  }

  recv(handle: number, maxLen: number, flags: number): Uint8Array {
    if (this.resetHandles.has(handle)) fail(ECONNRESET);
    if (this.segmentHandles.has(handle)) return this.segment!.recv(handle, maxLen, flags);
    if (!this.fallback) fail(ENOTCONN);
    return this.fallback!.recv(handle, maxLen, flags);
  }

  readiness(handle: number): number {
    if (this.resetHandles.has(handle)) {
      return NET_READINESS.ERROR | (ECONNRESET << NET_READINESS.ERRNO_SHIFT)
        | NET_READINESS.RECV_EOF | NET_READINESS.SEND_CLOSED | NET_READINESS.HANGUP;
    }
    if (this.segmentHandles.has(handle)) return this.segment!.readiness(handle);
    if (!this.fallback) fail(ENOTCONN);
    return this.fallback!.readiness?.(handle) ?? NET_READINESS.UNOBSERVABLE;
  }

  localEndpoint(handle: number): NetworkAddress {
    if (this.segmentHandles.has(handle)) return this.segment!.localEndpoint(handle);
    if (this.resetHandles.has(handle) || !this.fallback?.localEndpoint) fail(EOPNOTSUPP);
    return this.fallback!.localEndpoint!(handle);
  }

  shutdown(handle: number, how: number): void {
    if (this.resetHandles.has(handle)) fail(ECONNRESET);
    if (this.segmentHandles.has(handle)) { this.segment!.shutdown(handle, how); return; }
    if (!this.fallback?.shutdown) fail(EOPNOTSUPP);
    this.fallback!.shutdown!(handle, how);
  }

  close(handle: number): void {
    if (this.resetHandles.delete(handle)) return;
    if (this.segmentHandles.delete(handle)) { this.segment?.close(handle); return; }
    this.fallback?.close(handle);
  }

  getaddrinfo(hostname: string): Uint8Array {
    if (this.segment) {
      try { return this.segment.getaddrinfo(hostname); } catch { /* not a session name */ }
    }
    if (!this.fallback) fail(ENOENT);
    return this.fallback!.getaddrinfo(hostname);
  }

  bindUdp(id: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number {
    const inSegment = RemoteVirtualNetwork.routes(addr);
    if (inSegment) {
      if (!this.segment) return EADDRNOTAVAIL;
      const result = this.segment.bindUdp(id, addr, port, target);
      if (result === 0) this.udp.set(id, { addr: addr.slice(), port, target, inSegment });
      return result;
    }
    if (this.fallback?.bindUdp) {
      const result = this.fallback.bindUdp(id, addr, port, target);
      if (result !== 0) return result;
    } else if (!wildcard(addr)) {
      // As without any adapter: a wildcard binding is the kernel's own; a
      // specific nonlocal address cannot be authenticated.
      return EADDRNOTAVAIL;
    }
    if (this.segment && wildcard(addr)) {
      // A bind made during a session is refused truthfully when the session
      // cannot carry it; only replay at join time can merely be reported.
      const result = this.segment.bindUdp(id, addr, port, target);
      if (result !== 0) { this.fallback?.unbindUdp?.(id); return result; }
    }
    this.udp.set(id, { addr: addr.slice(), port, target, inSegment });
    return 0;
  }

  unbindUdp(id: string): void {
    const binding = this.udp.get(id);
    this.udp.delete(id);
    if (!binding) { this.fallback?.unbindUdp?.(id); return; }
    if (this.segment && (binding.inSegment || wildcard(binding.addr))) this.segment.unbindUdp(id);
    if (!binding.inSegment) this.fallback?.unbindUdp?.(id);
  }

  sendDatagram(datagram: UdpDatagram): number {
    if (this.segment && (RemoteVirtualNetwork.routes(datagram.dstAddr) || limitedBroadcast(datagram.dstAddr))) {
      return this.segment.sendDatagram(datagram);
    }
    return this.fallback?.sendDatagram?.(datagram) ?? ENETUNREACH;
  }

  listenTcp(id: string, addr: Uint8Array, port: number, target: TcpListenTarget): number {
    const inSegment = RemoteVirtualNetwork.routes(addr);
    if (inSegment) {
      if (!this.segment) return EADDRNOTAVAIL;
      const result = this.segment.listenTcp(id, addr, port, target);
      if (result === 0) this.tcp.set(id, { addr: addr.slice(), port, target, inSegment });
      return result;
    }
    if (this.fallback?.listenTcp) {
      const result = this.fallback.listenTcp(id, addr, port, target);
      if (result !== 0) return result;
    }
    if (this.segment && wildcard(addr)) {
      const result = this.segment.listenTcp(id, addr, port, target);
      if (result !== 0) { this.fallback?.closeTcpListener?.(id); return result; }
    }
    this.tcp.set(id, { addr: addr.slice(), port, target, inSegment });
    return 0;
  }

  closeTcpListener(id: string): void {
    const listener = this.tcp.get(id);
    this.tcp.delete(id);
    if (!listener) { this.fallback?.closeTcpListener?.(id); return; }
    if (this.segment && (listener.inSegment || wildcard(listener.addr))) this.segment.closeTcpListener(id);
    if (!listener.inSegment) this.fallback?.closeTcpListener?.(id);
  }
}

/**
 * Worker-owned session lifecycle shared by the Node and browser kernel
 * entries. The main thread only carries bytes for the links; creating,
 * joining and leaving a session, address ownership and forwarding all stay
 * in the kernel worker.
 */
export class RemoteSegmentRuntime {
  private session?: SessionNetwork;
  private state: RemoteSessionState = "offline";
  private lastDisconnect: string | null = null;
  private generation = 0;

  /** Install the machine's network. Call once, before the kernel starts. */
  install(fallback?: NetworkIO): NetworkIO {
    if (this.session) throw new Error("the session network is already installed");
    this.session = new SessionNetwork(fallback);
    return this.session;
  }

  /** Boot-time shorthand for `install` followed by `host` or `join`. */
  async initialize(config: RemoteSegmentInit, fallback?: NetworkIO): Promise<NetworkIO> {
    if (!config || (config.role !== "host" && config.role !== "joiner")) throw new Error("invalid remote segment role");
    const network = this.install(fallback);
    if (config.role === "host") this.host();
    else await this.join(config.peer);
    return network;
  }

  private requireSession(): SessionNetwork {
    if (!this.session) throw new Error("the session network is not installed");
    return this.session;
  }

  /** Start a session with this machine as the forwarding host, 10.89.0.1. */
  host(): string {
    const session = this.requireSession();
    if (session.attached) throw new Error("this machine is already in a network session");
    const segment = new RemoteVirtualNetwork("host");
    session.attach(segment);
    this.state = "hosting"; this.lastDisconnect = null; this.generation++;
    return segment.snapshot().address!;
  }

  /**
   * Join a session over `peer`, the byte bridge to the forwarding host.
   * Resolves with the address the host assigned once the directory arrives.
   */
  async join(peer: RemoteSegmentPeer): Promise<string> {
    const session = this.requireSession();
    if (session.attached || this.state === "joining") {
      peer.port.close();
      throw new Error("this machine is already in a network session");
    }
    const generation = ++this.generation;
    const segment = new RemoteVirtualNetwork("joiner");
    this.state = "joining"; this.lastDisconnect = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      segment.attachPeer(new RemoteSegmentPortTransport(peer));
      await Promise.race([
        segment.ready,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("the hosting computer did not assign an address within 30 seconds")), JOIN_ASSIGNMENT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      segment.close();
      if (generation === this.generation) this.state = "offline";
      throw error;
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
    if (generation !== this.generation) { segment.close(); throw new Error("the join was cancelled"); }
    session.attach(segment);
    this.state = "joined";
    // Losing the host ends the session for this machine; keep the reason.
    segment.onClosed((reason) => {
      if (generation !== this.generation || session.attached !== segment) return;
      session.detach();
      this.state = "offline"; this.lastDisconnect = reason;
    });
    return segment.snapshot().address!;
  }

  attachPeer(peer: RemoteSegmentPeer): number {
    const segment = this.session?.attached;
    if (!segment || segment.role !== "host") {
      peer.port.close();
      throw new Error("only a hosting computer can attach remote peers");
    }
    let transport: RemoteSegmentPortTransport | undefined;
    try {
      transport = new RemoteSegmentPortTransport(peer);
      return segment.attachPeer(transport);
    } catch (error) {
      if (transport) transport.close(); else peer.port.close();
      throw error;
    }
  }

  /** Leave the session. A host leaving ends it for every member. */
  leave(): void {
    this.generation++;
    this.session?.detach();
    this.state = "offline";
  }

  snapshot(): RemoteSessionSnapshot {
    const segment = this.session?.attached;
    const base: RemoteSegmentSnapshot = segment
      ? segment.snapshot()
      : { address: null, members: [], bindings: [], tcpListeners: [], droppedBroadcasts: 0 };
    return { ...base, state: this.state, lastDisconnect: this.lastDisconnect };
  }

  /** Destroy: leave any session and forget the installed network. */
  close(): void { this.leave(); this.session = undefined; this.lastDisconnect = null; }
}

/** Main-thread requests the runtime answers. Shared by both worker protocols. */
export type RemoteNetworkMessage =
  | { type: "remote_network_attach"; requestId: number; peer: RemoteSegmentPeer }
  | { type: "remote_network_snapshot"; requestId: number }
  | { type: "remote_network_host"; requestId: number }
  | { type: "remote_network_join"; requestId: number; peer: RemoteSegmentPeer }
  | { type: "remote_network_leave"; requestId: number };

const REMOTE_NETWORK_MESSAGES = new Set([
  "remote_network_attach", "remote_network_snapshot", "remote_network_host",
  "remote_network_join", "remote_network_leave",
]);

/**
 * Answer one session request in either kernel worker. Returns false when
 * `message` is not a session request, so the entry keeps dispatching.
 */
export function handleRemoteNetworkMessage(
  runtime: RemoteSegmentRuntime,
  message: { type: string },
  ready: boolean,
  respond: (requestId: number, result: unknown) => void,
  respondError: (requestId: number, error: string) => void,
): message is RemoteNetworkMessage {
  if (!REMOTE_NETWORK_MESSAGES.has(message.type)) return false;
  const request = message as RemoteNetworkMessage;
  const reject = (error: unknown) => respondError(request.requestId, error instanceof Error ? error.message : String(error));
  const transferredPort = "peer" in request ? request.peer.port : undefined;
  if (!ready) {
    transferredPort?.close();
    reject(new Error("the kernel is not initialized"));
    return true;
  }
  try {
    switch (request.type) {
      case "remote_network_attach": respond(request.requestId, runtime.attachPeer(request.peer)); break;
      case "remote_network_snapshot": respond(request.requestId, runtime.snapshot()); break;
      case "remote_network_host": respond(request.requestId, runtime.host()); break;
      case "remote_network_leave": runtime.leave(); respond(request.requestId, null); break;
      case "remote_network_join":
        void runtime.join(request.peer).then((address) => respond(request.requestId, address), reject);
        break;
    }
  } catch (error) { reject(error); }
  return true;
}
