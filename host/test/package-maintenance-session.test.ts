import { describe, expect, it, vi } from "vitest";
import { ERRNO, PACKAGE_MAINTENANCE_WIRE as wire } from "../src/generated/abi";
import { PackageMaintenanceError, type PackageMaintenanceRequest, type PackageMaintenanceResponse } from "../src/package-maintenance";
import { INCOMPATIBLE_SOFTWARE, NOT_UPDATABLE_SOFTWARE } from "../../web-libs/kandelo-session/src/computer-software";
import { PackageMaintenanceSession, type OwnedPackageSource } from "../../apps/browser-demos/pages/kandelo/kernel-host/package-maintenance-session";

function fixture(recovery: number = wire.RECOVERY_NONE) {
  const requests: string[] = [];
  let phase = wire.PHASE_PENDING as number;
  const runtime = { packageMaintenance: vi.fn(async (request: PackageMaintenanceRequest): Promise<PackageMaintenanceResponse> => {
    requests.push(request.action);
    if (request.action === "recovery") return { status: recovery, errorKind: 0, data: new Uint8Array() };
    if (request.action === "progress") {
      const bytes = new Uint8Array(wire.PROGRESS_HEADER_BYTES);
      const data = new DataView(bytes.buffer);
      data.setUint32(wire.PROGRESS_VERSION_OFFSET, wire.VERSION, true);
      data.setUint32(wire.PROGRESS_PHASE_OFFSET, phase, true);
      return { status: 0, errorKind: 0, data: bytes };
    }
    if (request.action === "prepare") recovery = wire.RECOVERY_PENDING;
    if (request.action === "resume") phase = wire.PHASE_ACTIVE;
    if (request.action === "discard") recovery = wire.RECOVERY_NONE;
    if (request.action === "commit") {
      phase = phase === wire.PHASE_PENDING ? wire.PHASE_ACTIVE : wire.PHASE_ROLLED_BACK;
      recovery = phase === wire.PHASE_ACTIVE ? wire.RECOVERY_ACTIVE : wire.RECOVERY_ROLLED_BACK;
    }
    return { status: request.action === "uploadInventory" ? request.offset! + request.data!.length
      : request.action === "verifyInstalled" || request.action === "verifyStaged" ? 1
      : request.action === "leave" && recovery === wire.RECOVERY_PENDING ? -16 : 0, errorKind: 0, data: new Uint8Array() };
  }) };
  const source: OwnedPackageSource = { source: { inventoryBytes: 4,
    readInventory: async () => Uint8Array.of(1, 2, 3, 4),
    readFile: async () => { throw new Error("No resident files requested by this native plan"); } }, close: vi.fn(async () => {}) };
  return { requests, runtime, source };
}

describe("application maintenance session ownership", () => {
  it("tells the owner a blocked computer needs an update and clears that once one is installed", async () => {
    const { runtime, source } = fixture();
    const session = await PackageMaintenanceSession.open(runtime, () => {}, true);
    expect(session.getSnapshot().incompatible).toBe(true);
    await session.run("install", async () => source);
    expect(session.getSnapshot().incompatible).toBe(false);
  });

  it("discards an existing rollback only after the target has passed verification", async () => {
    const { runtime, requests, source } = fixture(wire.RECOVERY_ACTIVE);
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    await session.run("install", async () => source);
    const discard = requests.indexOf("discard");
    expect(discard).toBeGreaterThan(requests.indexOf("verifyInstalled"));
    expect(requests.lastIndexOf("begin")).toBeGreaterThan(discard);
    expect(requests.lastIndexOf("verifyInstalled")).toBeGreaterThan(discard);
    expect(requests.indexOf("prepare")).toBeGreaterThan(requests.lastIndexOf("verifyInstalled"));
  });

  it("keeps the rollback when verification refuses the target", async () => {
    const { runtime, requests, source } = fixture(wire.RECOVERY_ACTIVE);
    const invoke = runtime.packageMaintenance.getMockImplementation()!;
    runtime.packageMaintenance.mockImplementation(async request => {
      if (request.action === "verifyInstalled") throw new PackageMaintenanceError(ERRNO.EIO, wire.ERROR_CONTENTS);
      return invoke(request);
    });
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    await expect(session.run("install", async () => source)).rejects.toBeInstanceOf(PackageMaintenanceError);
    expect(requests).not.toContain("discard");
  });

  it("offers no update to a blocked computer without an inventory and explains a refused start", async () => {
    const { runtime } = fixture();
    const invoke = runtime.packageMaintenance.getMockImplementation()!;
    runtime.packageMaintenance.mockImplementation(async request => {
      if (request.action === "leave") throw new PackageMaintenanceError(ERRNO.ENOENT, wire.ERROR_NONE);
      return invoke(request);
    });
    const session = await PackageMaintenanceSession.open(runtime, () => {}, true, false);
    expect(session.getSnapshot()).toMatchObject({ incompatible: true, updatable: false });
    await expect(session.release()).rejects.toThrow(NOT_UPDATABLE_SOFTWARE);
  });

  it("does not call an unfinished update incompatible", async () => {
    const { runtime } = fixture(wire.RECOVERY_PENDING);
    const session = await PackageMaintenanceSession.open(runtime, () => {}, true);
    expect(session.getSnapshot().incompatible).toBeUndefined();
  });

  it("explains a refused start and stays in maintenance", async () => {
    const { runtime } = fixture(wire.RECOVERY_ROLLED_BACK);
    const invoke = runtime.packageMaintenance.getMockImplementation()!;
    runtime.packageMaintenance.mockImplementation(async request => {
      if (request.action === "leave") throw new PackageMaintenanceError(ERRNO.ENOEXEC, wire.ERROR_NONE);
      return invoke(request);
    });
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    await expect(session.release()).rejects.toThrow(INCOMPATIBLE_SOFTWARE);
    expect(session.getSnapshot()).toMatchObject({ maintenance: true, incompatible: true });
  });

  it("enters native maintenance before inspection and never implicitly releases guests after install or rollback", async () => {
    const { runtime, requests, source } = fixture();
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    expect(requests).toEqual(["enter", "recovery"]);
    await session.run("install", async () => source);
    expect(source.close).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({ maintenance: true, busy: false, recovery: "active", error: null });
    expect(requests).not.toContain("leave");
    await session.run("rollback");
    expect(session.getSnapshot().recovery).toBe("rolled-back");
    await session.release();
    expect(session.getSnapshot().maintenance).toBe(false);
    const cancellations = requests.filter(action => action === "cancel").length;
    await session.close();
    expect(requests.filter(action => action === "cancel")).toHaveLength(cancellations);
  });

  it("keeps pending and unreadable authority in maintenance rather than pretending boot succeeded", async () => {
    const pending = fixture(wire.RECOVERY_PENDING);
    const session = await PackageMaintenanceSession.open(pending.runtime, () => {});
    await expect(session.release()).rejects.toThrow("errno 16");
    expect(session.getSnapshot()).toMatchObject({ maintenance: true, recovery: "pending" });
    await session.discard();
    expect(session.getSnapshot().recovery).toBe("none");
    await session.release();
    await session.close();
    const unreadable = fixture(99);
    const recovery = await PackageMaintenanceSession.open(unreadable.runtime, () => {});
    expect(recovery.getSnapshot()).toMatchObject({ maintenance: true, recovery: "unknown", error: expect.stringContaining("unknown package recovery") });
    await recovery.close();
    expect(unreadable.requests).not.toContain("leave");
  });

  it("joins source closure before retiring a committed operation and rejects overlapping operations", async () => {
    const { runtime, source, requests } = fixture();
    let release!: () => void;
    let announce!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const closing = new Promise<void>(resolve => { release = resolve; });
    source.close = async () => { announce(); await closing; };
    source.committed = vi.fn(async () => {});
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    const run = session.run("install", async () => source);
    await entered;
    await expect(session.discard()).rejects.toThrow("already running");
    let closed = false;
    const retiring = session.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(session.getSnapshot().busy).toBe(true);
    expect(source.committed).not.toHaveBeenCalled();
    release();
    await run;
    await retiring;
    expect(source.committed).toHaveBeenCalledOnce();
    expect(requests).not.toContain("leave");
  });

  it.each(["commit", "close"])("does not collect saved sources after an unconfirmed %s", async failure => {
    const { runtime, source } = fixture();
    source.committed = vi.fn(async () => {});
    if (failure === "close") source.close = vi.fn(async () => { throw new Error("close unconfirmed"); });
    else {
      const invoke = runtime.packageMaintenance.getMockImplementation()!;
      runtime.packageMaintenance.mockImplementation(async request => {
        if (request.action === "commit") {
          await invoke(request);
          throw new Error("commit acknowledgement lost");
        }
        return invoke(request);
      });
    }
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    await expect(session.run("install", async () => source)).rejects.toThrow();
    expect(source.close).toHaveBeenCalledOnce();
    expect(source.committed).not.toHaveBeenCalled();
    if (failure === "close") await expect(session.close()).rejects.toThrow("retain the computer and source");
    else {
      expect(session.getSnapshot().recovery).toBe("active");
      await session.close();
    }
  });

  it("does not open a source after reentrant cancellation during the busy notification", async () => {
    const { runtime, source } = fixture();
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    const open = vi.fn(async () => source);
    let closing: Promise<void> | undefined;
    session.subscribe(() => { if (session.getSnapshot().busy && closing === undefined) closing = session.close(); });
    await expect(session.run("install", open)).rejects.toMatchObject({ name: "AbortError" });
    await closing;
    expect(open).not.toHaveBeenCalled();
  });

  it("makes unconfirmed source cleanup terminal but still joins native cancellation", async () => {
    const { runtime, source, requests } = fixture();
    source.close = async () => { throw new Error("source handle close unconfirmed"); };
    const session = await PackageMaintenanceSession.open(runtime, () => {});
    await expect(session.run("install", async () => source)).rejects.toThrow("source handle close unconfirmed");
    await expect(session.release()).rejects.toThrow("cleanup is unconfirmed");
    await expect(session.close()).rejects.toThrow("retain the computer and source");
    expect(requests.at(-1)).toBe("cancel");
    expect(requests).not.toContain("leave");
  });

  it("checks lifecycle before source work but permits cancellation of the exact superseded kernel", async () => {
    const { runtime, source, requests } = fixture();
    let current = true;
    const session = await PackageMaintenanceSession.open(runtime, () => { if (!current) throw new Error("superseded"); });
    current = false;
    const open = vi.fn(async () => source);
    await expect(session.run("install", open)).rejects.toThrow("superseded");
    expect(open).not.toHaveBeenCalled();
    await session.close();
    expect(requests.at(-1)).toBe("cancel");
  });
});
