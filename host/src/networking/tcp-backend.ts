import * as net from "net";
import type { NetworkIO } from "../types";
import { lookup } from "dns";
import { EagainError } from "./fetch-backend";

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
    const socket = new net.Socket();
    const conn: Connection = {
      socket,
      recvBuf: Buffer.alloc(0),
      closed: false,
      connected: false,
      error: null,
    };

    socket.on("connect", () => {
      conn.connected = true;
    });
    socket.on("data", (data: Buffer) => {
      conn.recvBuf = Buffer.concat([conn.recvBuf, data]);
    });
    socket.on("error", (err: Error) => {
      conn.error = err;
    });
    socket.on("close", () => {
      conn.closed = true;
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
    if (conn.closed) throw new Error("EPIPE");
    // `net.Socket.write` buffers internally before the TCP handshake
    // completes, so we don't need to gate on `connected`.
    conn.socket.write(Buffer.from(data));
    return data.length;
  }

  recv(handle: number, maxLen: number, _flags: number): Uint8Array {
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
      conn.recvBuf = conn.recvBuf.subarray(len);
      return result;
    }

    if (conn.closed) return new Uint8Array(0);

    throw new EagainError();
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (conn) {
      conn.socket.destroy();
      this.connections.delete(handle);
    }
  }

  getaddrinfo(hostname: string): Uint8Array {
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
