import * as net from "net";
import type { NetworkAddress, NetworkIO, UdpReceiveTarget } from "../types";
import { EgressLink } from "./egress-link";
import { lookup } from "dns";
import { EagainError } from "./fetch-backend";
import { parseNumericIpv4Hostname, validateDnsHostname } from "./hostname";
import { NET_READINESS } from "../generated/abi";

const MSG_PEEK = 0x0002;

/**
 * Map a Node.js network error code to a POSIX errno value.
 * Returns EIO (5) for unknown codes so the kernel surfaces *something* rather
 * than 0 (which would look like a successful connect).
 */
function mapNetErrnoCode(code: string | undefined): number {
  switch (code) {
    case "ECONNREFUSED": return 111;
    case "ECONNRESET":   return 104;
    case "EHOSTUNREACH": return 113;
    case "ENETUNREACH":  return 101;
    case "ETIMEDOUT":    return 110;
    case "EADDRINUSE":   return 98;
    case "EADDRNOTAVAIL": return 99;
    case "EPIPE":        return 32;
    default:             return 5; // EIO — generic
  }
}

/**
 * TcpNetworkBackend — real `net.Socket`-backed networking for the Node host.
 *
 * Crucially, every operation returns synchronously and never blocks via
 * `Atomics.wait`. The kernel host runs in a single thread; if we blocked
 * with `Atomics.wait` here, libuv would never get the chance to dispatch the
 * `connect`/`data`/`error` callbacks that we'd be waiting for — classic
 * intra-thread deadlock.
 *
 * Instead we mirror `FetchNetworkBackend`: kick off the I/O asynchronously,
 * stash the state, and throw `EagainError` (errno 11) from `recv` when no
 * data is buffered yet. The kernel maps that to `-EAGAIN`, the wasm program's
 * `O_NONBLOCK` socket sees it, the QuickJS event loop yields back to libuv,
 * the network event fires, the buffer fills, and the program's next poll
 * cycle picks it up.
 *
 * `send` always succeeds locally — Node `net.Socket.write` buffers
 * pre-connect, so we don't need `EAGAIN` on writes. Connection-refused and
 * post-failure writes are reported via a sticky `conn.error`, which `recv`
 * surfaces as `-ECONNRESET` on the next poll cycle.
 */
interface Connection {
  socket: net.Socket;
  recvBuf: Buffer;
  closed: boolean;
  readEnded: boolean;
  readShutdown: boolean;
  /** True once net.Socket has emitted 'connect' (TCP handshake done). */
  connected: boolean;
  error: Error | null;
}

interface DnsEntry {
  result: Uint8Array | null;
  error: Error | null;
}

export class TcpNetworkBackend implements NetworkIO {
  private connections = new Map<number, Connection>();
  private dns = new Map<string, DnsEntry>();
  // The guest sees the host's sockets as a NAT gateway on its own link
  // (egress-link.ts); it never sees the host's real addresses.
  private readonly egress = new EgressLink();

  get localAddress(): Uint8Array { return this.egress.localAddress; }
  get localNetmask(): Uint8Array { return this.egress.localNetmask; }
  udpSourceAddress(destination: Uint8Array): Uint8Array { return this.egress.udpSourceAddress(destination); }
  bindUdp(id: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number { return this.egress.bindUdp(id, addr, port, target); }
  unbindUdp(id: string): void { this.egress.unbindUdp(id); }
  sendDatagram(): number { return this.egress.sendDatagram(); }

  connect(handle: number, addr: Uint8Array, port: number, source?: NetworkAddress): void {
    if (!this.egress.ownsSource(source)) throw Object.assign(new Error("EADDRNOTAVAIL"), { errno: 99 });
    const ip = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    const socket = new net.Socket({ allowHalfOpen: true });
    const conn: Connection = {
      socket,
      recvBuf: Buffer.alloc(0),
      closed: false,
      readEnded: false,
      readShutdown: false,
      connected: false,
      error: null,
    };

    socket.on("connect", () => {
      conn.connected = true;
    });
    socket.on("data", (data: Buffer) => {
      if (!conn.readShutdown) conn.recvBuf = Buffer.concat([conn.recvBuf, data]);
    });
    socket.on("end", () => {
      conn.readEnded = true;
    });
    socket.on("error", (err: Error) => {
      conn.error = err;
    });
    socket.on("close", () => {
      conn.closed = true;
      conn.readEnded = true;
    });

    // A bound guest port is kept on the host side of the NAT; the guest's
    // address is its own, so the host chooses its real source address.
    socket.connect({port,host:ip,...(source?.port ? {localPort:source.port} : {})});
    this.connections.set(handle, conn);
  }

  /**
   * Returns:
   *   0    — connected (TCP handshake completed).
   *   N>0  — connect failed with errno N.
   *   -11  — still pending (EAGAIN).
   */
  connectStatus(handle: number): number {
    const conn = this.connections.get(handle);
    if (!conn) return 107; // ENOTCONN
    if (conn.error) {
      return mapNetErrnoCode((conn.error as NodeJS.ErrnoException).code);
    }
    if (conn.connected) return 0;
    if (conn.closed) return 111; // ECONNREFUSED — closed before connect
    return -11; // EAGAIN — handshake still in flight
  }

  send(handle: number, data: Uint8Array, _flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");
    if (conn.error) throw Object.assign(conn.error,{errno:mapNetErrnoCode((conn.error as NodeJS.ErrnoException).code)});
    if (
      conn.closed ||
      conn.socket.destroyed ||
      conn.socket.writableEnded ||
      !conn.socket.writable
    ) {
      throw Object.assign(new Error("EPIPE"), { code: "EPIPE", errno: 32 });
    }
    // `net.Socket.write` buffers internally before the TCP handshake
    // completes, so we don't need to gate on `connected`. With allowHalfOpen,
    // this also permits writes after a peer FIN while Node still has an open
    // writable half, matching TCP half-close semantics.
    conn.socket.write(Buffer.from(data));
    return data.length;
  }

  recv(handle: number, maxLen: number, flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");
    if (conn.error) throw Object.assign(conn.error,{errno:mapNetErrnoCode((conn.error as NodeJS.ErrnoException).code)});

    if (conn.recvBuf.length > 0) {
      const len = Math.min(maxLen, conn.recvBuf.length);
      const result = new Uint8Array(
        conn.recvBuf.buffer,
        conn.recvBuf.byteOffset,
        len,
      );
      if ((flags & MSG_PEEK) === 0) {
        conn.recvBuf = conn.recvBuf.subarray(len);
      }
      return result;
    }

    if (conn.readEnded || conn.closed) return new Uint8Array(0);

    throw new EagainError();
  }

  /**
   * Report the OS-level facts `net.Socket` exposes. No POSIX readiness
   * decision is made here — `runtime_core::net_readiness` makes it.
   */
  readiness(handle: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: 107 });

    let facts = 0;
    if (conn.error) {
      facts |= NET_READINESS.ERROR
        | (mapNetErrnoCode((conn.error as NodeJS.ErrnoException).code)
          << NET_READINESS.ERRNO_SHIFT);
    }
    if (conn.recvBuf.length > 0) facts |= NET_READINESS.RECV_READY;
    if (conn.readEnded || conn.closed) facts |= NET_READINESS.RECV_EOF;
    if (conn.closed) facts |= NET_READINESS.HANGUP;
    if (
      conn.closed ||
      conn.socket.destroyed ||
      conn.socket.writableEnded ||
      !conn.socket.writable
    ) {
      facts |= NET_READINESS.SEND_CLOSED;
    } else if (conn.connected) {
      facts |= NET_READINESS.SEND_READY;
    }
    return facts;
  }

  localEndpoint(handle: number): NetworkAddress {
    const value = this.connections.get(handle)?.socket.address();
    if (!value || typeof value === "string" || !("family" in value) || value.family !== "IPv4") throw Object.assign(new Error("ENOTCONN"),{errno:107});
    // This machine's side of the NAT: its own address, the host's port.
    return {addr:this.egress.localAddress,port:value.port};
  }

  shutdown(handle: number, how: number): void {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), {errno:107});
    if (!Number.isInteger(how) || how < 0 || how > 2) throw Object.assign(new Error("EINVAL"),{errno:22});
    if (how === 0 || how === 2) {conn.readShutdown=true; conn.readEnded=true; conn.recvBuf=Buffer.alloc(0);}
    if ((how === 1 || how === 2) && !conn.socket.writableEnded) conn.socket.end();
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (conn) {
      // destroySoon() ends the writable half, flushes queued bytes, and only
      // then releases the Node handle. The operating system retains whatever
      // TCP close state is needed; no timer or fabricated post-FIN write count
      // is imposed here.
      if (!conn.socket.destroyed) {
        conn.socket.destroySoon();
      }
      this.connections.delete(handle);
    }
  }

  getaddrinfo(hostname: string): Uint8Array {
    const literalIp = parseNumericIpv4Hostname(hostname);
    if (literalIp) return literalIp;
    validateDnsHostname(hostname);

    // Atomics.wait would deadlock libuv's dns.lookup callback on the kernel
    // thread — same shape as connect/recv. Kick off async, throw EAGAIN,
    // pick up the cached result on the worker's next retry.
    let entry = this.dns.get(hostname);
    if (!entry) {
      entry = { result: null, error: null };
      this.dns.set(hostname, entry);
      const e = entry;
      lookup(hostname, 4, (err, address) => {
        if (err || !address) {
          e.error = err ?? new Error("ENOTFOUND");
        } else {
          const parts = address.split(".").map(Number);
          e.result = new Uint8Array(parts);
        }
      });
    }
    if (entry.error) {
      this.dns.delete(hostname);
      throw entry.error;
    }
    if (entry.result) {
      const r = entry.result;
      this.dns.delete(hostname);
      return r;
    }
    throw new EagainError();
  }
}
