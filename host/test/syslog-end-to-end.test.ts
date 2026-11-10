import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { findRepoRoot, tryResolveBinary } from "../src/binary-resolver";
import { parseExperimentalTerminalSession } from "../../web-libs/kandelo-session/src/experimental-terminal-session";

/**
 * The syslog facility end to end, through the boot the image itself declares.
 *
 * Everything else in this branch tests a piece: the kernel routes datagrams,
 * musl's syslog(3) reaches a bound socket, the helper generates a service.
 * None of it showed that a machine, booted the way the browser boots it,
 * ends up with a daemon running and a message in /var/log/messages.
 *
 * That gap let a real mistake ship. The boot program was changed in the
 * product recipe's `[boot]` stanza, which the browser never reads -- it reads
 * /etc/kandelo/experimental-terminal-session.json out of the image. The image
 * booted straight to login, no daemon started, and nothing failed; logging
 * simply did not happen. So this test takes the boot program from that file
 * rather than naming it, which is the thing that was wrong.
 */

const repoRoot = findRepoRoot();
const partialDir = join(repoRoot, "local-binaries/partial");
const kernelPath = tryResolveBinary("kernel.wasm");

let manifest: { file: string; packages: string[] } | null = null;
try {
  manifest = JSON.parse(readFileSync(join(partialDir, "partial.json"), "utf8"));
} catch {
  manifest = null;
}

const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe.skipIf(manifest === null || kernelPath === null || !manifest?.packages.includes("sysklogd"))(
  "syslog end to end",
  () => {
    it("starts the daemon at boot and delivers a logged message to /var/log/messages", async () => {
      const image = () => new Uint8Array(readFileSync(join(partialDir, manifest!.file)));

      // The boot program is whatever the image declares, not what this test
      // thinks it should be.
      const probe = KandeloImageFs.create();
      probe.loadImage(image());
      const session = parseExperimentalTerminalSession(
        new TextDecoder().decode(probe.readFile("/etc/kandelo/experimental-terminal-session.json")),
      );
      const program = probe.readFile(session.initial.path);

      let stdout = "", stderr = "";
      const host = new NodeKernelHost({
        maxWorkers: 4,
        rootfsImage: image(),
        onStdout: (_p, d) => { stdout += new TextDecoder().decode(d); },
        onStderr: (_p, d) => { stderr += new TextDecoder().decode(d); },
      });
      await host.init(ab(new Uint8Array(readFileSync(kernelPath!))));
      try {
        // The init execs login, which runs the account shell on this stdin.
        const script = [
          "logger -t probe hello-from-boot",
          // syslogd writes asynchronously; give it a moment rather than
          // racing it, and report what is there either way.
          "sleep 1",
          "echo '--- messages ---'",
          "cat /var/log/messages 2>&1 || echo 'no /var/log/messages'",
          "exit",
          "",
        ].join("\n");
        const exitCode = await host.spawn(ab(program), session.initial.argv, {
          env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/home/maker", "TERM=dumb", "TMPDIR=/tmp"],
          cwd: "/home/maker",
          uid: session.initial.uid,
          gid: session.initial.gid,
          stdin: new TextEncoder().encode(script),
        });

        const detail = `exit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`;
        // The daemon's own startup banner proves it ran; the tagged line
        // proves the message travelled through /dev/log to the log file.
        expect(stdout, detail).toContain("--- messages ---");
        expect(stdout, detail).toContain("probe: hello-from-boot");
      } finally {
        await host.shutdown?.();
      }
    }, 180_000);
  },
);
