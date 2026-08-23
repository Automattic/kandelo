import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const serviceWorkerSource = await readFile(
  new URL("./service-worker.js", import.meta.url),
  "utf8",
);

type Listener = () => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

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
}

class FakeWorker extends FakeTarget {
  state = "activated";

  constructor(readonly scriptURL: string) {
    super();
  }
}

class FakeRegistration extends FakeTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  updateCalls = 0;

  constructor(
    readonly scope: string,
    public active: FakeWorker | null,
  ) {
    super();
  }

  update(): Promise<void> {
    this.updateCalls += 1;
    return Promise.resolve();
  }
}

class FakeContainer extends FakeTarget {
  readonly calls: Array<{ url: string; options: unknown }> = [];
  controller: FakeWorker | null;

  constructor(
    private readonly registration: FakeRegistration,
    controller: FakeWorker | null,
  ) {
    super();
    this.controller = controller;
  }

  get ready(): never {
    throw new Error("origin-wide ready must not be consulted");
  }

  register(url: string, options: unknown): Promise<FakeRegistration> {
    this.calls.push({ url, options });
    return Promise.resolve(this.registration);
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function executeBootstrap(options: {
  scriptUrl: string;
  registrationScope?: string;
  activeScriptUrl?: string;
  controllerScriptUrl?: string | null;
  crossOriginIsolated?: boolean;
}) {
  const activeScriptUrl = options.activeScriptUrl ?? options.scriptUrl;
  const active = new FakeWorker(activeScriptUrl);
  const registration = new FakeRegistration(
    options.registrationScope ?? new URL("./", options.scriptUrl).href,
    active,
  );
  const controller = options.controllerScriptUrl === null
    ? null
    : new FakeWorker(options.controllerScriptUrl ?? options.scriptUrl);
  const serviceWorker = new FakeContainer(registration, controller);
  let reloadCalls = 0;
  const location = {
    href: new URL("page.html", new URL("./", options.scriptUrl)).href,
    reload() {
      reloadCalls += 1;
    },
  };
  const window = {
    crossOriginIsolated: options.crossOriginIsolated ?? false,
    location,
  };
  vm.runInNewContext(serviceWorkerSource, {
    URL,
    console: { warn() {} },
    document: { currentScript: { src: options.scriptUrl } },
    navigator: { serviceWorker },
    window,
  }, { filename: "public/service-worker.js" });
  return {
    active,
    get reloadCalls() {
      return reloadCalls;
    },
    registration,
    serviceWorker,
  };
}

test("the exact classic bootstrap registers a nested deployment explicitly", async () => {
  const fixture = executeBootstrap({
    scriptUrl: "https://example.test/a/service-worker.js",
    controllerScriptUrl: null,
  });
  await flushPromises();
  assert.equal(fixture.serviceWorker.calls.length, 1);
  assert.equal(
    fixture.serviceWorker.calls[0]?.url,
    "https://example.test/a/service-worker.js",
  );
  assert.equal(
    (fixture.serviceWorker.calls[0]?.options as { scope?: string }).scope,
    "/a/",
  );
  assert.equal(
    (fixture.serviceWorker.calls[0]?.options as { updateViaCache?: string })
      .updateViaCache,
    "none",
  );
});

test("the exact classic bootstrap retains explicit root development scope", async () => {
  const fixture = executeBootstrap({
    scriptUrl: "http://127.0.0.1:5401/service-worker.js",
    controllerScriptUrl: null,
  });
  await flushPromises();
  assert.equal(
    fixture.serviceWorker.calls[0]?.url,
    "http://127.0.0.1:5401/service-worker.js",
  );
  assert.equal(
    (fixture.serviceWorker.calls[0]?.options as { scope?: string }).scope,
    "/",
  );
  assert.equal(
    (fixture.serviceWorker.calls[0]?.options as { updateViaCache?: string })
      .updateViaCache,
    "none",
  );
});

test("the classic bootstrap ignores a sibling controller until its controller arrives", async () => {
  const fixture = executeBootstrap({
    scriptUrl: "https://example.test/a/service-worker.js",
    controllerScriptUrl: "https://example.test/b/service-worker.js",
  });
  await flushPromises();
  assert.equal(fixture.reloadCalls, 0);
  assert.equal(fixture.registration.updateCalls, 0);

  fixture.serviceWorker.emit("controllerchange");
  await flushPromises();
  assert.equal(fixture.reloadCalls, 0);

  fixture.serviceWorker.controller = fixture.active;
  fixture.serviceWorker.emit("controllerchange");
  await flushPromises();
  assert.equal(fixture.reloadCalls, 1);
});

test("the classic bootstrap neither reloads nor updates through the wrong registration", async () => {
  const fixture = executeBootstrap({
    scriptUrl: "https://example.test/a/service-worker.js",
    registrationScope: "https://example.test/b/",
    activeScriptUrl: "https://example.test/b/service-worker.js",
    controllerScriptUrl: "https://example.test/b/service-worker.js",
    crossOriginIsolated: true,
  });
  await flushPromises();
  assert.equal(fixture.reloadCalls, 0);
  assert.equal(fixture.registration.updateCalls, 0);
});
