/**
 * The root filesystem installs less as more(1): less follows POSIX more
 * semantics when argv[0] is "more". On a terminal, more must show one
 * screenful and wait for a command. The replaced posix-utils-lite more
 * copied every file straight to standard output and ignored its options.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";

const less = tryResolveBinary("programs/less.wasm");

const ROWS = 6;
const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

async function waitForScreen(
  screen: () => string,
  predicate: (text: string) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate(screen())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(screen())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!less)("less as more", () => {
  it("pages one screenful on a terminal and quits on q", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-more-"));
    writeFileSync(join(dir, "lines.txt"), `${LINES.join("\n")}\n`);
    const decoder = new TextDecoder();
    let screen = "";
    const host = new NodeKernelHost({
      maxWorkers: 2,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/data", hostPath: dir, readonly: true }],
      onPtyOutput: (_pid, data) => {
        screen += decoder.decode(data, { stream: true });
      },
    });
    try {
      await host.init();
      let pid = 0;
      const exit = host.spawn(
        readFileSync(less!).buffer as ArrayBuffer,
        ["more", "/data/lines.txt"],
        {
          env: ["TERM=vt100", "HOME=/tmp", "PATH=/usr/bin:/bin"],
          pty: true,
          ptyCols: 40,
          ptyRows: ROWS,
          onStarted: (started) => {
            pid = started;
          },
        },
      );

      // One screenful is ROWS - 1 lines of text plus the --More-- prompt.
      await waitForScreen(
        () => screen,
        (text) => text.includes(`line ${ROWS - 1}`) && text.includes("--More--"),
        "the first page",
      );
      expect(screen).not.toMatch(new RegExp(`\\bline ${ROWS + 1}\\b`));
      expect(screen).not.toContain(LINES[LINES.length - 1]);

      host.ptyWrite(pid, new TextEncoder().encode("q"));
      expect(await exit).toBe(0);
    } finally {
      await host.destroy().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
