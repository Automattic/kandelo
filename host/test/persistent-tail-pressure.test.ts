import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";

const artifacts = join(import.meta.dirname, "../../local-binaries/source-only-v1");

it("waits for compaction when uid 1000 copies three random files past the persistent tail bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-tail-pressure-"));
  const output: string[] = [];
  const coreutils = new Uint8Array(readFileSync(join(artifacts, "programs/wasm32/coreutils.wasm")));
  const options = {
    rootfsImage: new Uint8Array(readFileSync(join(artifacts, "programs/wasm32/shell.vfs.zst"))),
    rootfsLazyUrlBase: "https://kandelo.invalid/",
    rootfsLazyAssets: [{
      url: "https://kandelo.invalid/binaries/programs/wasm32/coreutils.wasm",
      sha256: createHash("sha256").update(coreutils).digest("hex"),
      size: coreutils.byteLength,
      bytes: coreutils,
    }],
    experimentalResizablePersistencePath: join(directory, "journal"),
    onStdout: (_pid: number, bytes: Uint8Array) => output.push(new TextDecoder().decode(bytes)),
    onStderr: (_pid: number, bytes: Uint8Array) => output.push(new TextDecoder().decode(bytes)),
  };
  let closed = true;
  try {
    for (const reopen of [false, true]) {
      const host = new NodeKernelHost({ ...options, requireExistingRootfsPersistence: reopen });
      closed = false;
      try {
        await host.init(new Uint8Array(readFileSync(join(artifacts, "kernel.wasm"))).buffer);
        const run = async (script: string, uid: number) => {
          const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-ec", script], {
            uid, gid: uid, env: ["PATH=/usr/bin:/bin", "HOME=/home/maker"],
          });
          expect(await exit, output.join("")).toBe(0);
        };
        if (!reopen) {
          await run("mkdir -p /home/maker /run/user/1000; chown 1000:1000 /home/maker /run/user/1000", 0);
          await run(`
            for i in 1 2 3; do
              dd if=/dev/urandom of=/run/user/1000/drop$i bs=65536 count=528
              cp /run/user/1000/drop$i /home/maker/copy$i
            done
            # Verify after the burst; hashing between copies would give the
            # two-second background poll time to hide the admission failure.
            for i in 1 2 3; do
              test "$(stat -c %s /home/maker/copy$i)" = 34603008
              read -r source_hash rest < <(sha256sum /run/user/1000/drop$i)
              read -r copy_hash rest < <(sha256sum /home/maker/copy$i)
              test "$source_hash" = "$copy_hash"
              printf '%s  /home/maker/copy%s\\n' "$source_hash" "$i" >> /home/maker/checksums
            done
            mv /home/maker/copy3 /home/maker/renamed
            mv /home/maker/renamed /home/maker/copy3
            sync
            printf 'TAIL_PRESSURE_WRITTEN\\n'
          `, 1000);
          expect(output.join("")).toContain("TAIL_PRESSURE_WRITTEN");
        } else {
          await run("sha256sum -c /home/maker/checksums; printf 'TAIL_PRESSURE_RECOVERED\\n'", 1000);
          expect(output.join("")).toContain("TAIL_PRESSURE_RECOVERED");
        }
      } finally {
        await host.destroy();
        closed = true;
      }
    }
  } finally {
    if (closed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained tail-pressure storage after unproven shutdown: ${directory}`);
  }
}, 180_000);
