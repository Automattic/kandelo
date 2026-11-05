import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PACKAGE_MAINTENANCE_WIRE as wire } from "../src/generated/abi";
import { PackageMaintenanceSession } from "../../apps/browser-demos/pages/kandelo/kernel-host/package-maintenance-session";
import { assertPersistentImageBootMetadata } from "../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-boot-metadata";

const state = vi.hoisted(() => ({ record: null as string | null, writes: 0, failWrite: false }));

vi.mock("../src/browser-computer-storage", () => ({
  browserComputerDirectory: async () => ({ getDirectoryHandle: async () => software }),
}));

vi.mock("../../apps/browser-demos/lib/kernel-owned-boot", () => ({}));

import {
  INSTALLED_INVENTORY_PATH, bootCompositionMatchesInstalled, promoteBootConfiguration, readBootConfigurations,
  prepareBootConfiguration, selectBootComposition,
} from "../../apps/browser-demos/pages/kandelo/kernel-host/package-boot-configuration";
import { KANDELO_DEMO_CONFIG_PATH } from "../../web-libs/kandelo-session/src/demo-config";
import { EXPERIMENTAL_TERMINAL_SESSION_PATH } from "../../web-libs/kandelo-session/src/experimental-terminal-session";

const software = {
  getFileHandle: async (_name: string, options?: { create?: boolean }) => {
    if (state.record === null && options?.create !== true) throw new DOMException("missing", "NotFoundError");
    return {
      getFile: async () => {
        const bytes = new TextEncoder().encode(state.record ?? "");
        return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
      },
      createWritable: async () => {
        let next = "";
        return {
          write: async (bytes: Uint8Array) => { next = new TextDecoder().decode(bytes); },
          close: async () => {
            if (state.failWrite) throw new Error("publication failed");
            state.record = next; state.writes++;
          },
          abort: async () => {},
        };
      },
    };
  },
};

const encoder = new TextEncoder();
const session = { kind: "kandelo-experimental-terminal-session", version: 1,
  initial: { path: "/bin/sh", argv: ["sh"], uid: 0, gid: 0 } };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const config = (title: string, target: string) => ({
  version: 1, profiles: { site: { title, init: { target } } },
});
function composition(title: string, target: string, services: string[]) {
  return { imageConfig: config(title, target), profileId: "site", terminalSession: session, requiredServices: services };
}

function reader(files: Record<string, Uint8Array>) {
  return { readFileRangeFromVfs: async (path: string, offset: number, length: number) => {
    const bytes = files[path];
    return bytes === undefined ? null : bytes.slice(offset, offset + length);
  } };
}

function source(files: Record<string, Uint8Array>, inventory: Uint8Array) {
  return {
    inventoryBytes: inventory.length,
    readInventory: async (offset: number, length: number) => inventory.slice(offset, offset + length),
    readFile: async (path: string, offset: number, length: number) => {
      const bytes = files[path];
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return bytes.slice(offset, offset + length);
    },
  };
}

const oldInventory = encoder.encode("old inventory");
const newInventory = encoder.encode("new inventory");
const base = composition("Old", "boot", ["boot"]);
const upgraded = composition("New", "web", ["web", "db"]);
const liveOld = { [INSTALLED_INVENTORY_PATH]: oldInventory };
const target = {
  [KANDELO_DEMO_CONFIG_PATH]: encoder.encode(JSON.stringify(upgraded.imageConfig)),
  [EXPERIMENTAL_TERMINAL_SESSION_PATH]: encoder.encode(JSON.stringify(session)),
  "/etc/dinit.d/web": encoder.encode("type = process\ndepends-on = db\n"),
  "/etc/dinit.d/db": encoder.encode("type = process\n"),
};
const computer = "11111111-1111-4111-8111-111111111111";

async function recordBootConfiguration(...args: Parameters<typeof prepareBootConfiguration>) {
  await (await prepareBootConfiguration(...args))();
}

afterEach(() => { state.record = null; state.writes = 0; state.failWrite = false; });

describe("boot configuration of upgraded computers", () => {
  it("records the verified target's configuration for both sides of the transaction", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const saved = await readBootConfigurations(computer);
    expect(saved.map(entry => entry.inventorySha256)).toEqual([sha256(oldInventory), sha256(newInventory)]);
    expect(saved[0].composition).toEqual(base);
    expect(saved[1].composition.imageConfig).toEqual(upgraded.imageConfig);
    expect(saved[1].composition.profileId).toBe("site");
    expect(new Set(saved[1].composition.requiredServices)).toEqual(new Set(["web", "db"]));
  });

  it("validates a candidate without changing the installed or rollback records", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const before = state.record;
    await prepareBootConfiguration(computer, reader({ [INSTALLED_INVENTORY_PATH]: newInventory }),
      base as never, source(target, encoder.encode("unaccepted candidate")));
    expect(state.record).toBe(before);
    expect(state.writes).toBe(1);
  });

  it("selects by the replayed inventory, never by which record is newest", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const saved = await readBootConfigurations(computer);
    expect(await selectBootComposition(reader({ [INSTALLED_INVENTORY_PATH]: newInventory }), saved, base as never))
      .toEqual(saved[1].composition);
    expect(await selectBootComposition(reader(liveOld), saved, base as never)).toEqual(base);
  });

  it("keeps the immutable base authority when a guest rewrites the inventory", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const saved = await readBootConfigurations(computer);
    const forged = reader({ [INSTALLED_INVENTORY_PATH]: encoder.encode("guest edit") });
    expect(await selectBootComposition(forged, saved, base as never)).toEqual(base);
    expect(await selectBootComposition(reader({}), saved, base as never)).toEqual(base);
  });

  it("carries the installed record forward across a later update and retains one rollback target", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const third = encoder.encode("third inventory");
    await recordBootConfiguration(computer, reader({ [INSTALLED_INVENTORY_PATH]: newInventory }), base as never, source(target, third));
    const saved = await readBootConfigurations(computer);
    expect(saved.map(entry => entry.inventorySha256)).toEqual([sha256(newInventory), sha256(third)]);
    expect(saved[0].composition.imageConfig).toEqual(upgraded.imageConfig);
  });

  it("refuses a target that no longer declares the computer's profile before any native work", async () => {
    const renamed = { ...target, [KANDELO_DEMO_CONFIG_PATH]: encoder.encode(JSON.stringify({
      version: 1, profiles: { other: { title: "x", init: { target: "web" } } } })) };
    await expect(recordBootConfiguration(computer, reader(liveOld), base as never, source(renamed, newInventory)))
      .rejects.toThrow(/does not declare/);
    expect(state.writes).toBe(0);
  });

  it("refuses a target whose record later boots could not read", async () => {
    const services = Array.from({ length: 65 }, (_, index) => `s${index}`);
    const wide = { ...target, "/etc/dinit.d/web": encoder.encode(`type = process\n${services.map(name => `depends-on = ${name}`).join("\n")}\n`),
      ...Object.fromEntries(services.map(name => [`/etc/dinit.d/${name}`, encoder.encode("type = process\n")])) };
    await expect(recordBootConfiguration(computer, reader(liveOld), base as never, source(wide, newInventory))).rejects.toThrow();
    expect(state.writes).toBe(0);
  });

  it("refuses an installed set it cannot read rather than recording a rollback guess", async () => {
    await expect(recordBootConfiguration(computer, reader({}), base as never, source(target, newInventory)))
      .rejects.toThrow(/installed software inventory/);
    expect(state.record).toBeNull();
  });

  it("treats a computer that was never upgraded as having no records", async () => {
    await expect(readBootConfigurations(computer)).resolves.toEqual([]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an unknown version", JSON.stringify({ version: 2, entries: [] })],
    ["too many records", JSON.stringify({ version: 1, entries: [1, 2, 3] })],
    ["a non-hex digest", JSON.stringify({ version: 1, entries: [{ inventorySha256: "x", composition: {} }] })],
  ])("refuses %s instead of silently using the base configuration", async (_label, record) => {
    state.record = record;
    await expect(readBootConfigurations(computer)).rejects.toThrow(/boot configuration/i);
  });

  it("refuses an oversized record before reading its body", async () => {
    state.record = " ".repeat(2 * 1024 * 1024);
    await expect(readBootConfigurations(computer)).rejects.toThrow(/exceeds its bound/);
  });

  it("moves the installed record last so the next boot assumes it", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    await promoteBootConfiguration(computer, sha256(oldInventory));
    const saved = await readBootConfigurations(computer);
    expect(saved.at(-1)!.inventorySha256).toBe(sha256(oldInventory));
    expect(saved).toHaveLength(2);
  });

  it("reports whether the assumed configuration is the installed one", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const saved = await readBootConfigurations(computer);
    expect(bootCompositionMatchesInstalled(saved[1].composition, saved[1].composition)).toBe(true);
    expect(bootCompositionMatchesInstalled(saved[0].composition, saved[1].composition)).toBe(false);
  });

  it("leaves the earlier record intact when publication fails", async () => {
    await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, newInventory));
    const before = state.record;
    state.failWrite = true;
    await expect(promoteBootConfiguration(computer, sha256(oldInventory))).rejects.toThrow("publication failed");
    expect(state.record).toBe(before);
  });
});

it("preserves a previous non-base rollback's boot settings after an install is refused", async () => {
  const B = newInventory;
  const C = encoder.encode("release C inventory");
  const filesFor = (title: string, service: string) => ({
    ...target,
    [KANDELO_DEMO_CONFIG_PATH]: encoder.encode(JSON.stringify(config(title, service))),
    [`/etc/dinit.d/${service}`]: encoder.encode("type = process\n"),
  });
  await recordBootConfiguration(computer, reader(liveOld), base as never, source(target, B));
  await recordBootConfiguration(computer, reader({ [INSTALLED_INVENTORY_PATH]: B }), base as never,
    source(filesFor("C", "service-c"), C));
  const actions: string[] = [];
  const progress = new Uint8Array(wire.PROGRESS_HEADER_BYTES);
  const data = new DataView(progress.buffer);
  data.setUint32(wire.PROGRESS_VERSION_OFFSET, wire.VERSION, true);
  data.setUint32(wire.PROGRESS_PHASE_OFFSET, wire.PHASE_PENDING, true);
  data.setUint32(wire.PROGRESS_FILE_COUNT_OFFSET, 1, true);
  const runtime = { packageMaintenance: async (request: { action: string; offset?: number; data?: Uint8Array }) => {
    actions.push(request.action);
    if (request.action === "verifyInstalled") return { status: -17, errorKind: wire.ERROR_COLLISION, data: new Uint8Array() };
    return { status: request.action === "recovery" ? wire.RECOVERY_ACTIVE
      : request.action === "uploadInventory" ? (request.offset ?? 0) + (request.data?.length ?? 0) : 0,
      errorKind: 0, data: request.action === "progress" ? progress : new Uint8Array() };
  } };
  const session = await PackageMaintenanceSession.open(runtime, () => {});
  const before = state.record;
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = source(filesFor("D", "service-d"), encoder.encode(`refused candidate ${attempt}`));
    await expect(session.run("install", async () => ({
      source: candidate,
      prepare: () => prepareBootConfiguration(computer, reader({ [INSTALLED_INVENTORY_PATH]: C }), base as never, candidate),
      close: async () => {},
    }))).rejects.toThrow(/maintenance refused/);
    expect(state.record).toBe(before);
  }
  expect(actions).not.toContain("discard");
  expect(session.getSnapshot().recovery).toBe("active");
  const records = await readBootConfigurations(computer);
  // A newly added D path colliding with an unmanaged user file can refuse
  // verifyInstalled without preventing a C-to-B rollback. Rust still has
  // that rollback: this failed install never calls discard.
  const rollback = await selectBootComposition(reader({ [INSTALLED_INVENTORY_PATH]: B }), records, base as never);
  const bootError = await assertPersistentImageBootMetadata(reader(target), rollback as never).then(() => null, error => String(error));
  expect(bootError).toBeNull();
  await session.close();
  expect(rollback.imageConfig).toEqual(upgraded.imageConfig);
  expect(rollback.requiredServices).toEqual(["web", "db"]);
});
