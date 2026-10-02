/**
 * /dev/kandelo/clipboard end to end on the Node host: NodeKernelHost's
 * offerClipboardText() → kernel_clipboard_stage/_offer → the guest's
 * blocking read → the guest's acknowledgement → the offer's result.
 *
 * programs/clipboard-device.c holds the device and prints a *_WAIT marker
 * whenever it is parked waiting for the next offer. Runs for wasm32 and
 * wasm64. Skips if the program is not built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { KANDELO_CLIPBOARD_MAX_TEXT_BYTES } from "../src/generated/abi";

const programs = [
  ["wasm32", tryResolveBinary("programs/wasm32/clipboard-device.wasm")],
  ["wasm64", tryResolveBinary("programs/wasm64/clipboard-device.wasm")],
] as const;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  read: () => string,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${needle}.\n${read()}`);
}

describe("/dev/kandelo/clipboard", () => {
  it.each(programs)(
    "carries host offers to a guest agent and its acknowledgements back (%s)",
    async (_arch, program) => {
      if (!program) return;
      let out = "";
      let err = "";
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err += new TextDecoder().decode(data); },
      });
      const read = () => `${out}\n--- stderr ---\n${err}`;
      try {
        await host.init();

        // No agent yet: the offer fails, and says why.
        expect(await host.offerClipboardText("nobody home")).toEqual({
          ok: false,
          reason: "no-agent",
        });

        const bytes = loadBytes(program);
        let agentPid = -1;
        const exit = host.spawn(bytes, ["clipboard-device"], {
          onStarted: (pid) => { agentPid = pid; },
        });
        await waitFor(read, "CLIPDEV_HELD", 20_000);
        expect(out).toContain("PASS node");
        expect(out).toContain("PASS empty");
        // A second process is refused while the first holds the device.
        expect(await host.spawn(bytes, ["clipboard-device", "--expect-busy"], {}), read())
          .toBe(0);
        expect(out).toContain("CLIPDEV_BUSY_OK");
        host.appendStdinData(agentPid, new Uint8Array([0x0a]));
        await waitFor(read, "CLIPDEV_WAIT_SMALL", 20_000);

        // The parked read wakes with exactly this offer; CRLF becomes LF.
        const small = await host.offerClipboardText("héllo\r\nworld");
        expect(small, read()).toEqual({ ok: true, seq: expect.any(Number) });
        const seq = (small as { seq: number }).seq;
        expect(out).toContain(
          `CLIPDEV_GOT seq=${seq} len=${new TextEncoder().encode("héllo\nworld").length}` +
            " text=héllo\nworld",
        );

        // Over the cap: refused before it reaches the guest, never truncated.
        expect(
          await host.offerClipboardText("x".repeat(KANDELO_CLIPBOARD_MAX_TEXT_BYTES + 1)),
        ).toEqual({ ok: false, reason: "too-large" });

        // Exactly the cap streams through, and the agent's own error
        // comes back as the result.
        await waitFor(read, "CLIPDEV_WAIT_LARGE", 20_000);
        const large = Array.from(
          { length: KANDELO_CLIPBOARD_MAX_TEXT_BYTES },
          (_, i) => String.fromCharCode(97 + (i % 26)),
        ).join("");
        expect(await host.offerClipboardText(large)).toEqual({
          ok: false,
          reason: "agent-error",
          errno: 5,
        });
        expect(out).toContain(`CLIPDEV_GOT_LARGE seq=${seq + 1} len=${large.length}`);

        expect(await exit, read()).toBe(0);
        expect(out).toContain("CLIPDEV_DONE");

        // The agent is gone; its device is free and offers fail again.
        expect(await host.offerClipboardText("too late")).toEqual({
          ok: false,
          reason: "no-agent",
        });
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
