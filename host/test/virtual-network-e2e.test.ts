import { describe, expect, it } from "vitest";
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

    const serverRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-server.wasm"),
      argv: ["virtual-tcp-echo-server", String(port)],
      io: serverIO,
      timeout: 10_000,
    });
    await waitMs(100);
    const clientRun = runCentralizedProgram({
      programPath: resolveBinary("programs/virtual-tcp-echo-client.wasm"),
      argv: ["virtual-tcp-echo-client", "10.88.0.2", String(port), "ping"],
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
