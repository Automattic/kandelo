import { notifyReadiness, readinessGeneration } from "./readiness-generation";
import type {
  NetworkAddress,
  NetworkIO,
  TcpConnectionPeer,
  TcpListenTarget,
  UdpDatagram,
  UdpReceiveTarget,
} from "../types";
import { EagainError } from "./fetch-backend";
import { parseNumericIpv4Hostname, validateDnsHostname } from "./hostname";
import { NET_READINESS } from "../generated/abi";

const EADDRINUSE = 98;
const EADDRNOTAVAIL = 99;
const ENETUNREACH = 101;
const ECONNRESET = 104;
const ENOTCONN = 107;
const EISCONN = 106;
const ECONNREFUSED = 111;
const EHOSTUNREACH = 113;
const MSG_PEEK = 0x0002;

const ANY = "0.0.0.0";

export function isIpv4Multicast(addr: Uint8Array): boolean {
  return addr.length === 4 && addr[0] >= 224 && addr[0] <= 239;
}

function ipKey(addr: Uint8Array): string {
  return `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
}

function copyAddr(addr: Uint8Array): Uint8Array {
  return new Uint8Array([addr[0] ?? 0, addr[1] ?? 0, addr[2] ?? 0, addr[3] ?? 0]);
}

function addrMatches(bound: string, dst: string): boolean {
  return bound === ANY || bound === dst;
}

function addrConflicts(a: string, b: string): boolean {
  return a === ANY || b === ANY || a === b;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

class VirtualTcpPeer implements TcpConnectionPeer {
  private recvBuf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private peer?: VirtualTcpPeer;
  private readClosed = false;
  private writeClosed = false;
  private orphanedReceive = false;
  private reset = false;

  constructor(private onRelease?: (peer: VirtualTcpPeer) => void) {}

  pairWith(peer: VirtualTcpPeer): void {
    this.peer = peer;
  }

  enqueue(data: Uint8Array): void {
    if (this.readClosed || this.reset) return;
    this.recvBuf = concatBytes(this.recvBuf, data);
    if (data.length) notifyReadiness(this, 0);
  }

  send(data: Uint8Array, _flags: number): number {
    if (this.reset) {
      const err = new Error("ECONNRESET") as Error & { errno?: number };
      err.errno = ECONNRESET;
      throw err;
    }
    if (this.writeClosed || !this.peer) {
      const err = new Error("EPIPE") as Error & { errno?: number };
      err.errno = 32;
      throw err;
    }
    if (this.peer.reset) {
      const err = new Error("ECONNRESET") as Error & { errno?: number };
      err.errno = ECONNRESET;
      throw err;
    }
    if (this.peer.readClosed) {
      const err = new Error("EPIPE") as Error & { errno?: number };
      err.errno = 32;
      throw err;
    }
    // Normal TCP close is simplex: the peer's FIN closes its write half while
    // its orphaned receive half continues to consume packets. Keep an explicit
    // discard sink rather than inventing a fixed successful-write count.
    if (this.peer.orphanedReceive) {
      return data.length;
    }
    this.peer.enqueue(data.slice());
    return data.length;
  }

  recv(maxLen: number, flags: number): Uint8Array {
    if (this.reset) {
      const err = new Error("ECONNRESET") as Error & { errno?: number };
      err.errno = ECONNRESET;
      throw err;
    }
    if (this.recvBuf.length > 0) {
      const len = Math.min(maxLen, this.recvBuf.length);
      const out = this.recvBuf.slice(0, len);
      if ((flags & MSG_PEEK) === 0) {
        this.recvBuf = this.recvBuf.slice(len);
      }
      return out;
    }
    if (!this.peer || this.peer.writeClosed) {
      return new Uint8Array(0);
    }
    throw new EagainError();
  }

  /**
   * Report the fabric-observable state of this endpoint. No POSIX readiness
   * decision is made here — `runtime_core::net_readiness` makes it.
   */
  readinessGeneration(direction: number): bigint { return readinessGeneration(this, direction); }

  readiness(): number {
    // A reset takes the connection down in both directions at once.
    if (this.reset) {
      return NET_READINESS.ERROR
        | (ECONNRESET << NET_READINESS.ERRNO_SHIFT)
        | NET_READINESS.RECV_EOF
        | NET_READINESS.SEND_CLOSED
        | NET_READINESS.HANGUP;
    }

    let facts = 0;
    if (this.recvBuf.length > 0) facts |= NET_READINESS.RECV_READY;
    if (!this.peer || this.peer.writeClosed || this.readClosed) {
      facts |= NET_READINESS.RECV_EOF;
    }
    // A hangup is both directions down, matching Linux's
    // `sk_shutdown == SHUTDOWN_MASK`. A bare peer FIN is end-of-stream, not a
    // hangup; this used to raise POLLHUP on a half-close, and then only when
    // the caller happened to have asked for POLLIN.
    if ((!this.peer || this.peer.writeClosed) && this.writeClosed) {
      facts |= NET_READINESS.HANGUP;
    }
    if (this.writeClosed || !this.peer || this.peer.readClosed || this.peer.reset) {
      facts |= NET_READINESS.SEND_CLOSED;
    } else {
      facts |= NET_READINESS.SEND_READY;
    }
    return facts;
  }

  shutdown(how: number): void {
    notifyReadiness(this);
    if (this.peer) notifyReadiness(this.peer);
    if (how === 0 || how === 2) {
      this.readClosed = true;
      this.recvBuf = new Uint8Array(0);
    }
    if (how === 1 || how === 2) {
      this.writeClosed = true;
    }
  }

  close(): void {
    notifyReadiness(this);
    if (this.peer) notifyReadiness(this.peer);
    this.writeClosed = true;
    this.orphanedReceive = true;
    this.recvBuf = new Uint8Array(0);
    this.releaseFromOwner();
  }

  abort(): void {
    notifyReadiness(this);
    if (this.peer) notifyReadiness(this.peer);
    this.readClosed = true;
    this.writeClosed = true;
    this.orphanedReceive = false;
    this.reset = true;
    this.recvBuf = new Uint8Array(0);
    this.releaseFromOwner();
    this.peer?.resetPeer();
  }

  resetPeer(): void {
    notifyReadiness(this);
    if (this.peer) notifyReadiness(this.peer);
    this.reset = true;
    this.recvBuf = new Uint8Array(0);
  }

  private releaseFromOwner(): void {
    const onRelease = this.onRelease;
    this.onRelease = undefined;
    onRelease?.(this);
  }
}

interface TcpListener {
  machineId: string;
  listenerId: string;
  addr: Uint8Array;
  addrKey: string;
  port: number;
  target: TcpListenTarget;
}

interface UdpEndpoint {
  machineId: string;
  endpointId: string;
  addr: Uint8Array;
  addrKey: string;
  port: number;
  target: UdpReceiveTarget;
}

interface TcpConnection {
  peer: TcpConnectionPeer;
  status: number;
}

/**
 * The IPv4 subnet one virtual link carries. Every machine on the link is
 * inside it, so the kernel can report a truthful netmask and broadcast
 * address for the interface the link backs.
 */
export interface VirtualNetworkSubnet {
  network: Uint8Array | [number, number, number, number];
  prefixLength: number;
}

const toU32 = (addr: Uint8Array) => ((addr[0] << 24) | (addr[1] << 16) | (addr[2] << 8) | addr[3]) >>> 0;
const fromU32 = (value: number) => new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

export interface VirtualNetworkMachineOptions {
  id: string;
  address: Uint8Array | [number, number, number, number];
  hostnames?: string[];
}

export class LocalVirtualNetwork {
  /** The link's netmask, in network byte order. */
  readonly netmask: Uint8Array;
  /** The link's directed broadcast address, or null on a /31 or /32 link. */
  readonly broadcastAddress: Uint8Array | null;
  private readonly networkAddress: number;
  private readonly mask: number;
  private machines = new Map<string, VirtualNetworkBackend>();
  private addressOwners = new Map<string, string>();
  private hostnames = new Map<string, Uint8Array>();
  private tcpListeners: TcpListener[] = [];
  private udpEndpoints: UdpEndpoint[] = [];
  private tcpPeersByMachine = new Map<string, Set<VirtualTcpPeer>>();

  constructor(subnet: VirtualNetworkSubnet) {
    const { prefixLength } = subnet;
    if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) {
      throw new Error("a virtual link's prefix length is 1 to 32");
    }
    this.mask = prefixLength === 32 ? 0xffffffff : (~((1 << (32 - prefixLength)) - 1)) >>> 0;
    this.networkAddress = toU32(copyAddr(new Uint8Array(subnet.network))) & this.mask;
    if (this.networkAddress !== toU32(copyAddr(new Uint8Array(subnet.network)))) {
      throw new Error("a virtual link's network address has host bits set");
    }
    this.netmask = fromU32(this.mask);
    this.broadcastAddress = prefixLength <= 30 ? fromU32((this.networkAddress | ~this.mask) >>> 0) : null;
  }

  /** Whether `addr` names every machine on this link. */
  isBroadcast(addr: Uint8Array): boolean {
    if (addr.length === 4 && addr.every((part) => part === 255)) return true;
    return this.broadcastAddress !== null && ipKey(addr) === ipKey(this.broadcastAddress);
  }

  attachMachine(options: VirtualNetworkMachineOptions): VirtualNetworkBackend {
    const address = copyAddr(options.address instanceof Uint8Array
      ? options.address
      : new Uint8Array(options.address));
    const key = ipKey(address);
    if ((toU32(address) & this.mask) !== this.networkAddress
      || (this.broadcastAddress && (toU32(address) === this.networkAddress || this.isBroadcast(address)))) {
      throw new Error(`address ${key} is not a host address on this link`);
    }
    if (this.addressOwners.has(key)) {
      throw new Error(`address ${key} is already attached`);
    }
    const backend = new VirtualNetworkBackend(this, options.id, address);
    this.machines.set(options.id, backend);
    this.addressOwners.set(key, options.id);
    this.hostnames.set(options.id, address);
    for (const hostname of options.hostnames ?? []) {
      this.hostnames.set(hostname, address);
    }
    return backend;
  }

  detachMachine(machineId: string): void {
    const backend = this.machines.get(machineId);
    if (!backend) return;
    this.addressOwners.delete(ipKey(backend.localAddress));
    this.machines.delete(machineId);
    for (const [hostname, addr] of this.hostnames) {
      if (ipKey(addr) === ipKey(backend.localAddress) || hostname === machineId) {
        this.hostnames.delete(hostname);
      }
    }
    this.tcpListeners = this.tcpListeners.filter((l) => l.machineId !== machineId);
    this.udpEndpoints = this.udpEndpoints.filter((e) => e.machineId !== machineId);
    for (const peer of this.tcpPeersByMachine.get(machineId) ?? []) {
      peer.abort();
    }
    this.tcpPeersByMachine.delete(machineId);
    backend.resetAllConnections();
  }

  hasAddress(addr: Uint8Array): boolean { return this.addressOwners.has(ipKey(addr)); }

  resolve(hostname: string): Uint8Array | null {
    const direct = parseNumericIpv4Hostname(hostname);
    if (direct) return direct;
    validateDnsHostname(hostname);
    const addr = this.hostnames.get(hostname);
    return addr ? copyAddr(addr) : null;
  }

  listenTcp(
    machineId: string,
    listenerId: string,
    addr: Uint8Array,
    port: number,
    target: TcpListenTarget,
  ): number {
    const addrKey = ipKey(addr);
    if (!this.machineOwnsAddress(machineId, addrKey)) return EADDRNOTAVAIL;
    for (const listener of this.tcpListeners) {
      if (
        listener.machineId === machineId &&
        listener.port === port &&
        addrConflicts(listener.addrKey, addrKey)
      ) {
        return EADDRINUSE;
      }
    }
    this.closeTcpListener(listenerId);
    this.tcpListeners.push({
      machineId,
      listenerId,
      addr: copyAddr(addr),
      addrKey,
      port,
      target,
    });
    return 0;
  }

  closeTcpListener(listenerId: string): void {
    this.tcpListeners = this.tcpListeners.filter((l) => l.listenerId !== listenerId);
  }

  connectTcp(
    sourceMachineId: string,
    source: NetworkAddress,
    destination: NetworkAddress,
  ): TcpConnection {
    const dstKey = ipKey(destination.addr);
    const targetMachineId = this.addressOwners.get(dstKey);
    if (!targetMachineId) {
      return { peer: new VirtualTcpPeer(), status: EHOSTUNREACH };
    }
    const listener = this.tcpListeners.find((candidate) =>
      candidate.machineId === targetMachineId &&
      candidate.port === destination.port &&
      addrMatches(candidate.addrKey, dstKey)
    );
    if (!listener) {
      return { peer: new VirtualTcpPeer(), status: ECONNREFUSED };
    }

    const client = this.createTcpPeer(sourceMachineId);
    const server = this.createTcpPeer(targetMachineId);
    client.pairWith(server);
    server.pairWith(client);
    const accepted = listener.target.accept(
      server,
      { addr: copyAddr(destination.addr), port: destination.port },
      { addr: copyAddr(source.addr), port: source.port },
    );
    if (accepted !== 0) {
      client.resetPeer();
      server.resetPeer();
      return { peer: client, status: accepted };
    }
    return { peer: client, status: 0 };
  }

  bindUdp(
    machineId: string,
    endpointId: string,
    addr: Uint8Array,
    port: number,
    target: UdpReceiveTarget,
  ): number {
    const addrKey = ipKey(addr);
    if (!this.machineOwnsAddress(machineId, addrKey)) return EADDRNOTAVAIL;
    for (const endpoint of this.udpEndpoints) {
      if (
        endpoint.machineId === machineId &&
        endpoint.port === port &&
        addrConflicts(endpoint.addrKey, addrKey) &&
        !(endpoint.target.kernelReceiver && target.kernelReceiver)
      ) {
        return EADDRINUSE;
      }
    }
    this.unbindUdp(endpointId);
    this.udpEndpoints.push({
      machineId,
      endpointId,
      addr: copyAddr(addr),
      addrKey,
      port,
      target,
    });
    return 0;
  }

  unbindUdp(endpointId: string): void {
    this.udpEndpoints = this.udpEndpoints.filter((e) => e.endpointId !== endpointId);
  }

  sendDatagram(datagram: UdpDatagram): number {
    if (isIpv4Multicast(datagram.dstAddr)) {
      // The sender's kernel already performed its optional local loopback.
      this.multicastDatagram(datagram, (machine) =>
        machine !== this.addressOwners.get(ipKey(datagram.srcAddr)));
      return 0;
    }
    // A broadcast reaches every machine on the link, the sender's included.
    if (this.isBroadcast(datagram.dstAddr)) {
      this.broadcastDatagram(datagram, () => true);
      return 0;
    }
    const dstKey = ipKey(datagram.dstAddr);
    const targetMachineId = this.addressOwners.get(dstKey);
    if (!targetMachineId) return EHOSTUNREACH;
    const endpoint = this.udpEndpoints.find((candidate) =>
      candidate.machineId === targetMachineId &&
      candidate.port === datagram.dstPort &&
      addrMatches(candidate.addrKey, dstKey)
    );
    if (!endpoint) return ECONNREFUSED;
    return endpoint.target.receive({
      srcAddr: copyAddr(datagram.srcAddr),
      srcPort: datagram.srcPort,
      dstAddr: copyAddr(datagram.dstAddr),
      dstPort: datagram.dstPort,
      data: datagram.data.slice(),
    });
  }

  /**
   * Deliver one limited broadcast (255.255.255.255) to every endpoint on its
   * port that accepts it, as a broadcast reaches every host on a link. Only
   * wildcard-bound sockets hear it: a socket bound to a unicast address does
   * not, as on Linux. `reaches` selects which machines the copy is for.
   */
  broadcastDatagram(datagram: UdpDatagram, reaches: (machineId: string) => boolean): void {
    for (const endpoint of [...this.udpEndpoints]) {
      if (endpoint.port !== datagram.dstPort || endpoint.addrKey !== ANY || !reaches(endpoint.machineId)) continue;
      endpoint.target.receive({
        srcAddr: copyAddr(datagram.srcAddr),
        srcPort: datagram.srcPort,
        dstAddr: copyAddr(datagram.dstAddr),
        dstPort: datagram.dstPort,
        data: datagram.data.slice(),
      });
    }
  }

  /** Link-level group flooding; kernel socket membership remains authoritative.
   * Deliver once per receive domain, not once per socket sharing the port. */
  multicastDatagram(datagram: UdpDatagram, reaches: (machineId: string) => boolean): void {
    const delivered = new Set<string>();
    for (const endpoint of [...this.udpEndpoints]) {
      if (endpoint.port !== datagram.dstPort || !addrMatches(endpoint.addrKey, ipKey(datagram.dstAddr))
        || !reaches(endpoint.machineId)) continue;
      const domain = `${endpoint.machineId}:${endpoint.target.kernelReceiver ?? endpoint.endpointId}`;
      if (delivered.has(domain)) continue;
      delivered.add(domain);
      endpoint.target.receive({ ...datagram, srcAddr: copyAddr(datagram.srcAddr),
        dstAddr: copyAddr(datagram.dstAddr), data: datagram.data.slice() });
    }
  }

  private machineOwnsAddress(machineId: string, addrKey: string): boolean {
    if (addrKey === ANY) return true;
    return this.addressOwners.get(addrKey) === machineId;
  }

  private trackTcpPeer(machineId: string, peer: VirtualTcpPeer): void {
    let peers = this.tcpPeersByMachine.get(machineId);
    if (!peers) {
      peers = new Set();
      this.tcpPeersByMachine.set(machineId, peers);
    }
    peers.add(peer);
  }

  private createTcpPeer(machineId: string): VirtualTcpPeer {
    const peer = new VirtualTcpPeer((released) => {
      const peers = this.tcpPeersByMachine.get(machineId);
      peers?.delete(released);
      if (peers?.size === 0) this.tcpPeersByMachine.delete(machineId);
    });
    this.trackTcpPeer(machineId, peer);
    return peer;
  }
}

export class VirtualNetworkBackend implements NetworkIO {
  private connections = new Map<number, TcpConnectionPeer>();
  private connectErrors = new Map<number, number>();
  private localEndpoints = new Map<number, NetworkAddress>();
  private nextEphemeralPort = 49152;

  constructor(
    private readonly network: LocalVirtualNetwork,
    private readonly machineId: string,
    readonly localAddress: Uint8Array,
  ) {}

  get localNetmask(): Uint8Array { return copyAddr(this.network.netmask); }

  udpSourceAddress(destination: Uint8Array): Uint8Array | number {
    return this.network.hasAddress(destination) || this.network.isBroadcast(destination) || isIpv4Multicast(destination)
      ? copyAddr(this.localAddress) : 101;
  }

  connect(handle: number, addr: Uint8Array, port: number, source?: NetworkAddress): void {
    if (this.connections.has(handle)) {
      this.connectErrors.set(handle, EISCONN);
      return;
    }
    if (source && (source.addr.length !== 4 || (!source.addr.every(v=>v===0) && !source.addr.every((v,i)=>v===this.localAddress[i])))) {
      this.connectErrors.set(handle,EADDRNOTAVAIL); return;
    }
    const sourcePort = source?.port || this.allocateEphemeralPort();
    const result = this.network.connectTcp(
      this.machineId,
      { addr: this.localAddress, port: sourcePort },
      { addr: copyAddr(addr), port },
    );
    if (result.status === 0) {
      this.connections.set(handle, result.peer);
      this.localEndpoints.set(handle,{addr:copyAddr(this.localAddress),port:sourcePort});
      this.connectErrors.delete(handle);
    } else {
      this.connectErrors.set(handle, result.status);
    }
  }

  connectStatus(handle: number): number {
    const err = this.connectErrors.get(handle);
    if (err !== undefined) return err;
    return this.connections.has(handle) ? 0 : ENOTCONN;
  }

  send(handle: number, data: Uint8Array, flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: ENOTCONN });
    return conn.send(data, flags);
  }

  recv(handle: number, maxLen: number, flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: ENOTCONN });
    return conn.recv(maxLen, flags);
  }

  readinessGeneration(handle: number, direction: number): bigint {
    return this.connections.get(handle)?.readinessGeneration?.(direction) ?? -1n;
  }

  readiness(handle: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: ENOTCONN });
    if (typeof conn.readiness === "function") {
      return conn.readiness();
    }
    // A peer with no readiness source. This used to `return events`, telling
    // the caller every event it asked about was ready; say so instead.
    return NET_READINESS.UNOBSERVABLE;
  }

  localEndpoint(handle: number): NetworkAddress {
    const value = this.localEndpoints.get(handle);
    if (!value) throw Object.assign(new Error("ENOTCONN"),{errno:ENOTCONN});
    return {addr:copyAddr(value.addr),port:value.port};
  }

  shutdown(handle: number, how: number): void {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), {errno: ENOTCONN});
    conn.shutdown(how);
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (conn) conn.close();
    this.connections.delete(handle);
    this.localEndpoints.delete(handle);
    this.connectErrors.delete(handle);
  }

  getaddrinfo(hostname: string): Uint8Array {
    const addr = this.network.resolve(hostname);
    if (!addr) throw Object.assign(new Error("ENOENT"), { errno: 2 });
    return addr;
  }

  listenTcp(listenerId: string, addr: Uint8Array, port: number, target: TcpListenTarget): number {
    return this.network.listenTcp(this.machineId, this.scopedId(listenerId), addr, port, target);
  }

  ownsTcpListener(addr: Uint8Array): boolean {
    return ipKey(addr) === ANY || ipKey(addr) === ipKey(this.localAddress);
  }

  closeTcpListener(listenerId: string): void {
    this.network.closeTcpListener(this.scopedId(listenerId));
  }

  bindUdp(endpointId: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number {
    return this.network.bindUdp(this.machineId, this.scopedId(endpointId), addr, port, target);
  }

  unbindUdp(endpointId: string): void {
    this.network.unbindUdp(this.scopedId(endpointId));
  }

  sendDatagram(datagram: UdpDatagram): number {
    // A socket bound to INADDR_ANY retains that wildcard in getsockname(),
    // but its outgoing packet needs the address of the selected interface.
    return this.network.sendDatagram({
      ...datagram,
      srcAddr: ipKey(datagram.srcAddr) === ANY ? this.localAddress : datagram.srcAddr,
    });
  }

  resetAllConnections(): void {
    for (const conn of this.connections.values()) conn.abort();
    this.connections.clear();
    this.connectErrors.clear();
  }

  private allocateEphemeralPort(): number {
    const port = this.nextEphemeralPort;
    this.nextEphemeralPort += 1;
    if (this.nextEphemeralPort > 65535) this.nextEphemeralPort = 49152;
    return port;
  }

  private scopedId(id: string): string {
    return `${this.machineId}:${id}`;
  }
}

export const VIRTUAL_NETWORK_ERRNO = {
  EADDRINUSE,
  EADDRNOTAVAIL,
  ENETUNREACH,
  ECONNRESET,
  ENOTCONN,
  ECONNREFUSED,
  EHOSTUNREACH,
} as const;
