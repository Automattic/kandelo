import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

async function minimalImage(): Promise<Uint8Array> {
  // Plain image bytes; the kernel worker owns the live filesystem.
  const fs = KandeloImageFs.create();
  for (const dir of ["/etc", "/tmp", "/root"]) fs.mkdir(dir, 0o755);
  fs.writeFile("/etc/hosts", new TextEncoder().encode("127.0.0.1 localhost\n"), 0o644);
  return fs.saveImage();
}
function fixture(): ArrayBuffer {
  return new Uint8Array(readFileSync(new URL("./fixtures/udp-state-observation.wasm", import.meta.url))).buffer;
}

describe("ordinary guest UDP state in dedicated Node kernel workers", () => {
  it("starts a session on running machines and reaches a guest that was already listening", async () => {
    let stderr = "", serverOutput = "", clientOutput = "";
    // Neither machine boots with a session: a person creates and joins one
    // on computers that are already running programs.
    const server = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      onStdout: (_pid, bytes) => { serverOutput += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    const client = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      onStdout: (_pid, bytes) => { clientOutput += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await Promise.all([server.init(), client.init()]);
      expect((await server.remoteNetworkSnapshot()).state).toBe("offline");
      // The guest binds 0.0.0.0:9001 before any session exists.
      const received = server.spawn(fixture(), ["udp-state-observation", "server", "10.89.0.2"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await server.hostRemoteNetwork()).toBe("10.89.0.1");
      const { port1, port2 } = new MessageChannel();
      const [assigned] = await Promise.all([
        client.joinRemoteNetwork({ port: port2, maxPayload: 32, maxControlBytes: 65536 }),
        server.attachRemotePeer({ port: port1, maxPayload: 32, maxControlBytes: 65536 }),
      ]);
      expect(assigned).toBe("10.89.0.2");
      await vi.waitFor(async () => expect((await client.remoteNetworkSnapshot()).bindings.some((binding) => binding.port === 9001)).toBe(true));
      const sent = client.spawn(fixture(), ["udp-state-observation", "client", "10.89.0.1", "32"]);
      expect(await Promise.all([received, sent])).toEqual([0, 0]);
      expect(stderr).toBe("");
      expect(serverOutput).toContain("received hello and replied");
      expect(clientOutput).toContain("received remote reply");
      await client.leaveRemoteNetwork();
      expect(await client.remoteNetworkSnapshot()).toMatchObject({ state: "offline", address: null });
      await vi.waitFor(async () => expect((await server.remoteNetworkSnapshot()).members).toHaveLength(1));
    } finally { await Promise.all([server.destroy(), client.destroy()]); }
  }, 30_000);

  it("delivers a real guest datagram and reply between independent Node machines", async () => {
    let stderr = "", serverOutput = "", clientOutput = "";
    const server = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      remoteNetwork: { role: "host" },
      onStdout: (_pid, bytes) => { serverOutput += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    const { port1, port2 } = new MessageChannel();
    const client = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      remoteNetwork: { role: "joiner", peer: { port: port2, maxPayload: 32, maxControlBytes: 65536 } },
      onStdout: (_pid, bytes) => { clientOutput += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await server.init();
      await Promise.all([server.attachRemotePeer({ port: port1, maxPayload: 32, maxControlBytes: 65536 }), client.init()]);
      const received = server.spawn(fixture(), ["udp-state-observation", "server", "10.89.0.2"]);
      await vi.waitFor(async () => expect((await client.remoteNetworkSnapshot()).bindings.some((binding) => binding.port === 9001)).toBe(true));
      const sent = client.spawn(fixture(), ["udp-state-observation", "client", "10.89.0.1", "32"]);
      expect(await Promise.all([received, sent])).toEqual([0, 0]);
      expect(stderr).toBe("");
      expect(serverOutput).toContain("received hello and replied");
      expect(clientOutput).toContain("received remote reply");
    } finally { await Promise.all([server.destroy(), client.destroy()]); }
  }, 30_000);

  it("preserves unreachable, refused, and segment binding exhaustion errnos in guest libc", async () => {
    let stdout = "", stderr = "";
    const machine = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      remoteNetwork: { role: "host" },
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await machine.init();
      const exit = await machine.spawn(fixture(), ["udp-state-observation", "errors"]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("UDP preserves unreachable, refused, and buffer exhaustion errnos");
    } finally { await machine.destroy(); }
  }, 30_000);

  it("reports the next queued datagram size through FIONREAD", async () => {
    let stdout = "", stderr = "";
    const machine = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await machine.init();
      const exit = await machine.spawn(fixture(), ["udp-state-observation"]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("FIONREAD reports the next datagram without consuming it");
    } finally { await machine.destroy(); }
  }, 30_000);

  it("preserves the owned UDP source through fork and restores wildcard on disconnect", async () => {
    let stderr = "";
    const server = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      remoteNetwork: { role: "host" },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    const { port1, port2 } = new MessageChannel();
    const joiner = new NodeKernelHost({ rootfsImage: await minimalImage(), maxPages: 4096,
      remoteNetwork: { role: "joiner", peer: { port: port2, maxPayload: 65507, maxControlBytes: 65536 } },
    });
    try {
      await server.init();
      await Promise.all([
        server.attachRemotePeer({ port: port1, maxPayload: 65507, maxControlBytes: 65536 }),
        joiner.init(),
      ]);
      expect((await joiner.remoteNetworkSnapshot()).address).toBe("10.89.0.2");
      const exit = await server.spawn(fixture(), ["udp-state-observation", "route", "10.89.0.2", "10.89.0.1"]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    } finally { await Promise.all([server.destroy(), joiner.destroy()]); }
  }, 30_000);
});
