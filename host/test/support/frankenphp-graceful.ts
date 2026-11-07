import { ABI_SYSCALLS } from "../../src/generated/abi";

// Keep a real PHP request open until SIGTERM closes the listening socket.
// Then require its complete response before normal server/service exit.
export function observeProcessExits() {
  const exits = new Map<number, number>();
  const pending = new Map<number, (status: number) => void>();
  return {
    onEvent(event: { kind: string; pid: number; exitStatus?: number }) {
      if (event.kind !== "exit" || event.exitStatus === undefined) return;
      exits.set(event.pid, event.exitStatus);
      pending.get(event.pid)?.(event.exitStatus);
      pending.delete(event.pid);
    },
    waitForExit(pid: number): Promise<number> {
      const status = exits.get(pid);
      if (status !== undefined) return Promise.resolve(status);
      return new Promise(resolve => pending.set(pid, resolve));
    },
  };
}

interface ShutdownHost {
  pickListenerTarget(port: number): Promise<{ pid: number; fd: number } | null>;
  writeFileToVfs(path: string, bytes: Uint8Array): Promise<void>;
  subscribeVfsChanges(prefix: string, callback: (event: { path: string }) => void): () => void;
  subscribeSyscalls(callback: (event: { nr: number; args: (number | bigint)[] }) => void): () => void;
  spawnFromVfs(path: string, argv: string[]): Promise<{ pid: number; exit: Promise<number> }>;
  fetchInKernel(port: number, request: {
    method: string; url: string; headers: Record<string, string>; body: null;
  }, options: { timeoutMs: number }): Promise<{ status: number; body: Uint8Array }>;
}

export async function verifyFrankenPhpGracefulShutdown(
  host: ShutdownHost,
  port: number,
  waitForExit: (pid: number) => Promise<number>,
  service: "frankenphp-classic" | "frankenphp-caddy" = "frankenphp-caddy",
) {
  const listener = await host.pickListenerTarget(port);
  if (!listener) throw new Error(`${service} listener missing before graceful shutdown`);
  const startedPath = "/tmp/kandelo-php-shutdown-started";
  const releasePath = "/tmp/kandelo-php-shutdown-release";
  const scriptPath = "/srv/www/html/__kandelo_shutdown_probe.php";
  const body = "PHP request completed during shutdown\n";
  await host.writeFileToVfs(scriptPath, new TextEncoder().encode(`<?php
file_put_contents('${startedPath}', '1');
$deadline = microtime(true) + 20;
while (true) {
    clearstatcache(true, '${releasePath}');
    if (file_exists('${releasePath}')) break;
    if (microtime(true) > $deadline) {
        http_response_code(504);
        exit('shutdown probe release timed out');
    }
    usleep(10000);
}
echo ${JSON.stringify(body)};
`));
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let signaled!: () => void;
  const signalSent = new Promise<void>(resolve => { signaled = resolve; });
  let signalObserved = false;
  let closed!: () => void;
  let closeFailed!: (error: unknown) => void;
  const listenerClosed = new Promise<void>((resolve, reject) => {
    closed = resolve;
    closeFailed = reject;
  });
  // Register a rejection handler before an asynchronous trace callback can fail.
  void listenerClosed.catch(() => {});
  const unwatch = host.subscribeVfsChanges(startedPath, event => {
    if (event.path === startedPath) started();
  });
  const untrace = host.subscribeSyscalls(event => {
    if (event.nr === ABI_SYSCALLS.Kill && Math.abs(Number(event.args[0])) === listener.pid && Number(event.args[1]) === 15) {
      signalObserved = true;
      signaled();
    }
    if (signalObserved && event.nr === ABI_SYSCALLS.Close) {
      // Trace entries record dispatch, not completion. Observe Rust's actual
      // listener table after a close; the server may own duplicate descriptors.
      void host.pickListenerTarget(port).then(target => {
        if (!target) closed();
      }, closeFailed);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage = "starting PHP request";
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${service}/PHP shutdown timed out: ${stage}`)), 30_000);
  });
  try {
    const response = host.fetchInKernel(port, {
      method: "GET", url: "/__kandelo_shutdown_probe.php",
      headers: { Host: `localhost:${port}` }, body: null,
    }, { timeoutMs: 25_000 });
    void response.catch(() => {});
    await Promise.race([
      requestStarted, timeout,
      response.then(result => { throw new Error(`PHP request finished before SIGTERM: ${result.status}`); }),
    ]);
    stage = "waiting for service SIGTERM";
    const stop = await Promise.race([host.spawnFromVfs("/usr/bin/kandelo-service", [
      "kandelo-service", "stop", service,
    ]), timeout]);
    await Promise.race([
      signalSent, timeout,
      stop.exit.then(code => { throw new Error(`service stop finished before SIGTERM: ${code}`); }),
    ]);
    stage = "waiting for listener shutdown with PHP still active";
    await Promise.race([
      listenerClosed, timeout,
      response.then(result => { throw new Error(`PHP finished before listener shutdown: ${result.status}`); }),
      stop.exit.then(code => { throw new Error(`service stopped before PHP was released: ${code}`); }),
    ]);
    stage = "draining PHP and stopping the server";
    await Promise.race([host.writeFileToVfs(releasePath, new Uint8Array([1])), timeout]);
    const [result, serverExit, stopExit] = await Promise.race([
      Promise.all([response, waitForExit(listener.pid), stop.exit]), timeout,
    ]);
    const responseBody = new TextDecoder().decode(result.body);
    if (result.status !== 200 || responseBody !== body || serverExit !== 0 || stopExit !== 0) {
      throw new Error(JSON.stringify({ status: result.status, responseBody, serverExit, stopExit }));
    }
    return { serverPid: listener.pid, listenerClosed: true, status: result.status, responseBody, serverExit, stopExit };
  } finally {
    clearTimeout(timer);
    unwatch();
    untrace();
  }
}
