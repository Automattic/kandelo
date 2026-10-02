/**
 * Host clipboard paste, end to end on the Node host, minus the browser:
 *
 *   NodeKernelHost.offerClipboardText(text)
 *     → /dev/kandelo/clipboard → kclipd (programs/kclipd.c)
 *     → ext_data_control_v1 set_selection in wlcompositor
 *     → a Wayland client (wlclip-test paste) receives the offer and reads
 *       the same bytes through a pipe kclipd writes.
 *
 * The offer resolves only once kclipd has installed the selection, which is
 * what lets the browser deliver the user's paste chord afterwards. A later
 * in-desktop copy replaces kclipd's selection, and a later host offer
 * replaces that. Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const kclipdBin = tryResolveBinary("programs/wayland-demo/kclipd.wasm");
const clipBin = tryResolveBinary("programs/wlclip-test.wasm");
const hasBinaries = !!compositorBin && !!kclipdBin && !!clipBin;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  read: () => string,
  needle: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hit = () =>
    typeof needle === "string" ? read().includes(needle) : needle.test(read());
  while (Date.now() < deadline) {
    if (hit()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${needle}.\n${context()}`);
}

describe("kclipd — host clipboard into the Wayland selection", () => {
  it.skipIf(!hasBinaries)(
    "an offer becomes the selection a Wayland client pastes",
    async () => {
      const clipBytes = loadBytes(clipBin!);
      const byPid = new Map<number, string>();
      let all = "";
      let err = "";
      const host = new NodeKernelHost({
        onStdout: (pid, data) => {
          const text = new TextDecoder().decode(data);
          all += text;
          byPid.set(pid, (byPid.get(pid) ?? "") + text);
        },
        onStderr: (_pid, data) => { err += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${all}\n--- stderr ---\n${err}`;
      const paste = async (label: string): Promise<string> => {
        let pid = -1;
        const exit = host.spawn(clipBytes, ["wlclip-test", "paste"], {
          onStarted: (p) => { pid = p; },
        });
        await waitFor(() => byPid.get(pid) ?? "", "CLIP_PASTED", 20_000, dump);
        expect(await exit, `${label}\n${dump()}`).toBe(0);
        return byPid.get(pid)!;
      };

      try {
        await host.init();
        host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {}).catch(() => {});
        await waitFor(() => all, "COMPOSITOR_UP", 20_000, dump);
        // kclipd finds the compositor the way the desktop's clients do.
        host.spawn(loadBytes(kclipdBin!), ["kclipd"], {
          env: ["XDG_RUNTIME_DIR=/tmp"],
        }).catch(() => {});
        await waitFor(() => all, "KCLIPD_READY", 20_000, dump);

        const hostText = "pasted from the host ✓";
        const offered = await host.offerClipboardText(hostText);
        expect(offered, dump()).toEqual({ ok: true, seq: expect.any(Number) });
        // Installed through ext_data_control_v1, with the four text types.
        expect(all).toMatch(/SELECTION_SET via=ext-data-control mimes=4/);
        expect(all).toMatch(
          new RegExp(`KCLIPD_OFFER seq=${(offered as { seq: number }).seq} len=${
            new TextEncoder().encode(hostText).length}`),
        );
        // kclipd logs lengths, never the text.
        expect(all).not.toMatch(/KCLIPD[^\n]*pasted from the host/);

        const first = await paste("first paste");
        expect(first).toContain(
          `CLIP_PASTED len=${new TextEncoder().encode(hostText).length} text=${hostText}`,
        );

        // An in-desktop copy replaces the host text...
        host.spawn(clipBytes, ["wlclip-test", "copy", "copied in the guest"], {})
          .catch(() => {});
        await waitFor(() => all, "CLIP_COPY_SET", 20_000, dump);
        expect(await paste("guest copy")).toContain("text=copied in the guest");

        // ...and the next host offer replaces that.
        expect(await host.offerClipboardText("second host text")).toEqual({
          ok: true,
          seq: expect.any(Number),
        });
        expect(await paste("second host offer")).toContain("text=second host text");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    120_000,
  );
});
