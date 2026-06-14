import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

type PendingTimer = {
  fn: () => void;
  due: number;
};

type WarningRecord = {
  message: string;
  name: string;
  code?: string;
};

function loadTimersShim() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("const timers = (() => {");
  const end = bootstrap.indexOf("// `timers/promises`", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate node-compat timers module");
  }

  let now = 0;
  let nextTimerId = 1;
  let nextResourceId = 1;
  const pendingTimers = new Map<number, PendingTimer>();
  const activeResources = new Map<number, string>();
  const warnings: WarningRecord[] = [];

  const os = {
    setTimeout(fn: () => void, delay: number) {
      const id = nextTimerId++;
      const ms = Math.max(0, Number(delay) || 0);
      pendingTimers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout(id: number | string) {
      pendingTimers.delete(Number(id));
    },
  };

  function runDueTimers(limit = 10000) {
    let ran = 0;
    while (limit-- > 0) {
      const dueIds: number[] = [];
      for (const [id, timer] of pendingTimers) {
        if (timer.due <= now) dueIds.push(id);
      }
      if (dueIds.length === 0) break;

      for (const id of dueIds) {
        const timer = pendingTimers.get(id);
        if (!timer) continue;
        pendingTimers.delete(id);
        timer.fn();
        ran++;
      }
    }
    if (limit <= 0) throw new Error("runDueTimers limit exceeded");
    return ran;
  }

  function tick(ms: number) {
    now += ms;
    return runDueTimers();
  }

  const source = `${bootstrap.slice(start, end)}\ntimers;`;
  const timers = vm.runInNewContext(source, {
    os,
    process: {
      emitWarning(warning: unknown, type?: string, code?: string) {
        warnings.push({
          message: String(warning),
          name: type || "Warning",
          code,
        });
      },
      _handleUncaughtException(err: unknown) {
        throw err;
      },
    },
    Date: { now: () => now },
    Number,
    Math,
    Map,
    Set,
    Symbol,
    RangeError,
    TypeError,
    Object,
    Array,
    String,
    Uint8Array,
    BigInt,
    _makeInvalidArgTypeError(name: string, expected: string, value: unknown) {
      const err = new TypeError(
        `The "${name}" argument must be of type ${expected}. Received ${typeof value}`,
      ) as TypeError & { code?: string };
      err.code = "ERR_INVALID_ARG_TYPE";
      return err;
    },
    _trackActiveResource(type: string) {
      const id = nextResourceId++;
      activeResources.set(id, type);
      return id;
    },
    _untrackActiveResource(id: number) {
      activeResources.delete(id);
    },
  });

  return {
    timers,
    pendingTimers,
    warnings,
    tick,
    runDueTimers,
  };
}

describe("node-compat timers shim", () => {
  it("implements legacy active/enroll object mutation and validation", () => {
    const { timers, pendingTimers } = loadTimersShim();

    const legit = { _idleTimeout: 0, _idleStart: undefined as number | undefined };
    timers.active(legit);
    expect(legit._idleTimeout).toBe(0);
    expect(Number.isInteger(legit._idleStart)).toBe(true);
    expect(legit).toHaveProperty("_idleNext");
    expect(legit).toHaveProperty("_idlePrev");
    expect(pendingTimers.size).toBe(0);

    const bogus = { _idleTimeout: -1 };
    timers.active(bogus);
    expect(bogus).toEqual({ _idleTimeout: -1 });

    for (const value of [{}, [], "foo", () => {}, Symbol("foo")]) {
      expect(() => timers.enroll({}, value)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }),
      );
    }
    for (const value of [-1, Infinity, NaN]) {
      expect(() => timers.enroll({}, value)).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE", name: "RangeError" }),
      );
    }
  });

  it("matches overflow and legacy deprecation warning counts", () => {
    const { timers, warnings } = loadTimersShim();

    const timeout = timers.setTimeout(() => {
      throw new Error("timeout should have been cleared");
    }, 2 ** 31);
    timers.clearTimeout(timeout);

    const interval = timers.setInterval(() => {
      throw new Error("interval should have been cleared");
    }, 2 ** 31);
    timers.clearInterval(interval);

    const item = {
      _onTimeout() {
        throw new Error("legacy timer should have been cleared");
      },
    };
    timers.enroll(item, 2 ** 31);
    timers.active(item);
    timers.unenroll(item);

    expect(warnings).toHaveLength(6);
    expect(warnings.filter((warning) => warning.name === "TimeoutOverflowWarning")).toHaveLength(3);
    expect(warnings.filter((warning) => warning.name === "DeprecationWarning")).toHaveLength(3);
    expect(warnings.some((warning) => warning.code === "DEP0095")).toBe(true);
    expect(warnings.some((warning) => warning.code === "DEP0096")).toBe(true);
    expect(warnings.some((warning) => warning.code === "DEP0126")).toBe(true);
  });

  it("supports dispose and primitive clearing for timeout handles", () => {
    const { timers, tick } = loadTimersShim();

    const timer = timers.setTimeout(() => {
      throw new Error("disposed timeout fired");
    }, 10);
    const interval = timers.setInterval(() => {
      throw new Error("disposed interval fired");
    }, 10);
    const immediate = timers.setImmediate(() => {
      throw new Error("disposed immediate fired");
    });

    timer[Symbol.dispose]();
    interval[Symbol.dispose]();
    immediate[Symbol.dispose]();

    expect(timer._destroyed).toBe(true);
    expect(interval._destroyed).toBe(true);
    expect(immediate._destroyed).toBe(true);
    tick(10);

    const numeric = timers.setTimeout(() => {
      throw new Error("numeric clear failed");
    }, 1);
    expect(+numeric).toBe(numeric[Symbol.toPrimitive]());
    expect(`${numeric}`).toBe(numeric[Symbol.toPrimitive]().toString());
    timers.clearTimeout(+numeric);

    const string = timers.setTimeout(() => {
      throw new Error("string clear failed");
    }, 1);
    timers.clearTimeout(`${string}`);
    tick(1);
  });

  it("runs unrefed work only while refed timers keep the loop alive", () => {
    const lone = loadTimersShim();
    let loneImmediateCalled = false;
    lone.timers.setImmediate(() => {
      lone.timers.setImmediate(() => {
        loneImmediateCalled = true;
      }).unref();
    });
    lone.runDueTimers();
    expect(loneImmediateCalled).toBe(false);

    const withRef = loadTimersShim();
    let unrefImmediateCalled = false;
    withRef.timers.setImmediate(() => {
      withRef.timers.setImmediate(() => {
        unrefImmediateCalled = true;
      }).unref();
      withRef.timers.setTimeout(() => {}, 5);
    });
    withRef.runDueTimers();
    expect(unrefImmediateCalled).toBe(true);

    const intervalHarness = loadTimersShim();
    let count = 0;
    const keepAlive = intervalHarness.timers.setTimeout(() => {}, 10);
    const interval = intervalHarness.timers.setInterval(() => {
      count++;
      if (count === 3) intervalHarness.timers.clearInterval(interval);
    }, 1).unref();
    intervalHarness.tick(1);
    intervalHarness.tick(1);
    intervalHarness.tick(1);
    expect(count).toBe(3);
    expect(interval._destroyed).toBe(true);
    intervalHarness.timers.clearTimeout(keepAlive);
  });

  it("preserves unrefed interval lifecycle state after refed work finishes", () => {
    const { timers, tick } = loadTimersShim();
    const interval = timers.setInterval(() => {}, 1).unref();
    timers.setTimeout(() => {}, 1);

    tick(1);

    expect(interval._destroyed).toBe(false);
    expect(interval.hasRef()).toBe(false);
    timers.clearInterval(interval);
  });
});
