import { describe, expect, it } from "vitest";
import * as net from "node:net";
import { resolveBinary, tryResolveBinary } from "../src/binary-resolver";
import { LocalVirtualNetwork } from "../src/networking/virtual-network";
import { NodePlatformIO } from "../src/platform/node";
import type { PlatformIO } from "../src/types";
import { runCentralizedProgram } from "./centralized-test-helper";

const udpServerPath = tryResolveBinary("programs/virtual-udp-echo-server.wasm");
const udpClientPath = tryResolveBinary("programs/virtual-udp-echo-client.wasm");
const tcpServerPath = tryResolveBinary("programs/virtual-tcp-echo-server.wasm");
const tcpClientPath = tryResolveBinary("programs/virtual-tcp-echo-client.wasm");
const ncPath = tryResolveBinary("programs/nc.wasm");

function machineIO(network: LocalVirtualNetwork, id: string, address: [number, number, number, number]): PlatformIO {
  const io = new NodePlatformIO() as NodePlatformIO & PlatformIO;
  io.network = network.attachMachine({ id, address, hostnames: [id] });
  return io;
}

type ProgramRun = Awaited<ReturnType<typeof runCentralizedProgram>>;

function summarizeRun(result: PromiseSettledResult<ProgramRun>): string {
  if (result.status === "rejected") return `rejected: ${String(result.reason)}`;
  return `exit=${result.value.exitCode} stdout=${JSON.stringify(result.value.stdout)} stderr=${JSON.stringify(result.value.stderr)}`;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unusedTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function connectLoopbackWithRetry(
  port: number,
  allowHalfOpen = false,
): Promise<net.Socket> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = new net.Socket({ allowHalfOpen });
        const onError = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        socket.once("connect", () => {
          socket.off("error", onError);
          resolve(socket);
        });
        socket.once("error", onError);
        socket.connect({ host: "127.0.0.1", port });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" || Date.now() >= deadline) {
        throw error;
      }
      await waitMs(10);
    }
  }
}

async function waitForReusableTcpPort(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() >= deadline) {
        throw error;
      }
      await waitMs(10);
    }
  }
}

async function readReplyAfterRequest(socket: net.Socket, request: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP reply timed out"));
    }, 5_000);
    let sawEnd = false;
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => {
      sawEnd = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("close", (hadError) => {
      if (!sawEnd && !hadError) {
        clearTimeout(timeout);
        reject(new Error("TCP socket closed before orderly EOF"));
      }
    });
    socket.end(request);
  });
}

async function sendAfterPeerFin(
  socket: net.Socket,
  request: string,
  postFinBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("post-FIN exchange timed out"));
    }, 5_000);
    let sawEnd = false;
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => {
      sawEnd = true;
      socket.end(Buffer.alloc(postFinBytes, 0x78));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("close", (hadError) => {
      clearTimeout(timeout);
      if (hadError) {
        reject(new Error("post-FIN socket closed with an error"));
      } else if (!sawEnd) {
        reject(new Error("post-FIN socket closed before orderly EOF"));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    socket.write(request);
  });
}

describe.skipIf(!udpServerPath || !udpClientPath)("virtual network guest socket integration", () => {
  it("routes POSIX UDP sendto/recvfrom between two Kandelo machines", async () => {
    const network = new LocalVirtualNetwork();
    const serverIO = machineIO(network, "server", [10, 88, 0, 2]);
    const clientIO = machineIO(network, "client", [10, 88, 0, 3]);
    const events: string[] = [];
    const serverBindUdp = serverIO.network!.bindUdp!.bind(serverIO.network!);
    serverIO.network!.bindUdp = (endpointId, addr, bindPort, target) => {
      events.push(`server bind ${endpointId} ${Array.from(addr).join(".")}:${bindPort}`);
      const result = serverBindUdp(endpointId, addr, bindPort, {
        receive(datagram) {
          events.push(`server receive ${Array.from(datagram.srcAddr).join(".")}:${datagram.srcPort}->${Array.from(datagram.dstAddr).join(".")}:${datagram.dstPort}`);
          return target.receive(datagram);
        },
      });
      events.push(`server bind result ${result}`);
      return result;
    };
    const clientSendDatagram = clientIO.network!.sendDatagram!.bind(clientIO.network!);
    clientIO.network!.sendDatagram = (datagram) => {
      events.push(`client send ${Array.from(datagram.srcAddr).join(".")}:${datagram.srcPort}->${Array.from(datagram.dstAddr).join(".")}:${datagram.dstPort}`);
      const result = clientSendDatagram(datagram);
      events.push(`client send result ${result}`);
      return result;
    };
    const port = 24123;

    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-udp-echo-server.wasm"),
      argv: ["virtual-udp-echo-server", String(port)],
      io: serverIO,
      timeout: 10_000,
    });
    await waitMs(100);
    const clientRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-udp-echo-client.wasm"),
      argv: ["virtual-udp-echo-client", "10.88.0.2", String(port), "ping"],
      io: clientIO,
      timeout: 10_000,
    });

    const [serverResult, clientResult] = await Promise.allSettled([serverRun, clientRun]);
    if (serverResult.status !== "fulfilled" || clientResult.status !== "fulfilled") {
      throw new Error(`server ${summarizeRun(serverResult)}; client ${summarizeRun(clientResult)}; events ${events.join("; ")}`);
    }
    const server = serverResult.value;
    const client = clientResult.value;

    expect(server.exitCode).toBe(0);
    expect(server.stderr).toBe("");
    expect(client.exitCode).toBe(0);
    expect(client.stderr).toBe("");
    expect(client.stdout.trim()).toBe(`10.88.0.2 ${port} echo:ping`);
  }, 15_000);
});

describe.skipIf(!tcpServerPath || !tcpClientPath)("virtual network TCP guest socket integration", () => {
  it("routes POSIX TCP connect/accept/read/write between two Kandelo machines", async () => {
    const network = new LocalVirtualNetwork();
    const serverIO = machineIO(network, "server", [10, 88, 0, 2]);
    const clientIO = machineIO(network, "client", [10, 88, 0, 3]);
    const port = 24124;
    const postFinBytes = 128 * 1024 + 123;

    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-server.wasm"),
      argv: [
        "virtual-tcp-echo-server",
        String(port),
        "half-close-bulk",
        String(postFinBytes),
      ],
      io: serverIO,
      timeout: 10_000,
    });
    await waitMs(100);
    const clientRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-client.wasm"),
      argv: [
        "virtual-tcp-echo-client",
        "10.88.0.2",
        String(port),
        "ping",
        String(postFinBytes),
      ],
      io: clientIO,
      timeout: 10_000,
    });

    const [serverResult, clientResult] = await Promise.allSettled([serverRun, clientRun]);
    if (serverResult.status !== "fulfilled" || clientResult.status !== "fulfilled") {
      throw new Error(`server ${summarizeRun(serverResult)}; client ${summarizeRun(clientResult)}`);
    }
    const server = serverResult.value;
    const client = clientResult.value;

    expect(server.exitCode).toBe(0);
    expect(server.stderr).toBe("");
    expect(client.exitCode).toBe(0);
    expect(client.stderr).toBe("");
    expect(client.stdout.trim()).toBe("echo:ping");
  }, 15_000);
});

describe.skipIf(!tcpServerPath)("Node TCP guest socket integration", () => {
  it("keeps a fork-inherited accepted socket alive after the parent exits", async () => {
    const port = await unusedTcpPort();
    const bulkBytes = 2 * 1024 * 1024;
    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-server.wasm"),
      argv: ["virtual-tcp-echo-server", String(port), "fork-bulk", String(bulkBytes)],
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    const socket = await connectLoopbackWithRetry(port);
    const server = await serverRun;
    const response = await readReplyAfterRequest(socket, "ping");

    expect(server.exitCode).toBe(0);
    expect(server.stdout).toBe("");
    expect(server.stderr).toBe("");
    expect(response.subarray(0, 9).toString("utf8")).toBe("echo:ping");
    expect(response).toHaveLength(9 + bulkBytes);
    expect(response.subarray(9).every((byte) => byte === 0x78)).toBe(true);

    // The listener must remain tracked by the child after parent cleanup and
    // then close when the child becomes the final owner.
    await waitForReusableTcpPort(port);
  }, 15_000);

  it("wakes a blocked accepted read on a zero-byte peer FIN", async () => {
    const port = await unusedTcpPort();
    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-server.wasm"),
      argv: ["virtual-tcp-echo-server", String(port)],
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    const socket = await connectLoopbackWithRetry(port);
    await waitMs(100);
    const [server, response] = await Promise.all([
      serverRun,
      readReplyAfterRequest(socket, ""),
    ]);

    expect(server.exitCode).toBe(0);
    expect(server.stdout).toBe("");
    expect(server.stderr).toBe("");
    expect(response.toString("utf8")).toBe("echo:");
  }, 15_000);

  it("drains native data queued before FIN after guest SHUT_WR", async () => {
    const port = await unusedTcpPort();
    const postFinBytes = 128 * 1024 + 123;
    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-server.wasm"),
      argv: [
        "virtual-tcp-echo-server",
        String(port),
        "half-close-bulk",
        String(postFinBytes),
      ],
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    const socket = await connectLoopbackWithRetry(port, true);
    const [server, response] = await Promise.all([
      serverRun,
      sendAfterPeerFin(socket, "ping", postFinBytes),
    ]);

    expect(server.exitCode).toBe(0);
    expect(server.stdout).toBe("");
    expect(server.stderr).toBe("");
    expect(response.toString("utf8")).toBe("echo:ping");
  }, 15_000);

  it("flushes a queued accepted reply after the guest closes and exits", async () => {
    const port = await unusedTcpPort();
    const bulkBytes = 2 * 1024 * 1024;
    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-server.wasm"),
      argv: ["virtual-tcp-echo-server", String(port), "bulk", String(bulkBytes)],
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    const socket = await connectLoopbackWithRetry(port);
    const responsePromise = readReplyAfterRequest(socket, "ping");
    socket.pause();
    const server = await serverRun;

    // The previous bridge destroyed accepted sockets one second after the
    // owning pid exited. Keep the native reader paused beyond that boundary:
    // only a connection whose lifetime follows pipe/socket ownership can
    // retain and later flush the whole queued response.
    await waitMs(1_200);
    socket.resume();
    const response = await responsePromise;

    expect(server.exitCode).toBe(0);
    expect(server.stdout).toBe("");
    expect(server.stderr).toBe("");
    expect(response.subarray(0, 9).toString("utf8")).toBe("echo:ping");
    expect(response).toHaveLength(9 + bulkBytes);
    expect(response.subarray(9).every((byte) => byte === 0x78)).toBe(true);
  }, 15_000);
});

describe.skipIf(!ncPath)("virtual network nc integration", () => {
  it("uses the packaged nc over the local virtual TCP network", async () => {
    const network = new LocalVirtualNetwork();
    const serverIO = machineIO(network, "server", [10, 88, 0, 2]);
    const clientIO = machineIO(network, "client", [10, 88, 0, 3]);
    const port = 24125;

    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/nc.wasm"),
      argv: ["nc", "-n", "-l", "-p", String(port), "-w", "3"],
      io: serverIO,
      stdin: "",
      timeout: 10_000,
    });
    await waitMs(100);
    const clientRun = runCentralizedProgram({
      programPath: resolveBinary("programs/nc.wasm"),
      argv: ["nc", "-n", "-c", "10.88.0.2", String(port)],
      io: clientIO,
      stdin: "from-nc\n",
      timeout: 10_000,
    });

    const [serverResult, clientResult] = await Promise.allSettled([serverRun, clientRun]);
    if (serverResult.status !== "fulfilled" || clientResult.status !== "fulfilled") {
      throw new Error(`server ${summarizeRun(serverResult)}; client ${summarizeRun(clientResult)}`);
    }
    const server = serverResult.value;
    const client = clientResult.value;

    expect(server.exitCode).toBe(0);
    expect(server.stderr).toBe("");
    expect(server.stdout).toContain("from-nc\n");
    expect(client.exitCode).toBe(0);
  }, 15_000);

  it("uses the packaged nc over the local virtual UDP network", async () => {
    const network = new LocalVirtualNetwork();
    const serverIO = machineIO(network, "server", [10, 88, 0, 2]);
    const clientIO = machineIO(network, "client", [10, 88, 0, 3]);
    const port = 24126;

    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/nc.wasm"),
      argv: ["nc", "-n", "-c", "-u", "-l", "-p", String(port), "-w", "3"],
      io: serverIO,
      stdin: "",
      timeout: 10_000,
    });
    await waitMs(100);
    const clientRun = runCentralizedProgram({
      programPath: resolveBinary("programs/nc.wasm"),
      argv: ["nc", "-n", "-u", "-c", "10.88.0.2", String(port)],
      io: clientIO,
      stdin: "from-nc-udp\n",
      timeout: 10_000,
    });

    const [serverResult, clientResult] = await Promise.allSettled([serverRun, clientRun]);
    if (serverResult.status !== "fulfilled" || clientResult.status !== "fulfilled") {
      throw new Error(`server ${summarizeRun(serverResult)}; client ${summarizeRun(clientResult)}`);
    }
    const server = serverResult.value;
    const client = clientResult.value;

    expect(server.exitCode).toBe(0);
    expect(server.stderr).toBe("");
    expect(server.stdout).toContain("from-nc-udp\n");
    expect(client.exitCode).toBe(0);
  }, 15_000);
});
