import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { ClosedLazyAsset } from "../src/vfs/closed-lazy-assets";

// NetHack's saves, scores and lock file live in one shared playground,
// /var/games/nethack, owned by group `games`. Players cannot write it; the game
// can, because /usr/bin/nethack is set-group-ID `games` — the layout Debian and
// Fedora install. This boots the built shell product and proves, for two
// different unprivileged users, that a save is written, owned by its player,
// unreachable by direct writes, and restored on the next start.
//
// The binary is a member of the lazy nethack.zip archive. Its set-group-ID bit
// survives boot only because the kernel counts the archive's verified digest
// (`demote_unverifiable_setid`); without that the game runs without the group
// and fails with "Cannot open save file.".
//
// NetHack gzips a save by running /bin/gzip, a `kandelo-lazy:` file the Node
// host cannot fetch. The exec fails, NetHack keeps the uncompressed save, and
// restore reads it. Either form is accepted so a host that can fetch gzip
// passes too.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const kernelPath = tryResolveBinary("kernel.wasm");
const programsDir = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32");
const shellImagePath = join(programsDir, "shell.vfs.zst");
const LAZY_URL_BASE = "https://kandelo.invalid/";
const PLAYGROUND = "/var/games/nethack";
const ASSETS: ReadonlyArray<readonly [url: string, file: string]> = [
  [`${LAZY_URL_BASE}nethack.zip`, "nethack.zip"],
  [`${LAZY_URL_BASE}binaries/programs/wasm32/coreutils.wasm`, "coreutils.wasm"],
];
const available =
  kernelPath !== null &&
  existsSync(shellImagePath) &&
  ASSETS.every(([, file]) => existsSync(join(programsDir, file)));

interface Player {
  name: string;
  uid: number;
  home: string;
}
const PLAYERS: Player[] = [
  { name: "maker", uid: 1000, home: "/home/maker" },
  { name: "alice", uid: 1001, home: "/home/alice" },
];
// tty with a preset character, so the game reaches the map without prompts.
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

// Screen text without terminal control sequences, whitespace collapsed.
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

describe.skipIf(!available)("NetHack shared playground (Node host, shell product)", () => {
  it("saves and restores for two unprivileged users through the set-group-ID binary", async () => {
    let output = "";
    let pty = "";
    const host = new NodeKernelHost({
      rootfsImage: new Uint8Array(readFileSync(shellImagePath)),
      rootfsLazyUrlBase: LAZY_URL_BASE,
      rootfsLazyAssets: ASSETS.map(([url, file]) => closedAsset(url, file)),
      onStdout: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
      onPtyOutput: (_pid, bytes) => { pty += new TextDecoder().decode(bytes); },
    });

    const run = async (command: string, uid: number, home: string) => {
      output = "";
      const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-c", command], {
        env: [`HOME=${home}`, "PATH=/usr/bin:/bin"],
        uid,
        gid: uid,
      });
      const status = await exit;
      return { status, output };
    };

    // Start NetHack on a PTY as `player`, then save. `restore` expects the
    // previous save to be picked up instead of a new character.
    const play = async (player: Player, restore: boolean) => {
      pty = "";
      let pid = -1;
      const { exit } = await host.spawnFromVfs(
        "/usr/bin/bash",
        ["bash", "-c", `NETHACKOPTIONS='${OPTIONS}' exec nethack -u ${player.name}`],
        {
          env: [`HOME=${player.home}`, `USER=${player.name}`, "TERM=xterm-256color", "PATH=/usr/bin:/bin"],
          uid: player.uid,
          gid: player.uid,
          pty: true,
          ptyCols: 80,
          ptyRows: 24,
          onStarted: (started) => { pid = started; },
        },
      );
      let status: number | null = null;
      void exit.then((code) => { status = code; });
      const key = (text: string) => host.ptyWrite(pid, new TextEncoder().encode(text));

      const atMap = await until(() => /Dlvl:?\s*1/.test(screenText(pty)), 60_000, () => key("\x1b"));
      const opening = screenText(pty);
      expect(atMap, `${player.name} reached the map:\n${opening}`).toBe(true);
      if (restore) expect(opening).toContain("Restoring save file");
      else expect(opening).not.toContain("Restoring save file");

      pty = "";
      key("S");
      expect(await until(() => /Really save\?/.test(screenText(pty)), 15_000)).toBe(true);
      key("y");
      await until(() => status !== null, 30_000, () => key(" "));
      const closing = screenText(pty);
      expect(status, `${player.name} save:\n${closing}`).toBe(0);
      expect(closing).not.toContain("Cannot open save file");
      expect(closing).toContain("Be seeing you");
    };

    try {
      await host.init(arrayBuffer(new Uint8Array(readFileSync(kernelPath!))));

      // The kernel kept the bit: this is what the player's exec sees.
      const binary = await run("stat -L -c '%a %u %g' /usr/bin/nethack", 1000, "/home/maker");
      expect(binary.output.trim()).toBe("2755 0 60");

      const added = await run(
        "echo 'alice:x:1001:1001:alice:/home/alice:/bin/bash' >> /etc/passwd && " +
          "echo 'alice:x:1001:' >> /etc/group && " +
          "mkdir -p /home/alice && chown 1001:1001 /home/alice",
        0,
        "/root",
      );
      expect(added.status, added.output).toBe(0);

      for (const player of PLAYERS) {
        await play(player, false);

        const saved = await run(
          `cd ${PLAYGROUND}/save && stat -c '%u %g %a %n' ${player.uid}${player.name}*`,
          player.uid,
          player.home,
        );
        expect(saved.status, saved.output).toBe(0);
        expect(saved.output.trim()).toMatch(
          new RegExp(`^${player.uid} 60 660 ${player.uid}${player.name}(\\.gz)?$`),
        );

        const intrusion = await run(
          `echo x > ${PLAYGROUND}/save/intruder`,
          player.uid,
          player.home,
        );
        expect(intrusion.status).not.toBe(0);
        expect(intrusion.output).toContain("Permission denied");
      }

      for (const player of PLAYERS) await play(player, true);
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 300_000);
});
