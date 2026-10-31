import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureServiceWorkerReady,
  pageBuildId,
  ServiceWorkerBuildMismatchError,
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
  updates = 0;
  onUpdate: () => Promise<void> = async () => {};

  constructor(
    readonly scope: string,
    public active: FakeWorker | null,
  ) {
    super();
  }

  async update(): Promise<void> {
    this.updates++;
    await this.onUpdate();
  }
}

/**
 * How a worker answers the page's build-id fetch, like public/service-worker.js:
 * a string id, `null` for a worker that predates build ids (the request falls
 * through to the server: 404), or "silent" for one that never answers.
 */
const workerBuildIds = new WeakMap<FakeWorker, string | null | "silent">();

function answersBuild(worker: FakeWorker, buildId: string | null | "silent"): FakeWorker {
  workerBuildIds.set(worker, buildId);
  return worker;
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

/** Let MessagePort replies (macrotasks) and the promises after them run. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !condition(); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "condition never held");
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
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  // The page's fetches reach whichever worker controls it at that moment.
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: URL | string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const answer = container.controller === null
        ? null
        : workerBuildIds.get(container.controller) ?? null;
      if (!url.pathname.endsWith("/__kandelo_build_id") || answer === null) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (answer === "silent") {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(Response.json({ type: "kandelo-build-id", buildId: answer }));
    },
  });
  try {
    return await run(clock);
  } finally {
    if (fetchDescriptor !== undefined) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
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

test("resolves at once when the controller reports the page's build", async () => {
  const fixture = readyFixture();
  answersBuild(fixture.controller!, "build-b");
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const mismatches: Array<string | null> = [];
    assert.equal(
      await ensureServiceWorkerReady("/a/service-worker.js", undefined, {
        buildId: "build-b",
        onBuildMismatch: (id) => mismatches.push(id),
      }),
      fixture.controller,
    );
    assert.equal(fixture.registration.updates, 0);
    assert.deepEqual(mismatches, []);
    assert.equal(clock.count(), 0);
  });
});

test("waits for its own deployment's worker to take control before resolving", async () => {
  // The first navigation after a deploy: the previous deployment's worker
  // answers, and the page must not boot until its own worker controls it.
  const fixture = readyFixture();
  answersBuild(fixture.controller!, "build-a");
  const next = answersBuild(new FakeWorker("https://example.test/a/service-worker.js"), "build-b");
  fixture.registration.onUpdate = async () => {
    next.state = "installing";
    fixture.registration.installing = next;
  };
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const mismatches: Array<string | null> = [];
    let resolved = false;
    const ready = ensureServiceWorkerReady("/a/service-worker.js", undefined, {
      buildId: "build-b",
      onBuildMismatch: (id) => mismatches.push(id),
    }).then((worker) => { resolved = true; return worker; });
    await until(() => fixture.registration.installing === next);
    assert.equal(fixture.registration.updates, 1);
    assert.deepEqual(mismatches, ["build-a"]);
    assert.equal(resolved, false, "the page waits while the new worker installs");
    // Activation with skipWaiting + clients.claim().
    fixture.registration.installing = null;
    fixture.registration.active = next;
    next.state = "activated";
    fixture.container.controller = next;
    fixture.container.emit("controllerchange");
    assert.equal(await ready, next);
    assert.equal(fixture.container.listenerCount(), 0);
    assert.equal(clock.count(), 0);
  });
});

test("names both builds when the server still serves the running worker", async () => {
  // An edge that keeps an old service-worker.js: update() finds the worker
  // already running, so no takeover will come.
  const fixture = readyFixture();
  answersBuild(fixture.controller!, "build-a");
  fixture.registration.active = fixture.controller;
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    await assert.rejects(
      ensureServiceWorkerReady("/a/service-worker.js", undefined, { buildId: "build-b" }),
      (error: unknown) =>
        error instanceof ServiceWorkerBuildMismatchError &&
        error.pageBuildId === "build-b" && error.workerBuildId === "build-a" &&
        error.message.includes("build-b") && error.message.includes("build-a"),
    );
    assert.equal(fixture.registration.updates, 1);
    assert.equal(fixture.container.listenerCount(), 0);
    assert.equal(clock.count(), 0, `pending timers: ${clock.delays.join(",")}`);
  });
});

test("treats a worker that predates build ids as a build without an id", async () => {
  const fixture = readyFixture();
  answersBuild(fixture.controller!, null);
  fixture.registration.active = fixture.controller;
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async () => {
    await assert.rejects(
      ensureServiceWorkerReady("/a/service-worker.js", undefined, { buildId: "build-b" }),
      (error: unknown) =>
        error instanceof ServiceWorkerBuildMismatchError && error.workerBuildId === null &&
        /does not report its id/.test(error.message),
    );
  });
});

test("gives a silent worker 2 s to answer", async () => {
  const fixture = readyFixture();
  answersBuild(fixture.controller!, "silent");
  fixture.registration.active = fixture.controller;
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const ready = ensureServiceWorkerReady("/a/service-worker.js", undefined, {
      buildId: "build-b",
    });
    await until(() => clock.delays.includes(2_000));
    clock.fire();
    await assert.rejects(
      ready,
      (error: unknown) =>
        error instanceof ServiceWorkerBuildMismatchError && error.workerBuildId === null,
    );
  });
});

test("gives up with both builds named when the new worker never takes control", async () => {
  const fixture = readyFixture();
  answersBuild(fixture.controller!, "build-a");
  const next = new FakeWorker("https://example.test/a/service-worker.js");
  fixture.registration.onUpdate = async () => {
    fixture.registration.installing = next;
  };
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const ready = ensureServiceWorkerReady("/a/service-worker.js", undefined, {
      buildId: "build-b",
    });
    await until(() => fixture.registration.installing === next);
    await flushPromises();
    assert.ok(clock.delays.includes(15_000));
    clock.fire();
    await assert.rejects(
      ready,
      (error: unknown) =>
        error instanceof ServiceWorkerBuildMismatchError &&
        error.workerBuildId === "build-a" && /did not take control/.test(error.message),
    );
    assert.equal(fixture.container.listenerCount(), 0);
  });
});

test("reads the page's build id from its meta element and refuses a page without one", () => {
  const document = (content: string | null) => ({
    querySelector: (selector: string) =>
      selector === 'meta[name="kandelo-build-id"]' && content !== null
        ? { getAttribute: (name: string) => (name === "content" ? content : null) }
        : null,
  }) as unknown as Pick<Document, "querySelector">;
  assert.equal(pageBuildId(document("0123456789abcdef0123")), "0123456789abcdef0123");
  assert.throws(() => pageBuildId(document(null)), /no Kandelo build id/);
  assert.throws(() => pageBuildId(document("")), /no Kandelo build id/);
});

test("waits for a worker the browser's own update already brought, without asking again", async () => {
  const fixture = readyFixture();
  answersBuild(fixture.controller!, "build-a");
  const next = answersBuild(new FakeWorker("https://example.test/a/service-worker.js"), "build-b");
  next.state = "installed";
  fixture.registration.waiting = next;
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async () => {
    const ready = ensureServiceWorkerReady("/a/service-worker.js", undefined, {
      buildId: "build-b",
    });
    await until(() => fixture.container.listenerCount() > 0);
    fixture.registration.waiting = null;
    fixture.registration.active = next;
    next.state = "activated";
    fixture.container.controller = next;
    fixture.container.emit("controllerchange");
    assert.equal(await ready, next);
    assert.equal(fixture.registration.updates, 0);
  });
});
