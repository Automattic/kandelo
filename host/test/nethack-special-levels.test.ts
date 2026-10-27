import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { ClosedLazyAsset } from "../src/vfs/closed-lazy-assets";

// NetHack's special levels (the Oracle, Sokoban, Minetown, the quest...) are
// compiled by lev_comp into nhdat. lev_comp writes each level's instruction
// count and operands as `long`; the game reads them back as its own `long`,
// 4 bytes on wasm32. Built on a 64-bit machine, lev_comp wrote 8-byte fields,
// and the game misread every level that holds a negative operand. Building
// the package inside Kandelo writes them as the game reads them. This boots
// the shell product, starts NetHack in wizard mode, and teleports to special
// levels by name.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const programsDir = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32");
const shellImagePath = join(programsDir, "shell.vfs.zst");
const LAZY_URL_BASE = "https://kandelo.invalid/";
const ASSETS: ReadonlyArray<readonly [url: string, file: string]> = [
  [`${LAZY_URL_BASE}assets/programs/wasm32/nethack.zip`, "nethack.zip"],
];
const available =
  kernelPath !== null &&
  existsSync(shellImagePath) &&
  ASSETS.every(([, file]) => existsSync(join(programsDir, file)));

// Levels whose old 8-byte encoding the game could not read, and one it could
// (oracle), so a teleport that fails for another reason does not pass.
const LEVELS = ["oracle", "minetn", "soko1", "bigrm", "medusa", "castle"];
const OPTIONS =
  "windowtype:tty,role:Valkyrie,race:human,gender:female,align:neutral,!legacy,!autopickup";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function closedAsset(url: string, file: string): ClosedLazyAsset {
  const bytes = new Uint8Array(readFileSync(join(programsDir, file)));
  return {
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    bytes,
  };
}

function screenText(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/[\x00-\x08\x0e-\x1f]/g, "")
    .replace(/\s+/g, " ");
}

async function until(
  check: () => boolean,
  timeoutMs: number,
  onTick: () => void = () => {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    onTick();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return check();
}

describe.skipIf(!available)("NetHack special levels (Node host, shell product)", () => {
  it("loads special levels from nhdat", async () => {
    let pty = "";
    const host = new NodeKernelHost({
      rootfsImage: new Uint8Array(readFileSync(shellImagePath)),
      rootfsLazyUrlBase: LAZY_URL_BASE,
      rootfsLazyAssetDirectory: LAZY_URL_BASE,
      rootfsLazyAssets: ASSETS.map(([url, file]) => closedAsset(url, file)),
      onPtyOutput: (_pid, bytes) => { pty += new TextDecoder().decode(bytes); },
    });
    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
      let pid = -1;
      // Without a sysconf file, the player named `wizard` may use wizard mode.
      const { exit } = await host.spawnFromVfs(
        "/usr/bin/bash",
        ["bash", "-c", `NETHACKOPTIONS='${OPTIONS}' exec nethack -D -u wizard`],
        {
          env: ["HOME=/home/maker", "USER=maker", "TERM=xterm-256color", "PATH=/usr/bin:/bin"],
          uid: 1000,
          gid: 1000,
          pty: true,
          ptyCols: 80,
          ptyRows: 24,
          onStarted: (started) => { pid = started; },
        },
      );
      let status: number | null = null;
      void exit.then((code) => { status = code; });
      const key = (text: string) => host.ptyWrite(pid, new TextEncoder().encode(text));

      expect(
        await until(() => /Dlvl:?\s*1/.test(screenText(pty)), 60_000, () => key("\x1b")),
        `reached the map:\n${screenText(pty)}`,
      ).toBe(true);

      for (const level of LEVELS) {
        pty = "";
        key("\x16"); // ^V: level teleport
        expect(
          await until(() => /To what level do you want to teleport\?/.test(screenText(pty)), 15_000),
          `${level} prompt:\n${screenText(pty)}`,
        ).toBe(true);
        pty = "";
        key(`${level}\r`);
        // A level that fails to load ends the game ("Program in disorder")
        // or reports the loader's panic; a loaded one redraws the status line.
        const arrived = await until(
          () => status !== null || /Dlvl:?\s*\d+/.test(screenText(pty)),
          60_000,
          () => key(" "),
        );
        const screen = screenText(pty);
        expect(arrived && status === null, `${level}:\n${screen}`).toBe(true);
        expect(screen, level).not.toMatch(/impossible opcode|Program in disorder|panic/i);
      }
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 600_000);
});
