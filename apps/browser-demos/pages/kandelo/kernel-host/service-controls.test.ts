import assert from "node:assert/strict";
import { test } from "node:test";
import { createServiceControls } from "./service-controls";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";

function fixture() {
  const commands: string[] = [];
  const released: string[] = [];
  const declaration = { version: 1, services: [{ id: "web-php", title: "PHP", port: 8080 }] };
  const host = {
    readVfsDir: async () => [{ name: "dinitctl", mode: 0o140600, size: 0, uid: 0, gid: 0 }],
    readVfsFile: async (_path: string, limit?: number) => { assert.equal(limit, 65536); return new TextEncoder().encode(JSON.stringify(declaration)); },
    startOwnedJob: async (_id: string, _program: string, argv: string[], options: { uid?: number }) => { assert.equal(options.uid, 1000); commands.push(argv[2]); },
    readOwnedJob: async () => ({ expired: false, terminationObserved: true, status: "completed", exitCode: 0, next: 1, chunks: [{ stream: "stdout", bytes: new TextEncoder().encode("KANDELO_SERVICES\t1\nweb-php\trunning\tdisabled\n") }] }),
    releaseOwnedJob: async (id: string) => { released.push(id); },
  } as unknown as KernelHost;
  host.captureOwnedJobs = () => ({ closed: () => false, start: host.startOwnedJob.bind(host), read: host.readOwnedJob.bind(host), release: host.releaseOwnedJob.bind(host) });
  return { host, commands, released };
}

test("service controls run as the normal account and read actual versioned reports", async () => {
  const state = fixture();
  const controller = createServiceControls(state.host, { uid: 1000, gid: 1000 }, () => {});
  assert.deepEqual(await controller.list(), [{ id: "web-php", title: "PHP", port: 8080, state: "running", enabled: false }]);
  await controller.change("stop", "web-php");
  assert.deepEqual(state.commands, ["/usr/local/bin/kandelo-service inspect", "/usr/local/bin/kandelo-service stop web-php"]);
  assert.equal(state.released.length, 2);
});

test("service controls reject undeclared targets and stale computer authority before launching", async () => {
  const state = fixture();
  let current = true;
  const controller = createServiceControls(state.host, { uid: 1000 }, () => { if (!current) throw new Error("Computer changed"); });
  await assert.rejects(controller.change("start", "unknown"), /Unknown service/);
  await assert.rejects(controller.change("start", "web-php; echo wrong"), /Unknown service/);
  current = false;
  await assert.rejects(controller.list(), /Computer changed/);
  assert.equal(state.commands.length, 0);
});

test("a computer without service declarations does not spawn an inspection process", async () => {
  const state = fixture();
  state.host.readVfsFile = async () => null;
  assert.deepEqual(await createServiceControls(state.host, {}, () => {}).list(), []);
  assert.equal(state.commands.length, 0);
});

test("service inspection waits for the real supervisor socket before creating a command", async () => {
  const state = fixture();
  state.host.readVfsDir = async () => [];
  const controller = createServiceControls(state.host, {}, () => {});
  await assert.rejects(controller.list(), { name: "ServiceSupervisorStartingError" });
  assert.equal(state.commands.length, 0);
});
