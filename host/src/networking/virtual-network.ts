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

const EADDRINUSE = 98;
const EADDRNOTAVAIL = 99;
const ENETUNREACH = 101;
const ECONNRESET = 104;
const ENOTCONN = 107;
const EISCONN = 106;
const ECONNREFUSED = 111;
const EHOSTUNREACH = 113;
const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;

const ANY = "0.0.0.0";

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
  private closed = false;
  private reset = false;

  pairWith(peer: VirtualTcpPeer): void {
    this.peer = peer;
  }

  enqueue(data: Uint8Array): void {
    if (this.readClosed || this.reset) return;
    this.recvBuf = concatBytes(this.recvBuf, data);
  }

  send(data: Uint8Array, _flags: number): number {
    if (this.reset) {
      const err = new Error("ECONNRESET") as Error & { errno?: number };
      err.errno = ECONNRESET;
      throw err;
    }
    if (this.writeClosed || !this.peer || this.peer.readClosed || this.peer.reset) {
      const err = new Error("EPIPE") as Error & { errno?: number };
      err.errno = 32;
      throw err;
    }
    // A peer close(2) on TCP is an orderly FIN for its write side, not an
    // immediate refusal of incoming data. Linux commonly lets the first write
    // after observing peer EOF succeed and reports the resulting reset on a
    // later operation. Preserve that POSIX-compatible TCP behavior by accepting
    // and discarding data sent to a fully closed peer, then marking this side
    // reset for subsequent operations. Explicit SHUT_RD remains EPIPE via the
    // readClosed check above.
    if (this.peer.closed) {
      this.reset = true;
      return data.length;
    }
    this.peer.enqueue(data.slice());
    return data.length;
  }

  recv(maxLen: number, _flags: number): Uint8Array {
    if (this.reset) {
      const err = new Error("ECONNRESET") as Error & { errno?: number };
      err.errno = ECONNRESET;
      throw err;
    }
    if (this.recvBuf.length > 0) {
      const len = Math.min(maxLen, this.recvBuf.length);
      const out = this.recvBuf.slice(0, len);
      this.recvBuf = this.recvBuf.slice(len);
      return out;
    }
    if (!this.peer || this.peer.writeClosed) {
      return new Uint8Array(0);
    }
    throw new EagainError();
  }

  poll(events: number): number {
    let revents = 0;
    if (this.reset) {
      revents |= POLLERR;
    }
    if ((events & POLLIN) !== 0) {
      if (this.recvBuf.length > 0 || !this.peer || this.peer.writeClosed || this.readClosed) {
        revents |= POLLIN;
      }
      if (!this.peer || this.peer.writeClosed) {
        revents |= POLLHUP;
      }
    }
    if ((events & POLLOUT) !== 0) {
      if (!this.writeClosed && this.peer && !this.peer.readClosed && !this.peer.reset) {
        revents |= POLLOUT;
      }
    }
    return revents;
  }

  shutdown(how: number): void {
    if (how === 0 || how === 2) {
      this.readClosed = true;
      this.recvBuf = new Uint8Array(0);
    }
    if (how === 1 || how === 2) {
      this.writeClosed = true;
    }
  }

  close(): void {
    this.closed = true;
    this.writeClosed = true;
    this.recvBuf = new Uint8Array(0);
  }

  abort(): void {
    this.closed = true;
    this.readClosed = true;
    this.writeClosed = true;
    this.reset = true;
    this.recvBuf = new Uint8Array(0);
    this.peer?.resetPeer();
  }

  resetPeer(): void {
    this.reset = true;
    this.recvBuf = new Uint8Array(0);
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

export interface VirtualNetworkMachineOptions {
  id: string;
  address: Uint8Array | [number, number, number, number];
  hostnames?: string[];
}

export class LocalVirtualNetwork {
  private machines = new Map<string, VirtualNetworkBackend>();
  private addressOwners = new Map<string, string>();
  private hostnames = new Map<string, Uint8Array>();
  private tcpListeners: TcpListener[] = [];
  private udpEndpoints: UdpEndpoint[] = [];
  private tcpPeersByMachine = new Map<string, Set<VirtualTcpPeer>>();

  attachMachine(options: VirtualNetworkMachineOptions): VirtualNetworkBackend {
    const address = copyAddr(options.address instanceof Uint8Array
      ? options.address
      : new Uint8Array(options.address));
    const key = ipKey(address);
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

    const client = new VirtualTcpPeer();
    const server = new VirtualTcpPeer();
    client.pairWith(server);
    server.pairWith(client);
    this.trackTcpPeer(sourceMachineId, client);
    this.trackTcpPeer(targetMachineId, server);
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
        addrConflicts(endpoint.addrKey, addrKey)
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
}

export class VirtualNetworkBackend implements NetworkIO {
  private connections = new Map<number, TcpConnectionPeer>();
  private connectErrors = new Map<number, number>();
  private nextEphemeralPort = 49152;

  constructor(
    private readonly network: LocalVirtualNetwork,
    private readonly machineId: string,
    readonly localAddress: Uint8Array,
  ) {}

  connect(handle: number, addr: Uint8Array, port: number): void {
    if (this.connections.has(handle)) {
      this.connectErrors.set(handle, EISCONN);
      return;
    }
    const sourcePort = this.allocateEphemeralPort();
    const result = this.network.connectTcp(
      this.machineId,
      { addr: this.localAddress, port: sourcePort },
      { addr: copyAddr(addr), port },
    );
    if (result.status === 0) {
      this.connections.set(handle, result.peer);
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

  poll(handle: number, events: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: ENOTCONN });
    if (typeof conn.poll === "function") {
      return conn.poll(events);
    }
    return events;
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (conn) conn.close();
    this.connections.delete(handle);
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
    return this.network.sendDatagram(datagram);
  }

  resetAllConnections(): void {
    for (const conn of this.connections.values()) {
      if (typeof conn.abort === "function") conn.abort();
      else conn.close();
    }
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
