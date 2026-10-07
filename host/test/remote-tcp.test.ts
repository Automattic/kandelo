import {afterEach, describe, expect, it, vi} from 'vitest';
import {RemoteTcpEngine, MAX_REMOTE_TCP_STREAMS} from '../src/networking/remote-tcp';
import {decodeRemoteTcp, encodeRemoteTcp, REMOTE_TCP_WINDOW_BYTES, TCP_FRAME, type RemoteTcpFrame} from '../src/networking/remote-tcp-codec';
import type {TcpConnectionPeer} from '../src/types';
const ip = (id: number) => new Uint8Array([10,89,0,id]);
const endpoint = (id: number, port: number) => ({addr: ip(id), port});
const owned: RemoteTcpEngine[] = [];
afterEach(() => { owned.splice(0).forEach(e => e.dispose()); vi.useRealTimers(); });
function pair(timeout = 10000, maxData = 16384) {
  let admitted = true;
  const frames: {to: RemoteTcpEngine; frame: RemoteTcpFrame}[] = [];
  const errors: string[] = [];
  const a = new RemoteTcpEngine(ip(1), {send: f => { if (!admitted) return false; frames.push({to:b, frame:decodeRemoteTcp(encodeRemoteTcp(f))}); return true; }, maxData: () => maxData, canSend:()=>admitted, failed: r => errors.push(r)}, timeout);
  const b = new RemoteTcpEngine(ip(2), {send: f => { if (!admitted) return false; frames.push({to:a, frame:decodeRemoteTcp(encodeRemoteTcp(f))}); return true; }, maxData: () => maxData, canSend:()=>admitted, failed: r => errors.push(r)}, timeout);
  owned.push(a,b);
  const drain = () => { while (frames.length) { const next = frames.shift()!; next.to.receive(next.frame); } };
  let accepted!: TcpConnectionPeer;
  b.listen('listener', new Uint8Array(4), 8080, {accept: p => {accepted = p; return 0;}});
  const connect = () => { a.connect(1, endpoint(2,8080)); expect(a.connection(1).status).toBe(-11); drain(); return {client:a.connection(1), server:accepted}; };
  return {a,b,drain,connect,errors,frames,setAdmission:(value:boolean) => {admitted=value;}};
}
const errno = (fn: () => unknown, value: number) => { try {fn(); throw new Error('expected failure');} catch (e) {expect((e as {errno?:number}).errno).toBe(value);} };

describe('bounded remote TCP', () => {
  it('connects asynchronously to a real accept target and selects distinct local ports', () => {
    const {a,b,connect,drain} = pair(); const {client} = connect(); expect(client.status).toBe(0);
    a.connect(2, endpoint(2,8080)); drain(); expect(a.connection(2).local.port).not.toBe(client.local.port);
    expect(client.local.addr).toEqual(ip(1)); expect(b.streamCount).toBe(2);
  });
  it('returns listener refusal through connectStatus', () => {
    const {a,b,drain} = pair(); b.unlisten('listener'); a.connect(1,endpoint(2,8080)); drain(); expect(a.connection(1).status).toBe(111);
  });
  it('bounds partial writes, returns EAGAIN at exhausted credit, and never credits MSG_PEEK', () => {
    const {connect,drain} = pair(); const {client,server} = connect();
    const bytes = new Uint8Array(16384).fill(42);
    for (let i=0;i<4;i++) expect(client.send(bytes,0)).toBe(16384);
    errno(() => client.send(bytes,0),11); drain(); expect(server.recv(32768,2)).toEqual(new Uint8Array(32768).fill(42)); drain();
    errno(() => client.send(bytes,0),11); expect(server.recv(100,0)).toHaveLength(100); drain(); expect(client.send(bytes,0)).toBe(100);
  });
  it('copies receive bytes across the circular-buffer wrap', () => {
    const {connect,drain} = pair(); const {client,server} = connect();
    for(let i=0;i<4;i++) client.send(new Uint8Array(16384).fill(i),0); drain();
    expect(server.recv(60000,0)).toHaveLength(60000); drain();
    for(let i=0;i<3;i++) client.send(new Uint8Array(16384).fill(9),0); drain();
    const expected = new Uint8Array(65536-60000+49152); expected.fill(3,0,5536); expected.fill(9,5536);
    expect(server.recv(65536,0)).toEqual(expected);
  });
  it('honors the negotiated DATA ceiling and bridge admission without consuming credit', () => {
    const p = pair(10000,123); const {client,server}=p.connect(); p.setAdmission(false);
    errno(() => client.send(new Uint8Array(1000),0),11); expect(client.poll(4)).toBe(0); p.setAdmission(true); expect(client.send(new Uint8Array(1000),0)).toBe(123); p.drain(); expect(server.recv(1000,0)).toHaveLength(123);
  });
  it('delivers admitted DATA before FIN, allows replies after EOF, and implements read shutdown', () => {
    const {connect,drain} = pair(); const {client,server}=connect(); client.send(new Uint8Array([1,2,3]),0); client.shutdown(1); drain();
    expect(server.recv(99,0)).toEqual(new Uint8Array([1,2,3])); expect(server.recv(99,0)).toHaveLength(0);
    expect(server.send(new Uint8Array([4]),0)).toBe(1); drain(); expect(client.recv(99,0)).toEqual(new Uint8Array([4]));
    client.shutdown(0); drain(); errno(() => server.send(new Uint8Array([5]),0),32);
  });
  it('retries pending credit and FIN when native bridge admission resumes', () => {
    const p=pair(); const {client,server}=p.connect(); client.send(new Uint8Array(123),0); p.drain(); p.setAdmission(false);
    server.recv(123,0); server.shutdown(1); expect(p.frames).toHaveLength(0); p.setAdmission(true); p.b.writable(); p.drain(); expect(client.recv(1,0)).toHaveLength(0); expect(client.poll(1)&16).toBe(16);
  });
  it('normal close retains a bounded discard sink until the other FIN', () => {
    const p=pair(); const {client,server}=p.connect(); server.close(); p.drain(); expect(client.recv(1,0)).toHaveLength(0);
    for(let i=0;i<20;i++) { expect(client.send(new Uint8Array(16384),0)).toBe(16384); p.drain(); }
    expect(p.b.streamCount).toBe(1); client.close(); p.drain(); expect(p.a.streamCount).toBe(0); expect(p.b.streamCount).toBe(0);
  });
  it('abort resets both directions and discards queued bytes', () => {
    const p=pair(); const {client,server}=p.connect(); client.send(new Uint8Array([1]),0); p.drain(); server.abort(); p.drain();
    errno(() => client.recv(1,0),104); errno(() => client.send(new Uint8Array([2]),0),104); expect(client.poll(5)).toBe(8); expect(p.a.streamCount).toBe(0);
  });
  it('disconnect preserves clean FIN and queued bytes, but resets a live stream', () => {
    const p=pair(); const {client,server}=p.connect(); server.send(new Uint8Array([5]),0); server.close(); p.drain(); p.a.disconnect(ip(2));
    expect(client.recv(1,0)).toEqual(new Uint8Array([5])); expect(client.recv(1,0)).toHaveLength(0); errno(() => client.send(new Uint8Array([4]),0),32);
    const q=pair(); const active=q.connect(); q.a.disconnect(ip(2)); errno(() => active.client.recv(1,0),104);
  });
  it('resets a half-closed stream when its worker disappears before orderly close', () => {
    const p=pair(); const {client,server}=p.connect(); server.shutdown(1); p.drain();
    p.a.disconnect(ip(2)); errno(()=>client.recv(1,0),104);
  });
  it('does not reuse an explicitly bound port as its ephemeral allocator start', () => {
    const p=pair(); p.a.connect(1,endpoint(2,8080),{addr:new Uint8Array(4),port:18187}); p.drain();
    expect(p.a.connection(1).local.port).toBe(18187); p.a.connect(2,endpoint(2,8080)); p.drain();
    expect(p.a.connection(2).local.port).toBeGreaterThanOrEqual(49152);
  });
  it('times out unacknowledged connect and bounds active/orphaned stream slots', () => {
    vi.useFakeTimers(); const p=pair(20); p.a.connect(1,endpoint(2,8080)); vi.advanceTimersByTime(20); expect(p.a.connection(1).status).toBe(110); p.a.close(1);
    for(let i=0;i<MAX_REMOTE_TCP_STREAMS;i++) p.a.connect(i+2,endpoint(2,8080));
    errno(() => p.a.connect(100,endpoint(2,8080)),105);
  });
  it('rejects excess credit, changed endpoints, and replayed OPEN identifiers', () => {
    const p=pair(); const {client}=p.connect();
    const frame:RemoteTcpFrame={kind:TCP_FRAME.credit,origin:1,serial:1,source:endpoint(2,8080),destination:client.local,value:1,data:new Uint8Array()};
    expect(() => p.a.receive(frame)).toThrow('credit'); expect(() => p.a.receive({...frame,source:endpoint(2,8081)})).toThrow('endpoint');
    const open={...frame,kind:TCP_FRAME.open,source:client.local,destination:endpoint(2,8080),value:REMOTE_TCP_WINDOW_BYTES};
    expect(() => p.b.receive(open)).toThrow();
  });
});

describe('remote TCP wire', () => {
  it('round trips owned bytes and rejects invalid framing/credit', () => {
    const frame:RemoteTcpFrame={kind:TCP_FRAME.data,origin:1,serial:1,source:endpoint(1,1234),destination:endpoint(2,8080),value:0,data:new Uint8Array([1,2])};
    const encoded=encodeRemoteTcp(frame); const decoded=decodeRemoteTcp(encoded); encoded.fill(0); expect(decoded).toEqual(frame);
    expect(()=>decodeRemoteTcp(new Uint8Array(24))).toThrow();
    expect(()=>encodeRemoteTcp({...frame,kind:TCP_FRAME.credit,data:new Uint8Array(),value:65537})).toThrow();
    expect(()=>encodeRemoteTcp({...frame,data:new Uint8Array(16385)})).toThrow();
  });
});
