// Shared Node/browser assertion: hold a request open until SIGTERM reaches
// Go, then require both a complete HTTP response and normal server exit.
export async function verifyHttpSignalDrain(
  host: {
    signalProcess(pid: number, signal: number): Promise<boolean>;
    fetchInKernel(port: number, request: {
      method: string; url: string; headers: Record<string, string>; body: null;
    }, options: { timeoutMs: number }): Promise<{ status: number; body: Uint8Array }>;
  },
  spawn: (onStdout: (bytes: Uint8Array) => void) => Promise<{ pid: number; exit: Promise<number> }>,
) {
  let stdout = "";
  let changed = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`HTTP signal drain timed out: ${stdout}`)), 20_000);
  });
  try {
    const { pid, exit } = await Promise.race([spawn(bytes => {
      stdout += new TextDecoder().decode(bytes);
      changed();
    }), timeout]);
    const waitForOutput = async (marker: string) => {
      while (!stdout.includes(marker)) {
        await Promise.race([
          new Promise<void>(resolve => { changed = resolve; }),
          exit.then(code => { throw new Error(`guest exited before ${marker}: ${code}; ${stdout}`); }),
          timeout,
        ]);
      }
    };
    await waitForOutput("GO SIGNAL HTTP READY");
    const response = host.fetchInKernel(8080, {
      method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null,
    }, { timeoutMs: 15_000 });
    // Attach the rejection handler immediately, before waiting for stdout.
    const completed = response.then(async result => ({ result, exitCode: await exit }));
    void completed.catch(() => {});
    await waitForOutput("GO SIGNAL REQUEST STARTED");
    if (!await host.signalProcess(pid, 15)) throw new Error("SIGTERM target disappeared");
    const { result, exitCode } = await Promise.race([completed, timeout]);
    const body = new TextDecoder().decode(result.body);
    if (exitCode !== 0 || result.status !== 200 || body !== "request completed during shutdown\n" ||
        !stdout.includes("GO SIGNAL TERM RECEIVED") || !stdout.includes("GO SIGNAL HTTP DRAIN PASS")) {
      throw new Error(JSON.stringify({ exitCode, status: result.status, body, stdout }));
    }
    return { exitCode, status: result.status, body, stdout };
  } finally { clearTimeout(timer); }
}
