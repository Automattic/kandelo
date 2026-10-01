import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost, KernelOwnedJobRead, MachineStatus } from "../kernel-host";
import { ToolError } from "./contract.ts";
import {
  getWebMcpRuntimeCapabilities,
  passwdAccount,
  readGuestFile,
  readGuestJob,
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
  const calls: Calls = { reads: [], writes: [], jobs: [], jobReads: [] };
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
