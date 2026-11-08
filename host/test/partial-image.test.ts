import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  parseKandeloDemoConfig,
} from "../../web-libs/kandelo-session/src/demo-config";

// Boots the worktree's partial image (`./run.sh partial <image> <pkg>...`,
// docs/package-management.md "Partial images") the way a developer would:
// Bash from the image, lazy programs resolved on first use from this
// worktree's packages through the Node host's repository resolver. Skipped
// until a partial image exists.
const repoRoot = findRepoRoot();
const partialDir = join(repoRoot, "local-binaries/partial");
const manifestPath = join(partialDir, "partial.json");
const kernelPath = tryResolveBinary("kernel.wasm");

interface PartialManifest {
  image: string;
  file: string;
  sha256: string;
  packages: string[];
  selection: string[];
  activities: string[];
}

const manifest: PartialManifest | null = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;

/** A program each package installs, to prove it runs from the image. */
const PROBES: Record<string, string> = {
  tmux: "tmux -V",
  less: "less --version | head -n 1",
  fbdoom: "test -x /usr/bin/fbdoom && test -x /usr/bin/doom-launch && echo fbdoom-wrapper-ok",
  "dosbox-pure": "dosbox-pure --info; dos-play --list",
  // Reads the kernel's own message ring and writes to the system log. `-r`
  // keeps the <pri> prefix, which is the part only the kernel can supply: the
  // ring always holds the boot records written when / was loaded, so a
  // machine that reaches this point has something to print. `logger -s` also
  // writes to standard error, which is the only way to observe the message
  // on an image with no daemon -- syslog(3) returns void, so nothing else
  // can report where it went.
  // This exact order is a regression guard. It used to hang: a `/dev/kmsg`
  // reader ended early by `head`, followed by a process opening an AF_UNIX
  // datagram socket, never completed. It was measured as fixed over five
  // consecutive runs under these same conditions, so if it ever comes back
  // this probe is where it surfaces. `dmesg -r` keeps the `<pri>` prefix,
  // which only the kernel can supply, and `logger -s` also writes to standard
  // error -- the only way to observe the message on an image with no daemon,
  // since syslog(3) returns void.
  toybox: "dmesg -r | head -n 1; logger -s -t probe hello 2>&1",
};

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe.skipIf(manifest === null || kernelPath === null)("partial image", () => {
  const imageBytes = () => new Uint8Array(readFileSync(join(partialDir, manifest!.file)));

  it("records the selection and only the activities it can run", () => {
    const fs = KandeloImageFs.create();
    fs.loadImage(imageBytes());
    const metadata = KandeloImageFs.readImageMetadata(imageBytes()) as Record<string, unknown>;
    expect(metadata.partialSelection).toEqual({ schema: 1, packages: manifest!.selection });
    const demo = parseKandeloDemoConfig(new TextDecoder().decode(fs.readFile(KANDELO_DEMO_CONFIG_PATH)));
    expect(Object.keys(demo?.profiles ?? {}).sort()).toEqual([...manifest!.activities].sort());
  });

  it("boots Bash and runs the named packages' programs", async () => {
    const probes = manifest!.packages.filter((name) => name in PROBES).map((name) => PROBES[name]!);
    const script = ["set -eu", "echo partial-boot-ok", ...probes].join("\n");
    let stdout = "";
    let stderr = "";
    const lazy: string[] = [];
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: imageBytes(),
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
      onLazyDownload: (event) => {
        if (event.status !== "progress") lazy.push(`${event.status} ${event.url}${"error" in event ? ` ${String(event.error)}` : ""}`);
      },
    });
    await host.init(arrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
    try {
      const fs = KandeloImageFs.create();
      fs.loadImage(imageBytes());
      const bash = fs.readFile("/bin/bash");
      const exitCode = await host.spawn(arrayBuffer(bash), ["bash", "-c", script], {
        env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/maker", "TERM=xterm", "TMPDIR=/tmp"],
        cwd: "/home/maker",
        uid: 1000,
        gid: 1000,
        stdin: new Uint8Array(),
      });
      expect(exitCode, `stdout=${stdout}\nstderr=${stderr}\nlazy=${lazy.join("\n")}`).toBe(0);
      expect(stdout).toContain("partial-boot-ok");
      if (manifest!.packages.includes("tmux")) expect(stdout).toMatch(/tmux \d/);
      if (manifest!.packages.includes("less")) expect(stdout).toMatch(/less \d+/);
      if (manifest!.packages.includes("fbdoom")) expect(stdout).toContain("fbdoom-wrapper-ok");
      if (manifest!.packages.includes("toybox")) {
        // A record the kernel wrote, carrying the priority it assigned.
        expect(stdout).toMatch(/<\d+>/);
        expect(stdout).toContain("probe: hello");
      }
      if (manifest!.packages.includes("dosbox-pure")) {
        expect(stdout).toContain("CPU: x86 interpreter");
        expect(stdout).toContain("keen1");
      }
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 180_000);

  it("does not carry programs it was not asked for", () => {
    const fs = KandeloImageFs.create();
    fs.loadImage(imageBytes());
    const absent = (path: string) => {
      try { fs.lstat(path); return false; } catch { return true; }
    };
    if (!manifest!.selection.includes("ffmpeg")) expect(absent("/usr/bin/ffmpeg")).toBe(true);
    if (!manifest!.selection.includes("scummvm")) expect(absent("/usr/bin/scummvm")).toBe(true);
    if (!manifest!.selection.includes("python-browser-bundle")) {
      expect(absent("/etc/profile.d/python.sh")).toBe(true);
    }
  });
});
