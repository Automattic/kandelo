import { describe, expect, it } from "vitest";
import { PACKAGE_MAINTENANCE_WIRE as wire } from "../src/generated/abi";
import {
  packageMaintenanceOpcode,
  performPackageMaintenanceWithCompaction,
  type PackageMaintenanceRequest,
  type PackageMaintenanceResponse,
} from "../src/package-maintenance";

function response(status = 0): PackageMaintenanceResponse {
  return { status, errorKind: 0, data: new Uint8Array() };
}

function fixture(advice = [1, 0]) {
  const events: string[] = [];
  const requests: PackageMaintenanceRequest[] = [];
  const invoke = (request: PackageMaintenanceRequest) => {
    events.push(request.action);
    requests.push(request);
    return response(request.action === "compactionNeeded" ? advice.shift() : 23);
  };
  const compactor = {
    settle: async () => { events.push("settle"); },
    compactForMaintenance: async () => { events.push("compact"); },
  };
  const active = () => { events.push("active"); };
  return { events, requests, invoke, compactor, active };
}

describe("maintenance compaction coordination", () => {
  for (const action of ["prepare", "stage", "commit", "discard", "restartStagingFile"] as const) {
    it(`settles, obtains Rust advice and confirms publication before ${action}`, async () => {
      const state = fixture();
      expect((await performPackageMaintenanceWithCompaction({ action }, state.invoke, state.compactor, state.active)).status).toBe(23);
      expect(state.events).toEqual(["settle", "active", "compactionNeeded", "compact", "active", "compactionNeeded", "active", action]);
      expect(state.requests.slice(0, 2)).toEqual([
        { action: "compactionNeeded", index: packageMaintenanceOpcode(action) },
        { action: "compactionNeeded", index: packageMaintenanceOpcode(action) },
      ]);
    });
  }

  it("snapshots upload bytes before awaiting an already-running compaction", async () => {
    const state = fixture([0]);
    let release!: () => void;
    state.compactor.settle = () => new Promise<void>(resolve => { release = resolve; });
    const data = Uint8Array.of(1, 2, 3);
    const request: PackageMaintenanceRequest = { action: "stage", index: 7, offset: 9, data };
    const pending = performPackageMaintenanceWithCompaction(request, state.invoke, state.compactor, state.active);
    request.action = "commit";
    data.fill(42);
    expect(state.requests).toEqual([]);
    release();
    await pending;
    expect(state.requests.at(-1)).toEqual({ action: "stage", index: 7, offset: 9, data: Uint8Array.of(1, 2, 3) });
    expect(state.events).not.toContain("compact");
  });

  it("returns native refusals without executing or translating the requested mutation", async () => {
    for (const refusal of [-12, -5]) {
      const state = fixture(refusal === -12 ? [refusal] : [1, refusal]);
      expect((await performPackageMaintenanceWithCompaction({ action: "commit" }, state.invoke, state.compactor, state.active)).status)
        .toBe(refusal);
      expect(state.requests.every(request => request.action === "compactionNeeded")).toBe(true);
    }
  });

  it("never retries a mutation after compaction fails or fails to relieve pressure", async () => {
    for (const failure of [true, false]) {
      const state = fixture([1, 1]);
      if (failure) state.compactor.compactForMaintenance = async () => { throw new Error("publication uncertain"); };
      await expect(performPackageMaintenanceWithCompaction({ action: "stage" }, state.invoke, state.compactor, state.active))
        .rejects.toThrow(failure ? "publication uncertain" : "still requires compaction");
      expect(state.requests.some(request => request.action === "stage")).toBe(false);
    }
  });

  it("refuses absent compaction support and invalid native advice", async () => {
    const state = fixture([1]);
    await expect(performPackageMaintenanceWithCompaction({ action: "commit" }, state.invoke, null, state.active))
      .rejects.toThrow("requires persistent compaction support");
    const invalid = fixture([2]);
    await expect(performPackageMaintenanceWithCompaction({ action: "prepare" }, invalid.invoke, invalid.compactor, invalid.active))
      .rejects.toThrow("invalid compaction advice");
  });

  it("rechecks lifecycle admission after joining asynchronous compaction", async () => {
    const state = fixture();
    let open = true;
    state.compactor.compactForMaintenance = async () => { open = false; };
    await expect(performPackageMaintenanceWithCompaction({ action: "commit" }, state.invoke, state.compactor,
      () => { if (!open) throw new Error("worker closing"); })).rejects.toThrow("worker closing");
    expect(state.requests.map(request => request.action)).toEqual(["compactionNeeded"]);
  });

  it("keeps recovery inspection and cancellation usable without compaction", async () => {
    for (const action of ["enter", "leave", "recovery", "cancel", "progress", "stagingFile", "verifyInstalled", "verifyStaged"] as const) {
      const state = fixture();
      state.compactor.settle = async () => { throw new Error("storage failed"); };
      await performPackageMaintenanceWithCompaction({ action }, state.invoke, state.compactor, state.active);
      expect(state.events).toEqual(["active", action]);
    }
    expect(packageMaintenanceOpcode("compactionNeeded")).toBe(wire.OP_COMPACTION_NEEDED);
  });
});
