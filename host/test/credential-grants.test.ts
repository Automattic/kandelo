/**
 * Credential grants through the real Node host, kernel worker and kernel wasm.
 *
 * A package declares, in `/etc/kandelo/credential-requests.d/*.json`, which
 * program may send credentials and to which HTTPS origins. When an image of
 * a declared program is committed (root spawn, guest `posix_spawn`, exec),
 * the kernel worker asks the host's `onCredentialRequest` handler and, on
 * "allow", records a grant for that one process in the kernel's process
 * table. These tests pin what the user's answer means:
 *
 * - `launch = "wait"`: the image runs no instruction before the answer.
 * - Allow grants that process; decline, no handler, or a throwing handler
 *   grants nothing, and the program still runs.
 * - A fork child never holds its parent's grant and is never asked.
 * - Any exec ends the grant; the same program exec'd again asks again.
 * - The program is matched by the file the kernel executed, so a symlink
 *   (`/bin/credprog` -> `/usr/bin/credprog`) is the same program.
 * - `launch = "continue"` starts at once and gains the grant on the answer.
 * - The kernel's records: set -> get, revoke (set 0) -> 0, exited -> ESRCH.
 * - A malformed declaration fails the boot; teardown while a prompt is open
 *   denies it and does not hang.
 * - A declared program whose file changed after boot is flagged as changed.
 * - At most 8 questions are open per machine; more are denied unasked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../src/binary-resolver";
import {
  OverCapReport,
  type CredentialRequest,
} from "../src/credential-grants";
import { NodeKernelHost } from "../src/node-kernel-host";
import {
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
  writeVfsFile,
} from "../src/vfs/image-helpers";
import { makeHostScratchTempRoot } from "./centralized-test-helper";

const repoRoot = join(import.meta.dirname, "..", "..");
const kernelPath = tryResolveBinary("kernel.wasm");
const artifactsMissing =
  !existsSync(join(repoRoot, "sysroot", "lib", "libc.a")) || kernelPath === null;

const DECLARED = "/usr/bin/credprog";
const DECLARED_LINK = "/bin/credprog";
const CONTINUE = "/usr/bin/credcont";
const UNDECLARED = "/usr/bin/credparent";
const DESTINATIONS = ["https://auth.example.test", "https://api.example.test"];
const IMAGE_SOURCE = "test image built by credential-grants.test.ts";

let buildDir = "";
let program: Uint8Array;

function declaration(path: string, launch: "wait" | "continue"): string {
  return JSON.stringify({
    program: path,
    title: launch === "wait" ? "Cred Prog" : "Cred Cont",
    destinations: DESTINATIONS,
    launch,
  });
}

async function image(
  declarations: Record<string, string> | null = {
    "credprog.json": declaration(DECLARED, "wait"),
    "credcont.json": declaration(CONTINUE, "continue"),
  },
): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, "/bin");
  // null: an image with no declaration directory at all.
  ensureDirRecursive(fs, declarations ? "/etc/kandelo/credential-requests.d" : "/etc/kandelo");
  writeVfsBinary(fs, DECLARED, program);
  writeVfsBinary(fs, CONTINUE, program);
  writeVfsBinary(fs, UNDECLARED, program);
  symlink(fs, DECLARED, DECLARED_LINK);
  for (const [name, text] of Object.entries(declarations ?? {})) {
    writeVfsFile(fs, `/etc/kandelo/credential-requests.d/${name}`, text);
  }
  return await fs.saveImage();
}

interface Machine {
  host: NodeKernelHost;
  stdout: () => string;
  requests: CredentialRequest[];
  events: string[];
  diagnostics: string[];
}

async function boot(options: {
  answer?: (request: CredentialRequest, signal: AbortSignal) => Promise<boolean>;
  image?: Uint8Array;
}): Promise<Machine> {
  let stdout = "";
  const requests: CredentialRequest[] = [];
  const events: string[] = [];
  const diagnostics: string[] = [];
  const host = new NodeKernelHost({
    onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    rootfsImage: options.image ?? await image(),
    credentialImageSource: IMAGE_SOURCE,
    onStdout: (_pid, bytes) => {
      const text = new TextDecoder().decode(bytes);
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.startsWith("MARKER")) events.push(line);
      }
    },
    ...(options.answer
      ? {
        onCredentialRequest: async (request, { signal }) => {
          requests.push(request);
          events.push(`prompt pid=${request.pid}`);
          const allow = await options.answer!(request, signal);
          events.push(`answer pid=${request.pid} ${allow}`);
          return allow;
        },
      }
      : {}),
  });
  await host.init(new Uint8Array(readFileSync(kernelPath!)).buffer as ArrayBuffer);
  return { host, stdout: () => stdout, requests, events, diagnostics };
}

const line = new TextEncoder().encode("\n");

async function waitForText(machine: Machine, text: string, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(machine.stdout().split(text).length - 1).toBeGreaterThanOrEqual(count);
  }, { timeout: 30_000, interval: 20 });
}

function pidAfter(machine: Machine, prefix: string): number {
  const match = machine.stdout().match(new RegExp(`${prefix} pid=(\\d+)`));
  if (!match) throw new Error(`no ${prefix} line in:\n${machine.stdout()}`);
  return Number(match[1]);
}

describe.skipIf(artifactsMissing)("credential grants", () => {
  beforeAll(() => {
    buildDir = makeHostScratchTempRoot("credential-grants-");
    const linked = join(buildDir, "credential-grants.linked.wasm");
    const instrumented = join(buildDir, "credential-grants.wasm");
    execFileSync(join(repoRoot, "sdk/bin/wasm32posix-cc"), [
      "-O2", join(repoRoot, "host/test/fixtures/credential-grants.c"), "-o", linked,
    ], { stdio: "inherit" });
    execFileSync("bash", [
      join(repoRoot, "scripts/run-wasm-fork-instrument.sh"), linked, "-o", instrumented,
    ], { stdio: "inherit" });
    program = new Uint8Array(readFileSync(instrumented));
  }, 300_000);

  afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  it("holds a declared program until the user allows it, then grants that process", async () => {
    let markerBeforeAnswer = false;
    const machine = await boot({
      answer: async () => {
        // Give a wrongly started image ample time to print its marker.
        await new Promise((resolve) => setTimeout(resolve, 300));
        markerBeforeAnswer = machine.stdout().includes("MARKER");
        return true;
      },
    });
    try {
      // Spawned through the symlink; matched as the file the kernel executed.
      const { pid, exit } = await machine.host.spawnFromVfs(
        DECLARED_LINK,
        ["credprog", "hold"],
        { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER");
      expect(markerBeforeAnswer).toBe(false);
      expect(machine.events).toEqual([
        `prompt pid=${pid}`,
        `answer pid=${pid} true`,
        `MARKER pid=${pid}`,
      ]);
      expect(machine.requests).toEqual([{
        pid,
        title: "Cred Prog",
        program: DECLARED,
        argv: ["credprog", "hold"],
        parentChain: [],
        destinations: DESTINATIONS,
        imageSource: IMAGE_SOURCE,
        programChangedSinceBoot: false,
        // Node has no CORS proxy or service-worker gate: the answer is
        // recorded in the kernel, but nothing on this host enforces it.
        enforcement: "none",
        // Nor any intermediary: a Node program connects to each
        // destination itself.
        transport: [{ kind: "direct", destinations: DESTINATIONS }],
      }]);

      // set -> get through the real kernel export.
      const grant = await machine.host.getCredentialGrant(pid);
      expect(grant).toBeGreaterThan(0);
      // Revoke is set 0 -> get 0.
      expect(await machine.host.revokeCredentialGrant(pid)).toBe(0);
      expect(await machine.host.getCredentialGrant(pid)).toBe(0);

      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
      // An exited (and reaped) process is ESRCH: no grant, no process.
      expect(await machine.host.getCredentialGrant(pid)).toBeNull();
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("runs a declined program without a grant", async () => {
    const machine = await boot({ answer: async () => false });
    try {
      const { pid, exit } = await machine.host.spawnFromVfs(
        DECLARED, ["credprog", "hold"], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER");
      expect(machine.requests.map((r) => r.pid)).toEqual([pid]);
      expect(await machine.host.getCredentialGrant(pid)).toBe(0);
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("denies when there is no handler or the handler throws", async () => {
    for (const answer of [
      undefined,
      async (): Promise<boolean> => { throw new Error("dialog failed"); },
    ]) {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const machine = await boot({ answer });
      try {
        const { pid, exit } = await machine.host.spawnFromVfs(
          DECLARED, ["credprog", "hold"], { onStarted: () => {} },
        );
        await waitForText(machine, "MARKER");
        expect(await machine.host.getCredentialGrant(pid)).toBe(0);
        machine.host.appendStdinData(pid, line);
        expect(await exit).toBe(0);
        if (answer) {
          expect(errors.mock.calls.some((call) =>
            String(call[0]).includes("onCredentialRequest failed")
          )).toBe(true);
        }
      } finally {
        await machine.host.destroy();
        errors.mockRestore();
      }
    }
  }, 120_000);

  it("never gives a fork child its parent's grant, and never asks for it", async () => {
    const machine = await boot({ answer: async () => true });
    try {
      const { pid, exit } = await machine.host.spawnFromVfs(
        DECLARED, ["credprog", "fork"], { onStarted: () => {} },
      );
      await waitForText(machine, "CHILD");
      const child = pidAfter(machine, "CHILD");
      expect(child).not.toBe(pid);
      expect(await machine.host.getCredentialGrant(pid)).toBeGreaterThan(0);
      expect(await machine.host.getCredentialGrant(child)).toBe(0);
      expect(machine.requests.map((r) => r.pid)).toEqual([pid]);
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("ends the grant on exec and asks again when the same program is exec'd", async () => {
    const machine = await boot({ answer: async () => true });
    try {
      const { pid, exit } = await machine.host.spawnFromVfs(
        DECLARED, ["credprog", "exec", DECLARED_LINK], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER");
      const before = await machine.host.getCredentialGrant(pid);
      expect(before).toBeGreaterThan(0);
      machine.host.appendStdinData(pid, line);
      await waitForText(machine, "MARKER", 2);
      const after = await machine.host.getCredentialGrant(pid);
      expect(after).toBeGreaterThan(0);
      expect(after).not.toBe(before);
      expect(machine.requests.map((r) => [r.pid, r.program, r.argv])).toEqual([
        [pid, DECLARED, ["credprog", "exec", DECLARED_LINK]],
        [pid, DECLARED, ["credprog", "hold"]],
      ]);
      // The second image was held until its own answer too.
      expect(machine.events).toEqual([
        `prompt pid=${pid}`, `answer pid=${pid} true`, `MARKER pid=${pid}`,
        `prompt pid=${pid}`, `answer pid=${pid} true`, `MARKER pid=${pid}`,
      ]);
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("asks for a posix_spawn child, naming its parent chain", async () => {
    const machine = await boot({ answer: async () => true });
    try {
      const { pid, exit } = await machine.host.spawnFromVfs(
        UNDECLARED, ["credparent", "spawn", DECLARED_LINK], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER", 2);
      expect(machine.requests).toHaveLength(1);
      const [request] = machine.requests;
      expect(request.pid).not.toBe(pid);
      expect(request.program).toBe(DECLARED);
      expect(request.parentChain[0]).toEqual({ pid, program: UNDECLARED });
      expect(await machine.host.getCredentialGrant(request.pid)).toBeGreaterThan(0);
      expect(await machine.host.getCredentialGrant(pid)).toBe(0);
      // The child shares the parent's host stdin pipe.
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("starts a launch = continue program at once and grants it on the answer", async () => {
    let release!: (allow: boolean) => void;
    const machine = await boot({
      answer: () => new Promise<boolean>((resolve) => { release = resolve; }),
    });
    try {
      const { pid, exit } = await machine.host.spawnFromVfs(
        CONTINUE, ["credcont", "hold"], { onStarted: () => {} },
      );
      // Runs while the question is still open.
      await waitForText(machine, "MARKER");
      expect(machine.events).toEqual([`prompt pid=${pid}`, `MARKER pid=${pid}`]);
      expect(await machine.host.getCredentialGrant(pid)).toBe(0);
      release(true);
      await expect.poll(() => machine.host.getCredentialGrant(pid), {
        timeout: 10_000,
        interval: 20,
      }).toBeGreaterThan(0);
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("withdraws the question when a held process is killed, and reports its death", async () => {
    let signal: AbortSignal | undefined;
    const machine = await boot({
      answer: (_request, abort) => {
        signal = abort;
        return new Promise<boolean>(() => {});
      },
    });
    try {
      for (const [path, argv] of [
        [DECLARED, ["credprog", "hold"]],
        [UNDECLARED, ["credparent", "spawn", DECLARED]],
      ] as const) {
        signal = undefined;
        machine.requests.length = 0;
        const spawned = machine.host.spawnFromVfs(path, [...argv], { onStarted: () => {} });
        void spawned.catch(() => {});
        await vi.waitFor(() => expect(machine.requests).toHaveLength(1), {
          timeout: 30_000,
          interval: 20,
        });
        const held = machine.requests[0].pid;
        expect(await machine.host.signalProcess(held, 9)).toBe(true);
        await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
          timeout: 30_000,
          interval: 20,
        });
        const { pid, exit } = await spawned;
        if (pid === held) {
          // Root spawn: the host reports the kill as the exit status.
          expect(await exit).toBe(128 + 9);
        } else {
          // posix_spawn child: its parent reaps it and sees SIGKILL.
          expect(await exit).toBe(10);
          expect(machine.stdout()).toContain("SIGNALED sig=9");
        }
        expect(await machine.host.getCredentialGrant(held)).toBeNull();
      }
      expect(machine.stdout()).not.toContain("DONE");
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("withdraws the question when a process held on exec is killed", async () => {
    let signal: AbortSignal | undefined;
    const machine = await boot({
      // The first image is allowed; the image it execs is held for good.
      answer: (_request, abort) => {
        if (machine.requests.length === 1) return Promise.resolve(true);
        signal = abort;
        return new Promise<boolean>(() => {});
      },
    });
    try {
      const { pid, exit } = await machine.host.spawnFromVfs(
        DECLARED, ["credprog", "exec", DECLARED_LINK], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER");
      machine.host.appendStdinData(pid, line);
      await vi.waitFor(() => expect(machine.requests).toHaveLength(2), {
        timeout: 30_000,
        interval: 20,
      });
      expect(machine.requests[1].pid).toBe(pid);
      expect(await machine.host.signalProcess(pid, 9)).toBe(true);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
        timeout: 30_000,
        interval: 20,
      });
      expect(await exit).toBe(128 + 9);
      // The exec'd image never ran an instruction.
      expect(machine.stdout().split("MARKER").length - 1).toBe(1);
      expect(await machine.host.getCredentialGrant(pid)).toBeNull();
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("grants nothing for a launch = continue answer that arrives after exec or exit", async () => {
    const releases: Array<(allow: boolean) => void> = [];
    const machine = await boot({
      answer: () => new Promise<boolean>((resolve) => { releases.push(resolve); }),
    });
    try {
      // Exec: the continue program execs an undeclared one before the
      // answer to its own question arrives.
      const execd = await machine.host.spawnFromVfs(
        CONTINUE, ["credcont", "exec", UNDECLARED], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER");
      machine.host.appendStdinData(execd.pid, line);
      await waitForText(machine, "MARKER", 2);
      releases[0](true);
      // A late grant is set from the answer's own task; give it ample time.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await machine.host.getCredentialGrant(execd.pid)).toBe(0);
      machine.host.appendStdinData(execd.pid, line);
      expect(await execd.exit).toBe(0);

      // Exit: the continue program exits before its answer arrives.
      const exited = await machine.host.spawnFromVfs(
        CONTINUE, ["credcont", "hold"], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER", 3);
      machine.host.appendStdinData(exited.pid, line);
      expect(await exited.exit).toBe(0);
      releases[1](true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await machine.host.getCredentialGrant(exited.pid)).toBeNull();
      expect(machine.requests.map((r) => r.pid)).toEqual([execd.pid, exited.pid]);
      expect(machine.diagnostics).toEqual([]);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("kills a held root-spawned program when its owned job is cancelled", async () => {
    let signal: AbortSignal | undefined;
    const machine = await boot({
      answer: (_request, abort) => {
        signal = abort;
        return new Promise<boolean>(() => {});
      },
    });
    try {
      const spawned = machine.host.spawnFromVfs(
        DECLARED, ["credprog", "hold"],
        { onStarted: () => {}, ownedJob: { id: "held-job", timeoutMs: 0 } },
      );
      void spawned.catch(() => {});
      await vi.waitFor(() => expect(machine.requests).toHaveLength(1), {
        timeout: 30_000,
        interval: 20,
      });
      const held = machine.requests[0].pid;
      const cancelled = await machine.host.readOwnedJob("held-job", undefined, undefined, true);
      expect(cancelled).toMatchObject({ expired: false, pid: held });
      // The cancellation reaches the held process; the question is withdrawn.
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
        timeout: 15_000,
        interval: 20,
      });
      const { pid, exit } = await spawned;
      expect(pid).toBe(held);
      expect(await exit).toBe(128 + 9);
      await vi.waitFor(async () => {
        expect(await machine.host.readOwnedJob("held-job")).toMatchObject({
          status: "cancelled",
          terminationObserved: true,
        });
      }, { timeout: 15_000, interval: 20 });
      expect(machine.stdout()).not.toContain("MARKER");
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("does not hold rootfs exports or other launches on an open question", async () => {
    let release!: (allow: boolean) => void;
    const machine = await boot({
      answer: (request) => request.program === DECLARED
        ? new Promise<boolean>((resolve) => { release = resolve; })
        : Promise.resolve(false),
    });
    try {
      const spawned = machine.host.spawnFromVfs(
        DECLARED, ["credprog", "hold"], { onStarted: () => {} },
      );
      void spawned.catch(() => {});
      await vi.waitFor(() => expect(machine.requests).toHaveLength(1), {
        timeout: 30_000,
        interval: 20,
      });
      // An export does not wait on the user: the held process is a live
      // process, so the export is refused at once.
      const exported = await Promise.race([
        machine.host.exportRootfsImage().then(
          () => "exported",
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
      ]);
      expect(exported).toMatch(/quiescent kernel/);
      // Nor do VFS writes or other launches.
      await machine.host.writeFileToVfs("/etc/held-note", new TextEncoder().encode("x"));
      const other = await machine.host.spawnFromVfs(
        UNDECLARED, ["credparent", "hold"], { onStarted: () => {} },
      );
      await waitForText(machine, `MARKER pid=${other.pid}`);
      machine.host.appendStdinData(other.pid, line);
      expect(await other.exit).toBe(0);

      release(true);
      const { pid, exit } = await spawned;
      await waitForText(machine, `MARKER pid=${pid}`);
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("reads declarations once at boot: a missing directory declares nothing, later writes add nothing", async () => {
    // An empty directory the guest could write into after boot, and none.
    for (const declarations of [{}, null]) {
      const machine = await boot({ answer: async () => true, image: await image(declarations) });
      try {
        if (declarations) {
          await machine.host.writeFileToVfs(
            "/etc/kandelo/credential-requests.d/credprog.json",
            new TextEncoder().encode(declaration(DECLARED, "wait")),
          );
        }
        const { pid, exit } = await machine.host.spawnFromVfs(
          DECLARED, ["credprog", "hold"], { onStarted: () => {} },
        );
        await waitForText(machine, "MARKER");
        expect(await machine.host.getCredentialGrant(pid)).toBe(0);
        machine.host.appendStdinData(pid, line);
        expect(await exit).toBe(0);
        expect(machine.requests).toEqual([]);
      } finally {
        await machine.host.destroy();
      }
    }
  }, 120_000);

  it("flags a declared program whose file changed since the machine booted", async () => {
    const machine = await boot({ answer: async () => false });
    try {
      // Same program, one valid custom section longer: a different file at
      // the declared path, as a guest or a package install could leave it.
      const changed = new Uint8Array(program.length + 7);
      changed.set(program);
      changed.set([0x00, 0x05, 0x04, 0x74, 0x65, 0x73, 0x74], program.length);
      await machine.host.writeFileToVfs(DECLARED, changed, 0o755);
      const { pid, exit } = await machine.host.spawnFromVfs(
        DECLARED_LINK, ["credprog", "hold"], { onStarted: () => {} },
      );
      await waitForText(machine, "MARKER");
      expect(machine.requests).toHaveLength(1);
      expect(machine.requests[0]).toMatchObject({
        pid,
        program: DECLARED,
        programChangedSinceBoot: true,
      });
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);

      // The other declared program's file is the one the image booted with.
      const other = await machine.host.spawnFromVfs(
        CONTINUE, ["credcont", "hold"], { onStarted: () => {} },
      );
      await waitForText(machine, `MARKER pid=${other.pid}`);
      expect(machine.requests[1]).toMatchObject({
        pid: other.pid,
        program: CONTINUE,
        programChangedSinceBoot: false,
      });
      machine.host.appendStdinData(other.pid, line);
      expect(await other.exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("flags an image of a replaced file even after the original is moved back", async () => {
    const machine = await boot({ answer: async () => false });
    try {
      // The guest moves the declared program aside, puts its own file at the
      // declared path and opens it, then moves its file away and the
      // original back before it executes the open file (fexecve). The
      // kernel's rename keeps the original's inode and change time, so the
      // declared path names exactly the file the machine booted with; only
      // the file the kernel retained for the image is the guest's. fexecve
      // makes the order deterministic; a posix_spawn with a sibling moving
      // the file back races to the same state.
      const { pid, exit } = await machine.host.spawnFromVfs(
        UNDECLARED, ["credparent", "swapexec", DECLARED, UNDECLARED], { onStarted: () => {} },
      );
      await waitForText(machine, `MARKER pid=${pid}`, 2);
      expect(machine.requests).toHaveLength(1);
      expect(machine.requests[0]).toMatchObject({
        pid,
        program: DECLARED,
        programChangedSinceBoot: true,
      });
      machine.host.appendStdinData(pid, line);
      expect(await exit).toBe(0);

      // The original, run from its own path again, is the file the image
      // booted with.
      const original = await machine.host.spawnFromVfs(
        DECLARED, ["credprog", "hold"], { onStarted: () => {} },
      );
      await waitForText(machine, `MARKER pid=${original.pid}`);
      expect(machine.requests[1]).toMatchObject({
        pid: original.pid,
        program: DECLARED,
        programChangedSinceBoot: false,
      });
      machine.host.appendStdinData(original.pid, line);
      expect(await original.exit).toBe(0);
    } finally {
      await machine.host.destroy();
    }
  }, 120_000);

  it("keeps at most 8 questions open per machine and denies the rest unasked", async () => {
    // The kernel worker reports each denial on its console, which a Node
    // worker thread pipes to this process's stderr.
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      stderr.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    const machine = await boot({ answer: () => new Promise<boolean>(() => {}) });
    try {
      const launches = Array.from({ length: 10 }, () => {
        const spawned = machine.host.spawnFromVfs(
          DECLARED, ["credprog", "hold"], { onStarted: () => {} },
        );
        void spawned.catch(() => {});
        return spawned;
      });
      // Eight are held on their questions; the ninth and tenth are denied
      // without asking and run.
      await waitForText(machine, "MARKER", 2);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(machine.requests).toHaveLength(8);
      expect(machine.stdout().split("MARKER").length - 1).toBe(2);
      // A launch loop could print a denial line per launch without bound,
      // so the report is rate-limited: the first denial is printed at once,
      // the second is counted and summarized when the interval ends.
      await vi.waitFor(() => {
        expect(stderr.join("").split("questions are already open").length - 1).toBe(1);
      }, { timeout: 10_000, interval: 20 });
      await vi.waitFor(() => {
        expect(stderr.join("")).toContain("1 more declared launch ran without a grant");
      }, { timeout: 15_000, interval: 50 });
      expect(stderr.join("").split("questions are already open").length - 1).toBe(1);
      expect(launches).toHaveLength(10);
    } finally {
      await machine.host.destroy();
      errors.mockRestore();
    }
  }, 120_000);

  it("fails the boot on a malformed declaration", async () => {
    const host = new NodeKernelHost({
      rootfsImage: await image({ "broken.json": "{\"program\": \"relative\"}" }),
    });
    try {
      await expect(
        host.init(new Uint8Array(readFileSync(kernelPath!)).buffer as ArrayBuffer),
      ).rejects.toThrow(/broken\.json/);
    } finally {
      await host.destroy();
    }
  }, 120_000);

  it("denies an open question at teardown without hanging", async () => {
    let signal: AbortSignal | undefined;
    const machine = await boot({
      answer: (_request, abort) => {
        signal = abort;
        return new Promise<boolean>(() => {});
      },
    });
    const spawned = machine.host.spawnFromVfs(
      DECLARED, ["credprog", "hold"], { onStarted: () => {} },
    );
    void spawned.catch(() => {});
    await vi.waitFor(() => expect(machine.requests).toHaveLength(1), {
      timeout: 30_000,
      interval: 20,
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await machine.host.destroy();
    } finally {
      warnings.mockRestore();
    }
    expect(signal?.aborted).toBe(true);
    // The denied launch finished, so the kernel worker's own teardown
    // completed; it was not cut short by the realm-termination fallback.
    await expect(spawned).resolves.toMatchObject({ pid: machine.requests[0].pid });
    expect(machine.diagnostics).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
  }, 120_000);
});

describe("over-cap credential denial report", () => {
  function harness() {
    let now = 0;
    const lines: string[] = [];
    const timers: { at: number; run: () => void }[] = [];
    const report = new OverCapReport((line) => lines.push(line), {
      intervalMs: 5_000,
      now: () => now,
      schedule: (run, delayMs) => {
        const timer = { at: now + delayMs, run };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    };
    return { report, lines, timers, advance };
  }

  it("prints one line per interval and summarizes the denials it held back", () => {
    const { report, lines, advance } = harness();
    report.deny("pid 10 (/usr/bin/codex) runs without a grant");
    for (let pid = 11; pid < 1011; pid++) report.deny(`pid ${pid} (/usr/bin/codex) runs without a grant`);
    expect(lines).toEqual(["pid 10 (/usr/bin/codex) runs without a grant"]);
    advance(5_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/1000 more declared launches ran without a grant/);
    // Quiet after the summary: the next denial waits for the next interval.
    report.deny("pid 2000 (/usr/bin/codex) runs without a grant");
    expect(lines).toHaveLength(2);
    advance(5_000);
    expect(lines[2]).toMatch(/^\[credentials\] 1 more declared launch ran without a grant/);
    // A denial after a quiet interval is printed at once.
    advance(5_000);
    report.deny("pid 3000 (/usr/bin/codex) runs without a grant");
    expect(lines.at(-1)).toBe("pid 3000 (/usr/bin/codex) runs without a grant");
  });

  it("drops a pending summary when the machine closes", () => {
    const { report, lines, timers } = harness();
    report.deny("first");
    report.deny("second");
    expect(timers).toHaveLength(1);
    report.close();
    expect(timers).toHaveLength(0);
    report.deny("after close");
    expect(lines).toEqual(["first"]);
  });
});
