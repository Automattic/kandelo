import { describe, expect, it, vi } from "vitest";
import { StorageCloseLedger, type StorageClose } from "../src/storage-close-ledger";

describe("storage close ownership", () => {
  it("closes provisional owners and retires successful closes exactly once", () => {
    const ledger = new StorageCloseLedger();
    const first = vi.fn(() => undefined);
    const provisional = vi.fn(() => undefined);
    const close = ledger.retain(first);
    ledger.retain(provisional);
    close();
    close();
    ledger.closeAll();
    ledger.closeAll();
    expect(first).toHaveBeenCalledOnce();
    expect(provisional).toHaveBeenCalledOnce();
  });

  it("retains failed closes while attempting every other owner", () => {
    const ledger = new StorageCloseLedger();
    const failure = new Error("native close failed");
    const failed = vi.fn(() => { throw failure; });
    const other = vi.fn(() => undefined);
    const close = ledger.retain(failed);
    ledger.retain(other);
    expect(close).toThrow(failure);
    expect(() => ledger.closeAll()).toThrow(AggregateError);
    expect(() => ledger.closeAll()).toThrow(AggregateError);
    expect(failed).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cleans up registration refusal and preserves unknown closure (failure=%s)", (closeFails) => {
    const ledger = new StorageCloseLedger();
    const pending = (ledger as unknown as { pending: Set<StorageClose> }).pending;
    const registrationFailure = new Error("registration refused");
    const closeFailure = new Error("unregistered owner close failed");
    const refusal = vi.spyOn(pending, "add").mockImplementationOnce(() => { throw registrationFailure; });
    const close = vi.fn(() => {
      if (closeFails) throw closeFailure;
      return undefined;
    });
    try {
      expect(() => ledger.retain(close)).toThrow(closeFails ? AggregateError : registrationFailure);
    } finally {
      refusal.mockRestore();
    }
    expect(close).toHaveBeenCalledOnce();
    if (closeFails) expect(() => ledger.closeAll()).toThrow(AggregateError);
    else expect(() => ledger.closeAll()).not.toThrow();
  });

  it("rejects the first sweep if a callback swallows a late acquisition cleanup error", () => {
    const ledger = new StorageCloseLedger();
    const other = vi.fn(() => undefined);
    ledger.retain(() => {
      expect(() => ledger.retain(() => { throw new Error("late native close failed"); })).toThrow(AggregateError);
    });
    ledger.retain(other);
    expect(() => ledger.closeAll()).toThrow(AggregateError);
    expect(other).toHaveBeenCalledOnce();
    expect(() => ledger.closeAll()).toThrow(AggregateError);
  });

  it.each([false, true])("rejects swallowed close reentry in the first sweep (nested sweep=%s)", (nestedSweep) => {
    const ledger = new StorageCloseLedger();
    let close: StorageClose;
    close = ledger.retain(() => {
      if (nestedSweep) expect(() => ledger.closeAll()).toThrow(AggregateError);
      else expect(() => close()).toThrow("reentered");
    });
    const other = vi.fn(() => undefined);
    ledger.retain(other);
    expect(() => ledger.closeAll()).toThrow(AggregateError);
    expect(other).toHaveBeenCalledOnce();
  });

  it("drains accepted operations before closure and rejects later admission", async () => {
    const ledger = new StorageCloseLedger();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const close = vi.fn(() => undefined);
    const operation = ledger.run(async () => {
      const release = ledger.retain(close);
      await pending;
      release();
    });
    const drained = ledger.beginRetirement();
    expect(ledger.beginRetirement()).toBe(drained);
    expect(() => ledger.closeAll()).toThrow("not drained");
    finish();
    await operation;
    await drained;
    ledger.closeAll();
    expect(close).toHaveBeenCalledOnce();
    const refused = vi.fn();
    await expect(ledger.run(refused)).rejects.toThrow("retiring");
    expect(refused).not.toHaveBeenCalled();
  });

  it.each([false, true])("accounts for late asynchronous acquisition before acknowledging closure (failure=%s)", async (closeFails) => {
    const ledger = new StorageCloseLedger();
    let acquired!: () => void;
    const pending = new Promise<void>(resolve => { acquired = resolve; });
    const close = vi.fn(() => {
      if (closeFails) throw new Error("late native close failed");
      return undefined;
    });
    const operation = ledger.run(async () => {
      await pending;
      ledger.retain(close);
    });
    const rejection = expect(operation).rejects.toThrow();
    const drained = ledger.beginRetirement();
    expect(() => ledger.closeAll()).toThrow("not drained");
    acquired();
    await rejection;
    await drained;
    expect(close).toHaveBeenCalledOnce();
    if (closeFails) expect(() => ledger.closeAll()).toThrow(AggregateError);
    else expect(() => ledger.closeAll()).not.toThrow();
  });

  it("releases operation admission on synchronous and asynchronous failure", async () => {
    const ledger = new StorageCloseLedger();
    await expect(ledger.run(() => { throw new Error("sync refusal"); })).rejects.toThrow("sync refusal");
    await expect(ledger.run(async () => { throw new Error("async refusal"); })).rejects.toThrow("async refusal");
    await ledger.beginRetirement();
    expect(() => ledger.closeAll()).not.toThrow();
  });
});
