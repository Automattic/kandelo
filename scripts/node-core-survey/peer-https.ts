import type { NodeKernelHost, NodeKernelHostOptions } from "../../host/src/node-kernel-host";
import type { ProcessGenerationEvent } from "../../host/src/process-generation-observation";
import { before } from "./guest-shard";

export type PeerHost = Pick<NodeKernelHost,
  "init" | "destroy" | "spawnFromVfs" | "enumProcs" | "writeFileToVfs" |
  "hostRemoteNetwork" | "joinRemoteNetwork" | "attachRemotePeer" | "remoteNetworkSnapshot" |
  "readOwnedJob" | "releaseOwnedJob"
>;
export type PeerFixtures = Record<"program" | "certificate" | "key", Uint8Array>;
type Event = ProcessGenerationEvent;

const port = 8443;
const node = "/usr/bin/node";
const fixture = "/tmp/peer-fetch.mjs";
const environment = ["PATH=/usr/bin:/bin", "HOME=/root", "LANG=C.UTF-8", "TZ=UTC"];

async function until<T>(deadline: number, phase: string, observe: () => Promise<T | undefined>): Promise<T> {
  return before(deadline, phase, async () => {
    while (performance.now() < deadline) {
      const observation = await observe();
      if (observation !== undefined) return observation;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`${phase} exceeded its deadline`);
  });
}

export async function runPeerHttps(
  createHost: (options: NodeKernelHostOptions) => PeerHost,
  image: Uint8Array,
  kernel: Uint8Array,
  fixtures: PeerFixtures,
  readinessStartedAt: number,
) {
  const diagnostics: unknown[] = [];
  const receipts: Record<string, unknown> = {};
  function machine(role: string) {
    const events: Event[] = [];
    const host = createHost({
      rootfsImage: new Uint8Array(image),
      onHostDiagnostic: diagnostic => diagnostics.push({ role, diagnostic }),
      onProcessGenerationEvent: event => events.push(event),
    });
    receipts[role + "Generations"] = events;
    return { role, host, events };
  }
  const server = machine("server"), client = machine("client");
  const peers = [server, client];
  let failure: string | null = null;
  let teardown: PromiseSettledResult<void>[] = [];
  try {
    const readyBy = readinessStartedAt + 180_000;
    await before(readyBy, "peer preparation", async () => {
      await Promise.all(peers.map(async ({ role, host }) => {
        await host.init(new Uint8Array(kernel).buffer);
        await host.writeFileToVfs(fixture, new Uint8Array(fixtures.program));
        await host.writeFileToVfs("/tmp/peer-cert.pem", new Uint8Array(fixtures.certificate));
        if (role === "server") await host.writeFileToVfs("/tmp/peer-key.pem", new Uint8Array(fixtures.key), 0o600);
      }));
    });
    const [serverAddress, clientAddress] = await before(readyBy, "connect guest peers", async () => {
      const address = await server.host.hostRemoteNetwork();
      const { port1, port2 } = new MessageChannel();
      const [, remoteAddress] = await Promise.all([
        server.host.attachRemotePeer({ port: port1, maxPayload: 1200, maxControlBytes: 65536 }),
        client.host.joinRemoteNetwork({ port: port2, maxPayload: 1200, maxControlBytes: 65536 }),
      ]);
      return [address, remoteAddress];
    });
    // The ephemeral certificate contains exactly this routed test address and
    // the authenticated native reference's IPv4 loopback address.
    if (serverAddress !== "10.89.0.1" || clientAddress !== "10.89.0.2") {
      throw new Error(`Unexpected controlled peer addresses ${serverAddress}, ${clientAddress}`);
    }
    const deadline = performance.now() + 120_000;
    const listenHere = (listener: { address: string; port: number }) =>
      listener.address === serverAddress && listener.port === port;

    async function launch({ role, host }: typeof server, extra: string[]) {
      const argv = [node, "--no-use-system-ca", fixture, role, serverAddress, String(port), ...extra];
      receipts[role + "Argv"] = argv;
      return before(deadline, `${role} start`, () => host.spawnFromVfs(node, argv, {
        cwd: "/tmp", env: environment, uid: 0, gid: 0, stdin: new Uint8Array(),
        ownedJob: { id: role, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) },
      }));
    }

    async function observeExit({ role, host, events }: typeof server, process: Awaited<ReturnType<typeof launch>>) {
      const status = await before(deadline, `${role} exit`, () => process.exit);
      const finished = await until(deadline, `${role} job retirement`, async () => {
        const job = await host.readOwnedJob(role, 0, 65_536);
        if (job.expired) throw new Error(`${role} command receipt expired`);
        return job.terminationObserved ? job : undefined;
      });
      const decode = new TextDecoder();
      receipts[role] = {
        ...finished, chunks: finished.chunks.map(({ stream, bytes }) => ({ stream, text: decode.decode(bytes) })),
      };
      const admission = events.find(event => event.kind === "admitted" && event.pid === process.pid);
      if (!admission) throw new Error(`No ${role} process admission for PID ${process.pid}`);
      const retired = await until(deadline, `${role} execution fence`, async () =>
        events.find((event): event is Extract<Event, { kind: "retired" }> =>
          event.kind === "retired" && event.executionId === admission.executionId));
      const remaining = await before(deadline, `${role} process table`, () => host.enumProcs());
      receipts[role + "ProcessesAfter"] = remaining;
      await before(deadline, `${role} release`, () => host.releaseOwnedJob(role));
      if (status !== 0 || finished.status !== "completed" || finished.exitCode !== status ||
          finished.truncated || finished.hasMore || retired.leaseDisposition !== "quiescent" ||
          retired.mainFence !== "acknowledged" || retired.threadFences === "missing" ||
          retired.threads !== retired.acknowledgedThreads || retired.postCommitFailed ||
          remaining.length !== 1 || remaining[0]?.pid !== 1) {
        throw new Error(`${role} command did not complete and retire cleanly`);
      }
    }

    const listener = await launch(server, [clientAddress]);
    receipts.listenerBefore = await until(deadline, "remote TCP listener", async () => {
      const snapshot = await client.host.remoteNetworkSnapshot();
      return snapshot.tcpListeners.some(listenHere) ? snapshot : undefined;
    });
    const requester = await launch(client, []);
    await observeExit(client, requester);
    await observeExit(server, listener);
    receipts.listenersAfter = await until(deadline, "remote listener withdrawal", async () => {
      const snapshots = await Promise.all(peers.map(({ host }) => host.remoteNetworkSnapshot()));
      return snapshots.every(snapshot => !snapshot.tcpListeners.some(listenHere)) ? snapshots : undefined;
    });
    if (diagnostics.length) throw new Error("Received guest host diagnostics");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    teardown = await Promise.allSettled(peers.map(({ role, host }) =>
      before(performance.now() + 60_000, `${role} teardown`, () => host.destroy())));
  }
  return {
    scope: "IPv4 TLS traffic between two separately hosted Kandelo kernels over the existing session network",
    environment, diagnostics, receipts, failure,
    teardown: teardown.map(result => result.status === "fulfilled" ? null : String(result.reason)),
  };
}
