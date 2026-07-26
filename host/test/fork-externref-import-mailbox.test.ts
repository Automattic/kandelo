import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  createForkExternrefImportMailbox,
  defineForkExternrefImport,
  forkExternrefImportMailboxBytes,
  ForkExternrefImportClosedError,
  ForkExternrefImportFailureCode,
  type ForkExternrefImportBinding,
  type ForkExternrefImportDescriptor,
  type ForkExternrefImportHandler,
  type ForkExternrefImportValueType,
  ForkExternrefImportOwnerCatalog,
  ForkExternrefImportOwnerEndpoint,
  ForkExternrefImportRemoteFailure,
  type ForkExternrefImportWake,
  ForkExternrefImportWorkerCaller,
} from "../src/fork-externref-import-mailbox";
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
    if (
      pid !== this.generation.pid
      || generationId !== this.generation.id
    ) {
      throw new Error(
        `stale test authority pid=${pid} generation=${generationId}`,
      );
    }
  }
}

interface Harness {
  readonly broker: ForkExternrefBroker;
  readonly generation: ForkExternrefGeneration;
  readonly tokens: ForkExternrefTokenCache;
  readonly binding: ForkExternrefImportBinding;
  readonly mailbox: SharedArrayBuffer;
  readonly catalog: ForkExternrefImportOwnerCatalog;
  readonly endpoint: ForkExternrefImportOwnerEndpoint;
  readonly caller: ForkExternrefImportWorkerCaller;
  readonly wakes: ForkExternrefImportWake[];
}

function harness(
  registrations: readonly [
    ForkExternrefImportDescriptor,
    ForkExternrefImportHandler,
  ][],
  options: {
    readonly authorizeSender?: (
      binding: ForkExternrefImportBinding,
    ) => void;
    readonly notify?: (
      wake: ForkExternrefImportWake,
      endpoint: ForkExternrefImportOwnerEndpoint,
      binding: ForkExternrefImportBinding,
    ) => void;
    readonly diagnostics?: Array<{
      error: unknown;
      failure: ForkExternrefImportFailureCode;
    }>;
    readonly onDiagnostic?: (
      error: unknown,
      failure: ForkExternrefImportFailureCode,
    ) => void;
  } = {},
): Harness {
  const broker = new ForkExternrefBroker();
  const generation = broker.createGeneration(101);
  const tokens = new ForkExternrefTokenCache(generation.id);
  const binding: ForkExternrefImportBinding = {
    pid: generation.pid,
    generationId: generation.id,
    senderId: 17,
  };
  const catalog = new ForkExternrefImportOwnerCatalog();
  for (const [descriptor, handler] of registrations) {
    catalog.register(descriptor, handler);
  }
  const mailbox = createForkExternrefImportMailbox(
    catalog.mailboxCapacity,
  );
  const authority = new TestAuthority(broker, generation);
  const endpoint = new ForkExternrefImportOwnerEndpoint(
    mailbox,
    binding,
    catalog,
    authority,
    {
      authorizeSender: options.authorizeSender ?? (() => {}),
      onDiagnostic: (error, failure) => {
        options.diagnostics?.push({ error, failure });
        options.onDiagnostic?.(error, failure);
      },
    },
  );
  const wakes: ForkExternrefImportWake[] = [];
  const caller = new ForkExternrefImportWorkerCaller(
    mailbox,
    binding,
    tokens,
    (wake) => {
      wakes.push(wake);
      if (options.notify) {
        options.notify(wake, endpoint, binding);
      } else if (!endpoint.dispatch(wake, binding)) {
        throw new Error("test owner did not claim current wake");
      }
    },
  );
  return {
    broker,
    generation,
    tokens,
    binding,
    mailbox,
    catalog,
    endpoint,
    caller,
    wakes,
  };
}

describe("fork externref host-import mailbox", () => {
  it("allocates one catalog-sized mailbox per Worker", () => {
    const empty = new ForkExternrefImportOwnerCatalog();
    const mailbox = createForkExternrefImportMailbox(
      empty.mailboxCapacity,
    );
    expect(mailbox).toBeInstanceOf(SharedArrayBuffer);
    expect(mailbox.byteLength).toBe(
      forkExternrefImportMailboxBytes({ params: 0, results: 0 }),
    );
    expect(mailbox.byteLength).toBe(72);

    expect(() =>
      defineForkExternrefImport(
        1,
        Array(257).fill("i32"),
        [],
      )
    ).not.toThrow();
    expect(() =>
      defineForkExternrefImport(1, ["v128" as never], [])
    ).toThrow(/unsupported fork externref import value type v128/);
  });

  it("rejects forged capacity metadata without allocating from it", () => {
    const mailbox = createForkExternrefImportMailbox({
      params: 0,
      results: 0,
    });
    // Header word 12 is the declared parameter capacity. A Worker receives an
    // already allocated SAB; it validates this count against byteLength and
    // never allocates storage based on the untrusted word.
    new DataView(mailbox).setUint32(12 * 4, 0xffff_ffff, true);
    const generation = new ForkExternrefBroker().createGeneration(102);
    const tokens = new ForkExternrefTokenCache(generation.id);

    expect(() =>
      new ForkExternrefImportWorkerCaller(
        mailbox,
        {
          pid: generation.pid,
          generationId: generation.id,
          senderId: 18,
        },
        tokens,
        () => {},
      )
    ).toThrow(/declared capacity requires exactly/);
  });

  it("round-trips signatures wider than 16 with exact tail validation", () => {
    const params = Array.from(
      { length: 40 },
      (_, index): ForkExternrefImportValueType =>
        index === 31 ? "i64" : "i32",
    );
    const results = Array.from(
      { length: 24 },
      (_, index): ForkExternrefImportValueType =>
        index === 22 ? "i64" : "i32",
    );
    const descriptor = defineForkExternrefImport(41, params, results);
    const resultValues = results.map((type, index) =>
      type === "i64" ? BigInt(index) : index === 0 ? 0 : -index
    );
    const state = harness([[
      descriptor,
      (_context, ...args) => {
        expect(args).toHaveLength(params.length);
        expect(args[31]).toBe(31n);
        return resultValues;
      },
    ]]);
    expect(state.mailbox.byteLength).toBe(
      forkExternrefImportMailboxBytes({ params: 40, results: 24 }),
    );

    const args = params.map((type, index) =>
      type === "i64" ? BigInt(index) : index
    );
    expect(state.caller.call(descriptor, args)).toEqual(resultValues);

    const mismatchedParams = [...params];
    mismatchedParams[31] = "f64";
    const mismatched = defineForkExternrefImport(
      descriptor.ordinal,
      mismatchedParams,
      results,
    );
    const mismatchedArgs = mismatchedParams.map((type, index) =>
      type === "i64" ? BigInt(index) : index
    );
    try {
      state.caller.call(mismatched, mismatchedArgs);
      throw new Error("expected wide signature mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ForkExternrefImportRemoteFailure);
      expect((error as ForkExternrefImportRemoteFailure).failureCode).toBe(
        ForkExternrefImportFailureCode.Protocol,
      );
    }
  });

  it("round-trips scalar bit patterns and owner-authorized externref aliases", () => {
    const descriptor = defineForkExternrefImport(
      1,
      ["i32", "i64", "f32", "f64", "externref"],
      ["i64", "f32", "f64", "externref"],
    );
    const realValue = { owner: true };
    const state = harness([
      [
        descriptor,
        (_context, i32, i64, f32, f64, externref) => {
          expect(i32).toBe(-17);
          expect(i64).toBe(-0x7fff_ffff_ffff_ffffn);
          expect(f32).toBe(Math.fround(1 / 3));
          expect(Object.is(f64, -0)).toBe(true);
          expect(externref).toBe(realValue);
          return [i64, f32, f64, externref];
        },
      ],
    ]);
    const handle = state.broker.register(state.generation, realValue);
    const token = state.tokens.materialize(handle);

    const result = state.caller.call(
      descriptor,
      [-17, -0x7fff_ffff_ffff_ffffn, 1 / 3, -0, token],
    );
    expect(result).toEqual([
      -0x7fff_ffff_ffff_ffffn,
      Math.fround(1 / 3),
      -0,
      token,
    ]);
    expect(Object.is((result as unknown[])[2], -0)).toBe(true);
  });

  it("normalizes a scalar-only host import exception into a forkable token", () => {
    const descriptor = defineForkExternrefImport(
      2,
      ["i32"],
      ["i32"],
    );
    const ownerError = new Error("owner-only failure");
    const state = harness([
      [
        descriptor,
        () => {
          throw ownerError;
        },
      ],
    ]);

    let parentToken: unknown;
    try {
      state.caller.call(descriptor, [41]);
      throw new Error("expected owner exception");
    } catch (error) {
      parentToken = error;
    }
    const handle = state.tokens.encode(parentToken);
    expect(handle).not.toBeNull();
    expect(state.broker.authorize(state.generation, handle!)).toBe(ownerError);

    // A fork child creates a different canonical token for the same leased
    // owner handle. CatchAllRef can retain that child-local identity without
    // consulting the parent's Worker or copying the Error through postMessage.
    const child = state.broker.createGeneration(102);
    state.broker.acquireFork(state.generation, child, [handle!]);
    const childTokens = new ForkExternrefTokenCache(child.id);
    const childToken = childTokens.materialize(handle!);
    expect(childToken).not.toBe(parentToken);
    expect(childTokens.encode(childToken)).toBe(handle);
    expect(state.broker.authorize(child, handle!)).toBe(ownerError);
  });

  it("gives thrown null a nonzero owner handle instead of the null sentinel", () => {
    const descriptor = defineForkExternrefImport(15, [], []);
    const state = harness([[descriptor, () => {
      throw null;
    }]]);

    let token: unknown;
    try {
      state.caller.call(descriptor, []);
      throw new Error("expected owner exception");
    } catch (error) {
      token = error;
    }
    expect(token).not.toBeNull();
    const handle = state.tokens.encode(token);
    expect(handle).not.toBeNull();
    expect(state.broker.authorize(state.generation, handle!)).toBeNull();
  });

  it("routes only numeric wake metadata and rejects stale duplicate wakes", () => {
    const descriptor = defineForkExternrefImport(3, ["i32"], ["i32"]);
    let previous: ForkExternrefImportWake | undefined;
    const state = harness(
      [[descriptor, (_context, value) => (value as number) + 1]],
      {
        notify: (wake, endpoint, binding) => {
          if (previous) {
            expect(endpoint.dispatch(previous, binding)).toBe(false);
          }
          expect(endpoint.dispatch(wake, binding)).toBe(true);
          previous = wake;
        },
      },
    );
    expect(state.caller.call(descriptor, [1])).toBe(2);
    expect(state.caller.call(descriptor, [2])).toBe(3);
    for (const wake of state.wakes) {
      expect(Object.values(wake).every((value) => typeof value === "number"))
        .toBe(true);
    }
    expect(state.wakes[1]!.sequenceLow).toBeGreaterThan(
      state.wakes[0]!.sequenceLow,
    );
  });

  it("requires independently observed exact sender identity", () => {
    const descriptor = defineForkExternrefImport(4, [], ["i32"]);
    let calls = 0;
    const state = harness(
      [[descriptor, () => ++calls]],
      {
        notify: (wake, endpoint, binding) => {
          expect(endpoint.dispatch(wake, {
            ...binding,
            senderId: binding.senderId + 1,
          })).toBe(false);
          expect(endpoint.dispatch(wake, binding)).toBe(true);
        },
      },
    );

    expect(state.caller.call(descriptor, [])).toBe(1);
    expect(calls).toBe(1);
  });

  it("fails a replaced sender generation before invoking its handler", () => {
    const descriptor = defineForkExternrefImport(5, [], ["i32"]);
    const diagnostics: Array<{
      error: unknown;
      failure: ForkExternrefImportFailureCode;
    }> = [];
    let current = false;
    let invoked = false;
    const state = harness(
      [[descriptor, () => {
        invoked = true;
        return 1;
      }]],
      {
        authorizeSender: () => {
          if (!current) throw new Error("process image was replaced");
        },
        diagnostics,
      },
    );

    expect(() => state.caller.call(descriptor, [])).toThrow(
      ForkExternrefImportRemoteFailure,
    );
    try {
      state.caller.call(descriptor, []);
    } catch (error) {
      expect((error as ForkExternrefImportRemoteFailure).failureCode).toBe(
        ForkExternrefImportFailureCode.Unauthorized,
      );
    }
    expect(invoked).toBe(false);
    expect(diagnostics.at(-1)?.failure).toBe(
      ForkExternrefImportFailureCode.Unauthorized,
    );

    current = true;
    expect(state.caller.call(descriptor, [])).toBe(1);
  });

  it("matches an ordinal's complete signature instead of trusting a hash", () => {
    const ownerDescriptor = defineForkExternrefImport(
      6,
      ["i32", "f64"],
      ["i32"],
    );
    const mismatchedWorkerDescriptor = defineForkExternrefImport(
      6,
      ["f32", "f64"],
      ["i32"],
    );
    let invoked = false;
    const state = harness([
      [ownerDescriptor, () => {
        invoked = true;
        return 1;
      }],
    ]);

    try {
      state.caller.call(mismatchedWorkerDescriptor, [1, 2]);
      throw new Error("expected signature rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ForkExternrefImportRemoteFailure);
      expect((error as ForkExternrefImportRemoteFailure).failureCode).toBe(
        ForkExternrefImportFailureCode.Protocol,
      );
    }
    expect(invoked).toBe(false);
  });

  it("rejects wrong-generation raw tokens before notifying the owner", () => {
    const descriptor = defineForkExternrefImport(
      7,
      ["externref"],
      ["externref"],
    );
    const state = harness([
      [descriptor, (_context, value) => value],
    ]);
    const foreignTokens = new ForkExternrefTokenCache(
      state.generation.id + 1,
    );

    expect(() =>
      state.caller.call(descriptor, [foreignTokens.materialize(9)])
    ).toThrow(/did not come from this process-image owner/);
    expect(state.wakes).toHaveLength(0);

    const value = { valid: true };
    const handle = state.broker.register(state.generation, value);
    const token = state.tokens.materialize(handle);
    expect(state.caller.call(descriptor, [token])).toBe(token);
  });

  it("rejects mailbox reentrancy rather than overwriting the live request", () => {
    const descriptor = defineForkExternrefImport(8, ["i32"], ["i32"]);
    let nestedError: unknown;
    let bound: (...args: Parameters<
      ForkExternrefImportWorkerCaller["call"]
    >) => unknown;
    const state = harness(
      [[descriptor, (_context, value) => value]],
      {
        notify: (wake, endpoint, binding) => {
          try {
            state.caller.call(descriptor, [99]);
          } catch (error) {
            nestedError = error;
          }
          expect(endpoint.dispatch(wake, binding)).toBe(true);
        },
      },
    );
    bound = state.caller.call.bind(state.caller);
    expect(bound(descriptor, [17])).toBe(17);
    expect(String(nestedError)).toMatch(/reentrant/);
  });

  it("lets main and side-module wrappers share one Worker mailbox", () => {
    const main = defineForkExternrefImport(9, ["i32"], ["i32"]);
    const side = defineForkExternrefImport(10, ["i64"], ["i64"]);
    const state = harness([
      [main, (_context, value) => (value as number) + 1],
      [side, (_context, value) => (value as bigint) + 1n],
    ]);
    const mainImport = state.caller.bind(main);
    const sideImport = state.caller.bind(side);

    expect(mainImport(4)).toBe(5);
    expect(sideImport(9n)).toBe(10n);
    expect(state.caller.mailbox).toBe(state.mailbox);
    expect(state.wakes).toHaveLength(2);
  });

  it("wakes a pending caller when process teardown closes the mailbox", () => {
    const descriptor = defineForkExternrefImport(11, [], []);
    const state = harness(
      [[descriptor, () => undefined]],
      {
        notify: (_wake, endpoint) => {
          endpoint.close(ForkExternrefImportFailureCode.Teardown);
        },
      },
    );

    try {
      state.caller.call(descriptor, []);
      throw new Error("expected closed mailbox");
    } catch (error) {
      expect(error).toBeInstanceOf(ForkExternrefImportClosedError);
      expect((error as ForkExternrefImportClosedError).reasonCode).toBe(
        ForkExternrefImportFailureCode.Teardown,
      );
    }
    expect(() => state.caller.call(descriptor, [])).toThrow(
      ForkExternrefImportClosedError,
    );
  });

  it("does not resurrect a mailbox closed during owner dispatch", () => {
    const descriptor = defineForkExternrefImport(12, [], ["i32"]);
    let endpoint: ForkExternrefImportOwnerEndpoint;
    const state = harness([
      [descriptor, () => {
        endpoint.close();
        return 42;
      }],
    ]);
    endpoint = state.endpoint;

    expect(() => state.caller.call(descriptor, [])).toThrow(
      ForkExternrefImportClosedError,
    );
  });

  it("does not let losing dispatch failure overwrite the teardown reason", () => {
    const descriptor = defineForkExternrefImport(14, [], ["i64"]);
    let endpoint: ForkExternrefImportOwnerEndpoint;
    const state = harness([
      [descriptor, () => {
        endpoint.close(
          ForkExternrefImportFailureCode.NotificationFailure,
        );
        // This invalid i64 result makes dispatch publish HandlerContract after
        // close. The caller must still observe the independently owned close
        // reason, not that losing completion.
        return 42;
      }],
    ]);
    endpoint = state.endpoint;

    try {
      state.caller.call(descriptor, []);
      throw new Error("expected closed mailbox");
    } catch (error) {
      expect(error).toBeInstanceOf(ForkExternrefImportClosedError);
      expect((error as ForkExternrefImportClosedError).reasonCode).toBe(
        ForkExternrefImportFailureCode.NotificationFailure,
      );
    }
  });

  it("reports handler result-shape failures without publishing partial data", () => {
    const descriptor = defineForkExternrefImport(13, [], ["i64", "i32"]);
    const diagnostics: Array<{
      error: unknown;
      failure: ForkExternrefImportFailureCode;
    }> = [];
    const state = harness(
      [[descriptor, () => [1n]]],
      { diagnostics },
    );

    try {
      state.caller.call(descriptor, []);
      throw new Error("expected handler contract failure");
    } catch (error) {
      expect((error as ForkExternrefImportRemoteFailure).failureCode).toBe(
        ForkExternrefImportFailureCode.HandlerContract,
      );
    }
    expect(diagnostics.at(-1)?.failure).toBe(
      ForkExternrefImportFailureCode.HandlerContract,
    );
  });

  it("completes a failure even when the diagnostic observer throws", () => {
    const descriptor = defineForkExternrefImport(16, [], ["i64"]);
    const state = harness(
      [[descriptor, () => 42]],
      {
        onDiagnostic: () => {
          throw new Error("broken diagnostic sink");
        },
      },
    );

    try {
      state.caller.call(descriptor, []);
      throw new Error("expected handler contract failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ForkExternrefImportRemoteFailure);
      expect((error as ForkExternrefImportRemoteFailure).failureCode).toBe(
        ForkExternrefImportFailureCode.HandlerContract,
      );
    }
  });

  it("blocks a real Worker while the owner returns only scalar wire data", async () => {
    const aliasDescriptor = defineForkExternrefImport(
      30,
      ["externref", "i64"],
      ["externref", "i64"],
    );
    const throwingDescriptor = defineForkExternrefImport(
      31,
      ["i32"],
      ["i32"],
    );
    const broker = new ForkExternrefBroker();
    const generation = broker.createGeneration(201);
    const binding: ForkExternrefImportBinding = {
      pid: generation.pid,
      generationId: generation.id,
      senderId: 29,
    };
    const realValue = { ownerOnly: true };
    const ownerError = new Error("owner-only exception");
    const inputHandle = broker.register(generation, realValue);
    const catalog = new ForkExternrefImportOwnerCatalog();
    catalog.register(
      aliasDescriptor,
      (_context, value, scalar) => [
        value,
        (scalar as bigint) - 1n,
      ],
    );
    catalog.register(throwingDescriptor, () => {
      throw ownerError;
    });
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
        "./fixtures/fork-externref-import-worker.ts",
        import.meta.url,
      ),
      {
        execArgv: ["--import", "tsx"],
        workerData: { mailbox, binding, inputHandle },
      },
    );

    try {
      const complete = new Promise<{
        resultHandle: number;
        resultScalar: bigint;
        exceptionHandle: number;
      }>((resolve, reject) => {
        worker.on("message", (message: {
          type: string;
          wake?: ForkExternrefImportWake;
          resultHandle?: number;
          resultScalar?: bigint;
          exceptionHandle?: number;
          message?: string;
        }) => {
          if (message.type === "wake") {
            if (!endpoint.dispatch(message.wake!, binding)) {
              reject(new Error("owner rejected current Worker wake"));
            }
          } else if (message.type === "complete") {
            resolve({
              resultHandle: message.resultHandle!,
              resultScalar: message.resultScalar!,
              exceptionHandle: message.exceptionHandle!,
            });
          } else if (message.type === "failed") {
            reject(new Error(message.message));
          }
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`externref import Worker exited ${code}`));
          }
        });
      });
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("externref import Worker watchdog expired")),
          5_000,
        );
      });
      const result = await Promise.race([complete, timeout]);

      expect(result.resultHandle).toBe(inputHandle);
      expect(result.resultScalar).toBe(-10n);
      expect(broker.authorize(generation, result.resultHandle)).toBe(
        realValue,
      );
      expect(broker.authorize(generation, result.exceptionHandle)).toBe(
        ownerError,
      );
    } finally {
      endpoint.close();
      await worker.terminate();
    }
  }, 8_000);
});
