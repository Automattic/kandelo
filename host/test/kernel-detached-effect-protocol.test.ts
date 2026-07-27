import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type KernelEntryEffectRegistrar,
  KernelEntryGate,
} from "../src/kernel-entry-gate";

type TestIngress = "first" | "follower";

type EffectHandler = (
  ingress: TestIngress,
  effects: KernelEntryEffectRegistrar,
) => undefined;

function createEffectHarness(
  onKernelFatal: (error: Error) => void = () => {},
): {
  gate: KernelEntryGate;
  run(ingress: TestIngress): boolean;
  setHandler(handler: EffectHandler): void;
} {
  const gate = new KernelEntryGate(onKernelFatal);
  let handler: EffectHandler = () => undefined;

  return {
    gate,
    run(ingress): boolean {
      return gate.runOrDeferVoidIngress(
        `test ${ingress} ingress`,
        (_scope, effects) => handler(ingress, effects),
      );
    },
    setHandler(nextHandler): void {
      handler = nextHandler;
    },
  };
}

async function drainGate(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kernel detached-effect protocol", () => {
  it.each(["immediate", "deferred"] as const)(
    "%s protocol publication failure latches fatal before any later work",
    async (phase) => {
      const order: string[] = [];
      let harness:
        | ReturnType<typeof createEffectHarness>
        | undefined;
      const onKernelFatal = vi.fn(() => {
        order.push("fatal");
        if (harness) {
          // A fatal observer can synchronously try to resurrect dispatch. The
          // latch and queue discard must already be authoritative.
          harness.run("follower");
        }
      });
      harness = createEffectHarness(onKernelFatal);
      const publish = vi.fn(() => {
        order.push("publish");
        throw new Error("injected publication failure");
      });
      const relisten = vi.fn(() => {
        order.push("relisten");
      });
      const observer = vi.fn(() => {
        order.push("observer");
      });
      const followerHandler = vi.fn(() => {
        order.push("follower");
      });
      harness.setHandler((ingress, effects) => {
        if (ingress === "follower") {
          followerHandler();
          return undefined;
        }
        order.push("handler");
        effects.deferProtocolEffect(publish);
        effects.deferProtocolEffect(relisten);
        effects.deferObserverEffect(observer);
        return undefined;
      });

      if (phase === "immediate") {
        expect(() => harness!.run("first"))
          .toThrow(/kernel protocol effect 0.*failed/);
      } else {
        harness.gate.invokeKernelExport("hold ingress", () => {
          harness!.run("first");
          harness!.run("follower");
        });
        await drainGate();
      }

      expect(order).toEqual(["handler", "publish", "fatal"]);
      expect(onKernelFatal).toHaveBeenCalledOnce();
      expect(relisten).not.toHaveBeenCalled();
      expect(observer).not.toHaveBeenCalled();
      expect(followerHandler).not.toHaveBeenCalled();

      harness.run("first");
      harness.run("follower");
      await drainGate();
      expect(order).toEqual(["handler", "publish", "fatal"]);
    },
  );

  it.each([
    ["immediate", "protocol"],
    ["immediate", "observer"],
    ["deferred", "protocol"],
    ["deferred", "observer"],
  ] as const)(
    "%s %s Promise return is rejected at the detached boundary",
    async (phase, kind) => {
      const order: string[] = [];
      const onKernelFatal = vi.fn(() => order.push("fatal"));
      const harness = createEffectHarness(onKernelFatal);
      const laterProtocol = vi.fn(() => {
        order.push("later-protocol");
      });
      const laterObserver = vi.fn(() => {
        order.push("later-observer");
      });
      const followerHandler = vi.fn(() => {
        order.push("follower");
      });
      const returningPromise = (() => {
        order.push(`${kind}-promise`);
        return Promise.resolve().then(() => order.push(`${kind}-continuation`));
      }) as unknown as () => undefined;
      harness.setHandler((ingress, effects) => {
        if (ingress === "follower") {
          followerHandler();
          return undefined;
        }
        order.push("handler");
        if (kind === "protocol") {
          effects.deferProtocolEffect(returningPromise);
        } else {
          effects.deferObserverEffect(returningPromise);
        }
        effects.deferProtocolEffect(laterProtocol);
        effects.deferObserverEffect(laterObserver);
        return undefined;
      });

      if (phase === "immediate") {
        const invoke = () => harness.run("first");
        if (kind === "protocol") {
          expect(invoke).toThrow(/kernel protocol effect 0.*failed/);
        } else {
          expect(invoke).not.toThrow();
          harness.run("follower");
        }
      } else {
        harness.gate.invokeKernelExport("hold ingress", () => {
          harness.run("first");
          harness.run("follower");
        });
      }
      await drainGate();

      if (kind === "protocol") {
        expect(onKernelFatal).toHaveBeenCalledOnce();
        expect(laterProtocol).not.toHaveBeenCalled();
        expect(laterObserver).not.toHaveBeenCalled();
        expect(followerHandler).not.toHaveBeenCalled();
      } else {
        expect(onKernelFatal).not.toHaveBeenCalled();
        expect(laterProtocol).toHaveBeenCalledOnce();
        expect(laterObserver).toHaveBeenCalledOnce();
        expect(followerHandler).toHaveBeenCalledOnce();
      }
      expect(order[0]).toBe("handler");
      expect(order[1]).toBe(`${kind}-promise`);
      expect(order).toContain(`${kind}-continuation`);
    },
  );

  it.each(["immediate", "deferred"] as const)(
    "%s generic ingress Promise return poisons and discards followers",
    async (phase) => {
      const order: string[] = [];
      const fatal = vi.fn(() => order.push("fatal"));
      const gate = new KernelEntryGate(fatal);
      const asyncIngress = (() => {
        order.push("async-ingress");
        return Promise.resolve().then(() => order.push("continuation"));
      }) as unknown as (
        scope: unknown,
        effects: unknown,
      ) => undefined;
      const follower = vi.fn(() => {
        order.push("follower");
        return undefined;
      });

      if (phase === "immediate") {
        expect(() =>
          gate.runOrDeferVoidIngress("async ingress", asyncIngress)
        ).toThrow(/void kernel ingress async ingress failed/);
      } else {
        gate.invokeKernelExport("hold ingress", () => {
          gate.runOrDeferVoidIngress("async ingress", asyncIngress);
          gate.runOrDeferVoidIngress("follower", follower);
        });
      }
      await drainGate();

      expect(fatal).toHaveBeenCalledOnce();
      expect(follower).not.toHaveBeenCalled();
      expect(order).toEqual([
        "async-ingress",
        "fatal",
        "continuation",
      ]);
    },
  );
});
