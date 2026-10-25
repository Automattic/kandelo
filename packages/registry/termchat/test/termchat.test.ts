import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { termchatImage, terminalText, transferBytes } from "./image";

describe("termchat over ordinary guest sockets and PTYs", () => {
  it("discovers peers, chats both ways, transfers bytes, resizes and disconnects", async () => {
    const outputs = ["", ""];
    const errors: string[] = [];
    const diagnostics: unknown[] = [];
    const image = await termchatImage();
    const machines = outputs.map((_, i) => new NodeKernelHost({ rootfsImage: image.slice(),
      onPtyOutput: (_pid, bytes) => { outputs[i] += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => errors.push(new TextDecoder().decode(bytes)),
      onHostDiagnostic: value => diagnostics.push(value),
    }));
    const text = (i: number) => terminalText(outputs[i]);
    const send = (i: number, pid: number, value: string) => machines[i].ptyWrite(pid, new TextEncoder().encode(value + "\r"));
    try {
      await Promise.all(machines.map(m => m.init()));
      expect(await machines[0].readFileFromVfs("/usr/share/probe.bin")).toEqual(transferBytes);
      await machines[0].hostRemoteNetwork();
      const { port1, port2 } = new MessageChannel();
      await Promise.all([
        machines[0].attachRemotePeer({ port: port1, maxPayload: 1200, maxControlBytes: 65536 }),
        machines[1].joinRemoteNetwork({ port: port2, maxPayload: 1200, maxControlBytes: 65536 }),
      ]);
      const opts = { env: ["HOME=/root", "TERM=xterm-256color", "LANG=C.UTF-8"], pty: true, ptyRows: 30, ptyCols: 100 };
      const alice = await machines[0].spawnFromVfs("/usr/bin/termchat", ["termchat", "-u", "alice"], opts);
      await vi.waitFor(async () => expect((await machines[0].remoteNetworkSnapshot()).bindings.some(b => b.port === 5877)).toBe(true), { timeout: 30_000 });
      const bob = await machines[1].spawnFromVfs("/usr/bin/termchat", ["termchat", "-u", "bob"], opts);
      await vi.waitFor(() => { expect(text(0)).toContain("bob is online"); expect(text(1)).toContain("alice is online"); }, { timeout: 30_000 });
      send(0, alice.pid, "hello-from-alice");
      await vi.waitFor(() => expect(text(1)).toContain("hello-from-alice"), { timeout: 15_000 });
      send(1, bob.pid, "hello-from-bob");
      await vi.waitFor(() => expect(text(0)).toContain("hello-from-bob"), { timeout: 15_000 });
      send(0, alice.pid, "?send /usr/share/probe.bin");
      await vi.waitFor(async () => expect(await machines[1].readFileFromVfs("/tmp/termchat/alice/probe.bin")).toEqual(transferBytes), { timeout: 30_000 });
      machines[0].ptyResize(alice.pid, 35, 110);
      machines[1].ptyResize(bob.pid, 35, 110);
      send(1, bob.pid, "after-resize");
      await vi.waitFor(() => expect(text(0)).toContain("after-resize"), { timeout: 15_000 });
      machines[1].ptyWrite(bob.pid, new Uint8Array([27]));
      expect(await bob.exit).toBe(0);
      // tui writes changed cells: the unchanged username need not appear
      // again in this raw PTY stream. Bob is the only peer; the browser
      // xterm test checks the complete rendered disconnection message.
      await vi.waitFor(() => expect(text(0)).toContain(" is offline"), { timeout: 15_000 });
      machines[0].ptyWrite(alice.pid, new Uint8Array([27]));
      expect(await alice.exit).toBe(0);
      for (const output of outputs) expect(output).toContain("\x1b[?1049l");
      for (const machine of machines) await vi.waitFor(async () => expect((await machine.enumProcs()).filter(p => p.pid !== 1)).toEqual([]));
      expect(errors).toEqual([]);
      expect(diagnostics).toEqual([]);
    } catch (error) {
      console.error(JSON.stringify({ terminals: outputs.map(terminalText), errors, diagnostics }));
      throw error;
    } finally { await Promise.all(machines.map(m => m.destroy())); }
  }, 150_000);
});
