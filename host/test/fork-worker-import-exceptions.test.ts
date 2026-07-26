import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  createForkExternrefImportMailbox,
  defineForkExternrefImport,
  type ForkExternrefImportBinding,
  type ForkExternrefImportWake,
  ForkExternrefImportOwnerCatalog,
  ForkExternrefImportOwnerEndpoint,
  ForkExternrefImportWorkerCaller,
} from "../src/fork-externref-import-mailbox";
import {
  ForkWorkerExceptionCapabilityOwner,
  ForkWorkerLocalImportExceptionNormalizer,
  FORK_WORKER_EXCEPTION_BEGIN_DESCRIPTOR,
  FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL,
} from "../src/fork-worker-import-exceptions";
import {
  isForkWorkerExceptionCapability,
  unwrapForkWorkerExceptionCapability,
} from "../src/fork-worker-exception-capability";
import {
  ForkExternrefBroker,
  type ForkExternrefGeneration,
  ForkExternrefTokenCache,
} from "../src/fork-reference-broker";

class TestAuthority {
  constructor(
    readonly broker: ForkExternrefBroker,
    readonly generation: ForkExternrefGeneration,
  ) {}

  authorizeForWire(
    pid: number,
    generationId: number,
    handle: number,
  ): unknown {
    this.assertBinding(pid, generationId);
    return this.broker.authorize(this.generation, handle);
  }

  registerForWire(
    pid: number,
    generationId: number,
    value: unknown,
  ): number {
    this.assertBinding(pid, generationId);
    return this.broker.register(this.generation, value);
  }

  private assertBinding(pid: number, generationId: number): void {
    expect(pid).toBe(this.generation.pid);
    expect(generationId).toBe(this.generation.id);
  }
}

function harness() {
  const broker = new ForkExternrefBroker();
  const generation = broker.createGeneration(301);
  const tokens = new ForkExternrefTokenCache(generation.id);
  const binding: ForkExternrefImportBinding = {
    pid: generation.pid,
    generationId: generation.id,
    senderId: 41,
  };
  const catalog = new ForkExternrefImportOwnerCatalog();
  const exceptionOwner = new ForkWorkerExceptionCapabilityOwner();
  exceptionOwner.install(catalog);
  const mailbox = createForkExternrefImportMailbox(
    catalog.mailboxCapacity,
  );
  const endpoint = new ForkExternrefImportOwnerEndpoint(
    mailbox,
    binding,
    catalog,
    new TestAuthority(broker, generation),
    { authorizeSender: () => {} },
  );
  const caller = new ForkExternrefImportWorkerCaller(
    mailbox,
    binding,
    tokens,
    (wake) => {
      expect(endpoint.dispatch(wake, binding)).toBe(true);
    },
  );
  const normalizer = new ForkWorkerLocalImportExceptionNormalizer(
    caller,
    tokens,
  );
  return {
    broker,
    generation,
    tokens,
    binding,
    exceptionOwner,
    endpoint,
    caller,
    normalizer,
  };
}

function thrownBy(fn: () => unknown): unknown {
  let didThrow = false;
  let thrown: unknown;
  try {
    fn();
  } catch (value) {
    didThrow = true;
    thrown = value;
  }
  expect(didThrow).toBe(true);
  return thrown;
}

function numberBits(value: number): bigint {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}

describe("Worker-local import exception normalization", () => {
  it("preserves every primitive before fork and normalizes it exactly for a child", () => {
    const state = harness();
    const customNanBytes = new ArrayBuffer(8);
    const customNanView = new DataView(customNanBytes);
    customNanView.setBigUint64(0, 0x7ff8_0000_0000_0042n, true);
    const customNan = customNanView.getFloat64(0, true);
    const longString =
      `prefix-\ud800-${"reference-state-".repeat(20)}-\udfff-suffix`;
    const hugeBigInt = (1n << 1000n) + 0x1234_5678_9abcn;
    const globalSymbol = Symbol.for(
      `kandelo-${"global-symbol-".repeat(12)}`,
    );
    const localSymbol = Symbol(`local-${"symbol-".repeat(20)}`);
    const values: unknown[] = [
      undefined,
      null,
      false,
      true,
      -0,
      customNan,
      17.25,
      hugeBigInt,
      longString,
      globalSymbol,
      localSymbol,
    ];

    for (const [ordinal, original] of values.entries()) {
      const wrapped = state.normalizer.wrap(ordinal, () => {
        throw original;
      });
      const importThrown = thrownBy(wrapped);
      expect(Object.is(importThrown, original)).toBe(true);

      const token =
        state.normalizer.normalizeUnclaimedForkException(importThrown);
      const handle = state.tokens.encode(token);
      expect(handle).not.toBeNull();
      const capability = state.broker.authorize(
        state.generation,
        handle!,
      );
      expect(isForkWorkerExceptionCapability(capability)).toBe(true);
      const boundary = unwrapForkWorkerExceptionCapability(capability);
      if (typeof original === "number" && Number.isNaN(original)) {
        expect(Number.isNaN(boundary)).toBe(true);
        expect(numberBits(boundary as number)).toBe(numberBits(original));
      } else if (typeof original === "symbol") {
        if (Symbol.keyFor(original) !== undefined) {
          expect(Symbol.keyFor(boundary as symbol)).toBe(
            Symbol.keyFor(original),
          );
        } else {
          expect((boundary as symbol).description).toBe(original.description);
        }
      } else {
        expect(Object.is(boundary, original)).toBe(true);
      }
    }
    expect(state.exceptionOwner.activeSessionCount).toBe(0);
  });

  it("preserves object/function/symbol rethrows and interns one child token", () => {
    const state = harness();
    const values: unknown[] = [
      { workerOnly: true },
      function workerOnlyFunction() {},
      Symbol("worker-only-symbol"),
    ];

    for (const [ordinal, original] of values.entries()) {
      const wrapped = state.normalizer.wrap(100 + ordinal, () => {
        throw original;
      });
      const first = thrownBy(wrapped);
      const second = thrownBy(wrapped);
      expect(first).toBe(original);
      expect(second).toBe(original);
      expect(state.tokens.encode(first)).toBeNull();

      const firstToken =
        state.normalizer.normalizeUnclaimedForkException(first);
      const secondToken =
        state.normalizer.normalizeUnclaimedForkException(second);
      expect(secondToken).toBe(firstToken);
      expect(state.tokens.encode(secondToken)).toBe(
        state.tokens.encode(firstToken),
      );

      const capability = state.broker.authorize(
        state.generation,
        state.tokens.encode(firstToken)!,
      );
      if (typeof original === "symbol") {
        expect(
          (unwrapForkWorkerExceptionCapability(capability) as symbol)
            .description,
        ).toBe(original.description);
      } else {
        expect(unwrapForkWorkerExceptionCapability(capability)).toBe(
          capability,
        );
      }
    }
  });

  it("keeps complete Error name/message fields on the opaque capability", () => {
    const state = harness();
    const error = new TypeError(
      `bad-reference-${"payload-".repeat(30)}`,
    );
    const wrapped = state.normalizer.wrap(207, () => {
      throw error;
    });
    const importThrown = thrownBy(wrapped);
    expect(importThrown).toBe(error);
    const token =
      state.normalizer.normalizeUnclaimedForkException(importThrown);
    const capability = state.broker.authorize(
      state.generation,
      state.tokens.encode(token)!,
    );

    expect(isForkWorkerExceptionCapability(capability)).toBe(true);
    expect(capability).toMatchObject({
      sourceImportOrdinal: FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL,
      kind: "error",
      name: "TypeError",
      message: error.message,
    });
    expect(unwrapForkWorkerExceptionCapability(capability)).toBe(capability);
  });

  it("preserves tagged catches before fork and normalizes only an unclaimed tag", () => {
    const state = harness();
    const tag = new WebAssembly.Tag({ parameters: ["i32"] });
    const exception = new WebAssembly.Exception(tag, [37]);

    const ordinary = state.normalizer.wrap(208, () => {
      throw exception;
    });
    expect(thrownBy(ordinary)).toBe(exception);

    // ForkExceptionBroker calls this only after every activation-local exact
    // tag codec has declined the exception.
    const normalized =
      state.normalizer.normalizeUnclaimedForkException(exception);
    expect(normalized).not.toBe(exception);
    const capability = state.broker.authorize(
      state.generation,
      state.tokens.encode(normalized)!,
    );
    expect(capability).toMatchObject({
      sourceImportOrdinal: FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL,
      kind: "object",
    });
  });

  it("keeps nested Wasm traps fatal rather than turning them into JSTag values", () => {
    const state = harness();
    const original = new WebAssembly.RuntimeError("nested Wasm trap");
    const wrapped = state.normalizer.wrap(210, () => {
      throw original;
    });

    const trapped = thrownBy(wrapped);
    expect(trapped).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(trapped).not.toBe(original);
    expect(state.tokens.encode(trapped)).toBeNull();
  });

  it("recreates a distinct child token for the same durable capability", () => {
    const state = harness();
    const workerOnly = Object.freeze({ cannotClone: () => 1 });
    const parentToken =
      state.normalizer.normalizeUnclaimedForkException(workerOnly);
    const handle = state.tokens.encode(parentToken)!;

    const child = state.broker.createGeneration(302);
    state.broker.acquireFork(state.generation, child, [handle]);
    const childTokens = new ForkExternrefTokenCache(child.id);
    const childToken = childTokens.materialize(handle);

    expect(childToken).not.toBe(parentToken);
    expect(childTokens.encode(childToken)).toBe(handle);
    expect(state.broker.authorize(child, handle)).toBe(
      state.broker.authorize(state.generation, handle),
    );
  });

  it("drops incomplete scalar sessions when the exact Worker is torn down", () => {
    const state = harness();
    state.caller.call(FORK_WORKER_EXCEPTION_BEGIN_DESCRIPTOR, [
      1,
      9,
      6,
      0,
      0n,
      100,
      0,
    ]);
    expect(state.exceptionOwner.activeSessionCount).toBe(1);

    state.exceptionOwner.clearBinding(state.binding);
    state.endpoint.close();
    expect(state.exceptionOwner.activeSessionCount).toBe(0);
  });

  it("replays a Worker-only opaque exception through a real fresh child Worker", async () => {
    const broker = new ForkExternrefBroker();
    const parentGeneration = broker.createGeneration(501);
    const parentBinding: ForkExternrefImportBinding = {
      pid: parentGeneration.pid,
      generationId: parentGeneration.id,
      senderId: 51,
    };
    const catalog = new ForkExternrefImportOwnerCatalog();
    const exceptionOwner = new ForkWorkerExceptionCapabilityOwner();
    exceptionOwner.install(catalog);
    const echo = defineForkExternrefImport(
      77,
      ["externref"],
      ["externref"],
    );
    catalog.register(echo, (_context, value) => value);

    const runWorker = async (
      mode: "parent" | "child",
      generation: ForkExternrefGeneration,
      binding: ForkExternrefImportBinding,
      inheritedHandle?: number,
    ): Promise<number> => {
      const mailbox = createForkExternrefImportMailbox(
        catalog.mailboxCapacity,
      );
      const endpoint = new ForkExternrefImportOwnerEndpoint(
        mailbox,
        binding,
        catalog,
        new TestAuthority(broker, generation),
        { authorizeSender: () => {} },
      );
      const worker = new Worker(
        new URL(
          "./fixtures/fork-worker-import-exception-worker.ts",
          import.meta.url,
        ),
        {
          execArgv: ["--import", "tsx"],
          workerData: {
            mode,
            binding,
            inheritedHandle,
            init: {
              mailbox,
              senderId: binding.senderId,
              ownerImports: [{
                module: "host",
                name: "echo",
                descriptor: echo,
              }],
            },
          },
        },
      );
      try {
        return await new Promise<number>((resolve, reject) => {
          const watchdog = setTimeout(
            () => reject(new Error(`${mode} Worker watchdog expired`)),
            5_000,
          );
          const settle = (action: () => void) => {
            clearTimeout(watchdog);
            action();
          };
          worker.on("message", (message: {
            type: string;
            wake?: ForkExternrefImportWake;
            handle?: number;
            message?: string;
          }) => {
            if (message.type === "wake") {
              if (!endpoint.dispatch(message.wake!, binding)) {
                settle(() =>
                  reject(new Error(`${mode} Worker wake was not claimed`))
                );
              }
            } else if (message.type === "complete") {
              settle(() => resolve(message.handle!));
            } else if (message.type === "failed") {
              settle(() => reject(new Error(message.message)));
            }
          });
          worker.once("error", (error) => settle(() => reject(error)));
        });
      } finally {
        exceptionOwner.clearBinding(binding);
        endpoint.close();
        await worker.terminate();
      }
    };

    const parentHandle = await runWorker(
      "parent",
      parentGeneration,
      parentBinding,
    );
    const capability = broker.authorize(parentGeneration, parentHandle);
    expect(isForkWorkerExceptionCapability(capability)).toBe(true);
    expect(capability).toMatchObject({
      kind: "object",
      sourceImportOrdinal: FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL,
    });

    const childGeneration = broker.createGeneration(502);
    broker.acquireFork(parentGeneration, childGeneration, [parentHandle]);
    const childHandle = await runWorker(
      "child",
      childGeneration,
      {
        pid: childGeneration.pid,
        generationId: childGeneration.id,
        senderId: 52,
      },
      parentHandle,
    );
    expect(childHandle).toBe(parentHandle);
    expect(broker.authorize(childGeneration, childHandle)).toBe(capability);
  }, 12_000);
});
