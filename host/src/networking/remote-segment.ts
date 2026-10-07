import type { NetworkIO, TcpListenTarget, UdpDatagram, UdpReceiveTarget } from "../types";
import { LocalVirtualNetwork, type VirtualNetworkBackend } from "./virtual-network";
import { IPV4_UDP_MAX_PAYLOAD } from "./remote-udp-codec";

const MAX_MEMBERS = 16;
// The largest valid directory fits one 64 KiB reliable control message.
const MAX_BINDINGS = 32;
export const MAX_SEGMENT_CONTROL_BYTES = 64 * 1024;
const EADDRNOTAVAIL = 99;
const ENETUNREACH = 101;
const ENOBUFS = 105;
const ENOTCONN = 107;
import {RemoteTcpEngine} from './remote-tcp';
import {type RemoteTcpFrame} from './remote-tcp-codec';
const EOPNOTSUPP = 95;
const EMSGSIZE = 90;

export interface RemoteSegmentMember {
  id: number;
  maxPayload: number;
  maxTcpData?: number;
}
export interface RemoteSegmentBinding {
  owner: number;
  id: string;
  addr: number[];
  port: number;
}
export type RemoteSegmentControl =
  | { version: 1; type: "hello" }
  | { version: 1; type: "directory"; self: number; members: RemoteSegmentMember[]; bindings: RemoteSegmentBinding[]; tcpBindings?: RemoteSegmentBinding[] }
  | { version: 1; type: "bind"; id: string; addr: number[]; port: number }
  | { version: 1; type: "unbind"; id: string }
  | { version: 1; type: "listen"; id: string; addr: number[]; port: number }
  | { version: 1; type: "unlisten"; id: string };

/** Shared by the browser port bridge and Node transports. Errnos are positive. */
export interface RemoteSegmentTransport {
  readonly maxPayload: number;
  readonly maxTcpData?: number;
  canSendTcp?(length: number): boolean;
  sendTcp?(frame: RemoteTcpFrame): boolean;
  onTcp?(listener: (frame: RemoteTcpFrame) => void): () => void;
  onWritable?(listener: () => void): () => void;
  sendControl(message: RemoteSegmentControl): boolean;
  sendDatagram(datagram: UdpDatagram): number;
  onControl(listener: (message: unknown) => void): () => void;
  onDatagram(listener: (datagram: UdpDatagram) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
}

export interface RemoteSegmentSnapshot {
  address: string | null;
  members: { address: string; hostname: string; maxPayload: number }[];
  bindings: { address: string; port: number; endpoint: string }[];
  tcpListeners: {address: string; port: number; endpoint: string}[];
}

const address = (id: number) => new Uint8Array([10, 89, 0, id]);
const addressKey = (addr: Uint8Array | number[]) => Array.from(addr).join(".");
const machineName = (id: number) => id === 1 ? "host" : `peer-${id}`;
const endpointKey = (owner: number, id: string) => `${owner}:${id}`;
const inSegment = (addr: Uint8Array) => addr.length === 4 && addr[0] === 10 && addr[1] === 89 && addr[2] === 0;
const validId = (id: unknown): id is number => Number.isInteger(id) && Number(id) >= 1 && Number(id) <= 254;
const validEndpoint = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9:._-]{1,64}$/.test(id);
const validPort = (port: unknown): port is number => Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535;
const validLimit = (limit: unknown): limit is number => Number.isInteger(limit) && Number(limit) >= 0 && Number(limit) <= IPV4_UDP_MAX_PAYLOAD;
const ownedBindAddress = (addr: unknown, owner: number): addr is number[] =>
  Array.isArray(addr) && addr.length === 4 && addr.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  && (addr.every((part) => part === 0) || addressKey(addr) === addressKey(address(owner)));

function parseControl(value: unknown): RemoteSegmentControl {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SEGMENT_CONTROL_BYTES) throw new Error("remote segment control exceeds its limit");
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    throw new Error("invalid remote segment control version");
  }
  const message = value as RemoteSegmentControl;
  if (message.type === "hello") {
    // Sent after the joiner installs its byte bridge; resend a directory
    // that may have arrived before its RTC message listener was attached.
  } else if ((message.type === "bind" || message.type === "listen")) {
    if (!validEndpoint(message.id) || !validPort(message.port)) throw new Error("invalid remote UDP binding");
  } else if ((message.type === "unbind" || message.type === "unlisten")) {
    if (!validEndpoint(message.id)) throw new Error("invalid remote UDP endpoint");
  } else if (message.type === "directory") {
    if (!validId(message.self) || message.self === 1 || !Array.isArray(message.members)
      || !Array.isArray(message.bindings) || message.members.length < 2 || message.members.length > MAX_MEMBERS
      || message.bindings.length > MAX_MEMBERS * MAX_BINDINGS) throw new Error("invalid remote segment directory");
    const ids = new Set<number>();
    for (const member of message.members) {
      if (!validId(member?.id) || !validLimit(member.maxPayload) || ids.has(member.id)) throw new Error("invalid remote segment member");
      if (member.maxTcpData !== undefined && (!Number.isInteger(member.maxTcpData) || member.maxTcpData < 0 || member.maxTcpData > 16384)) throw new Error("invalid remote TCP frame ceiling");
      ids.add(member.id);
    }
    if (!ids.has(1) || !ids.has(message.self)) throw new Error("remote directory lacks host or local ownership");
    if (message.tcpBindings !== undefined && !Array.isArray(message.tcpBindings)) throw new Error("invalid TCP directory");
    const endpoints = new Set<string>();
    const counts = new Map<number, number>();
    for (const binding of [...message.bindings, ...(message.tcpBindings ?? [])]) {
      if (!binding || !ids.has(binding.owner) || !validEndpoint(binding.id) || !validPort(binding.port)
        || !ownedBindAddress(binding.addr, binding.owner)) throw new Error("invalid remote directory binding");
      const key = `${message.bindings.includes(binding) ? "udp" : "tcp"}:${endpointKey(binding.owner, binding.id)}`;
      const count = (counts.get(binding.owner) ?? 0) + 1;
      if (endpoints.has(key) || count > MAX_BINDINGS) throw new Error("duplicate or excessive remote bindings");
      endpoints.add(key); counts.set(binding.owner, count);
    }
  } else throw new Error("unknown remote segment control type");
  return message;
}

/**
 * A remote extension of LocalVirtualNetwork. All routing and endpoint state
 * belongs in a kernel worker. Transports carry bytes; they do not run syscalls.
 */
export class RemoteVirtualNetwork implements NetworkIO {
  private readonly network = new LocalVirtualNetwork();
  private readonly members = new Map<number, RemoteSegmentMember>();
  private readonly bindings = new Map<string, RemoteSegmentBinding>();
  private readonly tcpBindings = new Map<string, RemoteSegmentBinding>();
  private tcp?: RemoteTcpEngine;
  private readonly localTcpHandles = new Set<number>();
  private readonly localTcpConnecting = new Set<number>();
  private readonly mirroredEndpoints = new Set<string>();
  private readonly peers = new Map<number, RemoteSegmentTransport>();
  private readonly subscriptions = new Map<number, (() => void)[]>();
  private local?: VirtualNetworkBackend;
  private localId?: number;
  private nextMemberId = 2;
  private closed = false;
  private readonly connectErrors = new Map<number, number>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve; this.rejectReady = reject;
  });

  constructor(readonly role: "host" | "joiner", private readonly fallback?: NetworkIO) {
    if (role !== "host" && role !== "joiner") throw new Error("invalid remote segment role");
    void this.ready.catch(() => {});
    if (role === "host") {
      this.localId = 1;
      this.members.set(1, { id: 1, maxPayload: IPV4_UDP_MAX_PAYLOAD, maxTcpData: 16384 });
      this.local = this.attachMember(1);
      this.initializeTcp();
      this.resolveReady();
    }
  }

  get localAddress(): Uint8Array | undefined { return this.local?.localAddress; }

  udpSourceAddress(destination: Uint8Array): Uint8Array | number {
    if (this.localAddress && inSegment(destination)) return this.localAddress.slice();
    return this.fallback?.udpSourceAddress?.(destination) ?? ENETUNREACH;
  }

  attachPeer(transport: RemoteSegmentTransport): number {
    if (this.closed || !validLimit(transport.maxPayload)) throw new Error("invalid or closed remote segment transport");
    if (this.role === "joiner") {
      if (this.peers.size) throw new Error("a joiner has one link to its forwarding host");
      this.installPeer(1, transport);
      if (!transport.sendControl({ version: 1, type: "hello" })) {
        this.dropPeer(1, "the remote segment hello could not be admitted");
        throw new Error("the remote segment hello could not be admitted");
      }
      return 1;
    }
    if (this.members.size >= MAX_MEMBERS) throw new Error("the remote segment is full");
    if (this.nextMemberId > 254) throw new Error("remote segment address lifetime exhausted; create a new segment");
    const id = this.nextMemberId++;
    this.members.set(id, { id, maxPayload: transport.maxPayload, maxTcpData: transport.maxTcpData ?? 0 });
    this.attachMember(id);
    this.installPeer(id, transport);
    this.publishDirectory();
    if (!this.peers.has(id)) throw new Error("the remote peer could not accept its segment directory");
    return id;
  }

  private attachMember(id: number): VirtualNetworkBackend {
    return this.network.attachMachine({ id: machineName(id), address: address(id) });
  }

  private installPeer(id: number, transport: RemoteSegmentTransport): void {
    this.peers.set(id, transport);
    this.subscriptions.set(id, [
      transport.onControl((value) => {
        try { this.receiveControl(id, parseControl(value)); }
        catch (error) { this.dropPeer(id, String(error), true); }
      }),
      transport.onDatagram((datagram) => {
        // A star's host authenticates the source on the ingress link. A
        // joiner receives forwarded sources from any member through the host.
        if (!this.localId || !inSegment(datagram.srcAddr)
          || !this.members.has(datagram.srcAddr[3])
          || (this.role === "host" && datagram.srcAddr[3] !== id)
          || (this.role === "joiner" && addressKey(datagram.dstAddr) !== addressKey(this.localAddress!))) {
          this.dropPeer(id, "the remote peer sent a datagram outside its address ownership");
          return;
        }
        this.network.sendDatagram(datagram);
      }),
      transport.onTcp?.((frame) => {
        try { this.receiveTcp(id, frame); } catch (error) { this.dropPeer(id, String(error), true); }
      }) ?? (() => {}),
      transport.onWritable?.(() => this.tcp?.writable()) ?? (() => {}),
      transport.onClose((reason) => this.dropPeer(id, reason)),
    ]);
  }

  private initializeTcp(): void {
    if (this.tcp || !this.localAddress) return;
    this.tcp = new RemoteTcpEngine(this.localAddress.slice(), {
      send: (frame) => {
        const transport = this.peers.get(this.role === "host" ? frame.destination.addr[3] : 1);
        return transport?.sendTcp?.(frame) ?? false;
      },
      canSend: (destination) => this.peers.get(this.role === "host" ? destination[3] : 1)?.canSendTcp?.(1) ?? false,
      maxData: (destination) => Math.min(this.members.get(destination[3])?.maxTcpData ?? 0,
        this.peers.get(this.role === "host" ? destination[3] : 1)?.maxTcpData ?? 0),
      failed: (reason) => { for (const id of [...this.peers.keys()]) this.dropPeer(id, reason, true); },
    });
  }
  private receiveTcp(ingress: number, frame: RemoteTcpFrame): void {
    if (!this.localId || !inSegment(frame.source.addr) || !inSegment(frame.destination.addr)
      || !this.members.has(frame.source.addr[3]) || !this.members.has(frame.origin)
      || (this.role === "host" && frame.source.addr[3] !== ingress)
      || (this.role === "joiner" && frame.destination.addr[3] !== this.localId)) throw new Error("remote TCP source ownership violated");
    if (frame.destination.addr[3] === this.localId) { this.tcp!.receive(frame); return; }
    const transport = this.peers.get(frame.destination.addr[3]);
    // Forwarding has no stream buffer. Losing admitted reliable traffic tears
    // down the ingress link so every affected endpoint observes a reset.
    if (!transport?.sendTcp?.(frame)) this.dropPeer(ingress, "remote TCP forwarding could not be admitted",true);
  }

  private receiveControl(peer: number, message: RemoteSegmentControl): void {
    if (this.role === "joiner") {
      if (message.type !== "directory") throw new Error("the forwarding host must send a directory");
      this.installDirectory(message);
      return;
    }
    if (message.type === "hello") { this.publishDirectory(); return; }
    if (message.type === "directory") throw new Error("a joiner cannot assign segment addresses");
    const key = endpointKey(peer, message.id);
    if (message.type === "listen" || message.type === "unlisten") {
      if (message.type === "unlisten") this.tcpBindings.delete(key);
      else {
        if (!ownedBindAddress(message.addr, peer)) throw new Error("TCP listener address ownership violated");
        if (!this.tcpBindings.has(key) && this.bindingCount(peer) >= MAX_BINDINGS) throw new Error("binding directory is full");
        for (const [other, binding] of this.tcpBindings) if (other !== key && binding.owner === peer && binding.port === message.port) throw new Error("conflicting TCP listener");
        this.tcpBindings.set(key, {owner:peer,id:message.id,addr:[...message.addr],port:message.port});
      }
      this.publishDirectory(); return;
    }
    if (message.type === "unbind") {
      this.bindings.delete(key);
      this.network.unbindUdp(`remote:${key}`);
      this.mirroredEndpoints.delete(key);
    } else {
      if (!ownedBindAddress(message.addr, peer)) throw new Error("the joiner tried to bind another member's address");
      if (!this.bindings.has(key) && this.bindingCount(peer) >= MAX_BINDINGS) throw new Error("the joiner's binding directory is full");
      const binding = { owner: peer, id: message.id, addr: [...message.addr], port: message.port };
      this.mirrorBinding(binding);
      this.bindings.set(key, binding);
    }
    this.publishDirectory();
  }

  private installDirectory(message: Extract<RemoteSegmentControl, { type: "directory" }>): void {
    if (this.localId !== undefined && this.localId !== message.self) throw new Error("the host changed this machine's address assignment");
    const transport = this.peers.get(1)!;
    if (message.members.find((member) => member.id === message.self)!.maxPayload !== transport.maxPayload) {
      throw new Error("the host's local transport limit differs from negotiation");
    }
    if ((message.members.find(member => member.id === message.self)!.maxTcpData ?? 0) !== (transport.maxTcpData ?? 0)) throw new Error("TCP frame ceiling differs from negotiation");
    this.clearMirroredBindings();
    const incoming = new Set(message.members.map((member) => member.id));
    for (const id of this.members.keys()) {
      if (!incoming.has(id)) { this.tcp?.disconnect(address(id)); this.network.detachMachine(machineName(id)); this.members.delete(id); }
    }
    this.localId = message.self;
    for (const member of message.members) {
      if (!this.members.has(member.id)) {
        const backend = this.attachMember(member.id);
        if (member.id === this.localId) this.local = backend;
      }
      this.members.set(member.id, { id: member.id, maxPayload: member.maxPayload, maxTcpData: member.maxTcpData ?? 0 });
    }
    for (const [key, binding] of this.bindings) if (binding.owner !== this.localId) this.bindings.delete(key);
    for (const binding of message.bindings) {
      if (binding.owner === this.localId) continue;
      this.mirrorBinding(binding);
      this.bindings.set(endpointKey(binding.owner, binding.id), { owner: binding.owner, id: binding.id, port: binding.port, addr: [...binding.addr] });
    }
    for (const [key, binding] of this.tcpBindings) if (binding.owner !== this.localId) this.tcpBindings.delete(key);
    for (const binding of message.tcpBindings ?? []) if (binding.owner !== this.localId) this.tcpBindings.set(endpointKey(binding.owner,binding.id), {...binding,addr:[...binding.addr]});
    this.initializeTcp();
    this.resolveReady();
  }

  private mirrorBinding(binding: RemoteSegmentBinding): void {
    const key = endpointKey(binding.owner, binding.id);
    const result = this.network.bindUdp(machineName(binding.owner), `remote:${key}`,
      new Uint8Array(binding.addr), binding.port, {
        receive: (datagram) => {
          const transport = this.peers.get(this.role === "host" ? binding.owner : 1);
          const limit = Math.min(transport?.maxPayload ?? 0, this.members.get(binding.owner)?.maxPayload ?? 0);
          if (datagram.data.length > limit) return EMSGSIZE;
          return transport ? transport.sendDatagram(datagram) : ENETUNREACH;
        },
      });
    if (result !== 0) throw new Error(`conflicting remote UDP endpoint (${result})`);
    this.mirroredEndpoints.add(key);
  }

  private clearMirroredBindings(): void {
    for (const key of this.mirroredEndpoints) this.network.unbindUdp(`remote:${key}`);
    this.mirroredEndpoints.clear();
  }

  private bindingCount(owner: number): number {
    let count = 0;
    for (const binding of [...this.bindings.values(), ...this.tcpBindings.values()]) if (binding.owner === owner) count++;
    return count;
  }

  private publishDirectory(): void {
    for (const [self, transport] of [...this.peers]) {
      if (!transport.sendControl({ version: 1, type: "directory", self,
        members: [...this.members.values()].map((member) => ({ ...member })),
        tcpBindings: [...this.tcpBindings.values()].map(binding => ({...binding,addr:[...binding.addr]})),
        bindings: [...this.bindings.values()].map((binding) => ({ owner: binding.owner, id: binding.id, port: binding.port, addr: [...binding.addr] })),
      })) this.dropPeer(self, "the reliable segment control bridge is full");
    }
  }

  private dropPeer(id: number, reason: string, forceReset = false): void {
    const transport = this.peers.get(id);
    if (!transport) return;
    this.peers.delete(id);
    for (const unsubscribe of this.subscriptions.get(id) ?? []) unsubscribe();
    this.subscriptions.delete(id);
    transport.close();
    if (this.role === "joiner") this.tcp?.disconnect(undefined,forceReset);
    else this.tcp?.disconnect(address(id),forceReset);
    for (const [key, binding] of this.tcpBindings) if (this.role === "joiner" ? binding.owner !== this.localId : binding.owner === id) this.tcpBindings.delete(key);
    if (this.role === "joiner") {
      this.rejectReady(new Error(`remote segment disconnected: ${reason}`));
      this.clearMirroredBindings();
      for (const member of [...this.members.keys()]) {
        if (member !== this.localId) { this.network.detachMachine(machineName(member)); this.members.delete(member); }
      }
      for (const [key, binding] of this.bindings) if (binding.owner !== this.localId) this.bindings.delete(key);
    } else {
      this.network.detachMachine(machineName(id));
      this.members.delete(id);
      for (const [key, binding] of this.bindings) if (binding.owner === id) {
        this.bindings.delete(key); this.mirroredEndpoints.delete(key);
      }
      this.publishDirectory();
    }
  }

  bindUdp(id: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number {
    if (!this.local || this.closed) return ENETUNREACH;
    if (!validEndpoint(id) || !validPort(port)) return EADDRNOTAVAIL;
    const key = endpointKey(this.localId!, id);
    if (!this.bindings.has(key) && this.bindingCount(this.localId!) >= MAX_BINDINGS) return ENOBUFS;
    const result = this.local.bindUdp(id, addr, port, target);
    if (result !== 0) return result;
    if (this.role === "joiner" && !this.peers.get(1)?.sendControl({ version: 1, type: "bind", id, addr: Array.from(addr), port })) {
      this.local.unbindUdp(id); return ENETUNREACH;
    }
    this.bindings.set(key, { owner: this.localId!, id, addr: Array.from(addr), port });
    if (this.role === "host") this.publishDirectory();
    return 0;
  }

  unbindUdp(id: string): void {
    this.local?.unbindUdp(id);
    this.bindings.delete(endpointKey(this.localId!, id));
    if (this.role === "host") this.publishDirectory();
    else if (this.peers.get(1) && !this.peers.get(1)!.sendControl({ version: 1, type: "unbind", id })) {
      this.dropPeer(1, "the reliable segment control bridge is full");
    }
  }

  sendDatagram(datagram: UdpDatagram): number {
    if (!this.local || this.closed) return ENETUNREACH;
    if (addressKey(datagram.srcAddr) !== "0.0.0.0"
      && addressKey(datagram.srcAddr) !== addressKey(this.localAddress!)) return EADDRNOTAVAIL;
    return this.local.sendDatagram(datagram);
  }

  getaddrinfo(hostname: string): Uint8Array {
    const result = this.network.resolve(hostname);
    if (result) return result;
    if (this.fallback) return this.fallback.getaddrinfo(hostname);
    throw Object.assign(new Error("ENOENT"), { errno: 2 });
  }

  connect(handle: number, addr: Uint8Array, port: number, source?: import("../types").NetworkAddress): void {
    this.connectErrors.delete(handle);
    if (inSegment(addr)) {
      if (!this.local || this.closed || !this.members.has(addr[3])) { this.connectErrors.set(handle, 113); return; }
      if (addr[3] === this.localId) {
        this.localTcpHandles.add(handle); this.localTcpConnecting.add(handle);
        const destination = addr.slice(); const localSource = source ? {addr:source.addr.slice(),port:source.port} : undefined;
        // LocalVirtualNetwork accepts synchronously. Leave the host import's
        // kernel entry before its target injects into this same kernel.
        queueMicrotask(() => {
          if (!this.localTcpConnecting.delete(handle)) return;
          if (this.closed) {this.connectErrors.set(handle,113);return;}
          try {this.local!.connect(handle,destination,port,localSource);}
          catch(error){this.connectErrors.set(handle,(error as {errno?:number}).errno ?? 5);}
        }); return;
      }
      if (!this.members.get(addr[3])?.maxTcpData || !this.peers.get(this.role === "host" ? addr[3] : 1)?.maxTcpData) { this.connectErrors.set(handle, EOPNOTSUPP); return; }
      try { this.tcp!.connect(handle,{addr,port},source); } catch (error) { this.connectErrors.set(handle, (error as {errno?:number}).errno ?? 5); }
    } else if (!this.fallback) this.connectErrors.set(handle, ENETUNREACH);
    else this.fallback.connect(handle,addr,port,source);
  }
  connectStatus(handle: number): number {
    if (this.connectErrors.has(handle)) return this.connectErrors.get(handle)!;
    if (this.tcp?.has(handle)) return this.tcp.connection(handle).status;
    if (this.localTcpConnecting.has(handle)) return -11;
    if (this.localTcpHandles.has(handle)) return this.local!.connectStatus(handle);
    return this.fallback?.connectStatus(handle) ?? ENOTCONN;
  }
  send(handle: number, data: Uint8Array, flags: number): number {
    if (this.tcp?.has(handle)) return this.tcp.connection(handle).send(data,flags);
    if (this.localTcpHandles.has(handle)) return this.local!.send(handle,data,flags);
    if (!this.fallback || this.connectErrors.has(handle)) throw Object.assign(new Error("ENOTCONN"), {errno:ENOTCONN});
    return this.fallback.send(handle,data,flags);
  }
  recv(handle: number, maxLen: number, flags: number): Uint8Array {
    if (this.tcp?.has(handle)) return this.tcp.connection(handle).recv(maxLen,flags);
    if (this.localTcpHandles.has(handle)) return this.local!.recv(handle,maxLen,flags);
    if (!this.fallback || this.connectErrors.has(handle)) throw Object.assign(new Error("ENOTCONN"), {errno:ENOTCONN});
    return this.fallback.recv(handle,maxLen,flags);
  }
  poll(handle: number, events: number): number {
    if (this.connectErrors.has(handle)) return 8;
    if (this.tcp?.has(handle)) return this.tcp.connection(handle).poll(events);
    if (this.localTcpHandles.has(handle)) return this.local!.poll(handle,events);
    return this.fallback?.poll?.(handle,events) ?? 0;
  }
  localEndpoint(handle: number): import('../types').NetworkAddress {
    if (this.tcp?.has(handle)) return {addr:this.tcp.connection(handle).local.addr.slice(),port:this.tcp.connection(handle).local.port};
    const backend = this.localTcpHandles.has(handle) ? this.local : this.fallback;
    if (!backend?.localEndpoint) throw Object.assign(new Error("EOPNOTSUPP"),{errno:95});
    return backend.localEndpoint(handle);
  }
  shutdown(handle: number, how: number): void {
    if (this.tcp?.has(handle)) { this.tcp.connection(handle).shutdown(how); return; }
    const backend = this.localTcpHandles.has(handle) ? this.local : this.fallback;
    if (!backend?.shutdown) throw Object.assign(new Error("EOPNOTSUPP"), {errno:95});
    backend.shutdown(handle,how);
  }
  close(handle?: number): void {
    if (handle !== undefined) {
      this.connectErrors.delete(handle); this.localTcpConnecting.delete(handle);
      if (this.tcp?.has(handle)) this.tcp.close(handle);
      else if (this.localTcpHandles.delete(handle)) this.local?.close(handle);
      else this.fallback?.close(handle);
      return;
    }
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.peers.keys()]) this.dropPeer(id, "the local segment closed");
    for (const id of this.members.keys()) this.network.detachMachine(machineName(id));
    this.localTcpConnecting.clear(); this.tcp?.dispose(); this.members.clear(); this.bindings.clear(); this.tcpBindings.clear(); this.mirroredEndpoints.clear();
    this.rejectReady(new Error("the local segment closed before assignment"));
  }
  listenTcp(id: string, addr: Uint8Array, port: number, target: TcpListenTarget): number {
    if (!this.local || this.closed) return ENETUNREACH;
    const key = endpointKey(this.localId!,id);
    if (!validEndpoint(id) || !validPort(port)) return EADDRNOTAVAIL;
    if (!this.tcpBindings.has(key) && this.bindingCount(this.localId!) >= MAX_BINDINGS) return ENOBUFS;
    const result = this.tcp!.listen(id,addr,port,target);
    if (result) return result;
    const localResult = this.local.listenTcp(id,addr,port,target);
    if (localResult) { this.tcp!.unlisten(id); return localResult; }
    if (this.role === "joiner" && !this.peers.get(1)?.sendControl({version:1,type:"listen",id,addr:Array.from(addr),port})) {
      this.tcp!.unlisten(id); this.local.closeTcpListener(id); return ENETUNREACH;
    }
    this.tcpBindings.set(key,{owner:this.localId!,id,addr:Array.from(addr),port});
    if (this.role === "host") this.publishDirectory();
    return 0;
  }
  closeTcpListener(id: string): void {
    this.tcp?.unlisten(id); this.local?.closeTcpListener(id); this.tcpBindings.delete(endpointKey(this.localId!,id));
    if (this.role === "host") this.publishDirectory();
    else if (this.peers.get(1) && !this.peers.get(1)!.sendControl({version:1,type:"unlisten",id})) this.dropPeer(1,"TCP unlisten could not be admitted");
  }

  snapshot(): RemoteSegmentSnapshot {
    return {
      address: this.localAddress ? addressKey(this.localAddress) : null,
      members: [...this.members.values()].map((member) => ({ address: addressKey(address(member.id)), hostname: machineName(member.id), maxPayload: member.maxPayload })),
      tcpListeners: [...this.tcpBindings.values()].map(binding => ({address:addressKey(address(binding.owner)),port:binding.port,endpoint:binding.id})),
      bindings: [...this.bindings.values()].map((binding) => ({ address: addressKey(address(binding.owner)), port: binding.port, endpoint: binding.id })),
    };
  }
}
