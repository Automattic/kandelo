import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost, KernelOwnedJobRead, MachineStatus } from "../kernel-host";
import { ToolError } from "./contract.ts";
import {
  announceGuestScript,
  getWebMcpRuntimeCapabilities,
  passwdAccount,
  readGuestFile,
  readGuestJob,
  runGuestScript,
  setWebMcpSession,
  startGuestJob,
  writeGuestFile,
  type WebMcpIdentity,
} from "./runtime.ts";

type Calls = {
  reads: string[];
  writes: Array<[string, Uint8Array, number | undefined, unknown]>;
  jobs: Array<[string, string, string[], unknown]>;
  jobReads: Array<[string, number | undefined, number | undefined, boolean | undefined]>;
  jobReleases: string[];
  announced: Array<[string, string]>;
};

const encoder = new TextEncoder();

const IDENTITY: WebMcpIdentity = { uid: 1000, gid: 1000, env: ["PATH=/bin", "TERM=xterm"] };
const PASSWD = "root:x:0:0:root:/root:/bin/sh\nmaker:x:1000:1000::/home/maker:/bin/bash\n";

const completed: KernelOwnedJobRead = {
  expired: false,
  pid: 7,
  status: "completed",
  exitCode: 0,
  terminationObserved: true,
  chunks: [],
  next: 0,
  hasMore: false,
  truncated: false,
};

function fakeHost(overrides: Partial<KernelHost> = {}) {
  const calls: Calls = { reads: [], writes: [], jobs: [], jobReads: [], jobReleases: [], announced: [] };
  const listeners: Array<(status: MachineStatus) => void> = [];
  let status: MachineStatus = "running";
  const host = {
    getStatus: () => status,
    subscribeStatus: (cb: (status: MachineStatus) => void) => {
      listeners.push(cb);
      return () => {};
    },
    readVfsFile: async (path: string) => {
      if (path === "/etc/passwd") return encoder.encode(PASSWD);
      calls.reads.push(path);
      return encoder.encode("foo\n");
    },
    readVfsDir: async (path: string) => (path === "/bin" ? [{ name: "bash" }, { name: "sh" }] : null),
    writeVfsFile: async (path: string, bytes: Uint8Array, mode?: number, options?: unknown) => {
      calls.writes.push([path, bytes, mode, options]);
    },
    startOwnedJob: async (id: string, program: string, argv: string[], options: unknown) => {
      calls.jobs.push([id, program, argv, options]);
    },
    readOwnedJob: async (id: string, offset?: number, limit?: number, cancel?: boolean) => {
      calls.jobReads.push([id, offset, limit, cancel]);
      return completed;
    },
    releaseOwnedJob: async (id: string) => {
      calls.jobReleases.push(id);
    },
    injectPtyOutput: (path: string, text: string) => {
      calls.announced.push([path, text]);
      return true;
    },
    ...overrides,
  } as unknown as KernelHost;
  const setStatus = (next: MachineStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };
  return { host, calls, setStatus };
}

function attached(overrides: Partial<KernelHost> = {}) {
  const fake = fakeHost(overrides);
  setWebMcpSession(fake.host, IDENTITY);
  return fake;
}

test("an unattached host offers no guest capability", async () => {
  const { host } = fakeHost();
  assert.deepEqual(getWebMcpRuntimeCapabilities(host), {
    readFile: false,
    writeFile: false,
    exclusiveFileCreation: false,
    listFiles: false,
    structuredJobs: false,
    jobCancellation: false,
  });
  await assert.rejects(readGuestFile(host, "/tmp/foo"), (error: ToolError) => error.code === "NOT_READY");
});

test("an attached running host offers every guest capability", () => {
  const { host } = attached();
  assert.deepEqual(getWebMcpRuntimeCapabilities(host), {
    readFile: true,
    writeFile: true,
    exclusiveFileCreation: true,
    listFiles: true,
    structuredJobs: true,
    jobCancellation: true,
  });
});

test("halting the machine detaches the session", () => {
  const { host, setStatus } = attached();
  setStatus("halted");
  assert.equal(getWebMcpRuntimeCapabilities(host).readFile, false);
});

test("reads go through the raw VFS surface and writes belong to the agent's account", async () => {
  const { host, calls } = attached();
  assert.deepEqual(await readGuestFile(host, "/tmp/foo"), encoder.encode("foo\n"));
  assert.deepEqual(calls.reads, ["/tmp/foo"]);

  await writeGuestFile(host, "/tmp/bar", new Uint8Array([1]), false);
  assert.deepEqual(calls.writes[0]?.slice(2), [0o644, { exclusive: true, owner: { uid: 1000, gid: 1000 } }]);
  await writeGuestFile(host, "/tmp/bar", new Uint8Array([1]), true);
  assert.deepEqual(calls.writes[1]?.slice(2), [0o644, { exclusive: false, owner: { uid: 1000, gid: 1000 } }]);
});

test("a missing guest file reports FILE_NOT_FOUND", async () => {
  const { host } = attached({ readVfsFile: async () => null });
  await assert.rejects(readGuestFile(host, "/tmp/foo"), (error: ToolError) => error.code === "FILE_NOT_FOUND");
});

test("an exclusive write onto an existing path reports FILE_EXISTS", async () => {
  const { host } = attached({
    writeVfsFile: async () => { throw new Error("EEXIST: /tmp/foo"); },
  });
  await assert.rejects(
    writeGuestFile(host, "/tmp/foo", new Uint8Array([1]), false),
    (error: ToolError) => error.code === "FILE_EXISTS",
  );
});

test("passwdAccount reads the home and login shell of one uid", () => {
  assert.deepEqual(passwdAccount(PASSWD, 1000), { home: "/home/maker", shell: "/bin/bash" });
  assert.deepEqual(passwdAccount(PASSWD, 0), { home: "/root", shell: "/bin/sh" });
  assert.equal(passwdAccount(PASSWD, 1001), null);
  assert.deepEqual(passwdAccount("qux:x:7:7:::\n", 7), { home: "/", shell: "/bin/sh" });
});

test("a job runs the script through the account's login shell as the agent, at home, with the baseline environment", async () => {
  const { host, calls } = attached();
  await startGuestJob(host, "job-1", { script: "echo hi", env: { FOO: "bar" }, timeoutMs: 1000 });
  assert.deepEqual(calls.jobs, [[
    "job-1",
    "/bin/bash",
    ["bash", "-c", "echo hi"],
    { cwd: "/home/maker", env: ["PATH=/bin", "TERM=xterm", "HOME=/home/maker", "FOO=bar"], uid: 1000, gid: 1000, timeoutMs: 1000 },
  ]]);
});

test("the caller's cwd and environment override the account's", async () => {
  const { host, calls } = attached();
  await startGuestJob(host, "job-1", { script: "true", cwd: "/tmp", env: { HOME: "/tmp", PATH: "/usr/bin" } });
  assert.deepEqual(calls.jobs[0]?.[3], {
    cwd: "/tmp",
    env: ["PATH=/usr/bin", "TERM=xterm", "HOME=/tmp"],
    uid: 1000,
    gid: 1000,
    timeoutMs: 30000,
  });
});

test("an image that lists no account for the agent gets /bin/sh at /", async () => {
  const { host, calls } = attached({ readVfsFile: async () => null });
  await startGuestJob(host, "job-1", { script: "true" });
  assert.equal(calls.jobs[0]?.[1], "/bin/sh");
  assert.deepEqual(calls.jobs[0]?.[2], ["sh", "-c", "true"]);
  assert.deepEqual(calls.jobs[0]?.[3], { cwd: "/", env: ["PATH=/bin", "TERM=xterm", "HOME=/"], uid: 1000, gid: 1000, timeoutMs: 30000 });
});

test("a login shell the image does not hold falls back to /bin/sh at the account's home", async () => {
  const { host, calls } = attached({ readVfsDir: async () => [{ name: "sh" }] } as Partial<KernelHost>);
  await startGuestJob(host, "job-1", { script: "true" });
  assert.equal(calls.jobs[0]?.[1], "/bin/sh");
  assert.deepEqual(calls.jobs[0]?.[2], ["sh", "-c", "true"]);
  assert.equal((calls.jobs[0]?.[3] as { cwd: string }).cwd, "/home/maker");
});

test("a job refuses a NUL in its script or environment", async () => {
  const { host, calls } = attached();
  await assert.rejects(
    startGuestJob(host, "job-1", { script: "echo \0" }),
    (error: ToolError) => error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    startGuestJob(host, "job-1", { script: "echo hi", env: { FOO: "\0" } }),
    (error: ToolError) => error.code === "INVALID_ARGUMENT",
  );
  assert.deepEqual(calls.jobs, []);
});

test("a job read forwards the cursor and the cancel flag", async () => {
  const { host, calls } = attached();
  assert.deepEqual(await readGuestJob(host, "job-1", 16, 64, true), completed);
  assert.deepEqual(calls.jobReads, [["job-1", 16, 64, true]]);
});

test("attaching a new session invalidates the previous one", async () => {
  const { host } = attached();
  const first = readGuestJob(host, "job-1");
  setWebMcpSession(host, IDENTITY);
  await assert.rejects(first, (error: ToolError) => error.code === "STALE_SESSION");
});

test("a machine that changed under an operation reports STALE_SESSION", async () => {
  let detach = () => {};
  const fake = fakeHost({
    readVfsFile: async () => { detach(); return new Uint8Array(); },
  });
  setWebMcpSession(fake.host, IDENTITY);
  detach = () => setWebMcpSession(fake.host, null);
  await assert.rejects(
    readGuestFile(fake.host, "/tmp/foo"),
    (error: ToolError) => error.code === "STALE_SESSION",
  );
});

test("a session releases its oldest finished jobs before starting a new one", async () => {
  const { host, calls } = attached();
  for (let index = 0; index < 32; index++) {
    await startGuestJob(host, `job-${index}`, { script: "true" });
  }
  assert.deepEqual(calls.jobReleases, []);
  for (let index = 32; index < 35; index++) {
    await startGuestJob(host, `job-${index}`, { script: "true" });
  }
  assert.deepEqual(calls.jobReleases, ["job-0", "job-1"]);
  assert.equal(calls.jobs.length, 35);
});

test("a job that is still running does not hold back the finished jobs behind it", async () => {
  const released: string[] = [];
  const { host, calls } = attached({
    releaseOwnedJob: async (id: string) => {
      if (id === "job-0") throw new Error("JOB_RUNNING");
      released.push(id);
    },
  });
  for (let index = 0; index < 40; index++) {
    await startGuestJob(host, `job-${index}`, { script: "true" });
  }
  assert.equal(calls.jobs.length, 40);
  assert.deepEqual(released, ["job-1", "job-2", "job-3", "job-4", "job-5", "job-6"]);
});

test("two jobs started at once release each finished job exactly once", async () => {
  const kernel = new Set<string>();
  const { host } = attached({
    startOwnedJob: async (id: string) => { kernel.add(id); },
    releaseOwnedJob: async (id: string) => {
      await Promise.resolve();
      if (!kernel.delete(id)) throw new Error("UNKNOWN_JOB");
    },
  });
  for (let index = 0; index < 33; index++) {
    await startGuestJob(host, `job-${index}`, { script: "true" });
  }
  await Promise.all([startGuestJob(host, "job-33", { script: "true" }), startGuestJob(host, "job-34", { script: "true" })]);
  await startGuestJob(host, "job-35", { script: "true" });
  assert.deepEqual([...kernel].sort(), Array.from({ length: 33 }, (_, index) => `job-${index + 3}`).sort());
});

test("a released job that the kernel no longer knows does not block the ones behind it", async () => {
  const attempts: string[] = [];
  const { host } = attached({
    releaseOwnedJob: async (id: string) => {
      attempts.push(id);
      if (id === "job-0") throw new Error("UNKNOWN_JOB");
    },
  });
  for (let index = 0; index < 36; index++) {
    await startGuestJob(host, `job-${index}`, { script: "true" });
  }
  assert.deepEqual(attempts, ["job-0", "job-1", "job-2"]);
});

test("a script run to completion collects both streams across reads and releases its job", async () => {
  const reads: KernelOwnedJobRead[] = [
    { ...completed, status: "running", exitCode: null, terminationObserved: false, chunks: [{ stream: "stdout", bytes: encoder.encode("3.") }], next: 2, hasMore: true },
    { ...completed, status: "running", exitCode: null, terminationObserved: false, chunks: [{ stream: "stderr", bytes: encoder.encode("warn\n") }], next: 7, hasMore: false },
    { ...completed, chunks: [{ stream: "stdout", bytes: encoder.encode("14\n") }], next: 10 },
  ];
  const { host, calls } = attached({ readOwnedJob: async () => reads.shift() ?? completed });

  const result = await runGuestScript(host, "echo 3.14", { timeoutMs: 1000 });

  assert.deepEqual(result, { stdout: "3.14\n", stderr: "warn\n", exitCode: 0, status: "completed", terminationObserved: true, truncated: false });
  assert.equal(calls.jobs.length, 1);
  assert.deepEqual(calls.jobReleases, [calls.jobs[0]![0]]);
});

test("a script that prints without end keeps its last 256 KiB of output", async () => {
  let reads = 0;
  const { host } = attached({
    readOwnedJob: async () => {
      reads += 1;
      const bytes = new Uint8Array(65536).fill(reads === 5 ? 0x62 : 0x61);
      return { ...completed, chunks: [{ stream: "stdout", bytes }], next: reads * 65536, hasMore: reads < 5 };
    },
  });

  const result = await runGuestScript(host, "yes", { timeoutMs: 1000 });

  assert.equal(result.stdout.length, 4 * 65536);
  assert.ok(result.stdout.endsWith("b".repeat(65536)));
  assert.equal(result.truncated, true);
});

test("a script whose call is aborted is cancelled once and still released", async () => {
  const controller = new AbortController();
  const cancels: boolean[] = [];
  let polls = 0;
  const { host, calls } = attached({
    readOwnedJob: async (_id: string, _offset?: number, _limit?: number, cancel?: boolean) => {
      cancels.push(Boolean(cancel));
      polls += 1;
      if (polls === 1) controller.abort();
      if (polls < 3) return { ...completed, status: "running", exitCode: null, terminationObserved: false };
      return { ...completed, status: "cancelled", exitCode: 137 };
    },
  });

  const result = await runGuestScript(host, "sleep 60", { timeoutMs: 1000, signal: controller.signal });

  assert.deepEqual(cancels, [false, true, false]);
  assert.equal(result.status, "cancelled");
  assert.equal(calls.jobReleases.length, 1);
});

test("a script announces its first line on the terminal without sending input", () => {
  const { host, calls } = attached();
  announceGuestScript(host, "/dev/pts/1", "echo hi\nls\n");
  announceGuestScript(host, null, "echo hi");
  assert.deepEqual(calls.announced, [["/dev/pts/1", "\r\n\x1b[2m[agent] echo hi ...\x1b[0m\r\n"]]);
});
