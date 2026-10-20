import { connect as connectTcp, type Socket as NodeSocket } from "node:net";
import { connect as connectTls } from "node:tls";
import { Readable, Writable } from "node:stream";
import type { Socket, Connect } from "../../src/pinned-fetch.ts";

let endpoint: { port: number; ca?: string } | undefined;
export const connections: { hostname: string; port: number; tlsName?: string }[] = [];
export function setEndpoint(value?: { port: number; ca?: string }) {
  endpoint = value;
  connections.length = 0;
}

export const connect: Connect = (address, options) => {
  // No real public network requests in tests. The source still resolves and
  // validates public addresses; only this adapter maps the socket to fixtures.
  if (!endpoint) throw new Error("No fixture endpoint configured");
  const record = { ...address, tlsName: undefined as string | undefined };
  connections.push(record);
  const fixture = endpoint;
  const native = connectTcp({ host: "127.0.0.1", port: fixture.port, allowHalfOpen: options.allowHalfOpen });
  function wrap(stream: NodeSocket, event: "connect" | "secureConnect"): Socket {
    return {
      readable: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      writable: Writable.toWeb(stream) as WritableStream<Uint8Array>,
      opened: new Promise((resolve, reject) => { stream.once(event, resolve); stream.once("error", reject); }),
      closed: new Promise((resolve, reject) => { stream.once("close", resolve); stream.once("error", reject); }),
      async close() { stream.destroy(); },
      startTls({ expectedServerHostname }) {
        record.tlsName = expectedServerHostname;
        return wrap(connectTls({ socket: stream, servername: expectedServerHostname,
          ca: fixture.ca, rejectUnauthorized: true }), "secureConnect");
      },
    };
  }
  return wrap(native, "connect");
};
