import { readIo, savedShellComputer, type ShellBootPhase, type ShellHost } from "./kifs-saved-shell-workload";

export async function compareWarmSavedStat(
  program: ArrayBuffer,
  boot: (phase: ShellBootPhase, write: (bytes: Uint8Array) => void) => Promise<ShellHost>,
  reverseOrder: boolean,
  observerName?: (phase: ShellBootPhase) => string,
) {
  const mounted: ShellHost[] = [];
  const saved = new Map<string, string>();
  const savedIdentity = /^saved objects .+? mtime [0-9.]+$/m;

  const open = async (phase: ShellBootPhase) => {
    let output = "";
    const decoder = new TextDecoder();
    const host = await boot(phase, bytes => { output += decoder.decode(bytes); });
    mounted.push(host);
    return {
      host,
      async run(mode: string, ...args: string[]) {
        output = "";
        const code = await host.spawn(program, ["kifs-capacity", mode, "/home", ...args], { uid: 0, gid: 0 });
        if (code !== 0) throw new Error(`guest ${mode} failed (${code}): ${output}`);
        return output;
      },
    };
  };

  const close = async (host: ShellHost) => {
    await host.destroy();
    const failure = host.getPersistenceShutdownFailure();
    if (failure !== null) throw new Error(failure);
  };

  try {
    for (const phase of ["seed", "seed-control", "upgrade"] as const) {
      const computer = await open(phase);
      const seeding = phase !== "upgrade";
      const output = await computer.run(seeding ? "seed-saved" : "check-saved");
      const identity = output.match(savedIdentity)?.[0];
      const id = savedShellComputer(phase);
      if (!identity || (!seeding && identity !== saved.get(id))) throw new Error("saved stat identities: " + output);
      if (seeding) {
        saved.set(id, identity);
        await computer.run("seed-stat");
      }
      await close(computer.host);
      mounted.pop();
    }

    const phases = reverseOrder ? ["v3", "legacy"] as const : ["legacy", "v3"] as const;
    const computers = new Map<"legacy" | "v3", Awaited<ReturnType<typeof open>>>();
    for (const phase of phases) {
      const computer = await open(phase);
      const check = await computer.run("check-saved");
      const identity = saved.get(savedShellComputer(phase));
      const geometry = check.match(/^geometry (\d+) (\d+)$/m);
      if (identity === undefined || check.match(savedIdentity)?.[0] !== identity || !geometry ||
          (phase === "v3" ? geometry[1] !== "262144" || geometry[2] !== "0" : geometry[2] === "0")) {
        throw new Error("unexpected saved stat filesystem: " + check);
      }
      computers.set(phase, computer);
    }

    const widths = [128, 512];
    const samples = [];
    const pageCounts = async () => Promise.all(phases.map(async phase => [phase, await computers.get(phase)!.host.getKernelMemoryPages()] as const));
    const bootPages = Object.fromEntries(await pageCounts());
    for (const width of widths) {
      for (const phase of phases) await computers.get(phase)!.run("warm-stat", String(width), "314159", "0");
      for (let round = 0; round < 8; round++) {
        const order = round % 2 === 0 ? phases : [...phases].reverse();
        let checksum: string | undefined;
        for (const phase of order) {
          const observer = observerName?.(phase);
          const before = observer === undefined ? undefined : await readIo(observer);
          const output = await computers.get(phase)!.run("warm-stat", String(width), String(314159 + round), String(round % 3));
          const match = output.match(/^warm-stat (\d+) (\d+) (\d+) (\d+)$/m);
          if (!match || (checksum !== undefined && match[1] !== checksum)) throw new Error("mismatched warm stat result: " + output);
          checksum = match[1];
          const after = observer === undefined ? undefined : await readIo(observer);
          samples.push({ width, round, phase, checksum, ns: match.slice(2).map(Number),
            ...(before && after ? { readCalls: after.readCalls - before.readCalls,
              bytesRead: after.bytesRead - before.bytesRead, writes: after.writeCalls - before.writeCalls } : {}),
          });
        }
      }
    }
    return { phases, samples, bootPages, finalPages: Object.fromEntries(await pageCounts()) };
  } finally {
    const outcomes = await Promise.allSettled(mounted.map(close));
    const failed = outcomes.find(result => result.status === "rejected");
    if (failed !== undefined && failed.status === "rejected") throw failed.reason;
  }
}
