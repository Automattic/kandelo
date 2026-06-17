import * as net from "net";
import type { NetworkIO } from "../types";
import { lookup } from "dns";
import { EagainError } from "./fetch-backend";
import { parseNumericIpv4Hostname, validateDnsHostname } from "./hostname";

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
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

  connect(handle: number, addr: Uint8Array, port: number): void {
    const ip = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    const socket = new net.Socket({ allowHalfOpen: true });
    const conn: Connection = {
      socket,
      recvBuf: Buffer.alloc(0),
      closed: false,
      readEnded: false,
      connected: false,
      error: null,
    };

    socket.on("connect", () => {
      conn.connected = true;
    });
    socket.on("data", (data: Buffer) => {
      conn.recvBuf = Buffer.concat([conn.recvBuf, data]);
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

    socket.connect(port, ip);
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
    if (conn.error) throw conn.error;
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
    if (conn.error) throw conn.error;

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

  poll(handle: number, events: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: 107 });

    if (conn.error) return POLLERR;

    let revents = 0;
    if ((events & POLLIN) !== 0 && (conn.recvBuf.length > 0 || conn.readEnded || conn.closed)) {
      revents |= POLLIN;
    }
    if (conn.closed) {
      revents |= POLLHUP;
    }
    if (
      (events & POLLOUT) !== 0 &&
      conn.connected &&
      !conn.closed &&
      !conn.socket.destroyed &&
      !conn.socket.writableEnded &&
      conn.socket.writable
    ) {
      revents |= POLLOUT;
    }
    return revents;
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
