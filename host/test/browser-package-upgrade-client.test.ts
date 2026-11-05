import { describe, expect, it } from "vitest";
import { PACKAGE_MAINTENANCE_WIRE as wire } from "../src/generated/abi";
import type { PackageMaintenanceRequest, PackageMaintenanceResponse } from "../src/package-maintenance";
import { PackageUpgradeClient, packageUpgradeProgress, type PackageUpgradeSource } from "../../apps/browser-demos/pages/kandelo/kernel-host/package-upgrade-client";

const encoder = new TextEncoder();

function reply(status = 0, data = new Uint8Array()): PackageMaintenanceResponse {
  return { status, data, errorKind: 0 };
}

function progress(phase: number, files = 3): Uint8Array {
  const bytes = new Uint8Array(wire.PROGRESS_HEADER_BYTES);
  const data = new DataView(bytes.buffer);
  data.setUint32(wire.PROGRESS_VERSION_OFFSET, wire.VERSION, true);
  data.setUint32(wire.PROGRESS_PHASE_OFFSET, phase, true);
  data.setUint32(wire.PROGRESS_FILE_COUNT_OFFSET, files, true);
  return bytes;
}

function staged(kind: number, size = 0, path = "/software/tool"): Uint8Array {
  const name = encoder.encode(path);
  const bytes = new Uint8Array(wire.STAGING_HEADER_BYTES + name.length);
  const data = new DataView(bytes.buffer);
  data.setUint32(wire.STAGING_KIND_OFFSET, kind, true);
  data.setUint32(wire.STAGING_PATH_LENGTH_OFFSET, name.length, true);
  data.setBigUint64(wire.STAGING_SIZE_OFFSET, BigInt(size), true);
  bytes.set(name, wire.STAGING_HEADER_BYTES);
  return bytes;
}

function fixture(initial = wire.PHASE_PENDING, size = 70000) {
  const requests: PackageMaintenanceRequest[] = [];
  let phase: number = initial;
  const transport = async (request: PackageMaintenanceRequest) => {
    requests.push(request);
    switch (request.action) {
      case "progress": return reply(0, progress(phase));
      case "uploadInventory": return reply(request.offset! + request.data!.length);
      case "verifyInstalled": case "verifyStaged": return reply(1);
      case "commit": phase = phase === wire.PHASE_PENDING ? wire.PHASE_ACTIVE : wire.PHASE_ROLLED_BACK; return reply();
      case "stagingFile": return reply(0, request.index === 0 ? staged(wire.STAGING_UPLOAD, size)
        : request.index === 1 ? staged(wire.STAGING_KERNEL) : staged(wire.STAGING_REMOVED));
      case "stage": return reply(Math.min(request.data?.length ?? 0, 32768));
      default: return reply();
    }
  };
  const source: PackageUpgradeSource = {
    inventoryBytes: 70001,
    readInventory: async (_offset, length) => new Uint8Array(length),
    readFile: async (_path, _offset, length) => new Uint8Array(length),
  };
  return { requests, source, client: new PackageUpgradeClient(transport), transport };
}

describe("bounded application package upgrade client", () => {
  it("preserves commit acknowledgement when the final recovery phase contradicts the operation", async () => {
    const { transport, source } = fixture();
    let committed = false;
    const client = new PackageUpgradeClient(async request => {
      const result = await transport(request);
      if (request.action === "commit") committed = true;
      return request.action === "progress" && committed ? reply(0, progress(wire.PHASE_PENDING)) : result;
    });
    await expect(client.run("install", source)).rejects.toMatchObject({ commitAcknowledged: true });
  });

  it("streams inventory and files using native acknowledgements and leaves guest admission to its owner", async () => {
    const { requests, source, client } = fixture();
    const transfers: number[] = [];
    const result = await client.run("install", source, {
      onTransfer: value => { if (value.path !== null) transfers.push(value.accepted); },
    });
    expect(result.phase).toBe(wire.PHASE_ACTIVE);
    expect(requests.filter(request => request.action === "uploadInventory").map(request => [request.offset, request.data?.length]))
      .toEqual([[0, 65536], [65536, 4465]]);
    expect(requests.filter(request => request.action === "stage" && request.index === 0).map(request => request.offset))
      .toEqual([0, 32768, 65536]);
    expect(transfers).toEqual([32768, 65536, 70000]);
    expect(requests.every(request => (request.data?.length ?? 0) <= 65536)).toBe(true);
    expect(requests.some(request => request.action === "enter" || request.action === "leave" || request.action === "discard")).toBe(false);
    expect(requests.at(-1)?.action).toBe("cancel");
  });

  it("restarts private staging on pending recovery and handles empty raw files", async () => {
    const { client, source, requests } = fixture(wire.PHASE_PENDING, 0);
    await client.run("resume", source);
    expect(requests.slice(0, 4).map(request => request.action)).toEqual(["cancel", "uploadInventory", "uploadInventory", "resumeFromSource"]);
    expect(requests.filter(request => request.action === "restartStagingFile").map(request => request.index)).toEqual([0, 1]);
    expect(requests.find(request => request.action === "stage" && request.index === 0)?.data).toHaveLength(0);
    expect(requests.some(request => request.action === "prepare" || request.action === "resume")).toBe(false);
  });

  it("rolls back only native active authority without consulting a target or staging uploads", async () => {
    const { client, requests } = fixture(wire.PHASE_ACTIVE);
    expect((await client.run("rollback")).phase).toBe(wire.PHASE_ROLLED_BACK);
    expect(requests.some(request => request.action === "stage" || request.action === "stagingFile" || request.action === "uploadInventory")).toBe(false);
    const pending = fixture();
    await expect(pending.client.run("rollback")).rejects.toThrow(/phase/);
    expect(pending.requests.some(request => request.action === "commit")).toBe(false);
  });

  it("joins an aborted source read before permitting another operation and never implicitly discards recovery", async () => {
    const { transport, requests, source } = fixture();
    const client = new PackageUpgradeClient(transport);
    const abort = new AbortController();
    let finish!: (bytes: Uint8Array) => void;
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    source.readInventory = () => new Promise(resolve => { finish = resolve; reading(); });
    const operation = client.run("install", source, { signal: abort.signal });
    const rejected = expect(operation).rejects.toThrow("stopped by user");
    await started;
    abort.abort(new Error("stopped by user"));
    await expect(client.run("rollback")).rejects.toThrow(/already running/);
    expect(requests).toEqual([]);
    finish(new Uint8Array(65536));
    await rejected;
    expect(requests).toEqual([]);
    await expect(client.run("rollback")).rejects.toThrow(/phase/);
    expect(requests.some(request => request.action === "leave" || request.action === "discard")).toBe(false);
  });

  it("rejects oversized backing buffers, short inventory acknowledgements and zero write progress", async () => {
    const large = fixture();
    large.source.readInventory = async () => new Uint8Array(100000).subarray(0, 65536);
    await expect(large.client.run("install", large.source)).rejects.toThrow(/bounded chunk/);
    expect(large.requests).toEqual([]);
    const short = fixture();
    const shortClient = new PackageUpgradeClient(async request => request.action === "uploadInventory" ? reply(0) : short.transport(request));
    await expect(shortClient.run("install", short.source)).rejects.toThrow(/inventory made invalid progress/);
    const zero = fixture();
    const zeroClient = new PackageUpgradeClient(async request => request.action === "stage" ? reply(0) : zero.transport(request));
    await expect(zeroClient.run("install", zero.source)).rejects.toThrow(/staging made invalid progress/);
    expect(zero.requests.some(request => request.action === "commit" || request.action === "discard" || request.action === "leave")).toBe(false);
  });

  it("decodes offset progress views and rejects truncated or inconsistent native replies", () => {
    const bytes = progress(wire.PHASE_PENDING);
    const backing = new Uint8Array(bytes.length + 8);
    backing.set(bytes, 8);
    expect(packageUpgradeProgress(backing.subarray(8)).files).toBe(3);
    expect(() => packageUpgradeProgress(bytes.subarray(1))).toThrow(/Truncated/);
    new DataView(bytes.buffer).setUint32(wire.PROGRESS_INSTALLED_COUNT_OFFSET, 4, true);
    expect(() => packageUpgradeProgress(bytes)).toThrow(/Invalid/);
  });

  it.each([65537, 131072])("accepts %i changed paths from the bounded union of two inventories", files => {
    const bytes = progress(wire.PHASE_PENDING);
    new DataView(bytes.buffer).setUint32(wire.PROGRESS_FILE_COUNT_OFFSET, files, true);
    expect(packageUpgradeProgress(bytes).files).toBe(files);
  });

  it("rejects progress beyond the Rust-owned changed-file transport bound", () => {
    const bytes = progress(wire.PHASE_PENDING);
    new DataView(bytes.buffer).setUint32(wire.PROGRESS_FILE_COUNT_OFFSET, wire.MAX_CHANGED_FILES + 1, true);
    expect(() => packageUpgradeProgress(bytes)).toThrow(/Invalid/);
  });

  it.each(["uploadInventory", "verifyInstalled"] as const)("cleans volatile %s state after abort so a fresh install can retry", async action => {
    const state = fixture();
    const abort = new AbortController();
    let incoming = 0;
    let active = false;
    let interrupt = true;
    const client = new PackageUpgradeClient(async request => {
      if (request.action === "uploadInventory") {
        expect(request.offset).toBe(incoming);
        incoming += request.data!.length;
      }
      if (request.action === "begin") { expect(active).toBe(false); active = true; }
      if (request.action === "cancel") { incoming = 0; active = false; }
      const response = await state.transport(request);
      if (request.action === action && interrupt) { interrupt = false; abort.abort(new Error("interrupted")); }
      return response;
    });
    await expect(client.run("install", state.source, { signal: abort.signal })).rejects.toThrow("interrupted");
    expect(state.requests.at(-1)?.action).toBe("cancel");
    expect(incoming).toBe(0);
    expect(active).toBe(false);
    expect((await client.run("install", state.source)).phase).toBe(wire.PHASE_ACTIVE);
  });

  it("consumes an in-flight commit acknowledgement despite abort and ignores aborts from final progress", async () => {
    const state = fixture();
    const abort = new AbortController();
    let acknowledge!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const client = new PackageUpgradeClient(async request => {
      const response = await state.transport(request);
      if (request.action === "commit") { started(); await acknowledgement; }
      return response;
    });
    const operation = client.run("install", state.source, { signal: abort.signal,
      onProgress: value => { if (value.phase === wire.PHASE_ACTIVE) abort.abort(); } });
    await entered;
    abort.abort();
    await expect(client.run("rollback")).rejects.toThrow(/already running/);
    acknowledge();
    expect((await operation).phase).toBe(wire.PHASE_ACTIVE);
    expect(state.requests.at(-1)?.action).toBe("cancel");
  });

  it("reports acknowledged commits on cleanup failure and refuses another operation until reopened", async () => {
    const state = fixture();
    const client = new PackageUpgradeClient(async request => {
      if (request.action === "cancel") throw new Error("worker unavailable");
      return state.transport(request);
    });
    await expect(client.run("install", state.source)).rejects.toMatchObject({ commitAcknowledged: true });
    const before = state.requests.length;
    await expect(client.run("rollback")).rejects.toThrow(/reopen the computer/);
    expect(state.requests).toHaveLength(before);
  });
});
