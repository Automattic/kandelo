/** A protocol probe shared by the Node and browser Harper acceptance tests. */
export class HarperLspProbe {
  private buffer = new Uint8Array();
  private messages: any[] = [];
  private changed: (() => void) | undefined;
  private nextId = 1;

  constructor(private readonly write: (bytes: Uint8Array, eof?: boolean) => void) {}

  accept(bytes: Uint8Array): void {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer = joined;
    while (this.buffer.length) {
      const headerEnd = this.buffer.findIndex((byte, index, all) =>
        byte === 13 && all[index + 1] === 10 && all[index + 2] === 13 && all[index + 3] === 10);
      if (headerEnd < 0) return;
      const header = new TextDecoder().decode(this.buffer.subarray(0, headerEnd));
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`Invalid LSP header: ${header}`);
      const end = headerEnd + 4 + Number(match[1]);
      if (this.buffer.length < end) return;
      const message = JSON.parse(new TextDecoder().decode(this.buffer.subarray(headerEnd + 4, end)));
      this.buffer = this.buffer.slice(end);
      if (message.method && message.id !== undefined) {
        // Harper asks its client for configuration and file-watch registration.
        // The probe serves settings and acknowledges registration; document
        // changes below are explicit LSP notifications, not simulated watches.
        const result = message.method === "workspace/configuration"
          ? [{ "harper-ls": { diagnosticDelayMs: 0 } }]
          : null;
        this.send({ jsonrpc: "2.0", id: message.id, result });
      } else {
        this.messages.push(message);
        this.changed?.();
      }
    }
  }

  private send(message: unknown, eof = false): void {
    const json = JSON.stringify(message);
    this.write(new TextEncoder().encode(`Content-Length: ${new TextEncoder().encode(json).length}\r\n\r\n${json}`), eof);
  }

  notify(method: string, params: unknown, eof = false): void {
    this.send({ jsonrpc: "2.0", method, params }, eof);
  }

  async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    const message = await this.wait(message => message.id === id);
    if (message.error) throw new Error(JSON.stringify(message.error));
    return message.result;
  }

  async wait(predicate: (message: any) => boolean): Promise<any> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.changed = undefined;
          reject(new Error(`Timed out waiting for LSP message; received ${JSON.stringify(this.messages)}`));
        }, Math.max(0, deadline - Date.now()));
        this.changed = () => { clearTimeout(timer); this.changed = undefined; resolve(); };
      });
    }
  }
}

export async function exerciseHarperLsp(peer: HarperLspProbe) {
  const uri = "file:///home/maker/probe.md";
  const initialization = await peer.request("initialize", {
    processId: null,
    capabilities: {},
    workspaceFolders: [{ uri: "file:///home/maker", name: "maker" }],
  });
  peer.notify("initialized", {});
  peer.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "markdown", version: 1, text: "This is an test.\n" },
  });
  const first = await peer.wait(message =>
    message.method === "textDocument/publishDiagnostics" &&
    message.params.uri === uri && message.params.diagnostics.length > 0);
  const diagnostic = first.params.diagnostics.find((item: any) => item.message.includes(" a ") || item.message.includes("\"a\""))
    ?? first.params.diagnostics[0];
  const actions = await peer.request("textDocument/codeAction", {
    textDocument: { uri }, range: diagnostic.range, context: { diagnostics: [diagnostic] },
  });
  const edit = actions.flatMap((action: any) => action.edit?.changes?.[uri] ?? [])
    .find((edit: any) => edit.newText === "a");
  if (!edit || edit.range.start.line !== 0 || edit.range.end.line !== 0) {
    throw new Error(`Harper did not offer the expected article correction: ${JSON.stringify(actions)}`);
  }
  const text = "This is an test.\n";
  const fixedText = text.slice(0, edit.range.start.character) + edit.newText + text.slice(edit.range.end.character);
  if (fixedText !== "This is a test.\n") throw new Error(`Incorrect LSP edit range: ${JSON.stringify(edit)}`);
  peer.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 }, contentChanges: [{ text: fixedText }],
  });
  const corrected = await peer.wait(message =>
    message.method === "textDocument/publishDiagnostics" &&
    message.params.uri === uri && message.params.diagnostics.length === 0);
  const commitUri = "file:///home/maker/COMMIT_EDITMSG";
  peer.notify("textDocument/didOpen", {
    textDocument: {
      uri: commitUri, languageId: "gitcommit", version: 1,
      text: "This is an test.\n\n# This is an ignored comment.\n",
    },
  });
  const commit = await peer.wait(message =>
    message.method === "textDocument/publishDiagnostics" &&
    message.params.uri === commitUri && message.params.diagnostics.length > 0);
  if (!commit.params.diagnostics.some((item: any) => item.range.start.line === 0) ||
      commit.params.diagnostics.some((item: any) => item.range.start.line >= 2)) {
    throw new Error(`Git commit grammar did not isolate the subject: ${JSON.stringify(commit)}`);
  }
  await peer.request("shutdown", null);
  // Finish the client pipe after exit so Tokio's blocking stdin reader can
  // observe EOF too. This is the normal LSP stdio transport shutdown.
  peer.notify("exit", null, true);
  return { initialization, diagnostics: first.params.diagnostics, actions, corrected: corrected.params.diagnostics,
    commitDiagnostics: commit.params.diagnostics };
}
