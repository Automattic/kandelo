// Trigger GC only after the actual read is dispatched, then deliver the
// signal. A moving Go stack must preserve the original syscall completion.
export async function verifySignalGC(
  host: {
    appendStdinData(pid: number, bytes: Uint8Array): void;
    signalProcess(pid: number, signal: number): Promise<boolean>;
    subscribeSyscalls(callback: (event: { nr: number; args: (number | bigint)[] }) => void): () => void;
  },
  spawn: (onStdout: (bytes: Uint8Array) => void) => Promise<{ pid: number; exit: Promise<number> }>,
) {
  let stdout = "";
  let changed = () => {};
  const reads = new Map<number, number>();
  const unsubscribe = host.subscribeSyscalls(event => {
    if (event.nr !== 3) return;
    const fd = Number(event.args[0]);
    reads.set(fd, (reads.get(fd) ?? 0) + 1);
    changed();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`signal/GC probe timed out: ${stdout}`)), 30_000);
  });
  try {
    const { pid, exit } = await Promise.race([spawn(bytes => {
      stdout += new TextDecoder().decode(bytes);
      changed();
    }), timeout]);
    const waitFor = async (condition: () => boolean) => {
      while (!condition()) {
        await Promise.race([
          new Promise<void>(resolve => { changed = resolve; }), timeout,
          exit.then(code => { throw new Error(`signal/GC guest exited early: ${code}; ${stdout}`); }),
        ]);
      }
    };
    for (let round = 0; round < 12; round++) {
      const pattern = new RegExp(`GO SIGNAL GC READ round=${round} fd=(\\d+)`);
      await waitFor(() => pattern.test(stdout));
      const fd = Number(pattern.exec(stdout)![1]);
      await waitFor(() => (reads.get(fd) ?? 0) >= round + 1);
      host.appendStdinData(pid, new TextEncoder().encode("g"));
      await waitFor(() => stdout.includes(`GO SIGNAL GC DONE round=${round}\n`));
      if (!await host.signalProcess(pid, 10)) throw new Error("signal/GC target disappeared");
    }
    const exitCode = await Promise.race([exit, timeout]);
    if (exitCode !== 0 || !stdout.includes("GO SIGNAL GC PASS")) {
      throw new Error(JSON.stringify({ exitCode, stdout }));
    }
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
