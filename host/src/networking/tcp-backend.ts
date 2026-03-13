import * as net from "net";
import type { NetworkIO } from "../types";
import { lookup } from "dns";

interface Connection {
  socket: net.Socket;
  recvBuf: Buffer;
  connected: boolean;
  error: Error | null;
  closed: boolean;
}

export class TcpNetworkBackend implements NetworkIO {
  private connections = new Map<number, Connection>();

  connect(handle: number, addr: Uint8Array, port: number): void {
    const ip = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    const socket = new net.Socket();
    const conn: Connection = {
      socket,
      recvBuf: Buffer.alloc(0),
      connected: false,
      error: null,
      closed: false,
    };

    socket.on("data", (data: Buffer) => {
      conn.recvBuf = Buffer.concat([conn.recvBuf, data]);
    });

    socket.on("error", (err: Error) => {
      conn.error = err;
    });

    socket.on("close", () => {
      conn.closed = true;
    });

    // Synchronous connect using Atomics — block until connected or error
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);

    socket.connect(port, ip, () => {
      conn.connected = true;
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });

    socket.on("error", () => {
      Atomics.store(flag, 0, -1);
      Atomics.notify(flag, 0);
    });

    Atomics.wait(flag, 0, 0, 30000); // 30s timeout

    if (flag[0] !== 1) {
      socket.destroy();
      const errMsg = conn.error?.message ?? "";
      if (errMsg.includes("ECONNREFUSED")) {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      if (errMsg.includes("ETIMEDOUT") || flag[0] === 0) {
        throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
      }
      throw conn.error ?? new Error("Connection failed");
    }

    this.connections.set(handle, conn);
  }

  send(handle: number, data: Uint8Array, _flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn || !conn.connected) throw new Error("ENOTCONN");
    conn.socket.write(data);
    return data.length;
  }

  recv(handle: number, maxLen: number, _flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    // Poll for data with Atomics.wait
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);

    if (conn.recvBuf.length === 0 && !conn.closed) {
      const onData = () => {
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      };
      const onClose = () => {
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      };
      conn.socket.once("data", onData);
      conn.socket.once("close", onClose);

      if (conn.recvBuf.length === 0 && !conn.closed) {
        Atomics.wait(flag, 0, 0, 30000);
      }

      conn.socket.removeListener("data", onData);
      conn.socket.removeListener("close", onClose);
    }

    const len = Math.min(maxLen, conn.recvBuf.length);
    if (len === 0) return new Uint8Array(0);

    const result = new Uint8Array(conn.recvBuf.buffer, conn.recvBuf.byteOffset, len);
    conn.recvBuf = conn.recvBuf.subarray(len);
    return result;
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (conn) {
      conn.socket.destroy();
      this.connections.delete(handle);
    }
  }

  getaddrinfo(hostname: string): Uint8Array {
    // Synchronous DNS lookup
    const sab = new SharedArrayBuffer(8);
    const flag = new Int32Array(sab);
    const result = new Uint8Array(4);

    lookup(hostname, 4, (err, address) => {
      if (err || !address) {
        Atomics.store(flag, 0, -1);
      } else {
        const parts = address.split(".").map(Number);
        result[0] = parts[0];
        result[1] = parts[1];
        result[2] = parts[2];
        result[3] = parts[3];
        Atomics.store(flag, 0, 1);
      }
      Atomics.notify(flag, 0);
    });

    Atomics.wait(flag, 0, 0, 10000); // 10s timeout
    if (flag[0] !== 1) throw new Error("DNS resolution failed");
    return result;
  }
}
