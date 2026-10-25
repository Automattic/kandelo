import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { BrowserKernel } from "../../../host/src/browser-kernel-host";

/** Production browser workers, real guest PTYs and xterm rendering. Images
 * are composed on the Node test side: the page never owns a VFS buffer. */
export async function startTermchatBrowserTest(imageBytes: number[]) {
  const stderr: string[] = [];
  const diagnostics: unknown[] = [];
  const raw = ["", ""];
  document.body.replaceChildren();
  document.body.style.cssText = "background:#141820;color:#ddd;font-family:monospace;margin:20px";
  const title = document.createElement("h1"); title.textContent = "termchat on Kandelo";
  document.body.append(title);
  const grid = document.createElement("div"); grid.style.cssText = "display:flex;gap:24px";
  document.body.append(grid);
  const names = ["alice", "bob"];
  const terminals = names.map(name => {
    const panel = document.createElement("section");
    const label = document.createElement("h2"); label.textContent = name;
    const element = document.createElement("div"); panel.append(label, element); grid.append(panel);
    const terminal = new Terminal({ cols: 90, rows: 30, fontSize: 13, theme: { background: "#141820" } });
    terminal.open(element); return terminal;
  });
  const kernels = names.map(() => new BrowserKernel({ maxMemoryPages: 4096, maxWorkers: 12,
    onStderr: bytes => stderr.push(new TextDecoder().decode(bytes)),
    onHostDiagnostic: value => diagnostics.push(value),
  }));
  const processes: { pid: number; exit: Promise<number> }[] = [];
  const text = (i: number) => Array.from({ length: terminals[i].buffer.active.length }, (_, n) => terminals[i].buffer.active.getLine(n)?.translateToString(true) ?? "").join("\n");
  const wait = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 30_000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`termchat timed out: ${JSON.stringify({ raw, stderr, diagnostics })}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const harness = { kernels, processes, text, raw, stderr, diagnostics,
    send: (i: number, value: string) => kernels[i].ptyWrite(processes[i].pid, new TextEncoder().encode(value + "\r")),
    resize: async (i: number) => {
      terminals[i].resize(100, 34); kernels[i].ptyResize(processes[i].pid, 34, 100);
      // Local xterm reflow is immediate; the guest receives SIGWINCH later.
      // Observe its new bottom border before typing into the resized TUI.
      await wait(() => {
        const bottom = terminals[i].buffer.active.getLine(33)?.translateToString(true) ?? "";
        return bottom.length === 100 && bottom.startsWith("└") && bottom.endsWith("┘");
      });
    },
    stop: async (i: number) => { kernels[i].ptyWrite(processes[i].pid, new Uint8Array([27])); return processes[i].exit; },
    destroy: async () => { await Promise.all(kernels.map(k => k.destroy())); terminals.forEach(t => t.dispose()); },
  };
  (window as any).__termchatHarness = harness;
  await Promise.all(kernels.map(k => k.initFromImage({ vfsImage: new Uint8Array(imageBytes) })));
  await kernels[0].hostRemoteNetwork();
  const { port1, port2 } = new MessageChannel();
  await Promise.all([
    kernels[0].attachRemotePeer({ port: port1, maxPayload: 1200, maxControlBytes: 65536 }),
    kernels[1].joinRemoteNetwork({ port: port2, maxPayload: 1200, maxControlBytes: 65536 }),
  ]);
  for (const [i, kernel] of kernels.entries()) {
    const process = await kernel.spawnFromVfs("/usr/bin/termchat", ["termchat", "-u", names[i]], {
      env: ["HOME=/root", "TERM=xterm-256color", "LANG=C.UTF-8"], pty: true, ptyCols: 90, ptyRows: 30,
    });
    processes.push(process);
    kernel.onPtyOutput(process.pid, bytes => { raw[i] += new TextDecoder().decode(bytes); terminals[i].write(bytes); });
    terminals[i].onData(data => kernel.ptyWrite(process.pid, new TextEncoder().encode(data)));
    if (i === 0) await wait(async () => (await kernel.remoteNetworkSnapshot()).bindings.some(b => b.port === 5877));
  }
  await wait(() => text(0).includes("bob is online") && text(1).includes("alice is online"));
}
