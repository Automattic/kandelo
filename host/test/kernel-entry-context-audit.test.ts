import { describe, expect, it } from "vitest";
import {
  auditKernelEntryContext,
  type KernelEntryContextViolationKind,
} from "./support/kernel-entry-context-audit";

function violationKinds(source: string): KernelEntryContextViolationKind[] {
  return auditKernelEntryContext(source).map(({ kind }) => kind);
}

describe("kernel entry-context static audit", () => {
  it("accepts explicit lexical authority and detached host effects", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        private io = { write(): void {} };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #write(
          bytes: Uint8Array,
          entry?: KernelWorkerEntryContext,
        ): void {
          const fn = this.#kernelInstanceForEntry(entry).exports.write as
            (length: number) => void;
          fn(bytes.byteLength);
          entry?.deferObserverEffect(() => {
            this.io.write();
          });
        }
        dispatch(bytes: Uint8Array): void {
          this.#runOrDeferKernelEntry("write", (entry) => {
            this.#write(bytes, entry);
          });
        }
      }
    `);

    expect(violations).toEqual([]);
  });

  it("audits immediate-result ingress as an exact lexical root", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        #runImmediateKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry.instance;
        }
        #read(entry: KernelWorkerEntryContext): void {
          const fn = this.#kernelInstanceForEntry(entry).exports.read as
            () => void;
          fn();
        }
        claim(): void {
          this.#runImmediateKernelEntry("claim", (entry) => {
            this.#read(entry);
          });
        }
        badClaim(): void {
          this.#runImmediateKernelEntry("bad claim", (_entry) => {
            this.#read(undefined as unknown as KernelWorkerEntryContext);
          });
        }
      }
    `);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "missing-explicit-entry",
      owner: expect.stringContaining("<scoped-root@"),
    });
  });

  it("admits only exact synchronous serialized host operations", () => {
    const safe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        private io = { read(): number { return 7; } };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #invokeSharedMmapHostOperation<T>(
          _entry: KernelWorkerEntryContext | undefined,
          operation: () => T,
        ): T {
          return operation();
        }
        #read(entry: KernelWorkerEntryContext): number {
          return this.#invokeSharedMmapHostOperation(
            entry,
            () => this.io.read(),
          );
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("read", (entry) => {
            void this.#read(entry);
          });
        }
      }
    `);
    expect(safe).toEqual([]);

    const unsafe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        private io = { read(): number { return 7; } };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #invokeSharedMmapHostOperation<T>(
          _entry: KernelWorkerEntryContext | undefined,
          operation: () => T,
        ): T {
          return operation();
        }
        #workerHelper(): void {}
        #hostCallback(): number {
          return this.io.read();
        }
        #bad(entry: KernelWorkerEntryContext): void {
          this.io.read();
          this.#invokeSharedMmapHostOperation(
            undefined,
            async () => this.io.read(),
          );
          this.#invokeSharedMmapHostOperation(entry, () => {
            void entry.instance;
            return this.io.read();
          });
          this.#invokeSharedMmapHostOperation(entry, () => {
            this.#workerHelper();
          });
          this.#invokeSharedMmapHostOperation(entry, this.#hostCallback);
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("bad", (entry) => {
            this.#bad(entry);
          });
        }
      }
    `);
    const kinds = unsafe.map(({ kind }) => kind);
    expect(kinds).toContain("host-effect-in-scoped-graph");
    expect(kinds).toContain("missing-explicit-entry");
    expect(kinds).toContain("scoped-method-async");
    expect(kinds).toContain("context-detached-capture");
    expect(kinds).toContain("nonlexical-entry-operation");
  });

  it("rejects authority storage, async capture, bare selectors, and host effects", () => {
    const kinds = violationKinds(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #saved: KernelWorkerEntryContext | null = null;
        private callbacks = { onExit(): void {} };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
          _dedupe?: object,
          _legacyPost?: () => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #exporting(entry?: KernelWorkerEntryContext): void {
          const fn = this.#kernelInstanceForEntry().exports.write as
            () => void;
          fn();
          this.callbacks.onExit();
          Promise.resolve().then(() => {
            this.#kernelInstanceForEntry(entry);
          });
        }
        #bad(entry: KernelWorkerEntryContext): KernelWorkerEntryContext {
          const alias = entry;
          this.#saved = entry;
          this.#exporting(entry);
          entry.deferObserverEffect(() => this.#exporting(entry));
          return alias;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry(
            "bad",
            (entry) => this.#bad(entry),
            undefined,
            () => this.callbacks.onExit(),
          );
        }
      }
    `);

    for (const expected of [
      "bare-entry-selector",
      "context-alias",
      "context-async-capture",
      "context-detached-capture",
      "context-return",
      "context-storage",
      "export-from-detached-effect",
      "host-effect-in-scoped-graph",
      "legacy-detached-operation",
    ] satisfies KernelEntryContextViolationKind[]) {
      expect(kinds).toContain(expected);
    }
  });

  it("rejects a scoped call chain that drops its explicit entry parameter", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(): void {
          const fn = this.#kernelInstanceForEntry().exports.read as
            () => void;
          fn();
        }
        #middle(_entry?: KernelWorkerEntryContext): void {
          this.#leaf();
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("read", (entry) => {
            this.#middle(entry);
          });
        }
      }
    `);

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "export-call-without-entry-channel",
        owner: "CentralizedKernelWorker.#middle",
      }),
    ]));
  });

  it("treats a nested ingress operation as a fresh lexical context", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(entry: KernelWorkerEntryContext): void {
          const fn = this.#kernelInstanceForEntry(entry).exports.read as
            () => void;
          fn();
        }
        #nested(_outerEntry: KernelWorkerEntryContext): void {
          this.#runOrDeferKernelEntry("nested", (innerEntry) => {
            this.#leaf(innerEntry);
          });
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            this.#nested(entry);
          });
        }
      }
    `);

    expect(violations).toEqual([]);
  });

  it("rejects detached authority aliases and nonlexical callbacks", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        scope: object;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #exporting(entry: KernelWorkerEntryContext): void {
          const instance = this.#kernelInstanceForEntry(entry);
          const write = instance.exports.write as () => void;
          entry.deferObserverEffect(() => write());
        }
        #fieldCallback(_entry: KernelWorkerEntryContext): void {}
        #bad(entry: KernelWorkerEntryContext): void {
          const directAlias = entry;
          const scopeAlias = entry.scope;
          void directAlias;
          entry.deferObserverEffect(() => void scopeAlias);
          entry.deferObserverEffect(this.#fieldCallback);
          entry.deferObserverEffect.call(entry, () => {});
          this.#kernelInstanceForEntry.call(this, entry);
          this.#kernelInstanceForEntry.apply(this, [entry]);
          const selectorAlias = this.#kernelInstanceForEntry;
          const bound = this.#kernelInstanceForEntry.bind(this, entry);
          void selectorAlias;
          void bound;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("bad", this.#bad);
        }
      }
    `);
    const kinds = violations.map(({ kind }) => kind);

    expect(kinds).toContain("context-alias");
    expect(kinds).toContain("context-detached-capture");
    expect(kinds).toContain("nonlexical-detached-effect");
    expect(kinds).toContain("nonlexical-entry-operation");
    expect(
      kinds.filter((kind) => kind === "indirect-entry-authority").length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("rejects destructured authority and synchronous closure escape", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        scope: object;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #leak(
          entry: KernelWorkerEntryContext,
        ): () => WebAssembly.Instance {
          const { scope } = entry;
          void scope;
          const closure = () => entry.instance;
          return closure;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("leak", (entry) => {
            void this.#leak(entry);
          });
        }
      }
    `);

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context-alias" }),
      expect.objectContaining({ kind: "context-return" }),
    ]));
  });

  it("requires async callbacks that export to open a fresh ingress", () => {
    const unsafe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(entry?: KernelWorkerEntryContext): void {
          const fn = this.#kernelInstanceForEntry(entry).exports.read as
            () => void;
          fn();
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (_entry) => {
            setTimeout(() => this.#leaf(), 0);
            queueMicrotask(() => {
              this.#kernelInstanceForEntry().exports.read;
            });
          });
        }
        promiseDispatch(): void {
          this.#runOrDeferKernelEntry("promise", (entry) => {
            const launch: Promise<void> = Promise.resolve();
            launch.then(() => this.#leaf(entry));
          });
        }
      }
    `);
    expect(unsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "async-export-without-ingress" }),
      expect.objectContaining({ kind: "context-async-capture" }),
    ]));

    const safe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(entry: KernelWorkerEntryContext): void {
          const fn = this.#kernelInstanceForEntry(entry).exports.read as
            () => void;
          fn();
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (_entry) => {
            setTimeout(() => {
              this.#runOrDeferKernelEntry("timer", (timerEntry) => {
                this.#leaf(timerEntry);
              });
            }, 0);
          });
        }
      }
    `);
    expect(safe).toEqual([]);
  });

  it("follows reviewed listener APIs, callback objects, and local scheduler wrappers", () => {
    const source = (operation: string) => `
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(entry?: KernelWorkerEntryContext): void {
          void this.#kernelInstanceForEntry(entry).exports.read;
        }
        #registerTimeout(operation: () => void, delay: number): void {
          setTimeout(operation, delay);
        }
        #registerInterval(operation: () => void, delay: number): void {
          setInterval(operation, delay);
        }
        #customSchedule(operation: () => void): void {
          this.#registerTimeout(operation, 0);
        }
        #continuePromise(
          promise: Promise<void>,
          operation: () => void,
        ): void {
          promise.then(operation);
        }
        #later(): void {
          ${operation}
        }
      }
    `;
    const unsafeOperations = [
      `this.#customSchedule(() => this.#leaf());`,
      `this.#registerInterval(() => this.#leaf(), 1);`,
      `const promise: Promise<void> = Promise.resolve();
       this.#continuePromise(promise, () => this.#leaf());`,
      `const channel = new MessageChannel();
       channel.port1.onmessage = () => this.#leaf();`,
      `const socket = {} as {
         on(name: string, listener: () => void): void;
       };
       socket.on("data", () => this.#leaf());`,
      `const network = {} as {
         bindUdp(
           key: string,
           address: Uint8Array,
           port: number,
           callbacks: { receive(): void },
         ): void;
       };
       network.bindUdp("key", new Uint8Array(), 7, {
         receive: () => this.#leaf(),
       });`,
      `new WasmPosixKernel({}, {}, {
         onAlarm: () => {
           this.#leaf();
           return 0;
         },
       });`,
    ];
    for (const operation of unsafeOperations) {
      expect(auditKernelEntryContext(source(operation))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "async-export-without-ingress",
            owner: "CentralizedKernelWorker.#later",
          }),
        ]),
      );
    }

    const safeOperations = unsafeOperations.map((operation) =>
      operation.replace(
        /this\.#leaf\(\)/g,
        `this.#runOrDeferKernelEntry("listener", (entry) => {
           this.#leaf(entry);
         })`,
      )
    );
    for (const operation of safeOperations) {
      expect(auditKernelEntryContext(source(operation))).toEqual([]);
    }
  });

  it("requires transaction continuations to re-enter through the exact channel", () => {
    const source = (transaction: string) => `
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
        deferProtocolTransactionStart(operation: () => undefined): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        private callbacks = {
          launch(): Promise<number> {
            return Promise.resolve(7);
          },
        };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #runOrDeferChannelKernelEntry(
          _channel: object,
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #runOrDeferPendingSpawnCompletionKernelEntry(
          _childPid: number,
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #continuePromise<T>(
          promise: Promise<T>,
          onFulfilled: (value: T) => unknown,
          onRejected?: (cause: unknown) => unknown,
        ): void {
          promise.then(onFulfilled, onRejected);
        }
        #finish(entry: KernelWorkerEntryContext): void {
          void this.#kernelInstanceForEntry(entry).exports.finish;
        }
        #start(
          channel: object,
          entry: KernelWorkerEntryContext,
        ): void {
          ${transaction}
        }
        dispatch(channel: object): void {
          this.#runOrDeferChannelKernelEntry(
            channel,
            "dispatch",
            (entry) => this.#start(channel, entry),
          );
        }
      }
    `;

    const capturedOuterEntry = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(() => {
        void this.#continuePromise(this.callbacks.launch(), () => {
          this.#runOrDeferChannelKernelEntry(
            channel,
            "finish",
            (_innerEntry) => this.#finish(entry),
          );
        });
        return undefined;
      });
    `));
    expect(capturedOuterEntry).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context-detached-capture" }),
    ]));

    const wrongIngress = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(() => {
        void this.#continuePromise(this.callbacks.launch(), () => {
          this.#runOrDeferKernelEntry("finish", (innerEntry) => {
            this.#finish(innerEntry);
          });
        });
        return undefined;
      });
    `));
    expect(wrongIngress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "transaction-continuation-without-channel-ingress",
      }),
    ]));

    const directCompletion = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(() => {
        void this.#continuePromise(
          this.callbacks.launch(),
          () => this.#finish({} as KernelWorkerEntryContext),
        );
        return undefined;
      });
    `));
    expect(directCompletion).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "async-export-without-ingress" }),
      expect.objectContaining({
        kind: "transaction-continuation-without-channel-ingress",
      }),
    ]));

    const asyncStart = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(async () => {
        await this.callbacks.launch();
      });
    `));
    expect(asyncStart).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "async-detached-effect" }),
    ]));

    const safe = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(() => {
        void this.#continuePromise(
          this.callbacks.launch(),
          (_result) => {
            this.#runOrDeferChannelKernelEntry(
              channel,
              "finish",
              (innerEntry) => this.#finish(innerEntry),
            );
          },
          (_cause) => {
            this.#runOrDeferChannelKernelEntry(
              channel,
              "rollback",
              (innerEntry) => this.#finish(innerEntry),
            );
          },
        );
        return undefined;
      });
    `));
    expect(safe).toEqual([]);

    const safeAfterParentRetirement = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(() => {
        void this.#continuePromise(
          this.callbacks.launch(),
          (_result) => {
            this.#runOrDeferPendingSpawnCompletionKernelEntry(
              42,
              "finish detached spawn",
              (innerEntry) => this.#finish(innerEntry),
            );
          },
        );
        return undefined;
      });
    `));
    expect(safeAfterParentRetirement).toEqual([]);

    const nonlexicalDetachedSpawnCompletion = auditKernelEntryContext(source(`
      entry.deferProtocolTransactionStart(() => {
        const finish = (innerEntry: KernelWorkerEntryContext) => {
          this.#finish(innerEntry);
        };
        void this.#continuePromise(this.callbacks.launch(), (_result) => {
          this.#runOrDeferPendingSpawnCompletionKernelEntry(
            42,
            "finish detached spawn",
            finish,
          );
        });
        return undefined;
      });
    `));
    expect(nonlexicalDetachedSpawnCompletion).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "nonlexical-entry-operation" }),
    ]));
  });

  it("keeps unknown HOFs synchronous and honors lexical shadowing", () => {
    const safe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(entry: KernelWorkerEntryContext): void {
          this.#kernelInstanceForEntry(entry).exports.read;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            const setTimeout = (operation: () => void) => operation();
            setTimeout(() => this.#leaf(entry));
            ({ run(operation: () => void) { operation(); } }).run(
              () => this.#leaf(entry),
            );
            for (const entry of [1, 2]) void entry;
            { const entry = "shadow"; void entry; }
            [1].forEach((entry) => void entry);
          });
        }
      }
    `);
    expect(safe).toEqual([]);

    const unsafe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #leaf(entry?: KernelWorkerEntryContext): void {
          this.#kernelInstanceForEntry(entry).exports.read;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (_entry) => {
            const run = () => this.#leaf();
            run();
          });
        }
      }
    `);
    expect(unsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "missing-explicit-entry",
      }),
    ]));
  });

  it("distinguishes host capability reads from calls and mutations", () => {
    const source = (operation: string) => `
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        private callbacks = { onExit(): void {}, status: 0 };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (_entry) => {
            ${operation}
          });
        }
      }
    `;
    expect(
      auditKernelEntryContext(source("void this.callbacks.onExit;")),
    ).toEqual([]);
    for (const operation of [
      "this.callbacks.onExit();",
      "this.callbacks.status = 1;",
      "const callback = this.callbacks.onExit; callback();",
    ]) {
      expect(auditKernelEntryContext(source(operation))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "host-effect-in-scoped-graph",
          }),
        ]),
      );
    }
  });

  it("rejects cross-ingress and detached authority but accepts materialized publication", () => {
    const unsafe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #nested(outer: KernelWorkerEntryContext): void {
          this.#runOrDeferKernelEntry("inner", (_inner) => {
            outer.instance.exports.read;
          });
        }
        #bad(entry: KernelWorkerEntryContext): void {
          const extracted = entry["instance"]["exports"]["read"] as
            () => void;
          entry.deferObserverEffect(() => extracted());
          entry = {} as KernelWorkerEntryContext;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            this.#nested(entry);
            this.#bad(entry);
          });
        }
      }
    `);
    expect(unsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "context-cross-ingress-capture",
      }),
      expect.objectContaining({
        kind: "context-detached-capture",
      }),
      expect.objectContaining({ kind: "context-storage" }),
    ]));

    const safe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
      }
      interface MaterializedCompletion { readonly value: number }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        private callbacks = { publish(_value: number): void {} };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry?: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry?.instance ?? this.#kernelInstance!;
        }
        #materialize(
          entry: KernelWorkerEntryContext,
        ): MaterializedCompletion {
          const read = this.#kernelInstanceForEntry(entry).exports.read as
            () => number;
          return { value: read() };
        }
        #publish(completion: MaterializedCompletion): void {
          this.callbacks.publish(completion.value);
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            const completion = this.#materialize(entry);
            entry.deferObserverEffect(() => this.#publish(completion));
          });
        }
      }
    `);
    expect(safe).toEqual([]);
  });

  it("keeps observer effects out of protocol publication and ingress", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
        deferProtocolEffect(operation: () => void): void;
      }
      interface MaterializedCompletion { readonly value: number }
      class CentralizedKernelWorker {
        private callbacks = { onOutput(_value: number): void {} };
        private published = 0;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        private relistenChannel(): void {}
        #publish(completion: MaterializedCompletion): void {
          this.published = completion.value;
          this.relistenChannel();
        }
        #publishAlias(completion: MaterializedCompletion): void {
          this.#publish(completion);
        }
        #startAlias(): void {
          this.#runOrDeferKernelEntry("observer-start", (_entry) => {});
        }
        #observe(completion: MaterializedCompletion): void {
          this.callbacks.onOutput(completion.value);
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            const completion = { value: 7 };
            entry.deferProtocolEffect(() => this.#publishAlias(completion));
            entry.deferObserverEffect(() => this.#observe(completion));
            entry.deferObserverEffect(() => this.#publishAlias(completion));
            entry.deferObserverEffect(() => this.#startAlias());
          });
        }
      }
    `);

    expect(
      violations.filter(
        ({ kind }) => kind === "protocol-effect-from-observer",
      ),
    ).toHaveLength(2);
  });

  it("rejects asynchronous detached callbacks and Promise-launching aliases", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
        deferProtocolEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            const asyncAlias = async (): Promise<void> => {};
            const launch = (): Promise<void> => Promise.resolve();
            entry.deferObserverEffect(async () => {});
            entry.deferProtocolEffect(asyncAlias);
            entry.deferObserverEffect(() => {
              void launch();
            });
            entry.deferProtocolEffect(() => Promise.resolve());
          });
        }
      }
    `);

    expect(
      violations.filter(({ kind }) => kind === "async-detached-effect"),
    ).toHaveLength(4);
  });

  it("does not recognize the removed deferHostEffect name", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferHostEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        private callbacks = { onOutput(): void {} };
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            entry.deferHostEffect(() => this.callbacks.onOutput());
          });
        }
      }
    `);

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "host-effect-in-scoped-graph" }),
    ]));
  });

  it("rejects nonliteral this dispatch and resolves immutable literal keys", () => {
    const unsafe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        entryExport(entry: KernelWorkerEntryContext): void {
          void entry.instance.exports.read;
        }
        dispatch(selectedMethod: string): void {
          this.#runOrDeferKernelEntry("dynamic", (entry) => {
            (this as any)[selectedMethod](entry);
          });
        }
      }
    `);
    expect(unsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "dynamic-entry-method-dispatch",
        owner: expect.stringContaining("<scoped-root@"),
      }),
    ]));

    const safe = auditKernelEntryContext(`
      const intrinsicSeal = Object.seal;
      const intrinsicFreeze = Object.freeze;
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        constructor() {
          if (new.target !== CentralizedKernelWorker) {
            throw new TypeError("CentralizedKernelWorker is final");
          }
          intrinsicSeal(this);
        }
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        entryExport(entry: KernelWorkerEntryContext): void {
          void entry.instance.exports.read;
        }
        dispatch(): void {
          const method = "entryExport" as const;
          const exactAlias = method;
          this.#runOrDeferKernelEntry("exact", (entry) => {
            this[exactAlias](entry);
          });
        }
      }
      intrinsicFreeze(CentralizedKernelWorker.prototype);
    `);
    expect(safe).toEqual([]);
  });

  it("rejects implicit arguments access in an entry-owning method", () => {
    const violations = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        private saved: unknown;
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #bad(entry: KernelWorkerEntryContext): void {
          this.saved = arguments[0];
          void entry;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("arguments", (entry) => {
            this.#bad(entry);
          });
        }
      }
    `);

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "implicit-arguments-entry-authority",
        owner: "CentralizedKernelWorker.#bad",
      }),
    ]));
  });

  it("rejects genuine direct eval in the entry graph", () => {
    const unsafe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #bad(entry: KernelWorkerEntryContext): void {
          eval("void entry.instance.exports.read");
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("eval", (entry) => {
            this.#bad(entry);
          });
        }
      }
    `);
    expect(unsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "direct-eval-in-entry-graph",
        owner: "CentralizedKernelWorker.#bad",
      }),
    ]));

    const safe = auditKernelEntryContext(`
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        dispatch(): void {
          const eval = (_source: string): void => {};
          this.#runOrDeferKernelEntry("shadowed", (_entry) => {
            eval("not the intrinsic");
            globalThis.eval?.("indirect eval");
          });
        }
      }
    `);
    expect(safe).toEqual([]);
  });

  it("requires sealed instances and a frozen prototype for TS-private entry dispatch", () => {
    const source = (hardening: string, prelude = "") => `
      ${prelude}
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
        deferObserverEffect(operation: () => void): void;
        deferProtocolEffect(operation: () => void): void;
      }
      class CentralizedKernelWorker {
        #kernelInstance: WebAssembly.Instance | null = null;
        constructor() {
          ${hardening.includes("rejectSubclass")
            ? `if (new.target !== CentralizedKernelWorker) {
                throw new TypeError("CentralizedKernelWorker is final");
              }`
            : ""}
          ${hardening.includes("intrinsicSeal")
            ? "intrinsicSeal(this);"
            : hardening.includes("fakeSeal")
            ? "fakeSeal(this);"
            : ""}
        }
        #runOrDeferKernelEntry(
          _label: string,
          _operation: (entry: KernelWorkerEntryContext) => void,
        ): void {}
        #kernelInstanceForEntry(
          entry: KernelWorkerEntryContext,
        ): WebAssembly.Instance {
          return entry.instance;
        }
        private dynamicEntryMethod(
          entry: KernelWorkerEntryContext,
        ): void {
          void this.#kernelInstanceForEntry(entry).exports.read;
        }
        dispatch(): void {
          this.#runOrDeferKernelEntry("outer", (entry) => {
            this.dynamicEntryMethod(entry);
          });
        }
      }
      ${hardening.includes("intrinsicFreeze")
        ? "intrinsicFreeze(CentralizedKernelWorker.prototype);"
        : hardening.includes("fakeFreeze")
        ? "fakeFreeze(CentralizedKernelWorker.prototype);"
        : ""}
    `;

    const unsafe = auditKernelEntryContext(source(""));
    expect(unsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "mutable-entry-method-dispatch",
        text: expect.stringContaining("dynamicEntryMethod"),
      }),
    ]));

    const spoofed = auditKernelEntryContext(source(
      "fakeSeal fakeFreeze",
      `
        const fakeSeal = <T>(value: T): T => value;
        const fakeFreeze = <T>(value: T): T => value;
      `,
    ));
    expect(spoofed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mutable-entry-method-dispatch" }),
    ]));

    const subclassable = auditKernelEntryContext(source(
      "intrinsicSeal intrinsicFreeze",
      `
        const intrinsicSeal = Object.seal;
        const intrinsicFreeze = Object.freeze;
      `,
    ));
    expect(subclassable).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mutable-entry-method-dispatch" }),
    ]));

    const hardened = auditKernelEntryContext(source(
      "intrinsicSeal intrinsicFreeze rejectSubclass",
      `
        const intrinsicSeal = Object.seal;
        const intrinsicFreeze = Object.freeze;
      `,
    ));
    expect(hardened).toEqual([]);
  });
});
