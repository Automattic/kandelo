export type ShellBootPhase = "seed" | "seed-control" | "legacy" | "upgrade" | "v3" | "verify-entries";

export function savedShellComputer(phase: ShellBootPhase): "original" | "control" {
  return phase === "seed-control" || phase === "legacy" ? "control" : "original";
}

export interface ShellHost {
  getKernelMemoryPages(): Promise<number>;
  getStorageMetadataMemoryUsage(): Promise<unknown>;
  getPersistenceShutdownFailure(): string | null;
  spawn(program: ArrayBuffer, args: string[], options: { uid: number; gid: number }): Promise<number>;
  spawnFromVfs(path: string, args: string[], options: { uid: number; gid: number }): Promise<{ exit: Promise<number> }>;
  destroy(): Promise<void>;
}

interface IoTotals { rootWrites: number; flushes: number; flushMs: number; readCalls: number; bytesRead: number; writeCalls: number; bytesWritten: number }

interface IoCounts extends IoTotals { preparation: IoTotals & { calls: number; ms: number } }

export async function readIo(name: string): Promise<IoCounts> {
  const channel = new BroadcastChannel("kifs-benchmark-" + name);
  try {
    return await new Promise<IoCounts>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No positioned I/O observer for " + name)), 5000);
      channel.onmessage = ({ data }) => { clearTimeout(timeout); resolve(data); };
      channel.postMessage("read");
    });
  } finally { channel.close(); }
}

async function verifyPermissions(
  host: ShellHost,
  diagnostics: { clear: () => void; read: () => string },
) {
  const checks = [
    { uid: 0, script: String.raw`
      mkdir -m 0755 "$1" "$1/guarded"
      printf original > "$1/guarded/file"
      chmod 0600 "$1/guarded/file"
      ln -s guarded "$1/alias"
      mkdir -m 0777 "$1/writable"
    ` },
    { uid: 1142, script: String.raw`
      if : < "$1/guarded/file"; then exit 1; fi
      if printf bad > "$1/guarded/new"; then exit 2; fi
      if printf bad > "$1/alias/new"; then exit 3; fi
      if rm "$1/guarded/file"; then exit 4; fi
      printf allowed > "$1/writable/file"
      rm "$1/writable/file"
    ` },
    { uid: 0, script: String.raw`
      test "$(cat "$1/guarded/file")" = original
      test ! -e "$1/guarded/new"
      test ! -e "$1/writable/file"
      rm -r "$1"
    ` },
  ];
  for (const { uid, script } of checks) {
    diagnostics.clear();
    const process = await host.spawnFromVfs("/bin/bash", [
      "bash", "--noprofile", "--norc", "-ec", script, "permissions", "/home/kifs-permissions",
    ], { uid, gid: uid });
    const status = await process.exit;
    if (status !== 0) throw new Error(`guest permissions check failed for uid ${uid} (${status}): ${diagnostics.read()}`);
  }
}

export async function compareSavedShell(
  program: ArrayBuffer,
  boot: (phase: ShellBootPhase, write: (bytes: Uint8Array) => void) => Promise<ShellHost>,
  diskBytes: (phase: ShellBootPhase) => Promise<number>,
  entries?: number,
  processResidentBytes?: () => number,
  getProfileName?: (phase: ShellBootPhase) => string,
  measureTmpfs = false,
  profileReads = false,
  reverseOrder = false,
) {
  const saved = new Map<"original" | "control", string>();
  let matchingObjects: string | undefined;
  const rounds = [];
  // Seed both computers before timing. The legacy workload mutates its
  // allocation history even though it removes the names it creates.
  const phases: ShellBootPhase[] = reverseOrder
    ? ["seed", "seed-control", "upgrade", "v3", "legacy"]
    : ["seed", "seed-control", "legacy", "upgrade", "v3"];
  if (entries !== undefined) phases.push("verify-entries");
  for (const phase of phases) {
    const seeding = phase === "seed" || phase === "seed-control";
    const profileName = getProfileName?.(phase);
    let output = "";
    const decoder = new TextDecoder();
    const start = performance.now();
    const host = await boot(phase, bytes => { output += decoder.decode(bytes); });
    const bootMs = performance.now() - start;
    const bootPages = await host.getKernelMemoryPages();
    const bootRss = processResidentBytes?.();
    const root = { uid: 0, gid: 0 };
    const run = async (mode: string, ...args: string[]) => {
      output = "";
      const code = await host.spawn(program, ["kifs-capacity", mode, "/home", ...args], root);
      if (code !== 0) throw new Error(`guest ${mode} failed (${code}): ${output}`);
      return output;
    };
    let round;
    try {
      await run(seeding ? "seed-saved" : "check-saved");
      const identity = output.match(/^(saved objects .+?) mtime [0-9.]+$/m);
      const geometry = output.match(/^geometry (\d+) (\d+)$/m);
      const store = savedShellComputer(phase);
      const previous = saved.get(store);
      // Each independently seeded store keeps its own timestamps. Inode
      // numbers and file size must also agree across the two stores.
      if (!identity || !geometry || (matchingObjects !== undefined && identity[1] !== matchingObjects)
          || (!seeding && identity[0] !== previous)) throw new Error("saved shell identities: " + output);
      matchingObjects = identity[1];
      saved.set(store, identity[0]);
      if ((seeding || phase === "legacy") && BigInt(geometry[2]!) === 0n) {
        throw new Error("Expected a fixed inode table in the legacy control: " + output);
      }
      if ((phase === "v3" || phase === "upgrade") && (geometry[1] !== "262144" || geometry[2] !== "0")) {
        throw new Error("unexpected migrated shell geometry: " + output);
      }
      const bash = await host.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-c",
        "test -d /home && test -f /etc/passwd && printf shell-ready"], root);
      if (await bash.exit !== 0 || !output.endsWith("shell-ready")) throw new Error("packaged Bash failed: " + output);
      const samples = [];
      const operationDetails = [];
      const kernelStatNs = [];
      const kernelStatComponents = [];
      if (phase === "legacy" || phase === "v3") {
        // Instrumented runs diagnose I/O. Keep the three timing samples in
        // the uninstrumented comparison independent of the observer cost.
        for (let i = 0; i < (profileName ? 1 : 3); i++) {
          const result = await run("compare");
          const components = result.match(/^kernel-component-ns (\d+) (\d+) (\d+) (\d+)$/m);
          if (components) kernelStatComponents.push(components.slice(1).map(Number));
          const measured = result.match(/^kernel-stat-ns (\d+)$/m);
          if (measured) kernelStatNs.push(Number(measured[1]));
          const details = result.match(/^guest-detail-ns (\d+) (\d+) (\d+) (\d+)$/m);
          if (details) operationDetails.push(details.slice(1).map(Number));
          const match = result.match(/^guest-io-ns (\d+) (\d+) (\d+) (\d+) (\d+)$/m);
          if (!match) throw new Error("missing guest timings: " + output);
          samples.push(match.slice(1).map(Number));
        }
      }
      const tmpfsSamples = [];
      const pathControl = [];
      if (measureTmpfs && (phase === "legacy" || phase === "v3")) {
        for (let i = 0; i < 3; i++) {
          output = "";
          const code = await host.spawn(program, ["kifs-capacity", "compare-tmpfs", "/tmp"], root);
          const match = output.match(/^guest-io-ns (\d+) (\d+) (\d+) (\d+) (\d+)$/m);
          if (code !== 0 || !match) throw new Error("tmpfs comparison failed: " + output);
          tmpfsSamples.push(match.slice(1).map(Number));
          const timing = (await run("profile-path")).match(/^path-control-ns (\d+) (\d+) (\d+)$/m);
          if (!timing) throw new Error("missing syscall control timings: " + output);
          pathControl.push(timing.slice(1).map(Number));
        }
      }
      const profile = [];
      if (profileName && (phase === "legacy" || phase === "v3")) {
        const operations = profileReads
          ? ["empty", "write", "stat", "stream", "sync", "read", "unlink"]
          : ["empty", "write", "stream", "sync", "unlink"];
        for (const op of operations) {
          const before = await readIo(profileName);
          const match = (await run("profile-" + op)).match(/^profile-ns (\d+)$/m);
          if (!match) throw new Error("missing profile timing for " + op);
          const after = await readIo(profileName);
          profile.push({ op, guestMs: Number(match[1]) / 1e6, flushes: after.flushes - before.flushes,
            flushMs: after.flushMs - before.flushMs, writeCalls: after.writeCalls - before.writeCalls,
            readCalls: after.readCalls - before.readCalls, bytesRead: after.bytesRead - before.bytesRead,
            bytesWritten: after.bytesWritten - before.bytesWritten,
            rootWrites: after.rootWrites - before.rootWrites,
            ...(after.preparation.calls !== before.preparation.calls ? { preparation: {
              rootWrites: after.preparation.rootWrites - before.preparation.rootWrites,
              calls: after.preparation.calls - before.preparation.calls,
              ms: after.preparation.ms - before.preparation.ms,
              bytesRead: after.preparation.bytesRead - before.preparation.bytesRead,
              bytesWritten: after.preparation.bytesWritten - before.preparation.bytesWritten,
              flushes: after.preparation.flushes - before.preparation.flushes,
              flushMs: after.preparation.flushMs - before.preparation.flushMs,
            } } : {}) });
        }
      }
      let entryWorkload;
      if (phase === "v3" && entries !== undefined) {
        const started = performance.now();
        const result = await run("entries", String(entries));
        entryWorkload = { elapsedMs: performance.now() - started, result };
      }
      if (phase === "verify-entries") {
        const count = entries!;
        const indexes = new Set([0, Math.min(1, count - 1), Math.floor(count / 2), Math.max(0, count - 2), count - 1]);
        for (const index of indexes) {
          const path = "/home/capacity-test/entry-" + String(index).padStart(8, "0");
          output = "";
          const check = await host.spawnFromVfs("/usr/bin/od", ["od", "-An", "-v", "-tu1", "--", path], root);
          const status = await check.exit;
          if (status !== 0 || output.trim() !== String(index % 256)) {
            throw new Error(`fresh boot could not verify byte ${index % 256} in ${path} (${status}): ${output}`);
          }
        }
      }
      const checkPermissions = phase === "legacy" || phase === "v3";
      if (checkPermissions) await verifyPermissions(host, { clear: () => { output = ""; }, read: () => output });
      round = { phase, bootMs, bootPages, finalPages: await host.getKernelMemoryPages(),
        ...(bootRss === undefined ? {} : { bootRss, finalRss: processResidentBytes!() }),
        transport: await host.getStorageMetadataMemoryUsage(), geometry: geometry.slice(1),
        samples, operationDetails, ...(kernelStatNs.length ? { kernelStatNs } : {}), ...(kernelStatComponents.length ? { kernelStatComponents } : {}), ...(measureTmpfs ? { tmpfsSamples, pathControl } : {}), ...(checkPermissions ? { permissionsVerified: true } : {}), profile, entryWorkload };
    } finally { await host.destroy(); }
    const failure = host.getPersistenceShutdownFailure();
    if (failure !== null) throw new Error(String(failure));
    // Shutdown waits for generation retirement. A live listing can lose a
    // file between reading its directory entry and measuring its size.
    rounds.push({ ...round, physicalBytes: await diskBytes(phase), diskSample: "after-shutdown" });
  }
  return rounds;
}

/** Check one independent, uninstrumented saved computer on its own host. */
export function requireSavedShellSpeedTarget(rounds: Awaited<ReturnType<typeof compareSavedShell>>) {
  const operations = ["create", "random stat", "write and sync", "verified read", "delete"];
  function medians(phase: ShellBootPhase) {
    const round = rounds.find(entry => entry.phase === phase);
    if (!round || round.samples.length !== 3 || round.profile.length || round.tmpfsSamples || round.kernelStatNs || round.kernelStatComponents) {
      throw new Error("Qualification requires three uninstrumented samples per mount");
    }
    return operations.map((_, i) => {
      const values = round.samples.map(sample => sample[i]!);
      if (values.some(ns => !Number.isSafeInteger(ns) || ns <= 0)) throw new Error("Missing guest elapsed time");
      return values.sort((a, b) => a - b)[1]!;
    });
  }
  const legacy = medians("legacy");
  const v3 = medians("v3");
  const failures = operations.flatMap((name, i) => {
    const ratio = v3[i]! / legacy[i]!;
    return ratio <= 0.75 ? [] : [`${name} ${(v3[i]! / 1e6).toFixed(2)} ms / ${(legacy[i]! / 1e6).toFixed(2)} ms = ${ratio.toFixed(3)}×`];
  });
  if (failures.length) throw new Error("KIFS v3 exceeded 75% of v2 elapsed time\n" + failures.join("\n"));
}
