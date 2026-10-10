import type { VfsDirEntrySnapshot } from "../../src/vfs/vfs";

/** Drive actual guest fd and PTY lifetime through the shared host API. */
export async function virtualInspection(
  host: {
    readDirFromVfs(path: string): Promise<VfsDirEntrySnapshot[] | null>;
    spawnFromVfs(path: string, args: string[], options: { pty: boolean }): Promise<{ pid: number; exit: Promise<number> }>;
    ptyWrite(pid: number, data: Uint8Array): void;
  },
  observeOutput: (pid: number, listener: (data: Uint8Array) => void) => void,
) {
  let ready!: () => void;
  let closed!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
  let output = "";
  const root = await host.readDirFromVfs("/");
  const initialPts = await host.readDirFromVfs("/dev/pts");
  const { pid: parentPid, exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-c", [
    "set -e",
    "(",
    "exec 9>/tmp/inspection-open-fd",
    "exec 8<>/dev/ptmx",
    // This produces more metadata than one kernel scratch lease can hold.
    "for ((fd=10; fd<810; fd++)); do eval \"exec $fd>/tmp/inspection-open-fd\"; done",
    "printf 'INSPECTION_READY\\n'",
    "read -r next",
    "exec 9>&-",
    "exec 8>&-",
    "printf 'INSPECTION_CLOSED\\n'",
    "read -r next",
    ") <&0 &",
    "child=$!",
    "printf 'INSPECTION_CHILD=%s\\n' \"$child\"",
    "wait \"$child\"",
  ].join("\n")], { pty: true });
  observeOutput(parentPid, (data) => {
    output += new TextDecoder().decode(data);
    if (output.includes("INSPECTION_READY") && /INSPECTION_CHILD=\d+/.test(output)) ready();
    if (output.includes("INSPECTION_CLOSED")) closed();
  });
  // A premature guest exit must fail the test rather than wait forever.
  const prematureExit = exit.then((status) => { throw new Error(`inspection guest exited early: ${status}; ${output}`); });
  await Promise.race([readyPromise, prematureExit]);
  const pid = Number(/INSPECTION_CHILD=(\d+)/.exec(output)![1]);
  const proc = await host.readDirFromVfs("/proc");
  const process = await host.readDirFromVfs(`/proc/${pid}`);
  const fds = await host.readDirFromVfs(`/proc/${pid}/fd`);
  const fdinfo = await host.readDirFromVfs(`/proc/${pid}/fdinfo`);
  const pts = await host.readDirFromVfs("/dev/pts");
  const dev = await host.readDirFromVfs("/dev");
  const initFds = await host.readDirFromVfs("/proc/self/fd");
  const devFds = await host.readDirFromVfs("/dev/fd");
  const input = await host.readDirFromVfs("/dev/input");
  const dri = await host.readDirFromVfs("/dev/dri");
  const kandelo = await host.readDirFromVfs("/dev/kandelo");
  const shm = await host.readDirFromVfs("/dev/shm");
  host.ptyWrite(parentPid, new TextEncoder().encode("close\n"));
  await Promise.race([closedPromise, prematureExit]);
  const closedFds = await host.readDirFromVfs(`/proc/${pid}/fd`);
  const closedInfo = await host.readDirFromVfs(`/proc/${pid}/fdinfo`);
  const closedPts = await host.readDirFromVfs("/dev/pts");
  host.ptyWrite(parentPid, new TextEncoder().encode("exit\n"));
  const status = await exit;
  // Handle the exit rejection created for the readiness races.
  await prematureExit.catch(() => {});
  const finalProc = await host.readDirFromVfs("/proc");
  const vanished = await host.readDirFromVfs(`/proc/${pid}/fd`);
  const finalPts = await host.readDirFromVfs("/dev/pts");
  return { pid, status, root, initialPts, proc, process, fds, fdinfo, pts, dev, initFds, devFds,
    input, dri, kandelo, shm, closedFds, closedInfo, closedPts, finalProc, vanished, finalPts };
}
