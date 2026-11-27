import { describe, expect, it, vi } from "vitest";
import { ConnectedNamesFile, CONNECTED_NAMES_PATH, type ConnectedNamesFileStorage } from "../src/networking/connected-names-file";
import { LocalVirtualNetwork } from "../src/networking/virtual-network";
import { RemoteSegmentRuntime, handleRemoteNetworkMessage } from "../src/networking/remote-segment-runtime";

// Interface tests only. This storage does not claim guest VFS qualification.
function fixture() {
  const files = new Map<string, Uint8Array>();
  const events: string[] = [];
  const storage: ConnectedNamesFileStorage = {
    rootfsStat: () => ({ mode: 0o040755, uid: 0, gid: 0 }),
    rootfsWriteFile: (path, bytes, mode) => {
      expect(mode).toBe(0o644);
      expect(path).not.toBe(CONNECTED_NAMES_PATH);
      events.push(`stage:${path}`); files.set(path, bytes.slice());
    },
    rootfsRenameFile: (from, to) => {
      expect(to).toBe(CONNECTED_NAMES_PATH);
      events.push(`commit:${from}`); files.set(to, files.get(from)!); files.delete(from);
    },
    rootfsUnlinkFile: (path) => { events.push(`unlink:${path}`); return files.delete(path); },
  };
  const network = new LocalVirtualNetwork({ network: [10, 88, 0, 0], prefixLength: 24 });
  const backend = network.attachMachine({ id: "first", address: [10, 88, 0, 1], hostnames: ["alias.test"] });
  const failures: unknown[] = [];
  const publisher = new ConnectedNamesFile(storage, backend, (error) => failures.push(error));
  const contents = () => new TextDecoder().decode(files.get(CONNECTED_NAMES_PATH));
  return { files, events, storage, network, backend, failures, publisher, contents };
}

describe("connected-name file publication interface", () => {
  it("stages canonical names and every alias, then replaces one complete snapshot", async () => {
    const f = fixture();
    await f.publisher.start();
    expect(f.contents()).toBe("10.88.0.1\tfirst alias.test\n");
    const oldReader = f.files.get(CONNECTED_NAMES_PATH)!;
    f.network.attachMachine({ id: "second", address: [10, 88, 0, 2], hostnames: ["second.test"] });
    await f.publisher.ready();
    expect(f.contents()).toBe("10.88.0.1\tfirst alias.test\n10.88.0.2\tsecond second.test\n");
    expect(new TextDecoder().decode(oldReader)).toBe("10.88.0.1\tfirst alias.test\n");
    f.network.detachMachine("second");
    await f.publisher.ready();
    expect(f.contents()).toBe("10.88.0.1\tfirst alias.test\n");
    expect([...f.files.keys()]).toEqual([CONNECTED_NAMES_PATH]);
    expect(f.failures).toEqual([]);
    f.publisher.close();
  });

  it("owns its name/address snapshots and unsubscribes queued notifications", async () => {
    const f = fixture();
    const snapshot = f.backend.connectedComputerNames();
    snapshot[0].address.fill(0);
    expect(Array.from(f.backend.getaddrinfo("first"))).toEqual([10, 88, 0, 1]);
    const removed = vi.fn();
    const unsubscribe = f.backend.onConnectedComputerNamesChanged(removed);
    const notification = new Promise<void>((resolve) => {
      const stop = f.backend.onConnectedComputerNamesChanged(() => { stop(); resolve(); });
    });
    f.network.attachMachine({ id: "second", address: [10, 88, 0, 2] });
    unsubscribe();
    await notification;
    expect(removed).not.toHaveBeenCalled();
  });

  it("does not restore a shadowed name when its former computer leaves", async () => {
    const f = fixture();
    f.network.attachMachine({ id: "second", address: [10, 88, 0, 2], hostnames: ["first"] });
    await f.publisher.start();
    expect(f.contents()).toBe("10.88.0.1\talias.test\n10.88.0.2\tsecond first\n");
    f.network.detachMachine("first");
    await f.publisher.ready();
    expect(f.contents()).toBe("10.88.0.2\tsecond first\n");
    expect(Array.from(f.backend.getaddrinfo("first"))).toEqual([10, 88, 0, 2]);
    f.publisher.close();
  });

  it("requires retirement before reusing an ID or address, removing old aliases", async () => {
    const f = fixture();
    expect(() => f.network.attachMachine({ id: "first", address: [10, 88, 0, 2] })).toThrow("already attached");
    await f.publisher.start();
    f.network.detachMachine("first");
    f.network.attachMachine({ id: "replacement", address: [10, 88, 0, 1] });
    await f.publisher.ready();
    expect(f.contents()).toBe("10.88.0.1\treplacement\n");
    expect(() => f.backend.getaddrinfo("alias.test")).toThrow("ENOENT");
    f.publisher.close();
  });

  it.each(["write", "rename"] as const)("preserves the old file and surfaces a failed %s", async (operation) => {
    const f = fixture();
    await f.publisher.start();
    const previous = f.contents();
    const failure = new Error("ENOSPC");
    if (operation === "write") f.storage.rootfsWriteFile = () => { throw failure; };
    else f.storage.rootfsRenameFile = () => { throw failure; };
    f.network.detachMachine("first");
    await expect(f.publisher.ready()).rejects.toBe(failure);
    expect(f.contents()).toBe(previous);
    expect(f.failures).toContain(failure);
    expect([...f.files.keys()]).toEqual([CONNECTED_NAMES_PATH]);
    f.publisher.close();
  });

  it.each(["bad\nname", "bad name", "bad#name"])("rejects an unsafe name %s without publishing", async (hostname) => {
    const f = fixture();
    f.network.attachMachine({ id: "unsafe", address: [10, 88, 0, 2], hostnames: [hostname] });
    await expect(f.publisher.start()).rejects.toThrow("ENOENT");
    expect(f.events).toEqual([]);
    f.publisher.close();
  });

  it.each([
    { mode: 0o040777, uid: 0, gid: 0 },
    { mode: 0o040755, uid: 1000, gid: 0 },
    { mode: 0o120755, uid: 0, gid: 0 },
  ])("refuses an unsafe publication directory: %s", async (stat) => {
    const f = fixture();
    f.storage.rootfsStat = () => stat;
    await expect(f.publisher.start()).rejects.toThrow("Unsafe connected-name directory");
    expect(f.events).toEqual([]);
    f.publisher.close();
  });

  it("cancels an already staged generation when its owner retires", async () => {
    const f = fixture();
    const write = f.storage.rootfsWriteFile;
    f.storage.rootfsWriteFile = (...args) => { write(...args); f.publisher.close(); };
    await expect(f.publisher.start()).rejects.toThrow("closed");
    expect(f.files.size).toBe(0);
    expect(f.events.some((event) => event.startsWith("commit:"))).toBe(false);
  });

  it("makes network replies wait for publication and surfaces barrier failure", async () => {
    const runtime = new RemoteSegmentRuntime(); runtime.install();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const respond = vi.fn();
    const reply = new Promise<void>((resolve) => {
      handleRemoteNetworkMessage(runtime, { type: "remote_network_host", requestId: 1 } as never,
        true, (...args) => { respond(...args); resolve(); }, vi.fn(), () => barrier);
    });
    expect(respond).not.toHaveBeenCalled();
    release(); await reply;
    expect(respond).toHaveBeenCalledWith(1, "10.89.0.1");
    const errorReply = new Promise<void>((resolve) => {
      handleRemoteNetworkMessage(runtime, { type: "remote_network_snapshot", requestId: 2 } as never,
        true, respond, (id, error) => { expect(id).toBe(2); expect(error).toBe("publication failed"); resolve(); },
        () => { throw new Error("publication failed"); });
    });
    await errorReply;
    runtime.close();
  });
});
