// Wait for the actual read dispatch, rather than sleeping and hoping the
// guest has blocked. The handler writes one byte; SA_RESTART must submit
// the interrupted read again and return that byte to Go.
export async function verifySignalRestart(
  host: {
    signalProcess(pid: number, signal: number): Promise<boolean>;
    subscribeSyscalls(callback: (event: { nr: number; args: (number | bigint)[] }) => void): () => void;
  },
  spawn: (onStdout: (bytes: Uint8Array) => void) => Promise<{ pid: number; exit: Promise<number> }>,
) {
  let stdout = "";
  let pid = 0;
  let fd = -1;
  const reads = new Map<number, number>();
  let readRetried!: () => void;
  const restarted = new Promise<void>(resolve => { readRetried = resolve; });
  let delivery: Promise<boolean> | undefined;
  const signalIfBlocked = () => {
    if (pid && fd >= 0 && reads.has(fd) && !delivery) {
      delivery = host.signalProcess(pid, 12);
      void delivery.catch(() => {});
    }
  };
  const unsubscribe = host.subscribeSyscalls(event => {
    if (event.nr === 3) {
      const currentFd = Number(event.args[0]);
      reads.set(currentFd, (reads.get(currentFd) ?? 0) + 1);
      signalIfBlocked();
      if (fd >= 0 && (reads.get(fd) ?? 0) >= 2) readRetried();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`SA_RESTART probe timed out: ${stdout}`)), 20_000);
  });
  try {
    const guest = await Promise.race([spawn(bytes => {
      stdout += new TextDecoder().decode(bytes);
      const ready = /GO SIGNAL RESTART READY fd=(\d+)/.exec(stdout);
      if (ready) fd = Number(ready[1]);
      signalIfBlocked();
    }), timeout]);
    pid = guest.pid;
    signalIfBlocked();
    const [exitCode] = await Promise.race([Promise.all([guest.exit, restarted]), timeout]);
    if (!delivery || !await delivery || exitCode !== 0 || !stdout.includes("GO SIGNAL RESTART PASS") ||
        (reads.get(fd) ?? 0) < 2) {
      throw new Error(JSON.stringify({ exitCode, stdout, readDispatches: reads.get(fd) }));
    }
    return { exitCode, stdout, readDispatches: reads.get(fd) };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
