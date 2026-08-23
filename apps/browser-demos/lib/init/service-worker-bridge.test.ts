import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureServiceWorkerReady,
  initServiceWorkerBridge,
} from "./service-worker-bridge";

type Listener = () => void;

class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  listenerCount(): number {
    return Array.from(this.listeners.values()).reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
}

class FakeWorker extends FakeEventTarget {
  state = "activated";
  postMessageHandler:
    | ((message: unknown, transfer: Transferable[]) => void)
    | null = null;

  constructor(readonly scriptURL: string) {
    super();
  }

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.postMessageHandler?.(message, transfer);
  }
}

class FakeRegistration extends FakeEventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;

  constructor(
    readonly scope: string,
    public active: FakeWorker | null,
  ) {
    super();
  }
}

class FakeServiceWorkerContainer extends FakeEventTarget {
  readonly calls: Array<{ url: string; options: RegistrationOptions }> = [];
  controller: FakeWorker | null;

  constructor(
    private readonly registration: FakeRegistration,
    controller?: FakeWorker | null,
  ) {
    super();
    this.controller = controller === undefined ? registration.active : controller;
  }

  get ready(): never {
    throw new Error("navigator.serviceWorker.ready is not ownership evidence");
  }

  async register(
    url: string,
    options: RegistrationOptions,
  ): Promise<FakeRegistration> {
    this.calls.push({ url, options });
    return this.registration;
  }
}

interface RegistrationOptions {
  scope?: string;
  updateViaCache?: string;
}

class FakeClock {
  readonly delays: number[] = [];
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.delays.push(delay);
    this.timers.set(id, callback);
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  fire(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const callback of pending) callback();
  }

  count(): number {
    return this.timers.size;
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function withBrowserGlobals<T>(
  pageUrl: string,
  container: FakeServiceWorkerContainer,
  run: (clock: FakeClock) => Promise<T>,
): Promise<T> {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const clock = new FakeClock();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: container },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: clock.clearTimeout,
      location: { href: pageUrl },
      setTimeout: clock.setTimeout,
    },
  });
  try {
    return await run(clock);
  } finally {
    if (navigatorDescriptor === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
    if (windowDescriptor === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", windowDescriptor);
    }
  }
}

function readyFixture(options: {
  pageUrl?: string;
  registrationScope?: string;
  activeScriptUrl?: string;
  controllerScriptUrl?: string | null;
} = {}) {
  const pageUrl = options.pageUrl ?? "https://example.test/a/page.html";
  const active = new FakeWorker(
    options.activeScriptUrl ?? "https://example.test/a/service-worker.js",
  );
  const registration = new FakeRegistration(
    options.registrationScope ?? "https://example.test/a/",
    active,
  );
  const controller = options.controllerScriptUrl === null
    ? null
    : new FakeWorker(
      options.controllerScriptUrl ?? "https://example.test/a/service-worker.js",
    );
  return {
    container: new FakeServiceWorkerContainer(registration, controller),
    controller,
    pageUrl,
    registration,
  };
}

test("registers a nested worker with its exact script-directory scope", async () => {
  const fixture = readyFixture();
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async () => {
    await ensureServiceWorkerReady("/a/service-worker.js");
  });
  assert.deepEqual(fixture.container.calls, [{
    url: "https://example.test/a/service-worker.js",
    options: { scope: "/a/", updateViaCache: "none" },
  }]);
});

test("retains root scope for the root development worker", async () => {
  const fixture = readyFixture({
    pageUrl: "http://127.0.0.1:5401/pages/kandelo/",
    registrationScope: "http://127.0.0.1:5401/",
    activeScriptUrl: "http://127.0.0.1:5401/service-worker.js",
    controllerScriptUrl: "http://127.0.0.1:5401/service-worker.js",
  });
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async () => {
    await ensureServiceWorkerReady("/service-worker.js");
  });
  assert.deepEqual(fixture.container.calls[0], {
    url: "http://127.0.0.1:5401/service-worker.js",
    options: { scope: "/", updateViaCache: "none" },
  });
});

test("accepts only an explicit scope equal to the derived script directory", async () => {
  const fixture = readyFixture();
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async () => {
    assert.equal(
      await ensureServiceWorkerReady("/a/service-worker.js", "/a/"),
      fixture.container.controller,
    );
    await assert.rejects(
      ensureServiceWorkerReady("/a/service-worker.js", "/b/"),
      /scope.*script directory|script directory.*scope/iu,
    );
  });
  assert.equal(fixture.container.calls.length, 1);
});

test("rejects unsupported, cross-origin, and out-of-scope script ownership", async () => {
  for (const [pageUrl, swUrl] of [
    ["https://example.test/a/page.html", "https://other.test/a/service-worker.js"],
    ["https://example.test/b/page.html", "https://example.test/a/service-worker.js"],
    ["https://example.test/a", "https://example.test/a/service-worker.js"],
    ["https://example.test/a/page.html", "data:text/javascript,worker"],
  ]) {
    const fixture = readyFixture({ pageUrl });
    await withBrowserGlobals(pageUrl, fixture.container, async () => {
      await assert.rejects(ensureServiceWorkerReady(swUrl));
    });
    assert.equal(fixture.container.calls.length, 0);
  }
});

test("rejects a returned registration with a different absolute scope", async () => {
  const fixture = readyFixture({
    registrationScope: "https://example.test/b/",
  });
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async () => {
    await assert.rejects(
      ensureServiceWorkerReady("/a/service-worker.js"),
      /returned.*scope|scope.*returned/iu,
    );
  });
});

test("rejects an active worker whose script is not the requested script", async () => {
  const fixture = readyFixture({
    activeScriptUrl: "https://example.test/b/service-worker.js",
  });
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    await assert.rejects(
      ensureServiceWorkerReady("/a/service-worker.js"),
      /active.*script|script.*active/iu,
    );
    assert.equal(fixture.container.listenerCount(), 0);
    assert.equal(fixture.registration.listenerCount(), 0);
    assert.equal(clock.count(), 0);
  });
});

test("waits for its returned registration to acquire an active worker", async () => {
  const fixture = readyFixture({ controllerScriptUrl: null });
  const installing = new FakeWorker(
    "https://example.test/a/service-worker.js",
  );
  installing.state = "installing";
  fixture.registration.active = null;
  fixture.registration.installing = installing;
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const ready = ensureServiceWorkerReady("/a/service-worker.js");
    await flushPromises();
    fixture.registration.active = installing;
    installing.state = "activated";
    installing.emit("statechange");
    fixture.container.controller = installing;
    fixture.container.emit("controllerchange");
    assert.equal(await ready, installing);
    assert.equal(installing.listenerCount(), 0);
    assert.equal(fixture.registration.listenerCount(), 0);
    assert.equal(fixture.container.listenerCount(), 0);
    assert.equal(clock.count(), 0);
  });
});

test("ignores sibling controllers without resetting the single readiness budget", async () => {
  const fixture = readyFixture({
    controllerScriptUrl: "https://example.test/b/service-worker.js",
  });
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const ready = ensureServiceWorkerReady("/a/service-worker.js");
    await flushPromises();
    fixture.container.emit("controllerchange");
    assert.deepEqual(clock.delays, [10_000]);

    const matching = new FakeWorker(
      "https://example.test/a/service-worker.js",
    );
    fixture.container.controller = matching;
    fixture.container.emit("controllerchange");
    assert.equal(await ready, matching);
    assert.deepEqual(clock.delays, [10_000]);
    assert.equal(fixture.container.listenerCount(), 0);
    assert.equal(fixture.registration.listenerCount(), 0);
    assert.equal(clock.count(), 0);
  });
});

test("times out a wrong controller with the expected script and scope diagnostic", async () => {
  const fixture = readyFixture({
    controllerScriptUrl: "https://example.test/b/service-worker.js",
  });
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const ready = ensureServiceWorkerReady("/a/service-worker.js");
    await flushPromises();
    clock.fire();
    await assert.rejects(
      ready,
      (error: Error) =>
        error.message.includes("https://example.test/a/service-worker.js") &&
        error.message.includes("https://example.test/a/"),
    );
    assert.equal(fixture.container.listenerCount(), 0);
    assert.equal(fixture.registration.listenerCount(), 0);
    assert.equal(clock.count(), 0);
  });
});

test("accepts only an explicit bridge-ready reply", async () => {
  const fixture = readyFixture();
  fixture.controller!.postMessageHandler = (message, transfer) => {
    assert.deepEqual(message, {
      type: "init-bridge",
      appPrefix: "/a/app/",
      sessionId: "01234567-89ab-4cde-8fab-0123456789ab",
    });
    (transfer[1] as MessagePort).postMessage({ type: "bridge-ready" });
    (transfer[0] as MessagePort).close();
  };

  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    assert.ok(await initServiceWorkerBridge(
      "/a/service-worker.js",
      "/a/",
      "/a/app/",
      "01234567-89ab-4cde-8fab-0123456789ab",
    ));
    assert.equal(clock.count(), 0);
  });
});

test("rejects a typed bridge initialization failure", async () => {
  const fixture = readyFixture();
  let replyPortClosed!: Promise<void>;
  fixture.controller!.postMessageHandler = (_message, transfer) => {
    const replyPort = transfer[1] as MessagePort & {
      on(type: "close", listener: () => void): void;
    };
    replyPortClosed = new Promise((resolve) => {
      replyPort.on("close", resolve);
    });
    replyPort.postMessage({
      type: "bridge-error",
      code: "bridge-init-failed",
    });
    (transfer[0] as MessagePort).close();
  };

  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    await assert.rejects(
      initServiceWorkerBridge(
        "/a/service-worker.js",
        "/a/",
        "/a/app/",
        "01234567-89ab-4cde-8fab-0123456789ab",
      ),
      /bridge-init-failed/,
    );
    await replyPortClosed;
    assert.equal(clock.count(), 0);
  });
});

test("rejects an unexpected bridge initialization reply", async () => {
  const fixture = readyFixture();
  fixture.controller!.postMessageHandler = (_message, transfer) => {
    (transfer[1] as MessagePort).postMessage({ type: "not-ready" });
    (transfer[0] as MessagePort).close();
  };

  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    await assert.rejects(
      initServiceWorkerBridge(
        "/a/service-worker.js",
        "/a/",
        "/a/app/",
        "01234567-89ab-4cde-8fab-0123456789ab",
      ),
      /unexpected bridge initialization reply/i,
    );
    assert.equal(clock.count(), 0);
  });
});

test("does not abandon an in-flight bridge transition", async () => {
  const fixture = readyFixture();
  let transferredPorts: Transferable[] = [];
  let bridgePosted!: () => void;
  const posted = new Promise<void>((resolve) => {
    bridgePosted = resolve;
  });
  fixture.controller!.postMessageHandler = (_message, transfer) => {
    transferredPorts = transfer;
    bridgePosted();
  };

  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    let outcome = "pending";
    const bridge = initServiceWorkerBridge(
      "/a/service-worker.js",
      "/a/",
      "/a/app/",
      "01234567-89ab-4cde-8fab-0123456789ab",
    ).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await posted;
    clock.fire();
    await flushPromises();
    assert.equal(outcome, "pending");
    (transferredPorts[1] as MessagePort).postMessage({ type: "bridge-ready" });
    await bridge;
    (transferredPorts[0] as MessagePort).close();
    assert.equal(outcome, "resolved");
    assert.equal(clock.count(), 0);
  });
});

test("cleans up when posting bridge initialization throws", async () => {
  const fixture = readyFixture();
  fixture.controller!.postMessageHandler = (_message, transfer) => {
    (transfer[0] as MessagePort).close();
    throw new Error("post failed");
  };

  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    await assert.rejects(
      initServiceWorkerBridge(
        "/a/service-worker.js",
        "/a/",
        "/a/app/",
        "01234567-89ab-4cde-8fab-0123456789ab",
      ),
      /post failed/,
    );
    assert.equal(clock.count(), 0);
  });
});
