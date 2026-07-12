import { describe, expect, it, vi } from "vitest";
import { ThreadExitCoordinator } from "../src/thread-exit-coordinator";

describe("ThreadExitCoordinator", () => {
  it("abandons pthread SYS_exit even before a terminator is registered", () => {
    const exits = new ThreadExitCoordinator();
    const terminate = vi.fn(async () => {});

    expect(exits.requestExit(123, 0x20000)).toBe(true);
    expect(terminate).not.toHaveBeenCalled();

    exits.register(123, 0x20000, terminate);

    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates immediately when the terminator is already registered", () => {
    const exits = new ThreadExitCoordinator();
    const terminate = vi.fn(async () => {});

    exits.register(123, 0x20000, terminate);

    expect(exits.requestExit(123, 0x20000)).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale pending exit terminate a reused channel", () => {
    const exits = new ThreadExitCoordinator();
    const firstTerminate = vi.fn(async () => {});
    const secondTerminate = vi.fn(async () => {});

    expect(exits.requestExit(123, 0x20000)).toBe(true);
    exits.release(123, 0x20000);
    exits.register(123, 0x20000, firstTerminate);
    expect(firstTerminate).not.toHaveBeenCalled();

    exits.requestExit(123, 0x20000);
    exits.release(123, 0x20000);
    exits.register(123, 0x20000, secondTerminate);

    expect(firstTerminate).toHaveBeenCalledTimes(1);
    expect(secondTerminate).not.toHaveBeenCalled();
  });

  it("does not let stale cleanup release a reused channel's terminator", () => {
    const exits = new ThreadExitCoordinator();
    const firstTerminate = vi.fn(async () => {});
    const secondTerminate = vi.fn(async () => {});

    exits.register(123, 0x20000, firstTerminate);
    exits.register(123, 0x20000, secondTerminate);
    exits.release(123, 0x20000, firstTerminate);

    expect(exits.requestExit(123, 0x20000)).toBe(true);
    expect(firstTerminate).not.toHaveBeenCalled();
    expect(secondTerminate).toHaveBeenCalledOnce();
  });
});
