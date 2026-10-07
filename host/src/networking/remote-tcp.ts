import type { NetworkAddress, TcpConnectionPeer, TcpListenTarget } from '../types';
import { REMOTE_TCP_DATA_BYTES, REMOTE_TCP_WINDOW_BYTES, TCP_FRAME, validateRemoteTcpFrame, type RemoteTcpFrame } from './remote-tcp-codec';

export const MAX_REMOTE_TCP_STREAMS = 64;
const endpointEqual = (a: NetworkAddress, b: NetworkAddress) => a.port === b.port && a.addr.every((v, i) => v === b.addr[i]);
const copyEndpoint = (a: NetworkAddress): NetworkAddress => ({addr: a.addr.slice(), port: a.port});
const key = (origin: number, serial: number) => `${origin}:${serial}`;
const fail = (errno: number): never => { throw Object.assign(new Error(`TCP errno ${errno}`), {errno}); };

export interface RemoteTcpRouter {
  /** Admission only; reliable delivery must never silently discard this frame. */
  send(frame: RemoteTcpFrame): boolean;
  maxData(destination: Uint8Array): number;
  canSend?(destination: Uint8Array): boolean;
  failed(reason: string): void;
}

/** Worker-owned stream registry. Receive storage and pending controls are bounded. */
export class RemoteTcpEngine {
  private readonly streams = new Map<string, RemoteTcpPeer>();
  private readonly handles = new Map<number, RemoteTcpPeer>();
  private readonly listeners = new Map<string, {addr: Uint8Array; port: number; target: TcpListenTarget}>();
  private readonly highWater = new Map<number, number>();
  private serial = 0;
  private nextPort = 49152;
  constructor(readonly address: Uint8Array, private readonly router: RemoteTcpRouter, private readonly connectTimeoutMs = 10_000) {}

  listen(id: string, addr: Uint8Array, port: number, target: TcpListenTarget): number {
    if (addr.length !== 4 || (!addr.every(v => v === 0) && !addr.every((v, i) => v === this.address[i]))) return 99;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 22;
    for (const [other, listener] of this.listeners) if (other !== id && listener.port === port) return 98;
    this.listeners.set(id, {addr: addr.slice(), port, target}); return 0;
  }
  unlisten(id: string): void { this.listeners.delete(id); }
  connect(handle: number, destination: NetworkAddress, source?: NetworkAddress): void {
    if (this.handles.has(handle)) fail(114);
    if (this.slotCount >= MAX_REMOTE_TCP_STREAMS || this.serial === 0xffffffff) fail(105);
    if (source && (source.addr.length !== 4 || (!source.addr.every(v=>v===0) && !source.addr.every((v,i)=>v===this.address[i])))) fail(99);
    let port = source?.port || this.nextPort;
    for (let count = 0; count < 16384; count++) {
      const busy = [...this.streams.values()].some(p => p.local.port === port) || [...this.listeners.values()].some(l => l.port === port);
      if (!source?.port) this.nextPort = port === 65535 ? 49152 : port + 1;
      if (!busy) break;
      if (source?.port) fail(98);
      port = this.nextPort;
      if (count === 16383) fail(99);
    }
    const peer = this.create(this.address[3], ++this.serial, {addr: this.address, port}, destination, false);
    this.handles.set(handle, peer);
    peer.begin(this.connectTimeoutMs);
  }
  private create(origin: number, serial: number, local: NetworkAddress, remote: NetworkAddress, accepted: boolean): RemoteTcpPeer {
    const peer = new RemoteTcpPeer(this, origin, serial, copyEndpoint(local), copyEndpoint(remote), accepted);
    this.streams.set(key(origin, serial), peer); return peer;
  }
  connection(handle: number): RemoteTcpPeer { return this.handles.get(handle) ?? fail(107); }
  has(handle: number): boolean { return this.handles.has(handle); }
  close(handle: number): void { const peer = this.handles.get(handle); this.handles.delete(handle); peer?.close(); }
  retire(peer: RemoteTcpPeer): void { this.streams.delete(key(peer.origin, peer.serial)); }
  send(frame: RemoteTcpFrame): boolean { return this.router.send(frame); }
  maxData(remote: Uint8Array): number { return Math.max(0, Math.min(REMOTE_TCP_DATA_BYTES, this.router.maxData(remote))); }
  canSend(destination: Uint8Array): boolean { return this.router.canSend?.(destination) ?? true; }
  fatal(reason: string): void { this.router.failed(reason); }
  writable(): void { for (const peer of [...this.streams.values()]) peer.flushControls(); }
  receive(frame: RemoteTcpFrame): void {
    validateRemoteTcpFrame(frame);
    if (!frame.destination.addr.every((v, i) => v === this.address[i])) throw new Error('TCP frame addressed to a different machine');
    const id = key(frame.origin, frame.serial);
    const existing = this.streams.get(id);
    if (existing) {
      if (!endpointEqual(existing.local, frame.destination) || !endpointEqual(existing.remote, frame.source)) throw new Error('TCP connection endpoint changed');
      existing.receive(frame); return;
    }
    if (frame.kind !== TCP_FRAME.open) return; // Late frames for a retired, nonreused identifier.
    if (frame.origin !== frame.source.addr[3] || frame.serial <= (this.highWater.get(frame.origin) ?? 0)) throw new Error('replayed TCP connect identifier');
    this.highWater.set(frame.origin, frame.serial);
    const listener = [...this.listeners.values()].find(l => l.port === frame.destination.port);
    let errno = listener ? 0 : 111;
    if (this.slotCount >= MAX_REMOTE_TCP_STREAMS) errno = 105;
    if (errno) { this.refuse(frame, errno); return; }
    const peer = this.create(frame.origin, frame.serial, frame.destination, frame.source, true);
    peer.remoteCredit = frame.value;
    try { errno = listener!.target.accept(peer, copyEndpoint(peer.local), copyEndpoint(peer.remote)); }
    catch { errno = 5; }
    if (errno) { peer.rejected(errno); this.refuse(frame, errno); return; }
    peer.accepted();
  }
  private refuse(frame: RemoteTcpFrame, errno: number): void {
    if (!this.send({...frame, kind: TCP_FRAME.refuse, source: frame.destination, destination: frame.source, value: errno, data: new Uint8Array(0)})) this.fatal('remote TCP refusal could not be admitted');
  }
  disconnect(address?: Uint8Array, forceReset = false): void {
    for (const peer of [...this.streams.values()]) if (!address || peer.remote.addr.every((v, i) => v === address[i])) peer.disconnected(forceReset);
  }
  dispose(): void { this.disconnect(); this.listeners.clear(); this.handles.clear(); }
  private get slotCount(): number { return new Set([...this.streams.values(), ...this.handles.values()]).size; }
  get streamCount(): number { return this.streams.size; }
}

class RemoteTcpPeer implements TcpConnectionPeer {
  remoteCredit = 0;
  private receiveBytes = 0;
  private buffer = new Uint8Array(REMOTE_TCP_WINDOW_BYTES);
  private readOffset = 0;
  private receiveAllowance = REMOTE_TCP_WINDOW_BYTES;
  private readonly controls: {kind: number; value: number}[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private connected: boolean;
  private error = 0;
  private readClosed = false;
  private writeClosed = false;
  private remoteReadClosed = false;
  private remoteFin = false;
  private remoteOrderlyClose = false;
  private orphaned = false;
  private retired = false;
  private finSent = false;
  constructor(private readonly engine: RemoteTcpEngine, readonly origin: number, readonly serial: number,
    readonly local: NetworkAddress, readonly remote: NetworkAddress, _accepted: boolean) { this.connected = false; }
  accepted(): void { this.connected = true; this.controls.unshift({kind: TCP_FRAME.accept, value: REMOTE_TCP_WINDOW_BYTES}); this.flushControls(); }
  get status(): number { return this.error || (this.connected ? 0 : -11); }
  begin(timeout: number): void {
    this.timer = setTimeout(() => { this.setError(110); this.emitReset(); }, timeout);
    (this.timer as unknown as {unref?: () => void}).unref?.();
    this.control(TCP_FRAME.open, REMOTE_TCP_WINDOW_BYTES);
  }
  private frame(kind: number, value = 0, data = new Uint8Array(0)): RemoteTcpFrame {
    return {kind, origin: this.origin, serial: this.serial, source: this.local, destination: this.remote, value, data};
  }
  control(kind: number, value = 0): void {
    // Consumption accumulates one numeric credit record, never a payload queue.
    const credit = kind === TCP_FRAME.credit ? this.controls.find(c => c.kind === kind) : undefined;
    if (credit) credit.value += value;
    else this.controls.push({kind, value});
    if (this.controls.length > 5 || (credit && credit.value > REMOTE_TCP_WINDOW_BYTES)) throw new Error('remote TCP pending controls exceeded their bound');
    this.flushControls();
  }
  flushControls(): void {
    if (this.error || this.retired) return;
    while (this.controls.length) {
      const next = this.controls[0];
      if (!this.engine.send(this.frame(next.kind, next.value))) return;
      this.controls.shift();
      if (next.kind === TCP_FRAME.fin) this.finSent = true;
      if (next.kind === TCP_FRAME.credit) this.receiveAllowance += next.value;
    }
    this.maybeRetire();
  }
  receive(frame: RemoteTcpFrame): void {
    if (this.error) return;
    if (frame.kind === TCP_FRAME.reset || frame.kind === TCP_FRAME.refuse) { this.setError(frame.kind === TCP_FRAME.reset ? 104 : frame.value); return; }
    if (frame.kind === TCP_FRAME.accept) {
      if (this.connected || this.origin !== this.local.addr[3]) throw new Error('unexpected TCP accept');
      this.connected = true; this.remoteCredit = frame.value; clearTimeout(this.timer); return;
    }
    if (!this.connected) throw new Error('TCP data arrived before connect completed');
    if (frame.kind === TCP_FRAME.credit) {
      if (this.remoteCredit + frame.value > REMOTE_TCP_WINDOW_BYTES) throw new Error('remote TCP credit exceeds the granted window');
      this.remoteCredit += frame.value;
    } else if (frame.kind === TCP_FRAME.data) {
      if (this.remoteFin || frame.data.length > this.receiveAllowance) throw new Error('remote TCP exceeded receive credit or sent data after FIN');
      this.receiveAllowance -= frame.data.length;
      if (this.readClosed) return; // In-flight DATA admitted before READ_STOP.
      if (this.orphaned) this.control(TCP_FRAME.credit, frame.data.length);
      else {
        const writeOffset = (this.readOffset + this.receiveBytes) % this.buffer.length;
        const first = Math.min(frame.data.length, this.buffer.length - writeOffset);
        this.buffer.set(frame.data.subarray(0, first), writeOffset);
        this.buffer.set(frame.data.subarray(first), 0);
        this.receiveBytes += frame.data.length;
      }
    } else if (frame.kind === TCP_FRAME.fin) {
      if (this.remoteFin) throw new Error('duplicate remote TCP FIN');
      this.remoteFin = true; this.maybeRetire();
    } else if (frame.kind === TCP_FRAME.close) {
      if (!this.remoteFin || this.remoteOrderlyClose) throw new Error('invalid orderly TCP close');
      this.remoteOrderlyClose = true;
    } else if (frame.kind === TCP_FRAME.readStop) this.remoteReadClosed = true;
    else throw new Error('unexpected TCP control');
  }
  send(data: Uint8Array, _flags: number): number {
    if (this.error) fail(this.error);
    if (this.writeClosed || this.remoteReadClosed) fail(32);
    if (!this.connected || this.controls.length || !this.remoteCredit) fail(11);
    if (!data.length) return 0;
    const length = Math.min(data.length, this.remoteCredit, this.engine.maxData(this.remote.addr));
    if (!length || !this.engine.send(this.frame(TCP_FRAME.data, 0, data.slice(0, length)))) fail(11);
    this.remoteCredit -= length; return length;
  }
  recv(maxLen: number, flags: number): Uint8Array {
    if (this.error) fail(this.error);
    if (maxLen < 0 || !Number.isInteger(maxLen)) fail(22);
    if (!maxLen || this.readClosed) return new Uint8Array(0);
    const length = Math.min(maxLen, this.receiveBytes);
    if (!length) { if (this.remoteFin) return new Uint8Array(0); return fail(11); }
    const result = new Uint8Array(length);
    const first = Math.min(length, this.buffer.length - this.readOffset);
    result.set(this.buffer.subarray(this.readOffset, this.readOffset + first));
    result.set(this.buffer.subarray(0, length - first), first);
    if (!(flags & 2)) {
      this.readOffset = (this.readOffset + length) % this.buffer.length;
      this.receiveBytes -= length; this.control(TCP_FRAME.credit, length);
    }
    return result;
  }
  poll(events: number): number {
    if (this.error) return 8;
    let result = 0;
    if ((events & 1) && (this.receiveBytes || this.remoteFin || this.readClosed)) result |= 1;
    if ((events & 1) && this.remoteFin) result |= 16;
    if ((events & 4) && this.connected && !this.writeClosed && !this.remoteReadClosed && this.remoteCredit && !this.controls.length && this.engine.canSend(this.remote.addr)) result |= 4;
    return result;
  }
  shutdown(how: number): void {
    if (how < 0 || how > 2 || !Number.isInteger(how)) fail(22);
    if (this.error) fail(this.error);
    if ((how === 0 || how === 2) && !this.readClosed) {
      this.readClosed = true; this.clearReceive(); this.control(TCP_FRAME.readStop);
    }
    if ((how === 1 || how === 2) && !this.writeClosed) { this.writeClosed = true; this.control(TCP_FRAME.fin); }
  }
  close(): void {
    if (this.error || this.orphaned) return;
    if (!this.connected) {this.abort(); return;}
    const discarded = this.receiveBytes; this.clearReceive();
    if (discarded && !this.readClosed) this.control(TCP_FRAME.credit, discarded);
    // Queue FIN and orderly-close together: retirement must not run between
    // these two messages when the other direction has already finished.
    if (!this.writeClosed) { this.writeClosed = true; this.controls.push({kind:TCP_FRAME.fin,value:0}); }
    this.controls.push({kind:TCP_FRAME.close,value:0}); this.orphaned = true;
    this.flushControls(); this.maybeRetire();
  }
  abort(): void { if (!this.error) { this.setError(104); this.emitReset(); } }
  private emitReset(): void { if (!this.engine.send(this.frame(TCP_FRAME.reset, 104))) this.engine.fatal('remote TCP reset could not be admitted'); }
  rejected(errno: number): void { this.setError(errno); }
  disconnected(forceReset = false): void {
    // An orderly peer close must preserve bytes already followed by its FIN.
    if (forceReset || !this.remoteOrderlyClose) this.setError(this.connected ? 104 : 113);
    else { this.remoteReadClosed = true; this.controls.length = 0; this.retire(); }
  }
  private setError(errno: number): void {
    this.error = errno; this.buffer = new Uint8Array(0); clearTimeout(this.timer); this.controls.length = 0; this.clearReceive(); this.retire();
  }
  private clearReceive(): void { this.readOffset = 0; this.receiveBytes = 0; }
  private maybeRetire(): void { if (this.orphaned && this.remoteFin && this.finSent && !this.controls.length) this.retire(); }
  private retire(): void { if (!this.retired) { this.retired = true; clearTimeout(this.timer); this.engine.retire(this); } }
}
